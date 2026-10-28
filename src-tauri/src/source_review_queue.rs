//! Durable local review results, separate from the user-center event outbox.
use crate::{
    error::{AppError, AppResult},
    machine_review::{self, ReviewState, ReviewView, SaveReviewRequest},
    model::UserIdentity,
    review_outbox,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeferredReview {
    pub request: SaveReviewRequest,
    pub output_hash: Option<String>,
    pub qc_content_hash: Option<String>,
    #[serde(default)]
    pub only_pending: bool,
    pub audit: Value,
    pub error: String,
    #[serde(default)]
    pub created_at_ms: u64,
}
impl DeferredReview {
    pub fn is_action_draft(&self) -> bool {
        self.request.source_name.as_deref() != Some(crate::machine_annotation::SKELETON_SOURCE)
            && self.request.status.as_deref().unwrap_or("pending") == "pending"
    }
}
// Drafts remain durable/recoverable, but are never eligible for NAS writeback,
// including pending action entries made by an older client.
const PUBLISHABLE: &str = "(source_name='skeleton.description.json' OR coalesce(json_extract(payload,'$.request.status'),'pending')!='pending')";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    pub channel: String,
    pub name: String,
    pub source_path: String,
    pub status: String,
    pub error: String,
    pub created_at_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingStatus {
    pub pending: usize,
    pub items: Vec<PendingItem>,
    pub ready: bool,
    pub storage_error: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub written: usize,
    pub remaining: usize,
    pub errors: Vec<String>,
}
fn failure(error: impl std::fmt::Display) -> AppError {
    AppError::Message(format!(
        "SOURCE_REVIEW_LOCAL_STORAGE: {error}。本机结果未确认保存，请保持当前数据打开并重试"
    ))
}
fn open(root: &Path) -> AppResult<rusqlite::Connection> {
    let db = review_outbox::open(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS source_reviews(service TEXT NOT NULL, username TEXT NOT NULL, source_path TEXT NOT NULL, source_name TEXT NOT NULL, payload TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(service, username, source_path, source_name));
    CREATE TABLE IF NOT EXISTS source_review_history(service TEXT NOT NULL, username TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(service,username,event_id));
    CREATE TABLE IF NOT EXISTS source_review_receipts(service TEXT NOT NULL, username TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(service,username,event_id));").map_err(failure)?;
    Ok(db)
}
pub(crate) fn owner_lock(root: &Path, service: &str, username: &str) -> AppResult<std::fs::File> {
    // Validate the private, no-follow queue directory before creating its lock.
    drop(open(root)?);
    let directory = root.join("review-outbox");
    let key = blake3::hash(format!("{service}\n{username}").as_bytes()).to_hex();
    machine_review::lock_file(&directory.join(format!("source-{key}.lock")))
}
// Windows canonicalize adds a verbatim prefix; old queues/UI paths may omit it.
// This is lexical only: the local durability path must not stat the NAS.
fn plain_path(path: &str) -> String {
    let windows = path.starts_with(r"\\") || path.as_bytes().get(1) == Some(&b':');
    if !windows {
        return path.into();
    }
    let path = path.replace('/', "\\");
    if path
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\UNC\"))
    {
        format!(r"\\{}", &path[8..])
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).into()
    }
}
fn verbatim_path(path: &str) -> String {
    if let Some(tail) = path.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{tail}")
    } else if path.as_bytes().get(1) == Some(&b':') {
        format!(r"\\?\{path}")
    } else {
        path.into()
    }
}
fn path_aliases(root: &Path, path: &str) -> AppResult<Vec<String>> {
    let plain = plain_path(path);
    let mut paths = vec![path.to_owned(), plain.clone(), verbatim_path(&plain)];
    for historical in crate::dataset_layout::historical_paths_cached(root, Path::new(&plain))? {
        let value = historical.to_string_lossy().into_owned();
        paths.push(value.clone());
        paths.push(verbatim_path(&value));
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub fn get(
    root: &Path,
    service: &str,
    username: &str,
    path: &str,
    source: Option<&str>,
) -> AppResult<Option<DeferredReview>> {
    let db = open(root)?;
    let paths = path_aliases(root, path)?;
    let collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    let sql=format!("SELECT payload FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (SELECT value FROM json_each(?)) AND source_name=? ORDER BY CASE WHEN source_path=? THEN 0 ELSE 1 END LIMIT 1");
    let raw: Option<String> = db
        .query_row(
            &sql,
            params![
                service,
                username,
                serde_json::to_string(&paths)?,
                source.unwrap_or(""),
                path
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(failure)?;
    raw.map(|s| serde_json::from_str(&s).map_err(failure))
        .transpose()
}
#[cfg(test)]
pub fn contains_path(root: &Path, service: &str, username: &str, path: &str) -> AppResult<bool> {
    contains_related(root, service, username, path, None)
}
pub fn contains_submitted(
    root: &Path,
    service: &str,
    username: &str,
    path: &str,
) -> AppResult<bool> {
    let paths = path_aliases(root, path)?;
    let collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    open(root)?.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (SELECT value FROM json_each(?)) AND source_name!='skeleton.description.json' AND {PUBLISHABLE})"),
        params![service, username, serde_json::to_string(&paths)?], |r|r.get(0),
    ).map_err(failure)
}
pub(crate) fn contains_action_draft(
    root: &Path,
    service: &str,
    username: &str,
    path: &str,
) -> AppResult<bool> {
    let paths = path_aliases(root, path)?;
    let collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    open(root)?.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (SELECT value FROM json_each(?)) AND source_name!='skeleton.description.json' AND coalesce(json_extract(payload,'$.request.status'),'pending')='pending')"),
        params![service, username, serde_json::to_string(&paths)?], |r| r.get(0),
    ).map_err(failure)
}
pub fn contains_related(
    root: &Path,
    service: &str,
    username: &str,
    path: &str,
    source: Option<&str>,
) -> AppResult<bool> {
    let paths = path_aliases(root, path)?;
    let skeleton = source == Some(crate::machine_annotation::SKELETON_SOURCE);
    let collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    let sql=format!("SELECT EXISTS(SELECT 1 FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (SELECT value FROM json_each(?)) AND (source_name=?)=?)");
    open(root)?
        .query_row(
            &sql,
            params![
                service,
                username,
                serde_json::to_string(&paths)?,
                crate::machine_annotation::SKELETON_SOURCE,
                skeleton
            ],
            |row| row.get(0),
        )
        .map_err(failure)
}
pub fn store(
    root: &Path,
    service: &str,
    username: &str,
    mut entry: DeferredReview,
) -> AppResult<DeferredReview> {
    let _lock = owner_lock(root, service, username)?;
    if !Path::new(&entry.request.source_path).is_absolute()
        || !["pending", "approved", "rejected"]
            .contains(&entry.request.status.as_deref().unwrap_or("pending"))
    {
        return Err(failure("待写回结果路径或状态无效"));
    }
    let id = entry
        .audit
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| failure("操作事件标识无效"))?
        .to_string();
    if serde_json::to_vec(&entry.audit)?.len() > 64 * 1024 {
        return Err(failure("操作记录过大"));
    }
    if entry.audit["details"].as_object().is_none()
        || entry.audit["occurredAtMs"]
            .as_u64()
            .is_none_or(|time| time == 0)
        || entry.audit["action"].as_str()
            != Some(match entry.request.status.as_deref() {
                Some("approved") => "approved",
                Some("rejected") => "rejected",
                _ => "saved",
            })
        || entry.request.segments.iter().any(|s| {
            s.end_frame < s.start_frame
                || !["pending", "approved", "rejected"].contains(&s.decision.as_str())
        })
        || (entry.request.status.as_deref() == Some("approved")
            && !entry.request.segments.iter().any(|s| !s.deleted))
    {
        return Err(failure("本机结果或对应操作记录无效"));
    }
    if entry.only_pending && entry.request.status.as_deref() != Some("rejected") {
        return Err(failure("批量暂存仅支持不通过"));
    }
    // Preserve the first shared baseline when an offline result is edited again.
    let old = get(
        root,
        service,
        username,
        &entry.request.source_path,
        entry.request.source_name.as_deref(),
    )?;
    if old.is_none()
        && entry.request.source_name.as_deref() != Some(crate::machine_annotation::SKELETON_SOURCE)
        && contains_submitted(root, service, username, &entry.request.source_path)?
    {
        return Err(failure(
            "该数据已有另一来源的审核结论待写回，请先确认写回；未审核草稿仍保留",
        ));
    }
    if let Some(old) = old {
        // Keep the original SQLite key; publication resolves only the filesystem path.
        entry.request.source_path = old.request.source_path;
        entry.output_hash = old.output_hash;
        entry.qc_content_hash = old.qc_content_hash;
        entry.request.expected_revision = old.request.expected_revision;
        entry.request.source_hash = old.request.source_hash;
        entry.created_at_ms = old.created_at_ms;
        entry.only_pending = old.only_pending;
        if old.only_pending {
            entry.request.source_name = old.request.source_name;
        }
    } else {
        entry.created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
    }
    let raw = serde_json::to_string(&entry)?;
    if raw.len() > 9 * 1024 * 1024 {
        return Err(failure("单条本机结果超过 9 MiB"));
    }
    let mut db = open(root)?;
    let tx = db.transaction().map_err(failure)?;
    tx.execute("INSERT OR IGNORE INTO source_review_history SELECT service,username,event_id,payload FROM source_reviews WHERE service=? AND username=? AND source_path=? AND source_name=?",params![service,username,entry.request.source_path,entry.request.source_name.as_deref().unwrap_or("")]).map_err(failure)?;
    tx.execute("INSERT INTO source_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(service,username,source_path,source_name) DO UPDATE SET payload=excluded.payload,event_id=excluded.event_id", params![service,username,entry.request.source_path,entry.request.source_name.as_deref().unwrap_or(""),raw,id]).map_err(failure)?;
    enqueue_receipt(&tx, service, username, &entry, "local", None)?;
    tx.commit().map_err(failure)?;
    Ok(entry)
}

/// Only dataset-relative identity and duration enter the fixed user-center
/// audit protocol. No absolute workstation/share path or annotation text.
pub fn receipt_metadata(path: &str, event: &Value, source: Option<&str>, storage: &str) -> Value {
    use sha2::{Digest, Sha256};
    let path = plain_path(path).replace('\\', "/");
    let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let relative = parts
        .iter()
        .position(|p| p.eq_ignore_ascii_case("Delta-D1") || *p == "一汽data")
        .map(|i| (parts[i], parts[i + 1..].join("/")));
    json!({"schema":"delta.review-receipt.v1", "storage":storage,
        "submissionId":event["eventId"],
        "identityKey":relative.as_ref().map(|(dataset, relative)|format!("{:x}",Sha256::digest(format!("{dataset}/{relative}").to_lowercase().as_bytes()))),
        "dataset":relative.map(|(dataset, _)|dataset.to_lowercase()),
        "channel":if source == Some(crate::machine_annotation::SKELETON_SOURCE) {"skeleton"} else {"action"},
        "originalDurationMs":event["details"]["durationMs"],
        "batch":event["details"]["target"].as_str().is_some_and(|s|s.starts_with("批量不通过"))})
}

fn enqueue_receipt(
    db: &rusqlite::Connection,
    service: &str,
    username: &str,
    entry: &DeferredReview,
    storage: &str,
    revision: Option<&str>,
) -> AppResult<()> {
    let mut audit = entry.audit.clone();
    let metadata = receipt_metadata(
        &entry.request.source_path,
        &audit,
        entry.request.source_name.as_deref(),
        storage,
    );
    if storage == "nas" {
        use sha2::{Digest, Sha256};
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("nas:{}", audit["eventId"].as_str().unwrap_or("")).as_bytes())
        );
        audit["eventId"] = json!(format!(
            "{}-{}-4{}-8{}-{}",
            &digest[..8],
            &digest[8..12],
            &digest[13..16],
            &digest[17..20],
            &digest[20..32]
        ));
        audit["action"] = json!("source_written");
        audit["occurredAtMs"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64);
        audit["elapsedMs"] = json!(0);
        audit["details"]["target"] = json!("审核结果写回NAS");
    } else {
        audit["details"]["target"] = json!(if entry.only_pending {
            "批量不通过 · 本机待写回"
        } else if entry.is_action_draft() {
            "本机动作草稿 · 待审核"
        } else {
            "本机待写回审核结果"
        });
    }
    audit["details"]["revision"] = json!(revision.map(str::to_owned).unwrap_or_else(|| entry
        .audit["eventId"]
        .as_str()
        .unwrap_or("")
        .replace('-', "")));
    audit["details"]["value"] = json!(serde_json::to_string(&metadata)?);
    let id = audit["eventId"].as_str().unwrap_or("");
    let inserted = db
        .execute(
            "INSERT OR IGNORE INTO source_review_receipts VALUES(?,?,?)",
            params![service, username, id],
        )
        .map_err(failure)?;
    if inserted > 0 {
        review_outbox::enqueue_with(db, service, username, &[audit])?;
    }
    Ok(())
}

/// Upgrade existing durable queues without reading NAS or rewriting results.
/// Receipt IDs/times come from the saved event, never from the upgrade clock.
fn migrate_receipts(root: &Path, service: &str, username: &str) -> AppResult<()> {
    let mut db = open(root)?;
    loop {
        let entries = {
            let mut q=db.prepare("SELECT payload FROM source_reviews s WHERE service=? AND username=? AND NOT EXISTS(SELECT 1 FROM source_review_receipts r WHERE r.service=s.service AND r.username=s.username AND r.event_id=s.event_id) LIMIT 20").map_err(failure)?;
            let rows = q
                .query_map(params![service, username], |r| r.get::<_, String>(0))
                .map_err(failure)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(failure)?
        };
        if entries.is_empty() {
            break;
        }
        let tx = db.transaction().map_err(failure)?;
        for raw in entries {
            let entry: DeferredReview = serde_json::from_str(&raw)?;
            enqueue_receipt(&tx, service, username, &entry, "local", None)?;
        }
        tx.commit().map_err(failure)?;
    }
    Ok(())
}
#[cfg(test)]
pub fn list(root: &Path, service: &str, username: &str) -> AppResult<Vec<DeferredReview>> {
    let db = open(root)?;
    let mut query = db
        .prepare("SELECT payload FROM source_reviews WHERE service=? AND username=? ORDER BY rowid LIMIT 100")
        .map_err(failure)?;
    let rows = query
        .query_map(params![service, username], |r| r.get::<_, String>(0))
        .map_err(failure)?;
    rows.map(|row| serde_json::from_str(&row.map_err(failure)?).map_err(failure))
        .collect()
}
pub fn local_view(
    entry: &DeferredReview,
    user: &UserIdentity,
    base: Option<ReviewView>,
) -> ReviewView {
    let mut view = base.unwrap_or_else(|| ReviewView {
        local_draft: false,
        review: ReviewState {
            reviewer_username: user.username.clone(),
            recovery_warnings: vec![],
            rejection_reason: String::new(),
            change_summary: String::new(),
            revision_label: String::new(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            workflow_version: 4,
            status: "pending".into(),
            version_id: String::new(),
            previous_version_id: String::new(),
            source_hash: entry.request.source_hash.clone(),
            revision: entry.request.expected_revision,
            segments: vec![],
            published: false,
            output_hash: entry.output_hash.clone(),
            updated_at_ms: entry.created_at_ms,
            reviewer: user.display_name.clone(),
        },
        output_name: "".into(),
        qc_status: "unknown".into(),
        qc_rejection_reason: String::new(),
        qc_status_error: String::new(),
        pending_source_write: true,
        qc_content_hash: entry.qc_content_hash.clone(),
        source_write_error: entry.error.clone(),
    });
    if entry.request.source_name.as_deref() == Some(crate::machine_annotation::SKELETON_SOURCE) {
        view.output_name = crate::machine_annotation::SKELETON_SOURCE.into();
        view.qc_status.clear();
        view.qc_status_error.clear();
        view.qc_rejection_reason.clear();
    }
    if view.output_name.is_empty() {
        view.output_name = match entry.request.source_name.as_deref() {
            Some(crate::machine_annotation::SKELETON_SOURCE) => {
                crate::machine_annotation::SKELETON_SOURCE
            }
            Some(crate::machine_annotation::FLASH_SOURCE | "desorption.json") => "desorption.json",
            _ => "description.json",
        }
        .into();
    }
    view.review.segments = entry.request.segments.clone();
    view.review.status = entry
        .request
        .status
        .clone()
        .unwrap_or_else(|| "pending".into());
    view.review.rejection_reason = entry.request.rejection_reason.clone().unwrap_or_default();
    view.review.source_hash = entry.request.source_hash.clone();
    view.review.revision = entry.request.expected_revision;
    view.review.output_hash = entry.output_hash.clone();
    view.review.published = false;
    view.local_draft = entry.is_action_draft();
    view.pending_source_write = !view.local_draft;
    if view.local_draft {
        view.qc_status = "pending".into();
        view.qc_rejection_reason.clear();
        view.qc_status_error.clear();
    }
    view.source_write_error = entry.error.clone();
    view
}
pub fn status(
    root: &Path,
    service: &str,
    username: &str,
    check_storage: bool,
) -> AppResult<PendingStatus> {
    migrate_receipts(root, service, username)?;
    let db = open(root)?;
    let pending = db
        .query_row(
            &format!("SELECT count(*) FROM source_reviews WHERE service=? AND username=? AND {PUBLISHABLE}"),
            params![service, username],
            |row| row.get::<_, usize>(0),
        )
        .map_err(failure)?;
    let mut query=db.prepare(&format!("SELECT source_path,json_extract(payload,'$.request.status'),json_extract(payload,'$.error'),json_extract(payload,'$.createdAtMs'),source_name FROM source_reviews WHERE service=? AND username=? AND {PUBLISHABLE} ORDER BY rowid LIMIT 200")).map_err(failure)?;
    let rows = query
        .query_map(params![service, username], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(failure)?;
    let mut items = vec![];
    for row in rows {
        let (path, status, error, created_at_ms, source_name) = row.map_err(failure)?;
        items.push(PendingItem {
            channel: if source_name == crate::machine_annotation::SKELETON_SOURCE {
                "skeleton"
            } else {
                "action"
            }
            .into(),
            name: Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            source_path: path,
            status: status.unwrap_or_else(|| "pending".into()),
            error,
            created_at_ms,
        });
    }
    let (ready, storage_error) = if check_storage {
        match items.first() {
            Some(entry) => match crate::source_path_probe::ensure_review_storage_responsive(
                Path::new(&entry.source_path),
            ) {
                Ok(()) => (true, String::new()),
                Err(e) => (false, e.to_string()),
            },
            None => (false, String::new()),
        }
    } else {
        (false, String::new())
    };
    Ok(PendingStatus {
        pending,
        items,
        ready,
        storage_error,
    })
}
/// Sidebar lookup is local only and is not truncated to the notice's 200 rows.
/// Read small summary columns, never retain all result payloads in memory.
pub fn status_for_paths(
    root: &Path,
    service: &str,
    username: &str,
    paths: &[String],
) -> AppResult<PendingStatus> {
    if paths.len() > 20_000 {
        return Err(failure("目录记录数量超过 20000"));
    }
    let mut aliases = std::collections::HashMap::new();
    for path in paths {
        for alias in path_aliases(root, path)? {
            let key = if cfg!(windows) {
                alias.to_lowercase()
            } else {
                alias
            };
            aliases.insert(key, path);
        }
    }
    let db = open(root)?;
    let mut query = db.prepare("SELECT source_path,json_extract(payload,'$.request.status'),json_extract(payload,'$.createdAtMs') FROM source_reviews WHERE service=? AND username=? AND source_name!=? ORDER BY json_extract(payload,'$.audit.occurredAtMs')").map_err(failure)?;
    let rows = query
        .query_map(
            params![
                service,
                username,
                crate::machine_annotation::SKELETON_SOURCE
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            },
        )
        .map_err(failure)?;
    let mut items = std::collections::BTreeMap::new();
    for row in rows {
        let (path, status, created_at_ms) = row.map_err(failure)?;
        let key = if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        };
        if let Some(current) = aliases.get(&key) {
            items.insert(
                (*current).clone(),
                PendingItem {
                    channel: "action".into(),
                    name: String::new(),
                    source_path: (*current).clone(),
                    status: status.unwrap_or_else(|| "pending".into()),
                    error: String::new(),
                    created_at_ms,
                },
            );
        }
    }
    Ok(PendingStatus {
        pending: items.len(),
        items: items.into_values().collect(),
        ready: false,
        storage_error: String::new(),
    })
}

fn publish_entry(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    entry: &DeferredReview,
    probe: &impl Fn(&Path) -> AppResult<()>,
) -> AppResult<ReviewState> {
    probe(Path::new(&entry.request.source_path))?;
    let state = if entry.only_pending {
        machine_review::reject_pending_deferred(
            root,
            Path::new(&entry.request.source_path),
            entry.request.rejection_reason.as_deref().unwrap_or(""),
            &user.display_name,
            &user.username,
            (
                entry.audit["eventId"].as_str().unwrap_or("").into(),
                entry.audit["occurredAtMs"]
                    .as_u64()
                    .unwrap_or(entry.created_at_ms),
            ),
        )?
        .ok_or_else(|| {
            AppError::Message(
                "共享数据已有审核结论，未覆盖；本机待写结果已保留，请打开对应数据核对".into(),
            )
        })?
    } else {
        machine_review::publish_deferred_for_user(
            root,
            entry.request.clone(),
            entry.output_hash.clone(),
            entry.qc_content_hash.clone(),
            &user.display_name,
            &user.username,
            (
                entry.audit["eventId"].as_str().unwrap_or("").into(),
                entry.audit["occurredAtMs"]
                    .as_u64()
                    .unwrap_or(entry.created_at_ms),
            ),
        )?
    };
    let mut db = open(root)?;
    let tx = db.transaction().map_err(failure)?;
    enqueue_receipt(&tx, service, &user.username, entry, "local", None)?;
    enqueue_receipt(
        &tx,
        service,
        &user.username,
        entry,
        "nas",
        Some(&state.revision_label),
    )?;
    tx.execute("DELETE FROM source_reviews WHERE service=? AND username=? AND source_path=? AND source_name=? AND event_id=?",params![service,user.username,entry.request.source_path,entry.request.source_name.as_deref().unwrap_or(""),entry.audit["eventId"].as_str().unwrap_or("")]).map_err(failure)?;
    tx.commit().map_err(failure)?;
    Ok(state)
}

pub fn submit_action(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    entry: DeferredReview,
) -> AppResult<ReviewView> {
    submit_action_with_probe(
        root,
        service,
        user,
        entry,
        &crate::source_path_probe::ensure_review_storage_responsive,
    )
}

pub(crate) fn submit_action_with_probe(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    entry: DeferredReview,
    probe: &impl Fn(&Path) -> AppResult<()>,
) -> AppResult<ReviewView> {
    if entry.request.source_name.as_deref() == Some(crate::machine_annotation::SKELETON_SOURCE)
        || entry.only_pending
    {
        return Err(failure("动作本机草稿入口不接受骨架或批量请求"));
    }
    let mut entry = entry;
    if !entry.is_action_draft() {
        if let Some(previous) = get(
            root,
            service,
            &user.username,
            &entry.request.source_path,
            entry.request.source_name.as_deref(),
        )? {
            if previous.request.status == entry.request.status
                && previous.request.rejection_reason == entry.request.rejection_reason
                && previous.request.segments == entry.request.segments
            {
                // Retry an unacknowledged conclusion with its original identity
                // and occurrence time, including a source commit/local-ACK failure.
                entry.audit = previous.audit;
            }
        }
    }
    let mut saved = store(root, service, &user.username, entry)?;
    if saved.is_action_draft() {
        return Ok(local_view(&saved, user, None));
    }
    let _lock = owner_lock(root, service, &user.username)?;
    let current = get(
        root,
        service,
        &user.username,
        &saved.request.source_path,
        saved.request.source_name.as_deref(),
    )?
    .ok_or_else(|| failure("本机结果发生变化，请重新读取"))?;
    if current.audit["eventId"] != saved.audit["eventId"] {
        return Err(failure("本机结果已有新修改，未写入共享目录"));
    }
    match publish_entry(root, service, user, &saved, probe) {
        Ok(state) => Ok(machine_review::view_for_source(
            Path::new(&saved.request.source_path),
            saved.request.source_name.as_deref(),
            state,
        )),
        Err(error) => {
            let message = error.to_string();
            saved.error = message.clone();
            open(root)?.execute("UPDATE source_reviews SET payload=? WHERE service=? AND username=? AND source_path=? AND source_name=? AND event_id=?",params![serde_json::to_string(&saved)?,service,user.username,saved.request.source_path,saved.request.source_name.as_deref().unwrap_or(""),saved.audit["eventId"].as_str().unwrap_or("")]).map_err(failure)?;
            if message.contains("REVIEW_STORAGE_")
                || message.contains("SOURCE_UNAVAILABLE")
                || message.contains("I/O 错误")
            {
                Ok(local_view(&saved, user, None))
            } else {
                Err(error)
            }
        }
    }
}

pub fn publish(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    cancelled: &std::sync::atomic::AtomicBool,
) -> AppResult<PublishResult> {
    publish_with_probe(
        root,
        service,
        user,
        cancelled,
        &crate::source_path_probe::ensure_review_storage_responsive,
    )
}

pub(crate) fn publish_with_probe(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    cancelled: &std::sync::atomic::AtomicBool,
    probe: &impl Fn(&Path) -> AppResult<()>,
) -> AppResult<PublishResult> {
    let _lock = owner_lock(root, service, &user.username)?;
    let mut written = 0;
    let mut errors = vec![];
    // Read small keys up front; load one payload at a time. Conflicting rows
    // remain in place without starving later rows or retaining all JSON in RAM.
    let keys = {
        let db = open(root)?;
        let mut query = db.prepare("SELECT source_path,source_name FROM source_reviews WHERE service=? AND username=? ORDER BY rowid").map_err(failure)?;
        let keys = query
            .query_map(params![service, user.username], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        keys
    };
    for (path, source) in keys {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let Some(mut entry) = get(root, service, &user.username, &path, Some(&source))? else {
            continue;
        };
        if entry.is_action_draft() {
            continue;
        }
        let result = publish_entry(root, service, user, &entry, probe);
        match result {
            Ok(_) => written += 1,
            Err(error) => {
                let message = error.to_string();
                entry.error = message.clone();
                // Do not replace a newer edit made by another process.
                open(root)?.execute("UPDATE source_reviews SET payload=? WHERE service=? AND username=? AND source_path=? AND source_name=? AND event_id=?",params![serde_json::to_string(&entry)?,service,user.username,entry.request.source_path,entry.request.source_name.as_deref().unwrap_or(""),entry.audit["eventId"].as_str().unwrap_or("")]).map_err(failure)?;
                if errors.len() < 200 {
                    errors.push(message.clone());
                }
                if message.contains("REVIEW_STORAGE_FULL")
                    || message.contains("REVIEW_STORAGE_UNRESPONSIVE")
                {
                    break;
                }
            }
        }
    }
    Ok(PublishResult {
        written,
        remaining: status(root, service, &user.username, false)?.pending,
        errors,
    })
}

#[cfg(test)]
mod path_tests {
    use super::*;
    #[test]
    fn durable_lookup_accepts_windows_verbatim_aliases_without_network_io() {
        let root = std::env::temp_dir().join(format!(
            "queue-alias-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = open(&root).unwrap();
        let mut entry = DeferredReview {
            request: SaveReviewRequest {
                source_path: r"C:\数据\sample".into(),
                source_name: None,
                source_hash: "isolated".into(),
                expected_revision: 0,
                segments: vec![],
                status: Some("pending".into()),
                rejection_reason: None,
            },
            output_hash: None,
            qc_content_hash: None,
            only_pending: false,
            audit: json!({"eventId":"isolated"}),
            error: "simulated".into(),
            created_at_ms: 1,
        };
        for stored in [r"C:\数据\sample", r"\\?\C:\数据\sample"] {
            db.execute("DELETE FROM source_reviews", []).unwrap();
            entry.request.source_path = stored.into();
            db.execute(
                "INSERT INTO source_reviews VALUES (?,?,?,?,?,?)",
                params![
                    "s",
                    "alice",
                    stored,
                    "",
                    serde_json::to_string(&entry).unwrap(),
                    "isolated"
                ],
            )
            .unwrap();
            for lookup in [r"C:\数据\sample", r"\\?\C:\数据\sample"] {
                assert_eq!(
                    get(&root, "s", "alice", lookup, None)
                        .unwrap()
                        .unwrap()
                        .request
                        .source_path,
                    stored
                );
                assert!(contains_path(&root, "s", "alice", lookup).unwrap());
                assert!(get(&root, "s", "bob", lookup, None).unwrap().is_none());
                assert!(get(&root, "other", "alice", lookup, None)
                    .unwrap()
                    .is_none());
            }
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sidebar_summaries_are_account_scoped_untruncated_and_do_not_read_nas() {
        let root = std::env::temp_dir().join(format!(
            "viewer-sidebar-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = open(&root).unwrap();
        let paths: Vec<String> = (0..205)
            .map(|i| format!("/unavailable-nas/sample-{i}"))
            .collect();
        for (i, path) in paths.iter().enumerate() {
            let payload = json!({"request":{"status":"approved"},"createdAtMs":i+100,"audit":{"occurredAtMs":i+200}}).to_string();
            for (service, username, source) in [
                ("s", "alice", ""),
                ("s", "bob", ""),
                ("other", "alice", ""),
                ("s", "alice", crate::machine_annotation::SKELETON_SOURCE),
            ] {
                db.execute(
                    "INSERT INTO source_reviews VALUES(?,?,?,?,?,?)",
                    params![service, username, path, source, payload, format!("id-{i}")],
                )
                .unwrap();
            }
        }
        assert_eq!(
            status_for_paths(&root, "s", "alice", &paths)
                .unwrap()
                .items
                .len(),
            205
        );
        let one = status_for_paths(&root, "s", "alice", &paths[204..]).unwrap();
        assert_eq!(one.pending, 1);
        assert_eq!(one.items[0].source_path, paths[204]);
        assert_eq!(one.items[0].status, "approved");
        assert_eq!(one.items[0].created_at_ms, 304);
        assert!(status_for_paths(&root, "s", "absent", &paths)
            .unwrap()
            .items
            .is_empty());
        assert!(status_for_paths(&root, "absent", "alice", &paths)
            .unwrap()
            .items
            .is_empty());
        assert!(
            status_for_paths(&root, "s", "alice", &["/other/sample-204".into()])
                .unwrap()
                .items
                .is_empty()
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_windows_paths_keep_legacy_drive_unc_and_mixed_separator_aliases() {
        for (input, plain) in [
            (
                r"\\?\UNC\nas\Datasets\Delta-D1/old/sample",
                r"\\nas\Datasets\Delta-D1\old\sample",
            ),
            (r"\\?\C:\data\sample", r"C:\data\sample"),
            (r"C:/data/sample", r"C:\data\sample"),
        ] {
            assert_eq!(plain_path(input), plain);
            assert_eq!(plain_path(&verbatim_path(plain)), plain);
        }
        assert_eq!(plain_path("/data/Sample"), "/data/Sample");
    }
}
