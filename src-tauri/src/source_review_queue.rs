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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
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
    CREATE TABLE IF NOT EXISTS source_review_history(service TEXT NOT NULL, username TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(service,username,event_id));").map_err(failure)?;
    Ok(db)
}
fn owner_lock(root: &Path, service: &str, username: &str) -> AppResult<std::fs::File> {
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
fn path_aliases(root: &Path, path: &str) -> AppResult<[String; 5]> {
    let plain = plain_path(path);
    let historical = crate::dataset_layout::historical_cached(root, Path::new(&plain))?
        .to_string_lossy()
        .into_owned();
    Ok([
        path.into(),
        plain.clone(),
        verbatim_path(&plain),
        historical.clone(),
        verbatim_path(&historical),
    ])
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
    let sql=format!("SELECT payload FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (?,?,?,?,?) AND source_name=? ORDER BY CASE WHEN source_path=? THEN 0 ELSE 1 END LIMIT 1");
    let raw: Option<String> = db
        .query_row(
            &sql,
            params![
                service,
                username,
                paths[0],
                paths[1],
                paths[2],
                paths[3],
                paths[4],
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
pub fn contains_path(root: &Path, service: &str, username: &str, path: &str) -> AppResult<bool> {
    let paths = path_aliases(root, path)?;
    let collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    let sql=format!("SELECT EXISTS(SELECT 1 FROM source_reviews WHERE service=? AND username=? AND source_path COLLATE {collation} IN (?,?,?,?,?))");
    open(root)?
        .query_row(
            &sql,
            params![service, username, paths[0], paths[1], paths[2], paths[3], paths[4]],
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
    if old.is_none() && contains_path(root, service, username, &entry.request.source_path)? {
        return Err(failure(
            "该数据已有另一来源或批量待写结果，请先确认写回，原结果保留",
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
    tx.commit().map_err(failure)?;
    Ok(entry)
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
    view.pending_source_write = true;
    view.source_write_error = entry.error.clone();
    view
}
pub fn status(
    root: &Path,
    service: &str,
    username: &str,
    check_storage: bool,
) -> AppResult<PendingStatus> {
    let db = open(root)?;
    let pending = db
        .query_row(
            "SELECT count(*) FROM source_reviews WHERE service=? AND username=?",
            params![service, username],
            |row| row.get::<_, usize>(0),
        )
        .map_err(failure)?;
    let mut query=db.prepare("SELECT source_path,json_extract(payload,'$.request.status'),json_extract(payload,'$.error'),json_extract(payload,'$.createdAtMs') FROM source_reviews WHERE service=? AND username=? ORDER BY rowid LIMIT 200").map_err(failure)?;
    let rows = query
        .query_map(params![service, username], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })
        .map_err(failure)?;
    let mut items = vec![];
    for row in rows {
        let (path, status, error, created_at_ms) = row.map_err(failure)?;
        items.push(PendingItem {
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
        let result = (|| -> AppResult<()> {
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
                        "共享数据已有审核结论，未覆盖；本机待写结果已保留，请打开对应数据核对"
                            .into(),
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
            let mut audit = entry.audit.clone();
            audit["details"]["revision"] = json!(state.revision_label);
            // Commit the stable original event BEFORE removing the local result.
            review_outbox::enqueue(root, service, &user.username, &[audit])?;
            let db = open(root)?;
            db.execute("DELETE FROM source_reviews WHERE service=? AND username=? AND source_path=? AND source_name=? AND event_id=?",params![service,user.username,entry.request.source_path,entry.request.source_name.as_deref().unwrap_or(""),entry.audit["eventId"].as_str().unwrap_or("")]).map_err(failure)?;
            Ok(())
        })();
        match result {
            Ok(()) => written += 1,
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
