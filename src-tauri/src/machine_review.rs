use crate::error::{AppError, AppResult};
use crate::{machine_annotation, model::MachineAnnotation, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const OUTPUT: &str = "description.json";
pub const FLASH_OUTPUT: &str = "description.json";
const LEGACY_OUTPUT: &str = "bailian_annotation_reviewed.json";
const LEGACY_FLASH_OUTPUT: &str = "bailian_annotation.qwen3.8-flash_reviewed.json";
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSegment {
    pub source_index: usize,
    pub start_frame: u64,
    pub end_frame: u64,
    pub description: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default = "pending_status")]
    pub decision: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewState {
    #[serde(default)]
    pub reviewer_username: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery_warnings: Vec<String>,
    #[serde(default)]
    pub rejection_reason: String,
    #[serde(default)]
    pub change_summary: String,
    #[serde(default)]
    pub revision_label: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub workflow_version: u32,
    #[serde(default = "pending_status")]
    pub status: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub previous_version_id: String,
    pub source_hash: String,
    pub revision: u64,
    pub segments: Vec<ReviewSegment>,
    pub published: bool,
    pub output_hash: Option<String>,
    pub updated_at_ms: u64,
    pub reviewer: String,
}

// UI-only envelope: never persist a copied QC value into drafts or human JSON.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    #[serde(flatten)]
    pub review: ReviewState,
    pub output_name: String,
    pub qc_status: String,
    pub qc_rejection_reason: String,
    pub qc_status_error: String,
    pub pending_source_write: bool,
    pub source_write_error: String,
    pub qc_content_hash: Option<String>,
}

pub fn view_for_source(root: &Path, source: Option<&str>, review: ReviewState) -> ReviewView {
    if source == Some(machine_annotation::SKELETON_SOURCE) {
        return ReviewView {
            review,
            output_name: machine_annotation::SKELETON_SOURCE.into(),
            qc_status: String::new(),
            qc_rejection_reason: String::new(),
            qc_status_error: String::new(),
            pending_source_write: false,
            source_write_error: String::new(),
            qc_content_hash: None,
        };
    }
    view_for_root(root, review)
}

pub fn view_for_root(root: &Path, review: ReviewState) -> ReviewView {
    let mut qc_content_hash = None;
    let qc = (|| -> AppResult<(String, String)> {
        let root = crate::dataset_layout::resolve(root)?;
        let bytes = machine_annotation::read_bytes(&root.join("session.json"))?;
        qc_content_hash = bytes
            .as_ref()
            .map(|bytes| blake3::hash(bytes).to_hex().to_string());
        let session: Value = bytes
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        if !session.is_object() {
            return Err(failure("当前目录 session.json 不是对象，审核状态未知"));
        }
        match session.get("qc") {
            None | Some(Value::Null) => Ok(("pending".into(), String::new())),
            Some(Value::String(value)) => match value.trim() {
                "" | "待审核" | "未审核" => Ok(("pending".into(), String::new())),
                "通过" => Ok(("approved".into(), String::new())),
                "不通过" => Ok(("rejected".into(), String::new())),
                value if value.starts_with("不通过：") || value.starts_with("不通过:") => {
                    Ok((
                        "rejected".into(),
                        value.chars().skip(4).collect::<String>().trim().into(),
                    ))
                }
                _ => Err(failure("当前目录 QC 无法识别，审核状态未知")),
            },
            _ => Err(failure("当前目录 QC 无法识别，审核状态未知")),
        }
    })();
    let (qc_status, qc_rejection_reason, qc_status_error) = match qc {
        Ok((status, reason)) => (status, reason, String::new()),
        Err(error) => ("unknown".into(), String::new(), error.to_string()),
    };
    let output_name = if root.join(OUTPUT).exists() {
        OUTPUT
    } else if root.join("desorption.json").exists() {
        "desorption.json"
    } else {
        OUTPUT
    };
    ReviewView {
        output_name: output_name.into(),
        review,
        qc_status,
        qc_rejection_reason,
        qc_status_error,
        pending_source_write: false,
        source_write_error: String::new(),
        qc_content_hash,
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveReviewRequest {
    pub source_path: String,
    pub source_name: Option<String>,
    pub source_hash: String,
    pub expected_revision: u64,
    pub segments: Vec<ReviewSegment>,
    pub status: Option<String>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReview {
    #[serde(default)]
    pub source_path: String,
    pub username: String,
    pub reviewer_name: String,
    pub status: String,
    pub rejection_reason: String,
    pub revision: String,
    pub updated_at_ms: u64,
}

fn account_review_path(data_root: &Path, username: &str, root: &Path) -> PathBuf {
    let mut hasher = blake3::Hasher::new();
    hasher.update(username.as_bytes());
    hasher.update(&[0]);
    hasher.update(root.to_string_lossy().as_bytes());
    let key = hasher.finalize().to_hex();
    data_root
        .join("machine-review-accounts")
        .join(format!("{key}.json"))
}

fn read_account_review(path: &Path) -> AppResult<Option<AccountReview>> {
    machine_annotation::read_bytes(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
        .transpose()
}

pub fn list_account_reviews(
    data_root: &Path,
    paths: &[String],
    username: &str,
) -> AppResult<Vec<AccountReview>> {
    if paths.len() > 20_000 {
        return Err(failure("目录记录数量超过 20000"));
    }
    let mut records = Vec::new();
    for path in paths {
        let root = Path::new(path);
        let local_path = account_review_path(data_root, username, root);
        let local = read_account_review(&local_path)
            .ok()
            .flatten()
            .filter(|item| item.username == username);
        let shared = machine_annotation::read_bytes(&root.join("session.json"))
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("qcReviewers")
                    .and_then(|items| items.get(username))
                    .cloned()
            })
            .and_then(|value| serde_json::from_value::<AccountReview>(value).ok())
            .filter(|item| item.username == username);
        let record = match (local, shared) {
            (Some(local), Some(shared)) => Some(if shared.updated_at_ms >= local.updated_at_ms {
                shared
            } else {
                local
            }),
            (local, shared) => local.or(shared),
        };
        if let Some(mut record) = record
            .filter(|item| ["pending", "approved", "rejected"].contains(&item.status.as_str()))
        {
            record.source_path = path.clone();
            records.push(record);
        }
    }
    Ok(records)
}

fn pending_status() -> String {
    "pending".into()
}

fn failure(message: &str) -> AppError {
    AppError::Message(format!("MACHINE_REVIEW: {message}"))
}

#[cfg(test)]
fn source(root: &Path) -> AppResult<MachineAnnotation> {
    machine_annotation::load(root)?.ok_or_else(|| failure("未找到机标文件"))
}

fn human_source(annotation: &MachineAnnotation) -> bool {
    matches!(
        annotation.source_name.rsplit('/').next(),
        Some("description.json" | "desorption.json")
    )
}

fn output_name(annotation: &MachineAnnotation, root: &Path) -> &'static str {
    if annotation.source_name == machine_annotation::SKELETON_SOURCE {
        return machine_annotation::SKELETON_SOURCE;
    }
    if annotation.source_name.rsplit('/').next() == Some("desorption.json")
        || (!root.join(OUTPUT).exists() && root.join("desorption.json").exists())
    {
        "desorption.json"
    } else {
        OUTPUT
    }
}

fn selected_draft_path(data_root: &Path, root: &Path, annotation: &MachineAnnotation) -> PathBuf {
    let select = |root: &Path| {
        let path = draft_path(data_root, root);
        if annotation.source_name == machine_annotation::FLASH_SOURCE {
            path.with_extension("qwen3.8-flash.json")
        } else if annotation.source_name == machine_annotation::DEFAULT_SOURCE {
            path
        } else {
            path.with_extension(format!(
                "{}.json",
                blake3::hash(annotation.source_name.as_bytes()).to_hex()
            ))
        }
    };
    let current = select(root);
    if current.exists() || current.with_extension("pending.json").exists() {
        return current;
    }
    if let Ok(paths) = crate::dataset_layout::historical_paths_for(root) {
        for old_root in paths {
            let old = select(&old_root);
            if old.exists() || old.with_extension("pending.json").exists() {
                return old;
            }
        }
    }
    current
}

fn draft_path(data_root: &Path, root: &Path) -> PathBuf {
    let key = blake3::hash(root.to_string_lossy().as_bytes()).to_hex();
    data_root
        .join("machine-reviews")
        .join(format!("{key}.json"))
}

fn initial(annotation: &MachineAnnotation) -> ReviewState {
    ReviewState {
        recovery_warnings: Vec::new(),
        rejection_reason: String::new(),
        change_summary: String::new(),
        revision_label: String::new(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        workflow_version: 2,
        status: pending_status(),
        version_id: String::new(),
        previous_version_id: String::new(),
        source_hash: annotation.source_hash.clone(),
        revision: 0,
        segments: annotation
            .segments
            .iter()
            .map(|segment| ReviewSegment {
                source_index: segment.source_index,
                start_frame: segment.start_frame,
                end_frame: segment.end_frame,
                description: segment.description.clone(),
                deleted: false,
                decision: "pending".into(),
            })
            .collect(),
        published: false,
        output_hash: None,
        updated_at_ms: 0,
        reviewer: String::new(),
        reviewer_username: String::new(),
    }
}

fn load_inner(
    data_root: &Path,
    root: &Path,
    annotation: &MachineAnnotation,
) -> AppResult<ReviewState> {
    match load_inner_checked(data_root, root, annotation) {
        Ok(mut state) => {
            if human_source(annotation)
                || annotation.source_name == machine_annotation::SKELETON_SOURCE
            {
                state.source_hash = annotation.source_hash.clone();
            }
            if state.output_hash.is_none() {
                state.published = false;
            } else if annotation.source_name == machine_annotation::SKELETON_SOURCE {
                state.published = true;
            }
            Ok(state)
        }
        Err(error) if annotation.source_name == machine_annotation::SKELETON_SOURCE => Err(error),
        Err(error)
            if matches!(&error, AppError::Json(_))
                || matches!(&error, AppError::Message(message) if message.starts_with("MACHINE_ANNOTATION_INVALID:")) =>
        {
            // An unreadable old human/draft file must not hide a readable model.
            // Preserve exact bytes first; permission/IO errors still propagate.
            let draft = selected_draft_path(data_root, root, annotation);
            let mut backups = Vec::new();
            for path in [
                draft.clone(),
                draft.with_extension("pending.json"),
                root.join(output_name(annotation, root)),
                root.join(
                    if annotation.source_name == machine_annotation::FLASH_SOURCE {
                        LEGACY_FLASH_OUTPUT
                    } else {
                        LEGACY_OUTPUT
                    },
                ),
            ] {
                if let Some(bytes) = machine_annotation::read_bytes(&path)? {
                    backups.push(preserve_recovery_bytes(data_root, &bytes)?);
                }
            }
            let mut state = initial(annotation);
            state.output_hash =
                machine_annotation::read_bytes(&root.join(output_name(annotation, root)))?
                    .map(|bytes| blake3::hash(&bytes).to_hex().to_string());
            state.recovery_warnings = vec![format!(
                "旧人工记录或本机草稿无法解析，已保留原字节并载入机标片段；原因：{error}。本机备份：{}。请核对后保存，加载未改写人工结果或 QC。",
                backups.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("；")
            )];
            Ok(state)
        }
        Err(error) => Err(error),
    }
}

fn load_inner_checked(
    data_root: &Path,
    root: &Path,
    annotation: &MachineAnnotation,
) -> AppResult<ReviewState> {
    let draft_path = selected_draft_path(data_root, root, annotation);
    let draft = machine_annotation::read_bytes(&draft_path)?
        .map(|bytes| serde_json::from_slice::<ReviewState>(&bytes))
        .transpose()?;
    let had_draft = draft.is_some();
    let local_revision = draft.as_ref().map_or(0, |state| state.revision);
    let output = match machine_annotation::read_bytes(&root.join(output_name(annotation, root)))? {
        Some(bytes) => Some(bytes),
        None if annotation.source_name == machine_annotation::SKELETON_SOURCE => None,
        None => machine_annotation::read_bytes(&root.join(
            if annotation.source_name == machine_annotation::FLASH_SOURCE {
                LEGACY_FLASH_OUTPUT
            } else {
                LEGACY_OUTPUT
            },
        ))?,
    };
    let output_hash = output
        .as_ref()
        .map(|bytes| blake3::hash(bytes).to_hex().to_string());
    // A committed NAS write can outlive a failed local draft update.
    if let Some(bytes) = machine_annotation::read_bytes(&draft_path.with_extension("pending.json"))?
    {
        let pending: ReviewState = serde_json::from_slice(&bytes)?;
        if pending.output_hash.is_some()
            && pending.output_hash == output_hash
            && draft
                .as_ref()
                .is_none_or(|old| old.revision < pending.revision)
        {
            return recover_loaded_state(data_root, root, annotation, pending);
        }
    }
    if let Some(draft) = draft {
        if draft.output_hash == output_hash {
            return recover_loaded_state(data_root, root, annotation, draft);
        }
        // The shared human description is authoritative after another host saves.
        // Keep the local draft on disk until the next successful save.
        if output.is_none() {
            let mut retained = draft;
            retained.output_hash = None;
            retained.published = false;
            return recover_loaded_state(data_root, root, annotation, retained);
        }
    }
    if let Some(bytes) = output {
        let document: Value = serde_json::from_slice(&bytes)?;
        let technical = technical_review(
            &root.join(output_name(annotation, root)),
            output_hash.as_deref().unwrap_or_default(),
        )?;
        let mut review_value = technical
            .map(serde_json::to_value)
            .transpose()?
            .or_else(|| document.get("_human_review").cloned());
        // Compact metadata (or an externally edited result) is reconstructed from
        // the actual annotations, never from a sidecar for different bytes.
        if review_value
            .as_ref()
            .is_some_and(|v| v.get("segments").is_none())
        {
            let public = review_value
                .take()
                .ok_or_else(|| failure("人工审核信息缺失"))?;
            let status = public["status"].as_str().unwrap_or("pending");
            if !matches!(status, "pending" | "approved" | "rejected") {
                // Use the existing read-only recovery path for unknown legacy states.
                let _: ReviewState = serde_json::from_value(public)?;
                return Err(failure("人工审核状态未知，原文件已保留"));
            }
            let human =
                machine_annotation::parse_human_in_directory(&bytes, &annotation.episode_id, root)?;
            let mut state = initial(&human);
            state.workflow_version = 4;
            state.published = true;
            state.revision = local_revision;
            state.status = status.into();
            state.reviewer = public["reviewer"].as_str().unwrap_or_default().into();
            state.updated_at_ms = public["reviewedAt"]
                .as_str()
                .and_then(|s| {
                    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .map_or(0, |date| {
                    (date.unix_timestamp_nanos() / 1_000_000).max(0) as u64
                });
            for segment in &mut state.segments {
                segment.decision = state.status.clone();
            }
            state.output_hash = output_hash;
            return recover_loaded_state(data_root, root, annotation, state);
        }
        let Some(mut review_value) = review_value else {
            if had_draft && document.get("episode_results").is_none() {
                return Err(failure(
                    "description.json 不是可识别的人工标注，原文件已保留",
                ));
            }
            let mut state = if document.get("episode_results").is_some() {
                initial(&machine_annotation::parse_human_in_directory(
                    &bytes,
                    &annotation.episode_id,
                    root,
                )?)
            } else {
                initial(annotation)
            };
            state.output_hash = output_hash;
            return Ok(state);
        };
        if review_value["workflowVersion"].as_u64().unwrap_or(0) >= 4
            && review_value.get("reviewRevision").is_some()
        {
            let sequence = review_value
                .as_object_mut()
                .and_then(|fields| fields.remove("reviewRevision"))
                .ok_or_else(|| failure("审核记录缺少修订序号"))?;
            review_value["revisionLabel"] = review_value["revision"].clone();
            review_value["revision"] = sequence;
        }
        let mut state: ReviewState = serde_json::from_value(review_value)?;
        for item in &mut state.segments {
            if !item.deleted {
                item.decision = state.status.clone();
            }
        }
        state.output_hash = output_hash;
        // Re-read the actual human annotations as well as the review metadata.
        // This includes edits made directly to description.json outside Viewer.
        if document.get("episode_results").is_some() {
            let human =
                machine_annotation::parse_human_in_directory(&bytes, &annotation.episode_id, root)?;
            let mut retained: Vec<_> = state
                .segments
                .iter()
                .filter(|item| !item.deleted)
                .cloned()
                .collect();
            retained.sort_by_key(|item| item.source_index);
            let mut used = BTreeSet::new();
            let mut next_index = state
                .segments
                .iter()
                .map(|item| item.source_index)
                .max()
                .map_or(0, |index| index + 1);
            let mut actual = Vec::new();
            for item in human.segments {
                let old = retained
                    .iter()
                    .find(|old| {
                        !used.contains(&old.source_index)
                            && old.start_frame == item.start_frame
                            && old.end_frame == item.end_frame
                    })
                    .or_else(|| {
                        retained
                            .get(item.source_index)
                            .filter(|old| !used.contains(&old.source_index))
                    });
                let source_index = old.map_or_else(
                    || {
                        let index = next_index;
                        next_index += 1;
                        index
                    },
                    |old| old.source_index,
                );
                used.insert(source_index);
                let description = if old.is_some_and(|old| old.description.is_empty())
                    && annotation.source_hash == state.source_hash
                    && !item
                        .description
                        .chars()
                        .any(|c| ('\u{3400}'..='\u{9fff}').contains(&c))
                {
                    let reference = machine_annotation::parse_review_reference(
                        annotation.source_json.as_bytes(),
                        &annotation.episode_id,
                    )?;
                    if reference.segments.iter().any(|original| {
                        original.source_index == source_index
                            && original.description == item.description
                    }) {
                        String::new()
                    } else {
                        item.description
                    }
                } else {
                    item.description
                };
                actual.push(ReviewSegment {
                    source_index,
                    start_frame: item.start_frame,
                    end_frame: item.end_frame,
                    description,
                    deleted: false,
                    decision: state.status.clone(),
                });
            }
            if annotation.source_name == machine_annotation::SKELETON_SOURCE {
                actual.extend(state.segments.iter().filter(|s| s.deleted).cloned());
                actual.sort_by_key(|s| s.source_index);
            }
            state.segments = actual;
        }
        if state.workflow_version >= 3 && state.source_hash == annotation.source_hash {
            // Published reviews contain only retained segments. Reconstruct local
            // deletion markers from the immutable source when opened on a new host.
            let present: BTreeSet<_> = state
                .segments
                .iter()
                .map(|item| item.source_index)
                .collect();
            state
                .segments
                .extend(
                    initial(annotation)
                        .segments
                        .into_iter()
                        .filter_map(|mut item| {
                            if present.contains(&item.source_index) {
                                return None;
                            }
                            item.deleted = true;
                            Some(item)
                        }),
                );
            state.segments.sort_by_key(|item| item.source_index);
        }
        return recover_loaded_state(data_root, root, annotation, state);
    }
    Ok(initial(annotation))
}

#[cfg(test)]
pub fn load(data_root: &Path, root: &Path) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    load_inner(data_root, &root, &source(&root)?)
}

pub fn load_selected(
    data_root: &Path,
    root: &Path,
    source_name: Option<&str>,
) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    let annotation = machine_annotation::load_for_review(&root, source_name)?
        .ok_or_else(|| failure("未找到机标文件"))?;
    let state = load_inner(data_root, &root, &annotation)?;
    if annotation.source_name == machine_annotation::SKELETON_SOURCE {
        // Remember the exact shared baseline read by this editor even on a new
        // host or after sidecar loss; a later external edit must not be overwritten.
        let draft = selected_draft_path(data_root, &root, &annotation);
        fs::create_dir_all(
            draft
                .parent()
                .ok_or_else(|| failure("骨架描述草稿目录无效"))?,
        )?;
        let _draft_lock = lock_file(&draft.with_extension("lock"))?;
        atomic_json(&draft, &serde_json::to_value(&state)?)?;
    }
    Ok(state)
}

// Legacy/local state can outlive a directory rename or a replacement model.
// Preserve the full input before repairing technical indices/status. Never clamp
// a human time range to make it look valid, and never write source files on load.
fn recover_loaded_state(
    data_root: &Path,
    root: &Path,
    annotation: &MachineAnnotation,
    mut state: ReviewState,
) -> AppResult<ReviewState> {
    let validation = if ["pending", "approved", "rejected"].contains(&state.status.as_str()) {
        validate(annotation, &state.segments)
    } else {
        Err(failure("旧记录的整体审核状态无效"))
    };
    let Err(error) = validation else {
        return Ok(state);
    };
    let backup = preserve_recovery_bytes(data_root, &serde_json::to_vec(&state)?)?;
    let draft = selected_draft_path(data_root, root, annotation);
    for path in [
        draft.clone(),
        draft.with_extension("pending.json"),
        root.join(output_name(annotation, root)),
    ] {
        if let Some(bytes) = machine_annotation::read_bytes(&path)? {
            preserve_recovery_bytes(data_root, &bytes)?;
        }
    }
    let mut reserved: BTreeSet<_> = state
        .segments
        .iter()
        .map(|item| item.source_index)
        .collect();
    let mut used = BTreeSet::new();
    let mut next_index = annotation.segments.len();
    for item in &mut state.segments {
        if !used.insert(item.source_index) {
            while reserved.contains(&next_index) {
                next_index += 1;
            }
            item.source_index = next_index;
            used.insert(next_index);
            reserved.insert(next_index);
            next_index += 1;
        }
        if !["pending", "approved", "rejected"].contains(&item.decision.as_str()) {
            item.decision = pending_status();
        }
    }
    let repair = if validate(annotation, &state.segments).is_ok() {
        "已修复旧记录重复索引或不兼容状态，保留动作描述与帧边界"
    } else {
        // Invalid human ranges are kept in the recovery snapshot, not silently
        // rescaled, truncated, or submitted as a completed human result.
        state.segments = initial(annotation).segments;
        "旧人工片段范围与当前机标不兼容，已重新载入机标片段；原人工内容保存在本机恢复备份中"
    };
    state.status = pending_status();
    for item in &mut state.segments {
        item.decision = pending_status();
    }
    state.rejection_reason.clear();
    state.recovery_warnings = vec![format!("{repair}。原因：{error}。恢复备份：{}；请核对后再保存。加载过程未改写共享目录中的人工结果。", backup.display())];
    Ok(state)
}

fn preserve_recovery_bytes(data_root: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(failure("恢复记录超过 8 MiB"));
    }
    let directory = data_root.join("machine-review-recovery");
    fs::create_dir_all(&directory)?;
    let hash = blake3::hash(bytes).to_hex().to_string();
    let destination = directory.join(format!("{hash}.json"));
    if let Some(existing) = machine_annotation::read_bytes(&destination)? {
        if existing != bytes {
            return Err(failure("恢复备份校验失败，原记录未修改"));
        }
        return Ok(destination);
    }
    let partial = directory.join(format!(
        ".{hash}.partial-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if machine_annotation::read_bytes(&partial)?.as_deref() != Some(bytes) {
            return Err(failure("恢复备份回读失败，原记录未修改"));
        }
        storage::publish_noreplace(&partial, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(destination)
}

fn validate(annotation: &MachineAnnotation, edits: &[ReviewSegment]) -> AppResult<()> {
    if edits.len() > 2000 {
        return Err(failure("片段数量超过 2000"));
    }
    let mut seen = BTreeSet::new();
    for (position, edit) in edits.iter().enumerate() {
        let problem = if !seen.insert(edit.source_index) {
            Some(format!("原始索引 {} 重复", edit.source_index))
        } else if edit.start_frame > edit.end_frame || edit.end_frame >= annotation.frame_count {
            Some(format!(
                "帧范围 [{}, {}] 无效，允许范围为 [0, {}]",
                edit.start_frame,
                edit.end_frame,
                annotation.frame_count.saturating_sub(1)
            ))
        } else if edit.description.len() > 16_384 {
            Some("动作描述超过 16384 字节".into())
        } else if !["pending", "approved", "rejected"].contains(&edit.decision.as_str()) {
            Some(format!(
                "审核状态 {} 无效",
                serde_json::to_string(&edit.decision.chars().take(60).collect::<String>())?
            ))
        } else {
            None
        };
        if let Some(problem) = problem {
            return Err(failure(&format!(
                "第 {} 个片段（索引 {}）：{problem}；原记录未覆盖",
                position + 1,
                edit.source_index
            )));
        }
    }
    Ok(())
}

// Patch a clone of the source document. Unknown model fields and untouched
// records survive, including fields on the mirrored segments array.
fn reviewed_document(annotation: &MachineAnnotation, state: &ReviewState) -> AppResult<Value> {
    let mut document: Value =
        serde_json::from_str(annotation.source_json.trim_start_matches('\u{feff}'))?;
    let episodes = document["episode_results"]
        .as_array_mut()
        .ok_or_else(|| failure("机标结构无效"))?;
    let episode = episodes
        .iter_mut()
        .find(|entry| entry["episode_id"].as_str() == Some(&annotation.episode_id))
        .ok_or_else(|| failure("机标记录不存在"))?;
    if annotation.timeline_warning.is_some() {
        episode["media"]["frame_count"] = json!(annotation.frame_count);
    }
    let base = episode["media"]["frame_index_base"].as_u64().unwrap_or(0);
    let exclusive = episode["media"]["interval_convention"].as_str() != Some("[start,end]");
    let edits: BTreeMap<_, _> = state
        .segments
        .iter()
        .map(|item| (item.source_index, item))
        .collect();
    let originals = episode["annotations"]
        .as_array()
        .ok_or_else(|| failure("机标片段不存在"))?
        .clone();
    let mut patched = Vec::new();
    let mut mirrors: BTreeMap<String, &ReviewSegment> = BTreeMap::new();
    for (index, mut value) in originals.iter().cloned().enumerate() {
        let raw_start = value["start_frame"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(base);
        let raw_end = value["end_frame"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(base + u64::from(exclusive));
        let source_index = annotation
            .segments
            .iter()
            .find(|item| item.start_frame == raw_start && item.end_frame == raw_end)
            .map(|item| item.source_index)
            .unwrap_or(index);
        let Some(edit) = edits.get(&source_index) else {
            continue;
        };
        for key in ["segment_id", "id"] {
            if let Some(id) = value[key].as_str() {
                if mirrors
                    .insert(id.into(), edit)
                    .is_some_and(|other| other.source_index != source_index)
                {
                    return Err(failure("机标关联 ID 重复，无法安全修改"));
                }
            }
        }
        if edit.deleted {
            continue;
        }
        let original = annotation
            .segments
            .iter()
            .find(|item| item.source_index == source_index)
            .ok_or_else(|| failure("片段索引无效"))?;
        if edit.start_frame != original.start_frame {
            value["start_frame"] = json!(edit.start_frame + base);
        }
        if edit.end_frame != original.end_frame || value["end_frame"].is_null() {
            value["end_frame"] = json!(edit.end_frame + base + u64::from(exclusive));
        }
        if edit.description != original.description {
            machine_annotation::patch_description(&mut value, &edit.description)?;
        }
        patched.push(value);
    }
    let mut added = Vec::new();
    for edit in state
        .segments
        .iter()
        .filter(|item| item.source_index >= originals.len() && !item.deleted)
    {
        // A split retains the model attributes of the original containing range.
        let template = annotation
            .segments
            .iter()
            .find(|item| item.start_frame <= edit.start_frame && item.end_frame >= edit.end_frame);
        let mut value = template
            .map(|item| originals[item.source_index].clone())
            .unwrap_or_else(|| json!({"label_code":"viewer"}));
        value["segment_id"] = json!(format!("viewer-{}", edit.source_index));
        if value.get("id").is_some() {
            value["id"] = value["segment_id"].clone();
        }
        value["start_frame"] = json!(edit.start_frame + base);
        value["end_frame"] = json!(edit.end_frame + base + u64::from(exclusive));
        machine_annotation::patch_description(&mut value, &edit.description)?;
        added.push(value.clone());
        patched.push(value);
    }
    if let Some(segments) = episode.get_mut("segments").and_then(Value::as_array_mut) {
        let mut updated = Vec::new();
        for mut value in segments.iter().cloned() {
            let linked = ["segment_id", "annotation_id"]
                .iter()
                .find_map(|key| value[*key].as_str().and_then(|id| mirrors.get(id)))
                .copied();
            let matching: Vec<_> = originals
                .iter()
                .enumerate()
                .filter(|(_, original)| {
                    ["start_frame", "end_frame", "label_code"]
                        .iter()
                        .all(|key| value[*key] == original[*key])
                })
                .collect();
            let edit = linked.or_else(|| {
                (matching.len() == 1).then(|| {
                    let index = matching[0].0;
                    let source_index = annotation
                        .segments
                        .iter()
                        .find(|item| {
                            item.start_frame
                                == value["start_frame"]
                                    .as_u64()
                                    .unwrap_or(0)
                                    .saturating_sub(base)
                                && item.end_frame
                                    == value["end_frame"]
                                        .as_u64()
                                        .unwrap_or(0)
                                        .saturating_sub(base + u64::from(exclusive))
                        })
                        .map(|item| item.source_index)
                        .unwrap_or(index);
                    edits[&source_index]
                })
            });
            if let Some(edit) = edit {
                if edit.deleted {
                    continue;
                }
                let original = annotation
                    .segments
                    .iter()
                    .find(|item| item.source_index == edit.source_index);
                if original.is_some_and(|item| item.start_frame != edit.start_frame) {
                    value["start_frame"] = json!(edit.start_frame + base);
                }
                if original.is_some_and(|item| item.end_frame != edit.end_frame)
                    || value["end_frame"].is_null()
                {
                    value["end_frame"] = json!(edit.end_frame + base + u64::from(exclusive));
                }
                if original.is_some_and(|item| item.description != edit.description)
                    && (value.get("attributes").is_some() || value.get("attributes_zh").is_some())
                {
                    machine_annotation::patch_description(&mut value, &edit.description)?;
                }
            } else if matching.iter().any(|(index, _)| {
                let edit = edits[index];
                let old = annotation
                    .segments
                    .iter()
                    .find(|item| item.source_index == *index)
                    .unwrap();
                edit.deleted
                    || edit.start_frame != old.start_frame
                    || edit.end_frame != old.end_frame
            }) {
                return Err(failure("机标关联片段存在歧义，无法安全修改"));
            }
            updated.push(value);
        }
        updated.extend(added);
        *segments = updated;
    }
    if patched.len() != annotation.segments.len() && episode.get("annotation_count").is_some() {
        episode["annotation_count"] = json!(patched.len());
    }
    episode["annotations"] = Value::Array(patched);
    document
        .as_object_mut()
        .ok_or_else(|| failure("人工结果必须是对象"))?
        .remove("_text_correction");
    document["_human_review"] = public_review(state)?;
    Ok(document)
}

// When model identities change, write the human snapshot independently of them.
fn human_document(
    annotation: &MachineAnnotation,
    state: &ReviewState,
    root: &Path,
) -> AppResult<Value> {
    let mut document: Value =
        machine_annotation::read_bytes(&root.join(output_name(annotation, root)))?
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()?
            .unwrap_or(serde_json::from_str(&annotation.source_json)?);
    if document.get("episode_results").is_none() {
        document = serde_json::from_str(&annotation.source_json)?;
    }
    let selected_id = if document["episode_results"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["episode_id"].as_str() == Some(&annotation.episode_id))
    }) {
        annotation.episode_id.clone()
    } else {
        machine_annotation::parse_human_in_directory(
            &serde_json::to_vec(&document)?,
            &annotation.episode_id,
            root,
        )?
        .episode_id
    };
    let episode = document["episode_results"]
        .as_array_mut()
        .and_then(|items| {
            items
                .iter_mut()
                .find(|item| item["episode_id"].as_str() == Some(&selected_id))
        })
        .ok_or_else(|| failure("人工 description 中未找到当前记录"))?;
    if annotation.timeline_warning.is_some() {
        episode["media"]["frame_count"] = json!(annotation.frame_count);
    }
    let base = episode["media"]["frame_index_base"].as_u64().unwrap_or(0);
    let exclusive = episode["media"]["interval_convention"].as_str() != Some("[start,end]");
    let mut rows = Vec::new();
    let mut visible: Vec<_> = state.segments.iter().filter(|item| !item.deleted).collect();
    visible.sort_by_key(|item| item.source_index);
    for item in visible {
        let mut row = json!({"segment_id":format!("viewer-{}",item.source_index),
            "label_code":"viewer", "start_frame":item.start_frame + base,
            "end_frame":item.end_frame + base + u64::from(exclusive)});
        machine_annotation::patch_description(&mut row, &item.description)?;
        rows.push(row);
    }
    episode["annotation_count"] = json!(rows.len());
    episode["annotations"] = json!(rows);
    if episode.get("segments").is_some() {
        episode["segments"] = json!(rows);
    }
    document
        .as_object_mut()
        .ok_or_else(|| failure("人工结果必须是对象"))?
        .remove("_text_correction");
    document["_human_review"] = public_review(state)?;
    Ok(document)
}

// The human result is a data deliverable. Recovery/CAS state is app metadata.
fn public_review(state: &ReviewState) -> AppResult<Value> {
    let date = time::OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(state.updated_at_ms) * 1_000_000,
    )
    .map_err(|_| failure("审核时间无效"))?
    .format(&time::format_description::well_known::Rfc3339)
    .map_err(|_| failure("审核时间格式无效"))?;
    Ok(
        json!({"status":state.status,"reviewer":if state.status == "pending" { "" } else { &state.reviewer },
        "reviewedAt":if state.status == "pending" { "" } else { &date }}),
    )
}

pub(crate) fn technical_path(output: &Path) -> PathBuf {
    output.with_file_name(format!(
        ".{}.review-state.json",
        output.file_stem().unwrap_or_default().to_string_lossy()
    ))
}

fn technical_review(output: &Path, content_hash: &str) -> AppResult<Option<ReviewState>> {
    let Some(bytes) = machine_annotation::read_bytes(&technical_path(output))? else {
        return Ok(None);
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    if record["schemaVersion"] != 1
        || record["contentHash"].as_str() != Some(content_hash)
        || record["outputName"].as_str() != output.file_name().and_then(|s| s.to_str())
    {
        return Ok(None);
    }
    record
        .get("review")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}

fn write_technical(output: &Path, content_hash: &str, state: &ReviewState) -> AppResult<()> {
    let path = technical_path(output);
    // Validate an existing reserved file before replacing it.
    if let Some(bytes) = machine_annotation::read_bytes(&path)? {
        let old: Value = serde_json::from_slice(&bytes)?;
        if old["schemaVersion"] != 1 {
            return Err(failure("技术记录格式未知，未覆盖；请保留文件后联系管理员"));
        }
    }
    atomic_json(
        &path,
        &json!({"schemaVersion":1,"outputName":output.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
        "contentHash":content_hash,"review":state}),
    )?;
    Ok(())
}

pub(crate) fn correction_technical(
    output: &Path,
    before: &str,
    document: &Value,
    correction: Value,
) -> AppResult<()> {
    let after = blake3::hash(&serde_json::to_vec_pretty(document)?)
        .to_hex()
        .to_string();
    let mut record = json!({"schemaVersion":1,"outputName":output.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
        "contentHash":after,"correction":correction});
    if let Some(mut review) = technical_review(output, before)? {
        review.revision = review
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("修订计数超限"))?;
        review.output_hash = Some(after);
        if document["_human_review"]["status"] == "pending" {
            review.status = "pending".into();
            review.reviewer.clear();
            review.reviewer_username.clear();
            review.rejection_reason.clear();
        }
        record["review"] = serde_json::to_value(review)?;
    }
    atomic_json(&technical_path(output), &record)?;
    Ok(())
}

fn has_correction(output: &Path, content_hash: Option<&str>) -> AppResult<bool> {
    let Some(bytes) = machine_annotation::read_bytes(&technical_path(output))? else {
        return Ok(false);
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    Ok(record["schemaVersion"] == 1
        && record["contentHash"].as_str() == content_hash
        && record.get("correction").is_some())
}

pub(crate) fn atomic_json(path: &Path, document: &Value) -> AppResult<String> {
    let bytes = serde_json::to_vec_pretty(document)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(failure("复核文件超过 8 MiB"));
    }
    let partial = path.with_file_name(format!(
        ".{}.partial-{}-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if machine_annotation::read_bytes(&partial)?.as_deref() != Some(bytes.as_slice()) {
            return Err(failure("复核文件回读失败"));
        }
        storage::replace_file_atomic(&partial, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result.map_err(|error| match error {
        AppError::Io(error) => review_write_error(path, error),
        error => error,
    })?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn review_write_error(path: &Path, error: std::io::Error) -> AppError {
    let (code, advice) = match error.kind() {
        std::io::ErrorKind::StorageFull => (
            "REVIEW_STORAGE_FULL",
            "保存目标磁盘/NAS 空间不足，请释放空间或扩容后重试",
        ),
        std::io::ErrorKind::PermissionDenied => (
            "REVIEW_STORAGE_PERMISSION_DENIED",
            "保存目标拒绝写入，请检查共享目录写权限后重试",
        ),
        std::io::ErrorKind::TimedOut => (
            "REVIEW_STORAGE_TIMEOUT",
            "保存目标写入超时，请检查 NAS 负载及共享目录连接后重试",
        ),
        _ => (
            "REVIEW_STORAGE_WRITE_FAILED",
            "保存目标 I/O 失败，具体原因请见系统信息；请检查存储状态后重试",
        ),
    };
    AppError::Message(format!(
        "{code}: {advice}。位置：{}。系统信息：{error}。未确认审核保存成功，请勿当作已提交。",
        path.display()
    ))
}

#[cfg(test)]
pub fn save(
    data_root: &Path,
    request: SaveReviewRequest,
    reviewer: &str,
) -> AppResult<ReviewState> {
    save_for_user(data_root, request, reviewer, reviewer)
}

pub fn save_for_user(
    data_root: &Path,
    request: SaveReviewRequest,
    reviewer: &str,
    username: &str,
) -> AppResult<ReviewState> {
    save_for_user_mode(data_root, request, reviewer, username, None, None)
}

pub fn save_with_event_for_user(
    data_root: &Path,
    request: SaveReviewRequest,
    reviewer: &str,
    username: &str,
    event: Option<(String, u64)>,
) -> AppResult<ReviewState> {
    if let Some((id, time)) = &event {
        if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || *time == 0 {
            return Err(failure("审核提交标识或时间无效"));
        }
    }
    if event.is_none() {
        return save_for_user(data_root, request, reviewer, username);
    }
    save_for_user_mode(data_root, request, reviewer, username, None, event)
}

fn pending_qc(root: &Path) -> AppResult<bool> {
    let root = crate::dataset_layout::resolve(root)?;
    let session: Value = machine_annotation::read_bytes(&root.join("session.json"))?
        .map(|bytes| serde_json::from_slice(&bytes))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    if !session.is_object() {
        return Err(failure("session.json 不是对象"));
    }
    match session.get("qc") {
        None | Some(Value::Null) => Ok(true),
        Some(Value::String(qc)) => match qc.trim() {
            "" | "待审核" | "未审核" => Ok(true),
            "通过" | "不通过" => Ok(false),
            value if value.starts_with("不通过：") || value.starts_with("不通过:") => {
                Ok(false)
            }
            _ => Err(failure("QC 结果无法识别，未修改")),
        },
        _ => Err(failure("QC 结果无法识别，未修改")),
    }
}

pub fn reject_pending_for_user(
    data_root: &Path,
    root: &Path,
    reason: &str,
    reviewer: &str,
    username: &str,
) -> AppResult<Option<ReviewState>> {
    reject_pending_mode(data_root, root, reason, reviewer, username, None)
}

pub fn reject_pending_deferred(
    data_root: &Path,
    root: &Path,
    reason: &str,
    reviewer: &str,
    username: &str,
    deferred: (String, u64),
) -> AppResult<Option<ReviewState>> {
    let session: Value = machine_annotation::read_bytes(&root.join("session.json"))?
        .map(|bytes| serde_json::from_slice(&bytes))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let expected = deferred.0.replace('-', "");
    if session["revision"]
        .as_str()
        .is_some_and(|label| label.split(" · ").next() == Some(expected.as_str()))
        && session["reviewerUsername"] == username
        && session["qc"] == format!("不通过：{reason}")
    {
        return Ok(Some(serde_json::from_value(
            json!({"sourceHash":"", "revision":0,"segments":[],"published":true,"outputHash":null,"updatedAtMs":deferred.1,"reviewer":reviewer,"reviewerUsername":username,"status":"rejected","rejectionReason":reason,"versionId":expected,"revisionLabel":session["revision"]}),
        )?));
    }
    reject_pending_mode(data_root, root, reason, reviewer, username, Some(deferred))
}

fn reject_pending_mode(
    data_root: &Path,
    root: &Path,
    reason: &str,
    reviewer: &str,
    username: &str,
    deferred: Option<(String, u64)>,
) -> AppResult<Option<ReviewState>> {
    let reason = validated_rejection_reason("rejected", Some(reason))?;
    if !pending_qc(root)? {
        return Ok(None);
    }
    // An unreadable annotation or capture can still receive a QC-only rejection.
    let annotation = machine_annotation::load_for_review(root, None).unwrap_or(None);
    let Some(annotation) = annotation else {
        return reject_pending_without_media(root, &reason, reviewer, username, deferred);
    };
    let current = match load_selected(data_root, root, Some(&annotation.source_name)) {
        Ok(current) => current,
        Err(_) => return reject_pending_without_media(root, &reason, reviewer, username, deferred),
    };
    let own_partial = deferred.as_ref().is_some_and(|(id, _)| {
        current.version_id == id.replace('-', "")
            && current.reviewer_username == username
            && current.status == "rejected"
            && current.rejection_reason == reason
    });
    if current.output_hash.is_some() && current.status != "pending" && !own_partial {
        return Ok(None);
    }
    let snapshot = PendingReviewSnapshot {
        output_hash: current.output_hash.clone(),
        only_pending: true,
        qc_content_hash: None,
        deferred,
    };
    let result = save_for_user_mode(
        data_root,
        SaveReviewRequest {
            source_path: root.to_string_lossy().into(),
            source_name: Some(annotation.source_name),
            source_hash: annotation.source_hash,
            expected_revision: current.revision,
            segments: current.segments,
            status: Some("rejected".into()),
            rejection_reason: Some(reason),
        },
        reviewer,
        username,
        Some(snapshot),
        None,
    );
    match result {
        Err(AppError::Message(message)) if message == "BATCH_REVIEW_SKIPPED" => Ok(None),
        result => result.map(Some),
    }
}

// A rejected QC decision does not need a playable frame or an annotation
// document. Keep the decision auditable so a broken capture cannot remain
// permanently in the pending count.
fn reject_pending_without_media(
    root: &Path,
    reason: &str,
    reviewer: &str,
    username: &str,
    deferred: Option<(String, u64)>,
) -> AppResult<Option<ReviewState>> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    let write_root = storage::review_write_root(&root)?;
    let _output_lock = lock_file(&write_root.join(".description.lock"))?;
    if !pending_qc(&write_root)? {
        return Ok(None);
    }
    for name in [
        OUTPUT,
        "desorption.json",
        LEGACY_OUTPUT,
        LEGACY_FLASH_OUTPUT,
    ] {
        if let Some(bytes) = machine_annotation::read_bytes(&write_root.join(name))? {
            if let Ok(document) = serde_json::from_slice::<Value>(&bytes) {
                if matches!(
                    document["_human_review"]["status"].as_str(),
                    Some("approved" | "rejected")
                ) {
                    return Ok(None);
                }
            }
        }
    }
    let session_path = write_root.join("session.json");
    let session_bytes = machine_annotation::read_bytes(&session_path)?
        .ok_or_else(|| failure("未找到 session.json，未修改"))?;
    let mut session: Value = serde_json::from_slice(&session_bytes)?;
    if !session.is_object() {
        return Err(failure("session.json 不是对象，未修改"));
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| failure("无法生成唯一质检版本号"))?;
    let version_id: String = deferred
        .as_ref()
        .map(|(id, _)| id.replace('-', ""))
        .unwrap_or_else(|| nonce.iter().map(|byte| format!("{byte:02x}")).collect());
    let revision = 1;
    let revision_label = format!("{version_id} · 媒体不可用；不通过");
    let updated_at_ms = deferred.as_ref().map(|(_, time)| *time).unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    });
    session["qc"] = json!(format!("不通过：{reason}"));
    session["revision"] = json!(&revision_label);
    session["appVersion"] = json!(env!("CARGO_PKG_VERSION"));
    session["reviewerUsername"] = json!(username);
    session["reviewerName"] = json!(reviewer);
    let reviewed_at =
        time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(updated_at_ms) * 1_000_000)
            .map_err(|_| failure("审核时间格式化失败"))?
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| failure("审核时间格式化失败"))?;
    session["reviewedAt"] = json!(reviewed_at);
    let record = AccountReview {
        source_path: root.to_string_lossy().into(),
        username: username.into(),
        reviewer_name: reviewer.into(),
        status: "rejected".into(),
        rejection_reason: reason.into(),
        revision: revision_label.clone(),
        updated_at_ms,
    };
    let accounts = session
        .as_object_mut()
        .ok_or_else(|| failure("session.json 不是对象，未修改"))?
        .entry("qcReviewers")
        .or_insert_with(|| json!({}));
    let mut shared = serde_json::to_value(&record)?;
    shared.as_object_mut().unwrap().remove("sourcePath");
    accounts
        .as_object_mut()
        .ok_or_else(|| failure("session.qcReviewers 必须是对象，未修改"))?
        .insert(username.into(), shared);
    atomic_json(&session_path, &session)?;
    Ok(Some(ReviewState {
        recovery_warnings: Vec::new(),
        reviewer_username: username.into(),
        rejection_reason: reason.into(),
        change_summary: "媒体不可用；不通过".into(),
        revision_label,
        app_version: env!("CARGO_PKG_VERSION").into(),
        workflow_version: 4,
        status: "rejected".into(),
        version_id,
        previous_version_id: String::new(),
        source_hash: blake3::hash(&session_bytes).to_hex().to_string(),
        revision,
        segments: Vec::new(),
        published: true,
        output_hash: None,
        updated_at_ms: record.updated_at_ms,
        reviewer: reviewer.into(),
    }))
}

struct PendingReviewSnapshot {
    output_hash: Option<String>,
    only_pending: bool,
    qc_content_hash: Option<String>,
    deferred: Option<(String, u64)>,
}

pub fn publish_deferred_for_user(
    data_root: &Path,
    mut request: SaveReviewRequest,
    mut output_hash: Option<String>,
    qc_content_hash: Option<String>,
    reviewer: &str,
    username: &str,
    deferred: (String, u64),
) -> AppResult<ReviewState> {
    // If the source commit succeeded but local queue acknowledgement failed,
    // acknowledge that same result without changing its revision or time again.
    let current = load_selected(
        data_root,
        Path::new(&request.source_path),
        request.source_name.as_deref(),
    )?;
    let status = request.status.as_deref().unwrap_or("pending");
    if current.output_hash.is_some()
        && current.version_id == deferred.0.replace('-', "")
        && current.source_hash == request.source_hash
        && current.reviewer_username == username
        && current.status == status
        && current.rejection_reason == request.rejection_reason.clone().unwrap_or_default()
        && current.segments.len() == request.segments.len()
        && current
            .segments
            .iter()
            .zip(&request.segments)
            .all(|(a, b)| {
                a.source_index == b.source_index
                    && a.start_frame == b.start_frame
                    && a.end_frame == b.end_frame
                    && a.description == b.description
                    && a.deleted == b.deleted
            })
    {
        let qc = view_for_source(
            Path::new(&request.source_path),
            request.source_name.as_deref(),
            current.clone(),
        );
        if request.source_name.as_deref() == Some(machine_annotation::SKELETON_SOURCE)
            || qc.qc_status == current.status
        {
            return Ok(current);
        }
        // Own description committed before QC failed: finish only if the
        // original QC baseline is still unchanged under the shared lock.
        request.expected_revision = current.revision;
        output_hash = current.output_hash.clone();
    }
    save_for_user_mode(
        data_root,
        request,
        reviewer,
        username,
        Some(PendingReviewSnapshot {
            output_hash,
            only_pending: false,
            qc_content_hash,
            deferred: Some(deferred),
        }),
        None,
    )
}

fn save_for_user_mode(
    data_root: &Path,
    mut request: SaveReviewRequest,
    reviewer: &str,
    username: &str,
    pending_snapshot: Option<PendingReviewSnapshot>,
    commit_event: Option<(String, u64)>,
) -> AppResult<ReviewState> {
    let commit_event =
        commit_event.or_else(|| pending_snapshot.as_ref().and_then(|s| s.deferred.clone()));
    let guarded = pending_snapshot.is_some();
    let only_pending = pending_snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.only_pending);
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = crate::dataset_layout::resolve(Path::new(&request.source_path))?.canonicalize()?;
    let annotation = machine_annotation::load_for_review(
        &root,
        request
            .source_name
            .as_deref()
            .or(Some(machine_annotation::DEFAULT_SOURCE)),
    )?
    .ok_or_else(|| failure("未找到机标文件"))?;
    let write_root = storage::review_write_root(&root)?;
    if write_root != root {
        let write_annotation =
            machine_annotation::load_for_review(&write_root, Some(&annotation.source_name))?
                .ok_or_else(|| failure("CIFS 目录中未找到相同机标文件"))?;
        if write_annotation.source_hash != annotation.source_hash {
            return Err(failure("CIFS 目录与当前机标不一致，拒绝写入"));
        }
    }
    let draft = selected_draft_path(data_root, &root, &annotation);
    fs::create_dir_all(draft.parent().ok_or_else(|| failure("草稿目录无效"))?)?;
    let _draft_lock = lock_file(&draft.with_extension("lock"))?;
    let output = output_name(&annotation, &write_root);
    let lock_path = write_root.join(".description.lock");
    let _output_lock = lock_file(&lock_path)?;
    if let Some(snapshot) = pending_snapshot.as_ref().filter(|snapshot| {
        !snapshot.only_pending && annotation.source_name != machine_annotation::SKELETON_SOURCE
    }) {
        let current_qc = machine_annotation::read_bytes(&write_root.join("session.json"))?
            .map(|bytes| blake3::hash(&bytes).to_hex().to_string());
        if annotation.source_name != machine_annotation::SKELETON_SOURCE
            && snapshot.qc_content_hash != current_qc
        {
            return Err(failure(
                "共享目录 QC 或采集记录已改变，本机待写结果已保留，请打开数据核对；未覆盖",
            ));
        }
    }
    if only_pending && !pending_qc(&write_root)? {
        return Err(AppError::Message("BATCH_REVIEW_SKIPPED".into()));
    }
    let current = load_inner(data_root, &root, &annotation)?;
    if (machine_annotation::read_bytes(&write_root.join(output))?
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|doc| doc.get("_text_correction").is_some())
        || has_correction(&write_root.join(output), current.output_hash.as_deref())?)
        && request.expected_revision != current.revision
    {
        return Err(failure("描述已由管理员勘误，请重新读取后继续审核"));
    }
    let own_partial = commit_event.as_ref().is_some_and(|(id, _)| {
        current.version_id == id.replace('-', "")
            && current.reviewer_username == username
            && current.status == "rejected"
            && request.status.as_deref() == Some("rejected")
            && Some(current.rejection_reason.as_str()) == request.rejection_reason.as_deref()
    });
    if only_pending && current.output_hash.is_some() && current.status != "pending" && !own_partial
    {
        return Err(AppError::Message("BATCH_REVIEW_SKIPPED".into()));
    }
    let previous_draft = machine_annotation::read_bytes(&draft)?
        .map(|bytes| serde_json::from_slice::<ReviewState>(&bytes))
        .transpose();
    let previous_draft = match previous_draft {
        Ok(draft) => draft,
        Err(_) if !current.recovery_warnings.is_empty() => None,
        Err(error) => return Err(error.into()),
    };
    let rebased = request.source_hash != annotation.source_hash
        || request.expected_revision != current.revision
        || match &pending_snapshot {
            // Batch preflight just loaded the current shared result. A stale
            // local draft is not a concurrent edit; compare that fresh snapshot
            // instead, including bytes changed without a revision increment.
            Some(snapshot) => snapshot.output_hash != current.output_hash,
            None => previous_draft
                .as_ref()
                .is_some_and(|saved| saved.output_hash != current.output_hash),
        };
    if (guarded || annotation.source_name == machine_annotation::SKELETON_SOURCE) && rebased {
        return Err(failure(if only_pending {
            "审核内容已改变，请刷新后重试，未批量覆盖"
        } else {
            "审核内容已改变，本机待写记录已保留；请重新读取并核对，未覆盖共享结果"
        }));
    }
    if rebased {
        // Preserve the displaced shared result before accepting the operator's snapshot.
        if let Some(bytes) = machine_annotation::read_bytes(&write_root.join(output))? {
            let backup = data_root.join("machine-review-history");
            fs::create_dir_all(&backup)?;
            atomic_json(
                &backup.join(format!("{}.json", blake3::hash(&bytes).to_hex())),
                &serde_json::from_slice(&bytes)?,
            )?;
        }
    }
    validate(&annotation, &request.segments)?;
    if !rebased {
        align_deleted_segments(&current.segments, &mut request.segments);
    }
    validate(&annotation, &request.segments)?;
    let status = request.status.unwrap_or_else(pending_status);
    if annotation.source_name == machine_annotation::SKELETON_SOURCE && status != "pending" {
        return Err(failure("骨架片段仅支持描述，不设置审核结论"));
    }
    if !["pending", "approved", "rejected"].contains(&status.as_str()) {
        return Err(failure("整条质检结论无效"));
    }
    let rejection_reason =
        validated_rejection_reason(&status, request.rejection_reason.as_deref())?;
    if status == "approved" && request.segments.iter().all(|item| item.deleted) {
        return Err(failure("没有保留片段，不能通过质检"));
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| failure("无法生成唯一质检版本号"))?;
    let version_id: String = commit_event
        .as_ref()
        .map(|(id, _)| id.replace('-', ""))
        .unwrap_or_else(|| nonce.iter().map(|byte| format!("{byte:02x}")).collect());
    let expected_output_hash = if current.workflow_version >= 2 {
        current.output_hash.clone()
    } else {
        None
    };
    let change_summary =
        review_change_summary(&current, &request.segments, &status, &rejection_reason);
    let revision_label = format!("{version_id} · {change_summary}");
    let mut state = ReviewState {
        recovery_warnings: Vec::new(),
        workflow_version: 4,
        rejection_reason,
        change_summary,
        revision_label,
        app_version: env!("CARGO_PKG_VERSION").into(),
        status: status.clone(),
        version_id,
        previous_version_id: current.version_id.clone(),
        segments: request
            .segments
            .into_iter()
            .map(|mut item| {
                item.decision = if item.deleted {
                    pending_status()
                } else {
                    status.clone()
                };
                item
            })
            .collect(),
        revision: current.revision + 1,
        published: true,
        reviewer: reviewer.into(),
        reviewer_username: username.into(),
        updated_at_ms: commit_event
            .as_ref()
            .map(|(_, time)| *time)
            .unwrap_or_else(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            }),
        ..current
    };
    if state.published {
        let output = output_name(&annotation, &write_root);
        let session_path = write_root.join("session.json");
        let mut session: Value = if annotation.source_name == machine_annotation::SKELETON_SOURCE {
            json!({})
        } else {
            machine_annotation::read_bytes(&session_path)?
                .map(|bytes| serde_json::from_slice(&bytes))
                .transpose()?
                .unwrap_or_else(|| json!({}))
        };
        if !session.is_object() {
            return Err(failure(
                "根目录 session.json 必须是 JSON 对象，原文件未覆盖",
            ));
        }
        if session
            .get("qcReviewers")
            .is_some_and(|value| !value.is_object())
        {
            return Err(failure("session.qcReviewers 必须是对象，原文件未覆盖"));
        }
        let result = (|| -> AppResult<String> {
            let actual = machine_annotation::read_bytes(&write_root.join(output))?
                .map(|bytes| blake3::hash(&bytes).to_hex().to_string());
            if actual != expected_output_hash {
                return Err(failure("复核结果已改变，拒绝覆盖"));
            }
            let mut document = if human_source(&annotation)
                || state.source_hash != annotation.source_hash
                || request.source_hash != annotation.source_hash
                || annotation.segments.iter().any(|original| {
                    !state
                        .segments
                        .iter()
                        .any(|item| item.source_index == original.source_index)
                }) {
                human_document(&annotation, &state, &write_root)?
            } else {
                reviewed_document(&annotation, &state)?
            };
            if annotation.source_name == machine_annotation::SKELETON_SOURCE {
                if let Some(fields) = document.as_object_mut() {
                    fields.remove("_human_review");
                }
                document["annotation_source"] = json!("skeleton-human");
            }
            let mut pending = state.clone();
            pending.output_hash = Some(
                blake3::hash(&serde_json::to_vec_pretty(&document)?)
                    .to_hex()
                    .to_string(),
            );
            atomic_json(
                &draft.with_extension("pending.json"),
                &serde_json::to_value(&pending)?,
            )?;
            write_technical(
                &write_root.join(output),
                pending
                    .output_hash
                    .as_deref()
                    .ok_or_else(|| failure("缺少人工结果指纹"))?,
                &pending,
            )?;
            atomic_json(&write_root.join(output), &document)
        })();
        state.output_hash = Some(result?);
        if human_source(&annotation) {
            state.source_hash = state
                .output_hash
                .clone()
                .ok_or_else(|| failure("缺少人工结果指纹"))?;
        }
        if annotation.source_name != machine_annotation::SKELETON_SOURCE {
            let qc = match state.status.as_str() {
                "approved" => "通过",
                "rejected" => "不通过",
                _ => "待审核",
            };
            session["qc"] = json!(if qc == "不通过" {
                format!("不通过：{}", state.rejection_reason)
            } else {
                qc.into()
            });
            session["revision"] = json!(state.revision_label);
            session["appVersion"] = json!(state.app_version);
            if let Some(fields) = session.as_object_mut() {
                fields.remove("decision");
                fields.remove("deleted");
            }
            if state.status == "pending" {
                if let Some(fields) = session.as_object_mut() {
                    fields.remove("reviewerUsername");
                    fields.remove("reviewerName");
                    fields.remove("reviewedAt");
                }
            } else {
                let reviewed_at = time::OffsetDateTime::from_unix_timestamp_nanos(
                    i128::from(state.updated_at_ms) * 1_000_000,
                )
                .map_err(|_| failure("审核时间无效"))?
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| failure("审核时间格式无效"))?;
                session["reviewerUsername"] = json!(username);
                session["reviewerName"] = json!(reviewer);
                session["reviewedAt"] = json!(reviewed_at);
            }
            let account_path = account_review_path(data_root, username, &root);
            let previous = read_account_review(&account_path)?;
            let known_account = session
                .get("qcReviewers")
                .and_then(|value| value.get(username))
                .is_some();
            if state.status != "pending" || previous.is_some() || known_account {
                let record = AccountReview {
                    source_path: root.to_string_lossy().into(),
                    username: username.into(),
                    reviewer_name: reviewer.into(),
                    status: state.status.clone(),
                    rejection_reason: state.rejection_reason.clone(),
                    revision: state.revision_label.clone(),
                    updated_at_ms: state.updated_at_ms,
                };
                if session.get("qcReviewers").is_none() {
                    session["qcReviewers"] = json!({});
                }
                let accounts = session["qcReviewers"]
                    .as_object_mut()
                    .ok_or_else(|| failure("session.qcReviewers 必须是对象，账号关联未覆盖"))?;
                // The shared record contains identity and review metadata, never a machine-local path.
                let mut shared = serde_json::to_value(&record)?;
                shared.as_object_mut().unwrap().remove("sourcePath");
                accounts.insert(username.into(), shared);
                atomic_json(&session_path, &session)?;
                fs::create_dir_all(account_path.parent().unwrap())?;
                atomic_json(&account_path, &serde_json::to_value(record)?)?;
            } else {
                atomic_json(&session_path, &session)?;
            }
        }
    }
    atomic_json(&draft, &serde_json::to_value(&state)?)?;
    let _ = fs::remove_file(draft.with_extension("pending.json"));
    Ok(state)
}

fn validated_rejection_reason(status: &str, reason: Option<&str>) -> AppResult<String> {
    if status != "rejected" {
        return Ok(String::new());
    }
    let reason = reason.unwrap_or_default().trim();
    let fixed = [
        "骨架抖动",
        "镜头污渍",
        "镜头遮挡",
        "动作错误",
        "画面过曝",
        "轨迹不动",
        "无效数据",
        "任务不符",
        "动作过快",
        "状态异常",
        "动作失范",
    ];
    if fixed.contains(&reason) {
        return Ok(reason.into());
    }
    if let Some(detail) = reason.strip_prefix("其他原因：") {
        let detail = detail.trim();
        if !detail.is_empty() && detail.chars().count() <= 1000 {
            return Ok(format!("其他原因：{detail}"));
        }
    }
    Err(failure("请选择不通过原因；其他原因需填写 1 至 1000 字"))
}

fn review_change_summary(
    previous: &ReviewState,
    next: &[ReviewSegment],
    status: &str,
    reason: &str,
) -> String {
    let old: BTreeMap<_, _> = previous
        .segments
        .iter()
        .map(|item| (item.source_index, item))
        .collect();
    let (mut added, mut removed, mut restored, mut frames, mut descriptions) = (0, 0, 0, 0, 0);
    for item in next {
        match old.get(&item.source_index) {
            None if !item.deleted => added += 1,
            Some(before) if item.deleted && !before.deleted => removed += 1,
            Some(before) if !item.deleted => {
                if before.deleted {
                    restored += 1;
                }
                if before.start_frame != item.start_frame || before.end_frame != item.end_frame {
                    frames += 1;
                }
                if before.description != item.description {
                    descriptions += 1;
                }
            }
            _ => {}
        }
    }
    let mut changes = Vec::new();
    for (count, action) in [
        (added, "新增片段"),
        (removed, "删除片段"),
        (restored, "恢复片段"),
        (frames, "调整帧数"),
        (descriptions, "修改描述"),
    ] {
        if count > 0 {
            changes.push(format!("{action} {count} 段"));
        }
    }
    if status == "rejected" {
        changes.push(format!("审核不通过：{reason}"));
    } else if status == "approved" {
        changes.push("审核通过".into());
    } else if previous.status != status {
        changes.push("改为待审核".into());
    }
    if changes.is_empty() {
        changes.push("保存待审核记录".into());
    }
    changes.join("；")
}

fn align_deleted_segments(previous: &[ReviewSegment], next: &mut [ReviewSegment]) {
    let mut removed: Vec<_> = previous
        .iter()
        .filter(|old| {
            !old.deleted
                && next
                    .iter()
                    .any(|item| item.source_index == old.source_index && item.deleted)
        })
        .collect();
    removed.sort_by_key(|item| (item.start_frame, item.source_index));
    for removed in removed {
        let following = next
            .iter()
            .filter(|item| !item.deleted && item.end_frame > removed.end_frame)
            .min_by_key(|item| (item.end_frame, item.source_index))
            .map(|item| item.source_index);
        let Some(following) = following else { continue };
        let boundary = next
            .iter()
            .filter(|item| !item.deleted && item.end_frame < removed.start_frame)
            .map(|item| item.end_frame + 1)
            .max()
            .unwrap_or(removed.start_frame);
        if let Some(item) = next.iter_mut().find(|item| item.source_index == following) {
            item.start_frame = item.start_frame.min(boundary);
        }
    }
}

pub(crate) fn lock_file(path: &Path) -> AppResult<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| review_write_error(path, error))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(failure("复核锁必须是普通文件"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(failure("复核锁不能是符号链接"));
        }
    }
    file.try_lock()
        .map_err(|_| failure("另一进程正在保存复核结果，请稍后重试"))?;
    Ok(file)
}

pub fn is_review_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name == OUTPUT
                    || name == machine_annotation::SKELETON_SOURCE
                    || name == ".skeleton.description.review-state.json"
                    || name.starts_with("..skeleton.description.review-state.json.partial-")
                    || name.starts_with(".skeleton.description.json.partial-")
                    || name == "desorption.json"
                    || name == FLASH_OUTPUT
                    || name == LEGACY_OUTPUT
                    || name == LEGACY_FLASH_OUTPUT
                    || name == ".review.3.8max.lock"
                    || name == ".review.3.8flash.lock"
                    || name == ".description.lock"
                    || name == ".description.review-state.json"
                    || name == ".desorption.review-state.json"
                    || name.starts_with("..description.review-state.json.partial-")
                    || name.starts_with("..desorption.review-state.json.partial-")
                    || name.starts_with(".description.json.partial-")
                    || name.starts_with(".desorption.json.partial-")
                    || name.starts_with(".session.json.partial-")
                    || name.starts_with(".review.3.8max.json.partial-")
                    || name.starts_with(".review.3.8flash.json.partial-")
                    || name == ".bailian_annotation.qwen3.8-flash_reviewed.lock"
                    || name.starts_with(".bailian_annotation.qwen3.8-flash_reviewed.json.partial-")
                    || name == ".bailian_annotation_reviewed.lock"
                    || name.starts_with(".bailian_annotation_reviewed.json.partial-")
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn skeleton_descriptions_are_independent_reopenable_and_do_not_write_qc() {
        let f = Fixture::new(0, true);
        fs::create_dir_all(f.root.join(".session_meta")).unwrap();
        fs::create_dir_all(f.root.join("cam0")).unwrap();
        fs::write(f.root.join("cam0/part.mp4"), b"unchanged media").unwrap();
        fs::write(f.root.join(".session_meta/manifest.json"), serde_json::to_vec(&json!({
            "storage_format":"h264-split-mp4-v1", "segment_seconds":300,
            "streams":{"cam0":{"fps":30,"frame_count":30,"width":320,"height":180,"segments":[{"path":"cam0/part.mp4"}]}}
        })).unwrap()).unwrap();
        let action = load(&f.local, &f.root).unwrap();
        f.save(&action).unwrap();
        let human_before = fs::read(f.root.join(OUTPUT)).unwrap();
        let session_before = fs::read(f.root.join("session.json")).unwrap();
        let machine_before = fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
        let source = Some(machine_annotation::SKELETON_SOURCE);
        let mut state = load_selected(&f.local, &f.root, source).unwrap();
        assert!(
            state.segments.is_empty(),
            "never import machine or action segments"
        );
        assert!(!f.root.join(machine_annotation::SKELETON_SOURCE).exists());
        let request = |state: &ReviewState, segments: Vec<ReviewSegment>| SaveReviewRequest {
            source_path: f.root.to_string_lossy().into(),
            source_name: source.map(Into::into),
            source_hash: state.source_hash.clone(),
            expected_revision: state.revision,
            segments,
            status: Some("pending".into()),
            rejection_reason: None,
        };
        let segment = ReviewSegment {
            source_index: 0,
            start_frame: 0,
            end_frame: 29,
            description: "往前走".into(),
            deleted: false,
            decision: "pending".into(),
        };
        state = save_for_user(
            &f.local,
            request(&state, vec![segment.clone()]),
            "Human",
            "alice",
        )
        .unwrap();
        state = save_for_user(
            &f.local,
            request(
                &state,
                vec![
                    ReviewSegment {
                        end_frame: 9,
                        ..segment.clone()
                    },
                    ReviewSegment {
                        source_index: 1,
                        start_frame: 10,
                        description: "抬肘".into(),
                        ..segment
                    },
                ],
            ),
            "Human",
            "alice",
        )
        .unwrap();
        let new_host = f.temp.join("skeleton-new-host");
        let reopened = load_selected(&new_host, &f.root, source).unwrap();
        assert_eq!(reopened.segments, state.segments);
        assert!(reopened.published);
        let output = f.root.join(machine_annotation::SKELETON_SOURCE);
        let doc: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert!(doc.get("_human_review").is_none());
        assert_eq!(
            doc["episode_results"][0]["annotations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(doc["episode_results"][0]["annotations"][1]["end_frame"], 30);
        let mut rejected = request(&state, state.segments.clone());
        rejected.status = Some("approved".into());
        assert!(save_for_user(&f.local, rejected, "Human", "alice").is_err());
        let mut removed = state.segments.clone();
        removed[0].deleted = true;
        state = save_for_user(&f.local, request(&state, removed), "Human", "alice").unwrap();
        assert_eq!(
            load_selected(&new_host, &f.root, source).unwrap().segments,
            state.segments
        );
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), human_before);
        assert_eq!(
            fs::read(f.root.join("session.json")).unwrap(),
            session_before
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            machine_before
        );
        // A missing technical sidecar still reloads actual annotations.
        fs::remove_file(technical_path(&output)).unwrap();
        let bare_host = f.temp.join("skeleton-without-sidecar");
        let bare = load_selected(&bare_host, &f.root, source).unwrap();
        assert_eq!(bare.segments.iter().filter(|s| !s.deleted).count(), 1);
        let mut external: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        external["episode_results"][0]["annotations"][0]["attributes_zh"]["动作描述"] =
            json!("外部修改");
        atomic_json(&output, &external).unwrap();
        assert!(
            save_for_user(
                &bare_host,
                request(&bare, bare.segments.clone()),
                "Human",
                "bob"
            )
            .is_err(),
            "stale editor cannot overwrite changed shared bytes"
        );
        // No machine JSON is needed, and malformed unrelated QC cannot block description-only editing.
        fs::remove_file(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
        fs::write(f.root.join("session.json"), b"malformed unrelated QC").unwrap();
        let fresh = load_selected(&f.temp.join("only-skeleton"), &f.root, source).unwrap();
        let saved = save_for_user(
            &f.temp.join("only-skeleton"),
            request(&fresh, vec![]),
            "Human",
            "bob",
        )
        .unwrap();
        assert!(saved.segments.iter().all(|s| s.deleted));
        assert_eq!(
            fs::read(f.root.join("session.json")).unwrap(),
            b"malformed unrelated QC"
        );
        assert!(is_review_path(&f.root, &output));
        assert!(is_review_path(&f.root, &technical_path(&output)));
        fs::write(&output, b"corrupt skeleton JSON").unwrap();
        assert!(load_selected(&f.temp.join("corrupt-host"), &f.root, source).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"corrupt skeleton JSON");
    }

    #[test]
    fn skeleton_and_action_offline_results_publish_independently_and_keep_event_identity() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        fs::create_dir_all(f.root.join(".session_meta")).unwrap();
        fs::create_dir_all(f.root.join("cam0")).unwrap();
        fs::write(f.root.join("cam0/part.mp4"), b"unchanged media").unwrap();
        fs::write(f.root.join(".session_meta/manifest.json"), serde_json::to_vec(&json!({
            "storage_format":"h264-split-mp4-v1", "segment_seconds":300,
            "streams":{"cam0":{"fps":30,"frame_count":30,"width":320,"height":180,"segments":[{"path":"cam0/part.mp4"}]}}
        })).unwrap()).unwrap();
        let mut originals = Vec::new();
        for (name, id) in [
            (
                machine_annotation::DEFAULT_SOURCE,
                "11111111-1111-4111-8111-111111111111",
            ),
            (
                machine_annotation::SKELETON_SOURCE,
                "22222222-2222-4222-8222-222222222222",
            ),
        ] {
            let state = load_selected(&f.local, &f.root, Some(name)).unwrap();
            let view = view_for_source(&f.root, Some(name), state.clone());
            let segments = if name == machine_annotation::SKELETON_SOURCE {
                vec![ReviewSegment {
                    source_index: 0,
                    start_frame: 0,
                    end_frame: 29,
                    description: "蹲下".into(),
                    deleted: false,
                    decision: "pending".into(),
                }]
            } else {
                state.segments.clone()
            };
            let entry = queue::DeferredReview {
                request: SaveReviewRequest {
                    source_path: f.root.to_string_lossy().into(),
                    source_name: Some(name.into()),
                    source_hash: state.source_hash,
                    expected_revision: state.revision,
                    segments,
                    status: Some("pending".into()),
                    rejection_reason: None,
                },
                output_hash: state.output_hash,
                qc_content_hash: view.qc_content_hash,
                only_pending: false,
                error: "REVIEW_STORAGE_FULL".into(),
                created_at_ms: 0,
                audit: json!({"eventId":id,"action":"saved","occurredAtMs":1792548000000u64,"details":{}}),
            };
            originals.push(queue::store(&f.local, "s", "alice", entry).unwrap());
        }
        assert_eq!(
            queue::status(&f.local, "s", "alice", false)
                .unwrap()
                .pending,
            2
        );
        assert_eq!(
            queue::status(&f.local, "s", "bob", false).unwrap().pending,
            0
        );
        let skeleton = queue::get(
            &f.local,
            "s",
            "alice",
            f.root.to_str().unwrap(),
            Some(machine_annotation::SKELETON_SOURCE),
        )
        .unwrap()
        .unwrap();
        assert_eq!(skeleton.request.segments[0].description, "蹲下");
        let user = crate::model::UserIdentity {
            username: "alice".into(),
            display_name: "甲".into(),
            role: Some("operator".into()),
        };
        let cancel = AtomicBool::new(false);
        let failed = queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| {
            Err(failure("disk unavailable"))
        })
        .unwrap();
        assert_eq!((failed.written, failed.remaining), (0, 2));
        let result = queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!(
            (result.written, result.remaining),
            (2, 0),
            "{:?}",
            result.errors
        );
        let session = fs::read(f.root.join("session.json")).unwrap();
        let output = fs::read(f.root.join(machine_annotation::SKELETON_SOURCE)).unwrap();
        // Interrupted local acknowledgement is idempotent even after unrelated QC changes.
        let mut changed: Value = serde_json::from_slice(&session).unwrap();
        changed["qc"] = json!("通过");
        atomic_json(&f.root.join("session.json"), &changed).unwrap();
        let qc_changed = fs::read(f.root.join("session.json")).unwrap();
        queue::store(&f.local, "s", "alice", originals.pop().unwrap()).unwrap();
        let again = queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!(
            (again.written, again.remaining),
            (1, 0),
            "{:?}",
            again.errors
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::SKELETON_SOURCE)).unwrap(),
            output
        );
        assert_eq!(fs::read(f.root.join("session.json")).unwrap(), qc_changed);
        let events = crate::review_outbox::batch(&f.local, "s", "alice", false).unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e["occurredAtMs"] == 1792548000000u64));
    }

    #[test]
    fn compact_metadata_is_read_only_until_save_and_stale_technical_bytes_are_not_applied() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        let saved = f.save(&state).unwrap();
        let before = fs::read(f.root.join(OUTPUT)).unwrap();
        let sidecar = fs::read(technical_path(&f.root.join(OUTPUT))).unwrap();
        let fresh = load(&f.temp.join("fresh-host"), &f.root).unwrap();
        assert_eq!(fresh.revision, saved.revision);
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), before);
        assert_eq!(
            fs::read(technical_path(&f.root.join(OUTPUT))).unwrap(),
            sidecar
        );
        let mut external = f.output();
        external["episode_results"][0]["annotations"]
            .as_array_mut()
            .unwrap()
            .remove(1);
        external["episode_results"][0]["annotation_count"] = json!(2);
        atomic_json(&f.root.join(OUTPUT), &external).unwrap();
        let loaded = load(&f.temp.join("other-host"), &f.root).unwrap();
        assert_eq!(loaded.segments.iter().filter(|s| !s.deleted).count(), 2);
        assert_eq!(
            loaded.revision, 0,
            "mismatched sidecar must not supply a revision or segments"
        );
        assert_eq!(
            external["_human_review"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["reviewedAt", "reviewer", "status"]
        );
    }

    #[test]
    fn compact_human_result_supports_corrections_undo_and_pending_semantics() {
        let f = Fixture::new(0, true);
        let mut initial = load(&f.local, &f.root).unwrap();
        initial.segments[0].description = "原始动作".into();
        let saved = save_for_user(
            &f.local,
            SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: None,
                source_hash: initial.source_hash,
                expected_revision: 0,
                segments: initial.segments,
                status: Some("approved".into()),
                rejection_reason: None,
            },
            "Reviewer",
            "alice",
        )
        .unwrap();
        for mode in ["typo", "semantic"] {
            let state = load(&f.local, &f.root).unwrap();
            let path = f.root.join(OUTPUT);
            let file_hash = blake3::hash(&fs::read(&path).unwrap()).to_hex().to_string();
            let session_hash = blake3::hash(&fs::read(f.root.join("session.json")).unwrap())
                .to_hex()
                .to_string();
            let changes = vec![crate::text_quality::Correction {
                file_path: path.to_string_lossy().into(),
                file_hash,
                session_hash,
                segment_index: 0,
                original: state.segments[0].description.clone(),
                replacement: format!("更正动作{mode}"),
            }];
            let result = crate::text_quality::apply(
                &f.local,
                &f.root,
                changes,
                mode,
                "核对修正",
                "Admin",
                &AtomicBool::new(false),
            )
            .unwrap();
            assert!(result[0].error.is_empty(), "{}", result[0].error);
            let corrected = load(&f.temp.join(format!("fresh-{mode}")), &f.root).unwrap();
            assert_eq!(corrected.segments[0].description, format!("更正动作{mode}"));
            assert_eq!(
                corrected.status,
                if mode == "typo" {
                    "approved"
                } else {
                    "pending"
                }
            );
            assert_eq!(f.output()["_human_review"].as_object().unwrap().len(), 3);
            assert!(f.output().get("_text_correction").is_none());
            crate::text_quality::undo(&f.local, result[0].history_id.as_deref().unwrap(), "Admin")
                .unwrap();
            let undone = load(&f.temp.join(format!("undo-{mode}")), &f.root).unwrap();
            assert_eq!(
                undone.segments[0].description,
                state.segments[0].description
            );
            assert!(undone.revision > saved.revision);
            if mode == "semantic" {
                assert_eq!(undone.status, "pending");
            }
        }
    }

    #[test]
    fn selected_human_source_self_save_does_not_block_guarded_offline_writeback() {
        for name in ["description.json", "desorption.json"] {
            let f = Fixture::new(0, true);
            let initial = load(&f.local, &f.root).unwrap();
            f.save(&initial).unwrap();
            if name == "desorption.json" {
                fs::rename(f.root.join(OUTPUT), f.root.join(name)).unwrap();
            }
            let selected = format!("./{name}");
            let state = load_selected(&f.local, &f.root, Some(&selected)).unwrap();
            let request = |state: &ReviewState, status: &str| SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: Some(selected.clone()),
                source_hash: state.source_hash.clone(),
                expected_revision: state.revision,
                segments: state.segments.clone(),
                status: Some(status.into()),
                rejection_reason: Some("动作失范".into()),
            };
            let saved = save_for_user(&f.local, request(&state, "pending"), "QA", "qa").unwrap();
            let view = view_for_root(&f.root, saved.clone());
            let approved = publish_deferred_for_user(
                &f.local,
                request(&saved, "approved"),
                saved.output_hash.clone(),
                view.qc_content_hash,
                "QA",
                "qa",
                ("55555555-5555-4555-8555-555555555555".into(), 1792548000000),
            )
            .unwrap();
            assert_eq!(approved.status, "approved");
            assert_eq!(
                approved.source_hash,
                approved.output_hash.as_deref().unwrap()
            );
            let doc: Value = serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap();
            assert_eq!(doc["_human_review"].as_object().unwrap().len(), 3);
            let fresh =
                load_selected(&f.temp.join("fresh-host"), &f.root, Some(&selected)).unwrap();
            assert_eq!(fresh.status, "approved");
            assert_eq!(fresh.source_hash, approved.source_hash);
        }
    }

    #[test]
    fn technical_write_failure_preserves_the_human_result_and_qc() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        fs::create_dir(technical_path(&f.root.join(OUTPUT))).unwrap();
        assert!(f.save(&state).is_err());
        assert!(!f.root.join(OUTPUT).exists());
        assert!(!f.root.join("session.json").exists());
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn relocated_offline_queue_uses_local_alias_and_publishes_original_event_once() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        let old = f.temp.join("Delta-D1/2026-09-16-Test/sample");
        let moved = f.temp.join("Delta-D1/D1 daily/2026-09-16-Test/sample");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::rename(&f.root, &old).unwrap();
        let state = load(&f.local, &old).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let at = 1792548000000u64;
        queue::store(
            &f.local,
            "s",
            "alice",
            queue::DeferredReview {
                request: SaveReviewRequest {
                    source_path: old.to_string_lossy().into(),
                    source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                    source_hash: state.source_hash,
                    expected_revision: state.revision,
                    segments: state.segments,
                    status: Some("approved".into()),
                    rejection_reason: None,
                },
                output_hash: None,
                qc_content_hash: None,
                only_pending: false,
                audit: json!({"eventId":id,"action":"approved","occurredAtMs":at,"details":{}}),
                error: "REVIEW_STORAGE_FULL".into(),
                created_at_ms: 0,
            },
        )
        .unwrap();
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        fs::rename(&old, &moved).unwrap();
        let registry = f.temp.join("Delta-Viewer-TaskIndex/Delta-D1/layout.json");
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        let config = json!({"moves":[{"source":"Delta-D1/2026-09-16-Test","destination":"Delta-D1/D1 daily/2026-09-16-Test","state":"completed"}]});
        atomic_json(&registry, &config).unwrap();
        crate::dataset_layout::cache_registry(&f.local, &moved).unwrap();
        fs::remove_file(&registry).unwrap();
        let local = queue::get(
            &f.local,
            "s",
            "alice",
            &moved.to_string_lossy(),
            Some(machine_annotation::DEFAULT_SOURCE),
        )
        .unwrap()
        .unwrap();
        assert_eq!(local.audit["eventId"], id);
        assert!(queue::get(
            &f.local,
            "s",
            "bob",
            &moved.to_string_lossy(),
            Some(machine_annotation::DEFAULT_SOURCE)
        )
        .unwrap()
        .is_none());
        assert!(queue::contains_path(&f.local, "s", "alice", &moved.to_string_lossy()).unwrap());
        atomic_json(&registry, &config).unwrap();
        let user = crate::model::UserIdentity {
            username: "alice".into(),
            display_name: "Alice".into(),
            role: Some("operator".into()),
        };
        let result =
            queue::publish_with_probe(&f.local, "s", &user, &AtomicBool::new(false), &|_| Ok(()))
                .unwrap();
        assert_eq!((result.written, result.remaining), (1, 0));
        let saved = load(&f.temp.join("fresh"), &moved).unwrap();
        assert_eq!(saved.version_id, id.replace('-', ""));
        assert_eq!(saved.updated_at_ms, at);
        assert_eq!(view_for_root(&moved, saved).qc_status, "approved");
    }

    #[test]
    fn save_io_errors_distinguish_full_permissions_timeout_and_unknown() {
        for (kind, code) in [
            (std::io::ErrorKind::StorageFull, "REVIEW_STORAGE_FULL"),
            (
                std::io::ErrorKind::PermissionDenied,
                "REVIEW_STORAGE_PERMISSION_DENIED",
            ),
            (std::io::ErrorKind::TimedOut, "REVIEW_STORAGE_TIMEOUT"),
            (std::io::ErrorKind::Other, "REVIEW_STORAGE_WRITE_FAILED"),
        ] {
            let error =
                review_write_error(Path::new("test/description.json"), kind.into()).to_string();
            assert!(error.contains(code));
            assert!(error.contains("test/description.json"));
            assert!(error.contains("未确认审核保存成功"));
        }
    }

    #[test]
    fn inferred_end_is_written_to_human_annotations_and_mirrors_only() {
        for base in [0, 1] {
            for exclusive in [true, false] {
                let f = Fixture::new(base, exclusive);
                let path = f.root.join(machine_annotation::DEFAULT_SOURCE);
                let mut document: Value = serde_json::from_slice(&f.original).unwrap();
                document["episode_results"][0]["annotations"][1]["end_frame"] = Value::Null;
                document["episode_results"][0]["segments"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("end_frame");
                let raw = serde_json::to_vec(&document).unwrap();
                fs::write(&path, &raw).unwrap();
                let state = load(&f.local, &f.root).unwrap();
                assert_eq!(state.segments.len(), 3);
                assert_eq!(state.segments[1].end_frame, 19);
                let saved = f.save(&state).unwrap();
                let output = f.output();
                let expected = 19 + base + u64::from(exclusive);
                for key in ["annotations", "segments"] {
                    assert_eq!(output["episode_results"][0][key][1]["end_frame"], expected);
                }
                let reloaded = load(&f.temp.join("fresh-host"), &f.root).unwrap();
                assert_eq!(reloaded.segments, saved.segments);
                assert_eq!(fs::read(&path).unwrap(), raw);
            }
        }
    }

    #[test]
    fn batch_rejection_without_media_completes_qc_without_inventing_annotations() {
        for broken_json in [false, true] {
            let f = Fixture::new(0, true);
            fs::remove_file(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
            fs::write(
                f.root.join("session.json"),
                br#"{"capture":"preserved","qc":""}"#,
            )
            .unwrap();
            fs::create_dir_all(f.root.join(".session_meta")).unwrap();
            let manifest = br#"{"storage_format":"jpeg-stream-v1","result":"PARTIAL","batch_count":0,"streams":{}}"#;
            fs::write(f.root.join(".session_meta/manifest.json"), manifest).unwrap();
            fs::create_dir_all(f.root.join("cam0")).unwrap();
            fs::write(
                f.root.join("cam0/cam0-00000.mp4"),
                b"original capture bytes",
            )
            .unwrap();
            if broken_json {
                fs::write(
                    f.root.join(machine_annotation::DEFAULT_SOURCE),
                    b"broken JSON",
                )
                .unwrap();
                fs::write(f.root.join(OUTPUT), b"broken human JSON").unwrap();
            }
            let state = reject_pending_for_user(&f.local, &f.root, "无效数据", "Reviewer", "alice")
                .unwrap()
                .unwrap();
            assert_eq!(state.status, "rejected");
            assert!(state.segments.is_empty());
            let session: Value =
                serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
            assert_eq!(session["qc"], "不通过：无效数据");
            assert_eq!(session["capture"], "preserved");
            assert_eq!(session["reviewerUsername"], "alice");
            assert!(session["qcReviewers"]["alice"].get("sourcePath").is_none());
            assert_eq!(
                list_account_reviews(
                    &f.temp.join("another-host"),
                    &[f.root.to_string_lossy().into()],
                    "alice"
                )
                .unwrap()[0]
                    .status,
                "rejected"
            );
            let catalog = serde_json::to_value(crate::task_center::scan(&f.root).unwrap()).unwrap();
            assert_eq!(catalog["tree"]["total"], 1);
            assert_eq!(catalog["tree"]["reviewed"], 1);
            assert_eq!(catalog["tree"]["rejected"], 1);
            assert_eq!(
                fs::read(f.root.join("cam0/cam0-00000.mp4")).unwrap(),
                b"original capture bytes"
            );
            assert_eq!(
                fs::read(f.root.join(".session_meta/manifest.json")).unwrap(),
                manifest
            );
            if broken_json {
                assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), b"broken human JSON");
            } else {
                assert!(!f.root.join(OUTPUT).exists());
            }
            let before = fs::read(f.root.join("session.json")).unwrap();
            assert!(
                reject_pending_for_user(&f.local, &f.root, "任务不符", "Other", "bob")
                    .unwrap()
                    .is_none()
            );
            assert_eq!(fs::read(f.root.join("session.json")).unwrap(), before);
        }
    }

    #[test]
    fn batch_rejection_without_media_preserves_invalid_qc_and_completed_human_results() {
        let f = Fixture::new(0, true);
        fs::remove_file(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
        for session in [
            br#"{"qc":true}"#.as_slice(),
            b"{invalid",
            br#"{"qcReviewers":[]}"#,
        ] {
            fs::write(f.root.join("session.json"), session).unwrap();
            assert!(
                reject_pending_for_user(&f.local, &f.root, "无效数据", "Reviewer", "alice")
                    .is_err()
            );
            assert_eq!(fs::read(f.root.join("session.json")).unwrap(), session);
        }
        fs::write(f.root.join("session.json"), b"{}").unwrap();
        fs::write(
            f.root.join(OUTPUT),
            br#"{"_human_review":{"status":"approved"}}"#,
        )
        .unwrap();
        assert!(
            reject_pending_for_user(&f.local, &f.root, "无效数据", "Reviewer", "alice")
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(f.root.join("session.json")).unwrap(), b"{}");
        fs::remove_file(f.root.join(OUTPUT)).unwrap();
        let lock = lock_file(&f.root.join(".description.lock")).unwrap();
        assert!(
            reject_pending_for_user(&f.local, &f.root, "无效数据", "Reviewer", "alice").is_err()
        );
        assert_eq!(fs::read(f.root.join("session.json")).unwrap(), b"{}");
        drop(lock);
        // A decision made after discovery must win when the shared lock is acquired.
        fs::write(
            f.root.join("session.json"),
            serde_json::to_vec(&json!({"qc":"通过"})).unwrap(),
        )
        .unwrap();
        assert!(
            reject_pending_without_media(&f.root, "无效数据", "Reviewer", "alice", None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn batch_rejection_preserves_completed_qc_and_rejects_pending_with_reason() {
        let fixture = Fixture::new(0, true);
        for qc in [
            json!("通过"),
            json!("不通过：旧原因"),
            json!(true),
            json!("异常标记"),
        ] {
            let session = serde_json::to_vec(&json!({"qc":qc,"capture":"keep"})).unwrap();
            fs::write(fixture.root.join("session.json"), &session).unwrap();
            let result = reject_pending_for_user(
                &fixture.local,
                &fixture.root,
                "其他原因：批量检查发现遮挡",
                "审核甲",
                "alice",
            );
            if qc.is_boolean() || qc == "异常标记" {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().is_none());
            }
            assert_eq!(
                fs::read(fixture.root.join("session.json")).unwrap(),
                session
            );
            assert!(!fixture.root.join(OUTPUT).exists());
        }
        fs::write(
            fixture.root.join("session.json"),
            br#"{"qc":"","capture":"keep"}"#,
        )
        .unwrap();
        assert!(reject_pending_for_user(
            &fixture.local,
            &fixture.root,
            "其他原因：  ",
            "审核甲",
            "alice"
        )
        .is_err());
        assert!(!fixture.root.join(OUTPUT).exists());
        let result = reject_pending_for_user(
            &fixture.local,
            &fixture.root,
            "其他原因：批量检查发现遮挡",
            "审核甲",
            "alice",
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(result.segments.len(), 3);
        let session: Value =
            serde_json::from_slice(&fs::read(fixture.root.join("session.json")).unwrap()).unwrap();
        assert_eq!(session["capture"], "keep");
        assert_eq!(session["qc"], "不通过：其他原因：批量检查发现遮挡");
        assert_eq!(session["reviewerUsername"], "alice");
        assert_eq!(
            list_account_reviews(
                &fixture.local,
                &[fixture.root.to_string_lossy().into()],
                "alice"
            )
            .unwrap()
            .len(),
            1
        );
        let before = fs::read(fixture.root.join(OUTPUT)).unwrap();
        assert!(reject_pending_for_user(
            &fixture.local,
            &fixture.root,
            "其他原因：重试",
            "审核甲",
            "alice"
        )
        .unwrap()
        .is_none());
        assert_eq!(fs::read(fixture.root.join(OUTPUT)).unwrap(), before);
        assert_eq!(
            fs::read(fixture.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            fixture.original
        );
    }

    #[test]
    fn batch_rejection_accepts_stale_local_hashes_and_retains_latest_human_text() {
        for changed_source in [false, true] {
            let f = Fixture::new(0, true);
            let state = load(&f.local, &f.root).unwrap();
            f.save(&state).unwrap();
            let mut doc = f.output();
            doc["episode_results"][0]["annotations"][0]["attributes_zh"] =
                json!({"动作描述": "其他电脑最新修改的动作"});
            let before = serde_json::to_vec(&doc).unwrap();
            fs::write(f.root.join(OUTPUT), &before).unwrap();
            if changed_source {
                let mut machine: Value = serde_json::from_slice(&f.original).unwrap();
                machine["generation"] = json!("new-export-same-segments");
                fs::write(
                    f.root.join(machine_annotation::DEFAULT_SOURCE),
                    serde_json::to_vec(&machine).unwrap(),
                )
                .unwrap();
            }
            let machine_before = fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
            let result =
                reject_pending_for_user(&f.local, &f.root, "镜头遮挡", "Reviewer", "alice")
                    .unwrap()
                    .expect("fresh batch read must not conflict with stale local cache");
            assert_eq!(result.status, "rejected");
            assert_eq!(result.segments[0].description, "其他电脑最新修改的动作");
            let session: Value =
                serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
            assert_eq!(session["qc"], "不通过：镜头遮挡");
            assert_eq!(
                fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
                machine_before
            );
            assert!(
                reject_pending_for_user(&f.local, &f.root, "无效数据", "Reviewer", "alice")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn batch_rejection_accepts_orphan_drafts_but_preserves_shared_completed_results() {
        for old_status in ["pending", "approved", "rejected"] {
            let f = Fixture::new(0, true);
            let current = load(&f.local, &f.root).unwrap();
            let saved = save(
                &f.local,
                SaveReviewRequest {
                    source_path: f.root.to_string_lossy().into(),
                    source_name: None,
                    source_hash: current.source_hash,
                    expected_revision: current.revision,
                    segments: current.segments,
                    status: Some(old_status.into()),
                    rejection_reason: Some("任务不符".into()),
                },
                "old-reviewer",
            )
            .unwrap();
            fs::write(f.root.join("session.json"), br#"{"qc":""}"#).unwrap();
            if old_status != "pending" {
                let mut shared = f.output();
                shared["_human_review"]["published"] = json!(false);
                fs::write(f.root.join(OUTPUT), serde_json::to_vec(&shared).unwrap()).unwrap();
                assert!(reject_pending_for_user(
                    &f.local,
                    &f.root,
                    "镜头遮挡",
                    "Reviewer",
                    "alice"
                )
                .unwrap()
                .is_none());
            }
            fs::remove_file(f.root.join(OUTPUT)).unwrap();
            let result =
                reject_pending_for_user(&f.local, &f.root, "镜头遮挡", "Reviewer", "alice")
                    .unwrap()
                    .expect("an orphan local conclusion must not hide a pending source record");
            assert_eq!(result.status, "rejected");
            assert_eq!(result.rejection_reason, "镜头遮挡");
            assert_eq!(result.revision, saved.revision + 1);
            assert_eq!(
                result
                    .segments
                    .iter()
                    .map(|s| (&s.description, s.start_frame, s.end_frame))
                    .collect::<Vec<_>>(),
                saved
                    .segments
                    .iter()
                    .map(|s| (&s.description, s.start_frame, s.end_frame))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
                f.original
            );
        }
    }

    #[test]
    fn batch_snapshot_rejects_real_shared_or_source_changes_after_preflight() {
        for changed_source in [false, true] {
            let f = Fixture::new(0, true);
            let state = load(&f.local, &f.root).unwrap();
            f.save(&state).unwrap();
            let state = load(&f.local, &f.root).unwrap();
            let snapshot = PendingReviewSnapshot {
                output_hash: state.output_hash.clone(),
                only_pending: true,
                qc_content_hash: None,
                deferred: None,
            };
            if changed_source {
                let mut machine: Value = serde_json::from_slice(&f.original).unwrap();
                machine["generation"] = json!("changed-after-preflight");
                fs::write(
                    f.root.join(machine_annotation::DEFAULT_SOURCE),
                    serde_json::to_vec(&machine).unwrap(),
                )
                .unwrap();
            } else {
                let mut doc = f.output();
                doc["episode_results"][0]["annotations"][0]["attributes_zh"] =
                    json!({"动作描述":"准备之后的新修改"});
                // Deliberately do not increment the revision: byte identity must protect it.
                fs::write(f.root.join(OUTPUT), serde_json::to_vec(&doc).unwrap()).unwrap();
            }
            let output = fs::read(f.root.join(OUTPUT)).unwrap();
            let session = fs::read(f.root.join("session.json")).unwrap();
            let result = save_for_user_mode(
                &f.local,
                SaveReviewRequest {
                    source_path: f.root.to_string_lossy().into(),
                    source_name: None,
                    source_hash: state.source_hash,
                    expected_revision: state.revision,
                    segments: state.segments,
                    status: Some("rejected".into()),
                    rejection_reason: Some("镜头遮挡".into()),
                },
                "Reviewer",
                "alice",
                Some(snapshot),
                None,
            );
            assert!(result.unwrap_err().to_string().contains("审核内容已改变"));
            assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), output);
            assert_eq!(fs::read(f.root.join("session.json")).unwrap(), session);
        }
    }

    #[test]
    fn batch_rejection_rechecks_qc_under_save_lock() {
        let fixture = Fixture::new(0, true);
        let state = load_selected(&fixture.local, &fixture.root, None).unwrap();
        fs::write(
            fixture.root.join("session.json"),
            serde_json::to_vec(&json!({"qc":"通过"})).unwrap(),
        )
        .unwrap();
        let result = save_for_user_mode(
            &fixture.local,
            SaveReviewRequest {
                source_path: fixture.root.to_string_lossy().into(),
                source_name: None,
                source_hash: state.source_hash,
                expected_revision: state.revision,
                segments: state.segments,
                status: Some("rejected".into()),
                rejection_reason: Some("轨迹不动".into()),
            },
            "审核甲",
            "alice",
            Some(PendingReviewSnapshot {
                output_hash: state.output_hash,
                only_pending: true,
                qc_content_hash: None,
                deferred: None,
            }),
            None,
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("BATCH_REVIEW_SKIPPED"));
        assert!(!fixture.root.join(OUTPUT).exists());
    }

    #[test]
    fn manual_without_machine_json_saves_splits_reopens_and_approves() {
        let fixture = Fixture::new(0, true);
        fs::remove_file(fixture.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
        fs::create_dir_all(fixture.root.join(".session_meta")).unwrap();
        fs::create_dir_all(fixture.root.join("cam0")).unwrap();
        fs::write(fixture.root.join("cam0/part.mp4"), b"unchanged media").unwrap();
        fs::write(fixture.root.join(".session_meta/manifest.json"), serde_json::to_vec(&json!({
            "storage_format":"h264-split-mp4-v1", "segment_seconds":300,
            "streams":{"cam0":{"fps":30,"frame_count":1065,"width":320,"height":180,"segments":[{"path":"cam0/part.mp4"}]}}
        })).unwrap()).unwrap();
        let annotation = machine_annotation::load_for_review(&fixture.root, None)
            .unwrap()
            .unwrap();
        assert_eq!(annotation.frame_count, 1065);
        assert_eq!(annotation.source_name, machine_annotation::MANUAL_SOURCE);
        let mut state = load_selected(&fixture.local, &fixture.root, None).unwrap();
        assert!(state.segments.is_empty());
        assert!(!fixture.root.join(OUTPUT).exists());
        let persist = |state: &ReviewState, segments: Vec<ReviewSegment>, status: &str| {
            save_for_user(
                &fixture.local,
                SaveReviewRequest {
                    source_path: fixture.root.to_string_lossy().into(),
                    source_name: Some(machine_annotation::MANUAL_SOURCE.into()),
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
                    segments,
                    status: Some(status.into()),
                    rejection_reason: None,
                },
                "Human",
                "manual-reviewer",
            )
            .unwrap()
        };
        let full = ReviewSegment {
            source_index: 0,
            start_frame: 0,
            end_frame: 1064,
            description: "人工整段".into(),
            deleted: false,
            decision: "pending".into(),
        };
        state = persist(&state, vec![full.clone()], "pending");
        assert_eq!(
            fixture.output()["episode_results"][0]["annotations"][0]["end_frame"],
            1065
        );
        state = persist(
            &state,
            vec![
                ReviewSegment {
                    end_frame: 577,
                    ..full.clone()
                },
                ReviewSegment {
                    source_index: 1,
                    start_frame: 578,
                    description: "人工后半段".into(),
                    ..full
                },
            ],
            "approved",
        );
        let reopened =
            load_selected(&fixture.temp.join("fresh-host"), &fixture.root, None).unwrap();
        assert_eq!(reopened.status, "approved");
        assert_eq!(reopened.revision, state.revision);
        assert_eq!(reopened.segments.len(), 2);
        assert_eq!(reopened.segments[1].start_frame, 578);
        assert_eq!(reopened.segments[1].end_frame, 1064);
        assert_eq!(reopened.segments[1].description, "人工后半段");
        assert_eq!(
            fs::read(fixture.root.join("cam0/part.mp4")).unwrap(),
            b"unchanged media"
        );
        assert!(!fixture
            .root
            .join(machine_annotation::DEFAULT_SOURCE)
            .exists());
        fs::write(
            fixture.root.join(machine_annotation::DEFAULT_SOURCE),
            b"invalid json",
        )
        .unwrap();
        let compatible = machine_annotation::load_for_review(&fixture.root, None)
            .unwrap()
            .unwrap();
        assert!(compatible.source_name.ends_with("description.json"));
        assert_eq!(compatible.segments.len(), 2);
        assert!(machine_annotation::load_for_review(
            &fixture.root,
            Some(machine_annotation::DEFAULT_SOURCE)
        )
        .is_err());
    }

    #[test]
    fn deferred_result_survives_restart_accounts_conflicts_and_idempotent_writeback() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        fs::write(
            f.root.join("session.json"),
            r#"{"qc":"待审核","capture":"keep"}"#.as_bytes(),
        )
        .unwrap();
        let state = load(&f.local, &f.root).unwrap();
        let view = view_for_root(&f.root, state.clone());
        let user = crate::model::UserIdentity {
            username: "alice".into(),
            display_name: "审核甲".into(),
            role: Some("operator".into()),
        };
        let event = json!({"eventId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","episodeKey":"a".repeat(64),"episodeName":"sample","action":"approved","occurredAtMs":1792548000000u64,"elapsedMs":1000,"details":{}});
        let entry = queue::DeferredReview {
            request: SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                source_hash: state.source_hash.clone(),
                expected_revision: state.revision,
                segments: state.segments.clone(),
                status: Some("approved".into()),
                rejection_reason: None,
            },
            output_hash: state.output_hash,
            qc_content_hash: view.qc_content_hash,
            only_pending: false,
            audit: event.clone(),
            error: "REVIEW_STORAGE_FULL".into(),
            created_at_ms: 0,
        };
        queue::store(&f.local, "service", &user.username, entry.clone()).unwrap();
        assert!(!f.root.join(OUTPUT).exists());
        assert_eq!(queue::list(&f.local, "service", "bob").unwrap().len(), 0);
        assert_eq!(
            queue::list(&f.local, "different-service", "alice")
                .unwrap()
                .len(),
            0
        );
        let restored = queue::get(
            &f.local,
            "service",
            "alice",
            &entry.request.source_path,
            entry.request.source_name.as_deref(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(restored.audit, event);
        assert!(queue::local_view(&restored, &user, None).pending_source_write);
        assert!(!queue::local_view(&restored, &user, None).review.published);
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let full = queue::publish_with_probe(&f.local, "service", &user, &cancel, &|_| {
            Err(failure("REVIEW_STORAGE_FULL"))
        })
        .unwrap();
        assert_eq!((full.written, full.remaining), (0, 1));
        assert!(!f.root.join(OUTPUT).exists());
        fs::write(
            f.root.join("session.json"),
            r#"{"qc":"通过","capture":"keep"}"#.as_bytes(),
        )
        .unwrap();
        let conflict =
            queue::publish_with_probe(&f.local, "service", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!((conflict.written, conflict.remaining), (0, 1));
        assert!(conflict.errors[0].contains("已改变"));
        assert!(!f.root.join(OUTPUT).exists());
        fs::write(
            f.root.join("session.json"),
            r#"{"qc":"待审核","capture":"keep"}"#.as_bytes(),
        )
        .unwrap();
        let published =
            queue::publish_with_probe(&f.local, "service", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!((published.written, published.remaining), (1, 0));
        let shared_before = fs::read(f.root.join(OUTPUT)).unwrap();
        let session_before = fs::read(f.root.join("session.json")).unwrap();
        let doc: Value = serde_json::from_slice(&session_before).unwrap();
        assert_eq!(doc["qc"], "通过");
        assert_eq!(doc["capture"], "keep");
        let saved = load(&f.local, &f.root).unwrap();
        assert_eq!(saved.updated_at_ms, 1792548000000u64);
        assert_eq!(saved.version_id, "11111111111141118111111111111111");
        let events = crate::review_outbox::batch(&f.local, "service", "alice", false).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["eventId"], event["eventId"]);
        assert_eq!(events[0]["occurredAtMs"], event["occurredAtMs"]);
        // Emulate source success before queue removal: same event must not save again.
        queue::store(&f.local, "service", "alice", entry).unwrap();
        let retried =
            queue::publish_with_probe(&f.local, "service", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!((retried.written, retried.remaining), (1, 0));
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), shared_before);
        assert_eq!(
            fs::read(f.root.join("session.json")).unwrap(),
            session_before
        );
        assert_eq!(
            crate::review_outbox::batch(&f.local, "service", "alice", false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn deferred_partial_initial_commit_finishes_qc_with_original_identity() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        fs::write(
            f.root.join("session.json"),
            br#"{"qc":"pending","capture":"keep"}"#,
        )
        .unwrap();
        let session = fs::read(f.root.join("session.json")).unwrap();
        let initial = load(&f.local, &f.root).unwrap();
        let view = view_for_root(&f.root, initial.clone());
        let request = SaveReviewRequest {
            source_path: f.root.to_string_lossy().into(),
            source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
            source_hash: initial.source_hash,
            expected_revision: initial.revision,
            segments: initial.segments,
            status: Some("approved".into()),
            rejection_reason: None,
        };
        let id = "33333333-3333-4333-8333-333333333333";
        let time = 1792548000000u64;
        let saved = save_with_event_for_user(
            &f.local,
            request.clone(),
            "甲",
            "alice",
            Some((id.into(), time)),
        )
        .unwrap();
        assert_eq!(saved.version_id, id.replace('-', ""));
        // Isolate the state after description commit but before QC commit.
        fs::write(f.root.join("session.json"), session).unwrap();
        queue::store(
            &f.local,
            "s",
            "alice",
            queue::DeferredReview {
                request,
                output_hash: initial.output_hash,
                qc_content_hash: view.qc_content_hash,
                only_pending: false,
                audit: json!({"eventId":id,"action":"approved","occurredAtMs":time,"details":{}}),
                error: "REVIEW_STORAGE_FULL".into(),
                created_at_ms: 0,
            },
        )
        .unwrap();
        let user = crate::model::UserIdentity {
            username: "alice".into(),
            display_name: "甲".into(),
            role: Some("operator".into()),
        };
        let result = queue::publish_with_probe(
            &f.local,
            "s",
            &user,
            &std::sync::atomic::AtomicBool::new(false),
            &|_| Ok(()),
        )
        .unwrap();
        assert_eq!((result.written, result.remaining), (1, 0));
        let confirmed = load(&f.local, &f.root).unwrap();
        assert_eq!(confirmed.updated_at_ms, time);
        assert_eq!(confirmed.version_id, id.replace('-', ""));
        assert_eq!(view_for_root(&f.root, confirmed).qc_status, "approved");
    }

    #[test]
    fn deferred_edits_keep_first_baseline_and_preserve_displaced_local_results() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        let mut entry = queue::DeferredReview {
            request: SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                source_hash: state.source_hash.clone(),
                expected_revision: 0,
                segments: state.segments,
                status: Some("pending".into()),
                rejection_reason: None,
            },
            output_hash: None,
            qc_content_hash: None,
            only_pending: false,
            audit: json!({"eventId":"11111111-1111-4111-8111-111111111111","action":"saved","occurredAtMs":1792548000000u64,"details":{}}),
            error: "full".into(),
            created_at_ms: 0,
        };
        queue::store(&f.local, "s", "alice", entry.clone()).unwrap();
        entry.output_hash = Some("untrusted later baseline".into());
        entry.request.expected_revision = 100;
        entry.request.source_hash = "changed".into();
        entry.request.segments[0].description = "第二次本机修改".into();
        entry.audit["eventId"] = json!("22222222-2222-4222-8222-222222222222");
        queue::store(&f.local, "s", "alice", entry.clone()).unwrap();
        let rows = queue::list(&f.local, "s", "alice").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].request.expected_revision, 0);
        assert_eq!(rows[0].request.source_hash, state.source_hash);
        assert_eq!(rows[0].output_hash, None);
        assert_eq!(rows[0].request.segments[0].description, "第二次本机修改");
        let db = crate::review_outbox::open(&f.local).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM source_review_history", [], |row| row
                .get::<_, u64>(
                0
            ))
            .unwrap(),
            1
        );
        let bad = f.temp.join("not-directory");
        fs::write(&bad, b"keep").unwrap();
        assert!(queue::store(&bad, "s", "alice", entry).is_err());
        assert_eq!(queue::list(&f.local, "s", "alice").unwrap().len(), 1);
    }

    #[test]
    fn deferred_batch_resumes_own_partial_description_but_preserves_other_decisions() {
        let f = Fixture::new(0, true);
        fs::write(f.root.join("session.json"), r#"{"qc":"待审核"}"#.as_bytes()).unwrap();
        let session = fs::read(f.root.join("session.json")).unwrap();
        let current = load(&f.local, &f.root).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let time = 1792548000000u64;
        let event = (id.to_string(), time);
        save_with_event_for_user(
            &f.local,
            SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: None,
                source_hash: current.source_hash,
                expected_revision: current.revision,
                segments: current.segments,
                status: Some("rejected".into()),
                rejection_reason: Some("动作失范".into()),
            },
            "甲",
            "alice",
            Some(event.clone()),
        )
        .unwrap();
        fs::write(f.root.join("session.json"), session).unwrap();
        let saved =
            reject_pending_deferred(&f.local, &f.root, "动作失范", "甲", "alice", event.clone())
                .unwrap()
                .unwrap();
        assert_eq!(saved.version_id, id.replace('-', ""));
        assert_eq!(saved.updated_at_ms, time);
        assert_eq!(view_for_root(&f.root, saved).qc_status, "rejected");
        fs::write(f.root.join("session.json"), r#"{"qc":"通过"}"#.as_bytes()).unwrap();
        assert!(
            reject_pending_deferred(&f.local, &f.root, "动作失范", "甲", "alice", event)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read(f.root.join("session.json")).unwrap(),
            r#"{"qc":"通过"}"#.as_bytes()
        );
    }

    #[test]
    fn deferred_batch_rejection_is_idempotent_and_never_overwrites_completed_qc() {
        use crate::source_review_queue as queue;
        let f = Fixture::new(0, true);
        fs::remove_file(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap();
        fs::write(
            f.root.join("session.json"),
            r#"{"qc":"待审核","capture":"keep"}"#.as_bytes(),
        )
        .unwrap();
        let user = crate::model::UserIdentity {
            username: "alice".into(),
            display_name: "甲".into(),
            role: Some("operator".into()),
        };
        let entry = queue::DeferredReview {
            request: SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: None,
                source_hash: String::new(),
                expected_revision: 0,
                segments: vec![],
                status: Some("rejected".into()),
                rejection_reason: Some("动作失范".into()),
            },
            output_hash: None,
            qc_content_hash: None,
            only_pending: true,
            audit: json!({"eventId":"11111111-1111-4111-8111-111111111111","action":"rejected","occurredAtMs":1792548000000u64,"details":{}}),
            error: "full".into(),
            created_at_ms: 0,
        };
        queue::store(&f.local, "s", "alice", entry.clone()).unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let result = queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!(result.written, 1);
        let before = fs::read(f.root.join("session.json")).unwrap();
        queue::store(&f.local, "s", "alice", entry.clone()).unwrap();
        assert_eq!(
            queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| Ok(()))
                .unwrap()
                .written,
            1
        );
        assert_eq!(fs::read(f.root.join("session.json")).unwrap(), before);
        fs::write(f.root.join("session.json"), r#"{"qc":"通过"}"#.as_bytes()).unwrap();
        queue::store(&f.local, "s", "alice", entry).unwrap();
        let result = queue::publish_with_probe(&f.local, "s", &user, &cancel, &|_| Ok(())).unwrap();
        assert_eq!((result.written, result.remaining), (0, 1));
        assert_eq!(
            fs::read(f.root.join("session.json")).unwrap(),
            r#"{"qc":"通过"}"#.as_bytes()
        );
    }

    #[test]
    fn grouped_moved_batches_keep_conclusions_and_structural_edits_on_fresh_hosts() {
        for selected in [
            machine_annotation::DEFAULT_SOURCE,
            "./description.json",
            "./desorption.json",
        ] {
            let f = Fixture::new(0, true);
            let state = load_selected(&f.local, &f.root, None).unwrap();
            f.save(&state).unwrap();
            let root = f.temp.join("Delta-D1/D1 daily/2026-09-16-Test/sample");
            fs::create_dir_all(root.parent().unwrap()).unwrap();
            fs::rename(&f.root, &root).unwrap();
            if selected.ends_with("desorption.json") {
                fs::rename(root.join(OUTPUT), root.join("desorption.json")).unwrap();
            }
            let mut state = load_selected(&f.temp.join("new-host"), &root, Some(selected)).unwrap();
            let mut segments = state.segments.clone();
            segments[1].deleted = true;
            segments[0].description = "目录移动后保留文字".into();
            segments.push(ReviewSegment {
                source_index: 3,
                start_frame: 1,
                end_frame: 2,
                description: "新增片段".into(),
                deleted: false,
                decision: "pending".into(),
            });
            for status in ["pending", "approved", "rejected"] {
                state = save_for_user(
                    &f.temp.join("new-host"),
                    SaveReviewRequest {
                        source_path: root.to_string_lossy().into(),
                        source_name: Some(selected.into()),
                        source_hash: state.source_hash.clone(),
                        expected_revision: state.revision,
                        segments: segments.clone(),
                        status: Some(status.into()),
                        rejection_reason: Some("动作失范".into()),
                    },
                    "QA",
                    "qa",
                )
                .unwrap();
                let other = load_selected(
                    &f.temp.join(format!("fresh-{status}")),
                    &root,
                    Some(selected),
                )
                .unwrap();
                assert_eq!(view_for_root(&root, other.clone()).qc_status, status);
                assert_eq!(other.status, status);
                let output = if selected.ends_with("desorption.json") {
                    "desorption.json"
                } else {
                    OUTPUT
                };
                let doc: Value =
                    serde_json::from_slice(&fs::read(root.join(output)).unwrap()).unwrap();
                let annotations = doc["episode_results"][0]["annotations"].as_array().unwrap();
                assert_eq!(
                    annotations.len(),
                    3,
                    "deleted one and added one: {selected}, {status}"
                );
                assert!(!annotations.iter().any(|a| a["segment_id"] == "seg1"));
                assert!(other
                    .segments
                    .iter()
                    .any(|s| !s.deleted && s.description == "新增片段"));
                assert_eq!(
                    other.segments.iter().filter(|s| !s.deleted).count(),
                    3,
                    "{selected}, {status}"
                );
            }
        }
    }

    #[test]
    #[ignore = "Local metadata-only reproduction; writes solely into a temporary fixture"]
    fn moved_private_metadata_roundtrip() {
        let original = PathBuf::from(std::env::var("DELTA_LAYOUT_SAMPLE").unwrap());
        let f = Fixture::new(0, true);
        let root = f.temp.join(original.file_name().unwrap());
        fs::create_dir_all(root.join(".session_meta")).unwrap();
        for name in [
            "description.json",
            "session.json",
            ".session_meta/bailian_annotation.qwen3.8-flash.json",
            ".session_meta/manifest.json",
        ] {
            fs::copy(original.join(name), root.join(name)).unwrap();
        }
        let state = load_selected(&f.local, &root, None).unwrap();
        let ann = machine_annotation::load_for_review(&root, None)
            .unwrap()
            .unwrap();
        let mut edits = state.segments.clone();
        edits[0].deleted = true;
        edits.push(ReviewSegment {
            source_index: edits.iter().map(|s| s.source_index).max().unwrap() + 1,
            start_frame: 0,
            end_frame: 1,
            description: "隔离新增片段".into(),
            deleted: false,
            decision: "pending".into(),
        });
        let saved = save_for_user(
            &f.local,
            SaveReviewRequest {
                source_path: root.to_string_lossy().into(),
                source_name: Some(ann.source_name),
                source_hash: state.source_hash,
                expected_revision: state.revision,
                segments: edits,
                status: Some("rejected".into()),
                rejection_reason: Some("动作失范".into()),
            },
            "QA",
            "qa",
        )
        .unwrap();
        let loaded = load_selected(&f.temp.join("fresh-account"), &root, None).unwrap();
        assert_eq!(loaded.status, "rejected");
        assert_eq!(view_for_root(&root, loaded.clone()).qc_status, "rejected");
        assert!(loaded
            .segments
            .iter()
            .any(|s| s.description == "隔离新增片段"));
        assert_eq!(
            loaded.segments.iter().filter(|s| !s.deleted).count(),
            saved.segments.iter().filter(|s| !s.deleted).count()
        );
    }

    struct Fixture {
        temp: PathBuf,
        root: PathBuf,
        local: PathBuf,
        original: Vec<u8>,
    }
    impl Fixture {
        fn new(base: u64, exclusive: bool) -> Self {
            let temp = std::env::temp_dir().join(format!(
                "dohc-review-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let root = temp.join("sample");
            let local = temp.join("local");
            fs::create_dir_all(&root).unwrap();
            let annotations: Vec<_> = (0..3).map(|index| json!({
                "id":format!("ann{index}"), "segment_id":format!("seg{index}"), "label_code":"phase_test",
                "start_frame":index*10 + base, "end_frame":index*10 + 9 + base + u64::from(exclusive),
                "attributes":{"semantic_description":format!("action {index}"),"body_part":"right_hand","unknown":[null,7,{"keep":true}]},
                "confidence":0.987, "provenance":{"untouched":true}
            })).collect();
            let segments: Vec<_> = annotations.iter().map(|item| json!({
                "segment_id":item["segment_id"], "annotation_id":item["id"], "label_code":item["label_code"],
                "start_frame":item["start_frame"],"end_frame":item["end_frame"],"extra":"keep"
            })).collect();
            let document = json!({"schema_version":3,"model_metadata":{"nested":[1,2,3]},"episode_results":[{
                "episode_id":"sample", "media":{"frame_count":30,"frame_index_base":base,"interval_convention":if exclusive {"[start,end)"} else {"[start,end]"}},
                "annotation_count":3,"annotations":annotations,"segments":segments,"quality":{"validation_status":"passed","custom":"keep"}
            },{"episode_id":"other","media":{"frame_count":1},"annotations":[],"unknown":42}]});
            let original = serde_json::to_vec(&document).unwrap();
            fs::write(root.join("bailian_annotation.json"), &original).unwrap();
            Self {
                temp,
                root,
                local,
                original,
            }
        }
        fn save(&self, state: &ReviewState) -> AppResult<ReviewState> {
            save(
                &self.local,
                SaveReviewRequest {
                    status: None,
                    source_path: self.root.to_string_lossy().into(),
                    source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
                    rejection_reason: Some("骨架抖动".into()),
                    segments: state.segments.clone(),
                },
                "reviewer",
            )
        }
        fn output(&self) -> Value {
            serde_json::from_slice(&fs::read(self.root.join(OUTPUT)).unwrap()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp);
        }
    }

    #[test]
    fn current_root_qc_does_not_inherit_local_or_shared_approval() {
        let f = Fixture::new(0, true);
        let mut state = load(&f.local, &f.root).unwrap();
        state.status = "approved".into();
        state.published = true;
        state.revision = 7;
        state.reviewer_username = "another-account".into();
        state.output_hash = Some("deleted-output".into());
        let root = f.root.canonicalize().unwrap();
        fs::create_dir_all(f.local.join("machine-reviews")).unwrap();
        atomic_json(
            &draft_path(&f.local, &root),
            &serde_json::to_value(&state).unwrap(),
        )
        .unwrap();
        let recovered = load(&f.local, &f.root).unwrap();
        assert!(!recovered.published);
        assert_eq!(recovered.segments, state.segments);
        assert_eq!(recovered.revision, 7);
        assert_eq!(view_for_root(&f.root, recovered).qc_status, "pending");
        state.output_hash = None;
        atomic_json(
            &draft_path(&f.local, &root),
            &serde_json::to_value(&state).unwrap(),
        )
        .unwrap();
        assert!(!load(&f.local, &f.root).unwrap().published);
        // A shared historical result is equally insufficient: root QC is current.
        let document = reviewed_document(&source(&f.root).unwrap(), &state).unwrap();
        let output = serde_json::to_vec(&document).unwrap();
        fs::write(f.root.join(OUTPUT), &output).unwrap();
        let shared = load(&f.temp.join("fresh-host"), &f.root).unwrap();
        assert_eq!(shared.status, "approved");
        assert!(shared.published);
        assert_eq!(view_for_root(&f.root, shared).qc_status, "pending");
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), output);
        for qc in [Value::Null, json!(""), json!("待审核"), json!("未审核")] {
            let raw = serde_json::to_vec(&json!({"qc": qc, "capture": "keep"})).unwrap();
            fs::write(f.root.join("session.json"), &raw).unwrap();
            let view = view_for_root(&f.root, state.clone());
            assert_eq!(view.qc_status, "pending");
            assert_eq!(view.review.status, "approved");
            assert_eq!(fs::read(f.root.join("session.json")).unwrap(), raw);
        }
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn current_qc_is_read_again_after_external_changes_and_errors_are_not_approval() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        for (qc, expected, reason) in [
            (json!("通过"), "approved", ""),
            (json!("不通过：动作失范"), "rejected", "动作失范"),
            (json!("不通过:状态异常"), "rejected", "状态异常"),
            (json!("待审核"), "pending", ""),
            (json!(true), "unknown", ""),
            (json!("异常"), "unknown", ""),
        ] {
            fs::write(
                f.root.join("session.json"),
                serde_json::to_vec(&json!({"qc": qc})).unwrap(),
            )
            .unwrap();
            let view = view_for_root(&f.root, state.clone());
            assert_eq!(view.qc_status, expected);
            assert_eq!(view.qc_rejection_reason, reason);
            assert_eq!(!view.qc_status_error.is_empty(), expected == "unknown");
        }
        for bytes in [b"{".as_slice(), b"[]"] {
            fs::write(f.root.join("session.json"), bytes).unwrap();
            let view = view_for_root(&f.root, state.clone());
            assert_eq!(view.qc_status, "unknown");
            assert!(!view.qc_status_error.is_empty());
        }
        // A read failure must not fall back to the previous successful QC read.
        fs::remove_file(f.root.join("session.json")).unwrap();
        fs::create_dir(f.root.join("session.json")).unwrap();
        assert_eq!(view_for_root(&f.root, state).qc_status, "unknown");
    }

    #[test]
    fn account_reviews_persist_across_restart_rename_other_reviewers_and_fresh_hosts() {
        let f = Fixture::new(0, true);
        let initial = load(&f.local, &f.root).unwrap();
        let request = |status: &str| SaveReviewRequest {
            source_path: f.root.to_string_lossy().into(),
            source_name: None,
            source_hash: initial.source_hash.clone(),
            expected_revision: initial.revision,
            segments: initial.segments.clone(),
            status: Some(status.into()),
            rejection_reason: Some("镜头遮挡".into()),
        };
        let saved = save_for_user(&f.local, request("rejected"), "同名审核员", "alice").unwrap();
        assert_eq!(saved.reviewer_username, "alice");
        let root = f.root.canonicalize().unwrap();
        let paths = vec![root.to_string_lossy().into_owned()];
        let alice = list_account_reviews(&f.local, &paths, "alice").unwrap();
        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].status, "rejected");
        assert_eq!(alice[0].rejection_reason, "镜头遮挡");
        assert!(list_account_reviews(&f.local, &paths, "bob")
            .unwrap()
            .is_empty());
        let session: Value =
            serde_json::from_slice(&fs::read(root.join("session.json")).unwrap()).unwrap();
        assert_eq!(session["qc"], "不通过：镜头遮挡");
        assert_eq!(session["reviewerUsername"], "alice");
        assert_eq!(session["qcReviewers"]["alice"]["username"], "alice");
        assert!(session["qcReviewers"]["alice"].get("sourcePath").is_none());
        save_for_user(&f.local, request("approved"), "同名审核员", "bob").unwrap();
        assert_eq!(
            list_account_reviews(&f.local, &paths, "alice").unwrap()[0].status,
            "rejected"
        );
        assert_eq!(
            list_account_reviews(&f.local, &paths, "bob").unwrap()[0].status,
            "approved"
        );
        let fresh_host = f.temp.join("fresh-host");
        assert_eq!(
            list_account_reviews(&fresh_host, &paths, "alice").unwrap()[0].status,
            "rejected"
        );
        save_for_user(&f.local, request("approved"), "改名后的审核员", "alice").unwrap();
        let renamed = list_account_reviews(&fresh_host, &paths, "alice").unwrap();
        assert_eq!(renamed[0].reviewer_name, "改名后的审核员");
        assert_eq!(renamed[0].status, "approved");
        save_for_user(&f.local, request("pending"), "改名后的审核员", "alice").unwrap();
        assert_eq!(
            list_account_reviews(&f.local, &paths, "alice").unwrap()[0].status,
            "pending"
        );
        assert_eq!(
            list_account_reviews(&f.local, &paths, "bob").unwrap()[0].status,
            "approved"
        );
        fs::remove_file(root.join("session.json")).unwrap();
        assert_eq!(
            list_account_reviews(&f.local, &paths, "alice").unwrap()[0].status,
            "pending"
        );
    }

    #[test]
    fn account_link_is_not_created_for_plain_edits_or_failed_saves() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        let paths = vec![f
            .root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()];
        f.save(&state).unwrap();
        assert!(list_account_reviews(&f.local, &paths, "reviewer")
            .unwrap()
            .is_empty());
        fs::write(f.root.join("session.json"), b"[]").unwrap();
        let request = SaveReviewRequest {
            source_path: f.root.to_string_lossy().into(),
            source_name: None,
            source_hash: state.source_hash,
            expected_revision: state.revision,
            segments: state.segments,
            status: Some("approved".into()),
            rejection_reason: None,
        };
        assert!(save_for_user(&f.local, request, "审核员", "alice").is_err());
        assert!(list_account_reviews(&f.local, &paths, "alice")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_missing_invalid_and_empty_other_reasons_without_writing() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        for reason in [
            None,
            Some(""),
            Some(" "),
            Some("其他原因"),
            Some("其他原因： \n "),
            Some("无效类别"),
        ] {
            let request = SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: None,
                source_hash: state.source_hash.clone(),
                expected_revision: state.revision,
                segments: state.segments.clone(),
                status: Some("rejected".into()),
                rejection_reason: reason.map(str::to_string),
            };
            assert!(save(&f.local, request, "审核员").is_err());
            assert!(!f.root.join(OUTPUT).exists());
            assert!(!f.root.join("session.json").exists());
        }
        assert!(validated_rejection_reason(
            "rejected",
            Some(&format!("其他原因：{}", "字".repeat(1001)))
        )
        .is_err());
        assert_eq!(
            validated_rejection_reason("rejected", Some("其他原因：  视频缺帧 \n")).unwrap(),
            "其他原因：视频缺帧"
        );
    }

    #[test]
    fn rejection_reasons_and_revision_survive_public_reload_without_internal_flags() {
        let f = Fixture::new(0, true);
        fs::write(
            f.root.join("session.json"),
            br#"{"device":{"serial":"keep"},"decision":"approved","deleted":false}"#,
        )
        .unwrap();
        let mut state = load(&f.local, &f.root).unwrap();
        let reasons = [
            "轨迹不动",
            "无效数据",
            "任务不符",
            "动作过快",
            "状态异常",
            "动作失范",
            "骨架抖动",
            "镜头污渍",
            "动作错误",
            "画面过曝",
            "其他原因：视频缺帧",
        ];
        for (index, reason) in reasons.into_iter().enumerate() {
            let previous = state.version_id.clone();
            let request = SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: None,
                source_hash: state.source_hash.clone(),
                expected_revision: state.revision,
                segments: state.segments.clone(),
                status: Some("rejected".into()),
                rejection_reason: Some(reason.into()),
            };
            state = save(&f.local, request, "张审核").unwrap();
            assert_ne!(state.version_id, previous);
            assert_eq!(state.previous_version_id, previous);
            assert_eq!(
                state.revision_label,
                format!("{} · 审核不通过：{reason}", state.version_id)
            );
            let session: Value =
                serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
            assert_eq!(session["qc"], format!("不通过：{reason}"));
            assert_eq!(session["revision"], state.revision_label);
            assert_eq!(session["reviewerName"], "张审核");
            assert_eq!(session["device"]["serial"], "keep");
            assert!(session.get("decision").is_none() && session.get("deleted").is_none());
            let published = f.output();
            assert_eq!(published["_human_review"].as_object().unwrap().len(), 3);
            assert_eq!(published["_human_review"]["reviewer"], "张审核");
            assert!(published["_human_review"]["reviewedAt"]
                .as_str()
                .unwrap()
                .contains('T'));
            let technical =
                technical_review(&f.root.join(OUTPUT), state.output_hash.as_deref().unwrap())
                    .unwrap()
                    .unwrap();
            assert_eq!(technical.revision_label, session["revision"]);
            let reloaded = load(&f.temp.join(format!("another-host-{index}")), &f.root).unwrap();
            assert_eq!(reloaded.rejection_reason, reason);
            assert_eq!(reloaded.revision_label, state.revision_label);
            assert_eq!(reloaded.revision, state.revision);
            assert_eq!(reloaded.segments, state.segments);
        }
        state.segments[1].deleted = true;
        state = f.save(&state).unwrap();
        assert!(state.rejection_reason.is_empty());
        assert!(state.change_summary.contains("删除片段 1 段"));
        assert!(state.change_summary.contains("调整帧数 1 段"));
        assert!(state.change_summary.contains("改为待审核"));
        let reloaded = load(&f.temp.join("after-delete"), &f.root).unwrap();
        assert!(reloaded.segments[1].deleted);
        assert_eq!(reloaded.segments[2].start_frame, 10);
        let session: Value =
            serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
        assert_eq!(session["qc"], "待审核");
        assert!(session.get("reviewerName").is_none());
        assert!(session.get("reviewedAt").is_none());
    }
    #[test]
    fn qc_updates_root_session_only_and_preserves_capture_fields_and_fingerprint() {
        let f = Fixture::new(0, true);
        let original =
            json!({"session_id":"sample", "device":{"serial":"test"}, "frame_batches":30});
        fs::write(
            f.root.join("session.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        fs::create_dir(f.root.join(".session_meta")).unwrap();
        let hidden = b"{\"capture\":\"untouched\"}";
        fs::write(f.root.join(".session_meta/session.json"), hidden).unwrap();
        let before = crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap();
        let mut state = load(&f.local, &f.root).unwrap();
        for (status, qc) in [
            ("approved", "通过"),
            ("rejected", "不通过：骨架抖动"),
            ("pending", "待审核"),
        ] {
            state = save(
                &f.local,
                SaveReviewRequest {
                    source_path: f.root.to_string_lossy().into(),
                    source_name: None,
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
                    rejection_reason: Some("骨架抖动".into()),
                    segments: state.segments.clone(),
                    status: Some(status.into()),
                },
                "reviewer",
            )
            .unwrap();
            let mut actual: Value =
                serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
            assert_eq!(
                actual.as_object_mut().unwrap().remove("revision"),
                Some(json!(state.revision_label))
            );
            assert_eq!(
                actual.as_object_mut().unwrap().remove("appVersion"),
                Some(json!(env!("CARGO_PKG_VERSION")))
            );
            let reviewer_username = actual.as_object_mut().unwrap().remove("reviewerUsername");
            let account_reviewers = actual.as_object_mut().unwrap().remove("qcReviewers");
            if status == "pending" {
                assert!(reviewer_username.is_none());
            } else {
                assert_eq!(reviewer_username, Some(json!("reviewer")));
            }
            let account = account_reviewers
                .as_ref()
                .and_then(|value| value.get("reviewer"))
                .expect("account reviewer record");
            assert_eq!(account["username"], "reviewer");
            assert_eq!(
                actual.as_object_mut().unwrap().remove("qc"),
                Some(json!(qc))
            );
            if status == "pending" {
                assert!(actual.get("reviewerName").is_none());
                assert!(actual.get("reviewedAt").is_none());
            } else {
                assert_eq!(
                    actual.as_object_mut().unwrap().remove("reviewerName"),
                    Some(json!("reviewer"))
                );
                let timestamp = actual
                    .as_object_mut()
                    .unwrap()
                    .remove("reviewedAt")
                    .unwrap();
                let expected = time::OffsetDateTime::from_unix_timestamp_nanos(
                    i128::from(state.updated_at_ms) * 1_000_000,
                )
                .unwrap()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
                assert_eq!(timestamp, json!(expected));
            }
            assert_eq!(actual, original);
            assert_eq!(
                fs::read(f.root.join(".session_meta/session.json")).unwrap(),
                hidden
            );
            assert_eq!(
                crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap(),
                before
            );
        }
        fs::write(f.root.join("session.json"), b"{\"session_id\":\"changed\"}").unwrap();
        assert_ne!(
            crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap(),
            before
        );
        fs::write(f.root.join("session.json"), b"[]").unwrap();
        let output = fs::read(f.root.join(OUTPUT)).unwrap();
        assert!(f
            .save(&state)
            .unwrap_err()
            .to_string()
            .contains("JSON 对象"));
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), output);
        assert_eq!(fs::read(f.root.join("session.json")).unwrap(), b"[]");
    }

    #[test]
    fn deleted_records_are_absent_from_public_json_and_frames_align_in_both_arrays() {
        for (base, exclusive) in [(0, true), (1, false)] {
            let f = Fixture::new(base, exclusive);
            let mut state = load(&f.local, &f.root).unwrap();
            state.segments[1].deleted = true;
            let saved = f.save(&state).unwrap();
            assert_eq!(saved.segments[2].start_frame, 10);
            assert_eq!(saved.segments[2].end_frame, 29);
            let output = f.output();
            for name in ["annotations", "segments"] {
                let values = output["episode_results"][0][name].as_array().unwrap();
                assert_eq!(values.len(), 2);
                assert_eq!(values[1]["start_frame"], 10 + base);
                assert_eq!(values[1]["end_frame"], 29 + base + u64::from(exclusive));
            }
            assert_eq!(output["_human_review"].as_object().unwrap().len(), 3);
            let technical =
                technical_review(&f.root.join(OUTPUT), saved.output_hash.as_deref().unwrap())
                    .unwrap()
                    .unwrap();
            assert!(technical.segments[1].deleted);
            assert_eq!(technical.segments[2].start_frame, 10);
            let reopened = load(&f.temp.join("new-host"), &f.root).unwrap();
            assert_eq!(reopened.segments, saved.segments);
            assert_eq!(
                fs::read(f.root.join("bailian_annotation.json")).unwrap(),
                f.original
            );
            let mut retry = reopened.clone();
            retry.segments[2].description = "new edit".into();
            f.save(&retry).unwrap();
            assert_eq!(
                f.output()["episode_results"][0]["annotations"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires DOHC_REVIEW_GVFS_ROOT pointing to a writable test share with a matching CIFS mount"]
    fn gvfs_review_repeated_save_approval_and_cross_mount_lock() {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let f = Fixture::new(0, true);
        let share = PathBuf::from(std::env::var_os("DOHC_REVIEW_GVFS_ROOT").expect("test share"));
        let network_temp = share.join(f.temp.file_name().unwrap());
        let native_temp = storage::review_write_root(&share)
            .unwrap()
            .join(f.temp.file_name().unwrap());
        fs::create_dir(&native_temp).unwrap();
        let _cleanup = Cleanup(native_temp.clone());
        let root = network_temp.join("sample");
        let native_root = native_temp.join("sample");
        fs::create_dir(&native_root).unwrap();
        fs::write(native_root.join("bailian_annotation.json"), &f.original).unwrap();
        let mut state = load(&f.local, &root).unwrap();
        let save_request = |state: &ReviewState, status: &str| SaveReviewRequest {
            source_path: root.to_string_lossy().into(),
            source_name: None,
            source_hash: state.source_hash.clone(),
            expected_revision: state.revision,
            rejection_reason: Some("骨架抖动".into()),
            segments: state.segments.clone(),
            status: Some(status.into()),
        };
        state = save(&f.local, save_request(&state, "pending"), "fixture").unwrap();
        state.segments[1].deleted = true;
        let saved = save(&f.local, save_request(&state, "approved"), "fixture").unwrap();
        assert_eq!(saved.status, "approved");
        assert_eq!(saved.segments[2].start_frame, 10);
        assert_eq!(load(&f.local, &root).unwrap().revision, 2);
        let output: Value =
            serde_json::from_slice(&fs::read(native_root.join(OUTPUT)).unwrap()).unwrap();
        assert_eq!(
            output["episode_results"][0]["annotations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let session: Value =
            serde_json::from_slice(&fs::read(native_root.join("session.json")).unwrap()).unwrap();
        assert_eq!(session["qc"], "通过");
        let _lock = lock_file(&native_root.join(".description.lock")).unwrap();
        assert!(save(&f.local, save_request(&saved, "rejected"), "fixture")
            .unwrap_err()
            .to_string()
            .contains("另一进程"));
        assert_eq!(
            fs::read(native_root.join("bailian_annotation.json")).unwrap(),
            f.original
        );
    }

    #[test]
    fn split_and_added_segments_roundtrip_with_model_metadata() {
        let fixture = Fixture::new(0, true);
        let mut state = load(&fixture.local, &fixture.root).unwrap();
        state.segments[0].end_frame = 3;
        state.segments.push(ReviewSegment {
            source_index: 3,
            start_frame: 4,
            end_frame: 9,
            description: "新增人工片段".into(),
            deleted: false,
            decision: "pending".into(),
        });
        state = fixture.save(&state).unwrap();
        let document = fixture.output();
        let episode = &document["episode_results"][0];
        assert_eq!(episode["annotations"].as_array().unwrap().len(), 4);
        assert_eq!(episode["segments"].as_array().unwrap().len(), 4);
        assert_eq!(
            episode["annotations"][3]["attributes_zh"]["动作描述"],
            "新增人工片段"
        );
        assert_eq!(episode["annotations"][3]["label_code"], "phase_test");
        assert_eq!(episode["annotations"][3]["provenance"]["untouched"], true);
        assert_eq!(
            load(&fixture.local, &fixture.root).unwrap().segments,
            state.segments
        );
        state.segments[3].deleted = true;
        fixture.save(&state).unwrap();
        assert_eq!(
            fixture.output()["episode_results"][0]["annotations"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            fixture.output()["episode_results"][0]["segments"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn unsorted_model_uses_original_source_index_for_edits() {
        let fixture = Fixture::new(0, true);
        let mut raw: Value = serde_json::from_slice(&fixture.original).unwrap();
        raw["episode_results"][0]["annotations"]
            .as_array_mut()
            .unwrap()
            .swap(0, 2);
        fs::write(
            fixture.root.join(machine_annotation::DEFAULT_SOURCE),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        let mut state = load(&fixture.local, &fixture.root).unwrap();
        let first = state
            .segments
            .iter_mut()
            .find(|item| item.start_frame == 0)
            .unwrap();
        assert_eq!(first.source_index, 2);
        first.description = "起始动作修改".into();
        fixture.save(&state).unwrap();
        assert_eq!(
            fixture.output()["episode_results"][0]["annotations"][2]["attributes_zh"]["动作描述"],
            "起始动作修改"
        );
    }

    #[test]
    fn malformed_optional_attributes_survive_edits_approval_and_fresh_reload() {
        let f = Fixture::new(0, true);
        let mut document: Value = serde_json::from_slice(&f.original).unwrap();
        let row = &mut document["episode_results"][0]["annotations"][1];
        row["attributes"] = json!([
            {"T":"interaction_method","unexpected_key":"legacy","untouched":true},
            {"T":"semantic_description","value":"Original English"}
        ]);
        row["attributes_zh"] = json!([{"T":"动作描述","value":"原中文","extra":42}]);
        let raw = serde_json::to_vec(&document).unwrap();
        fs::write(f.root.join(machine_annotation::DEFAULT_SOURCE), &raw).unwrap();
        let mut state = load(&f.local, &f.root).unwrap();
        assert_eq!(state.segments.len(), 3);
        assert_eq!(state.segments[1].description, "原中文");
        state.segments[1].description = "人工修改中文".into();
        let saved = save_for_user(
            &f.local,
            SaveReviewRequest {
                source_path: f.root.to_string_lossy().into(),
                source_name: Some(machine_annotation::DEFAULT_SOURCE.into()),
                source_hash: state.source_hash,
                expected_revision: state.revision,
                segments: state.segments,
                status: Some("approved".into()),
                rejection_reason: None,
            },
            "Reviewer",
            "reviewer",
        )
        .unwrap();
        let output = f.output();
        let result = &output["episode_results"][0]["annotations"][1];
        assert_eq!(
            result["attributes"],
            document["episode_results"][0]["annotations"][1]["attributes"]
        );
        assert_eq!(result["attributes_zh"][0]["value"], "人工修改中文");
        assert_eq!(result["attributes_zh"][0]["extra"], 42);
        let fresh = load(&f.temp.join("fresh"), &f.root).unwrap();
        assert_eq!(fresh.segments, saved.segments);
        assert_eq!(fresh.status, "approved");
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            raw
        );
    }

    #[test]
    fn flash_source_is_selected_and_reviewed_independently_with_bilingual_fields_preserved() {
        let fixture = Fixture::new(0, true);
        let mut document: Value = serde_json::from_slice(&fixture.original).unwrap();
        document["schema_version"] = 4.into();
        for value in document["episode_results"][0]["annotations"]
            .as_array_mut()
            .unwrap()
        {
            value["attributes"] = json!([
                {"T":"semantic_description","value":"Standing","extra":"keep"},
                {"T":"body_part","value":"双手"}
            ]);
            value["attributes_zh"] = json!([
                {"T":"动作描述","value":"静止状态","extra":42},
                {"T":"身体部位","value":"双手"}
            ]);
            value["task"] =
                json!({"description":"Make bed","description_zh":"整理床铺","direction":"正向"});
        }
        let raw = serde_json::to_vec(&document).unwrap();
        fs::write(fixture.root.join(machine_annotation::FLASH_SOURCE), &raw).unwrap();
        let annotation = machine_annotation::load_selected(&fixture.root, None)
            .unwrap()
            .unwrap();
        assert_eq!(annotation.source_name, machine_annotation::FLASH_SOURCE);
        let mut flash = load_selected(&fixture.local, &fixture.root, None).unwrap();
        flash.segments[0].description = "双手整理被子".into();
        flash.segments[0].end_frame = 7;
        flash.segments[1].start_frame = 8;
        flash.segments[2].deleted = true;
        let save_flash = |state: &ReviewState| {
            save(
                &fixture.local,
                SaveReviewRequest {
                    status: None,
                    source_path: fixture.root.to_string_lossy().into(),
                    source_name: Some(machine_annotation::FLASH_SOURCE.into()),
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
                    rejection_reason: Some("骨架抖动".into()),
                    segments: state.segments.clone(),
                },
                "reviewer",
            )
            .unwrap()
        };
        flash = save_flash(&flash);
        assert!(fixture.root.join(FLASH_OUTPUT).exists());
        assert_eq!(
            load(&fixture.local, &fixture.root).unwrap().revision,
            flash.revision
        );
        for segment in &mut flash.segments {
            segment.decision = "approved".into();
        }
        save_flash(&flash);
        let output: Value =
            serde_json::from_slice(&fs::read(fixture.root.join(FLASH_OUTPUT)).unwrap()).unwrap();
        let mut expected = document.clone();
        let episode = &mut expected["episode_results"][0];
        episode["annotations"][0]["attributes_zh"][0]["value"] = "双手整理被子".into();
        for key in ["annotations", "segments"] {
            episode[key][0]["end_frame"] = 8.into();
            episode[key][1]["start_frame"] = 8.into();
            episode[key].as_array_mut().unwrap().pop();
        }
        episode["annotation_count"] = 2.into();
        let mut actual = output;
        actual.as_object_mut().unwrap().remove("_human_review");
        assert_eq!(actual, expected);
        let mut original_review = load(&fixture.local, &fixture.root).unwrap();
        for segment in &mut original_review.segments {
            segment.decision = "approved".into();
        }
        fixture.save(&original_review).unwrap();
        assert!(fixture.root.join(OUTPUT).exists());
        // Switching the reference model keeps the shared human description.
        let reopened = load_selected(
            &fixture.local,
            &fixture.root,
            Some(machine_annotation::FLASH_SOURCE),
        )
        .unwrap();
        assert_eq!(
            reopened
                .segments
                .iter()
                .filter(|item| !item.deleted)
                .count(),
            2
        );
        assert_eq!(reopened.segments[0].description, "双手整理被子");
        assert_eq!(
            fs::read(fixture.root.join(machine_annotation::FLASH_SOURCE)).unwrap(),
            raw
        );
        assert_eq!(
            fs::read(fixture.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            fixture.original
        );
        assert!(is_review_path(
            &fixture.root,
            &fixture.root.join(FLASH_OUTPUT)
        ));
    }

    #[test]
    #[ignore = "Requires a private Flash sample; writes only to a temporary fixture"]
    fn selected_flash_sample_roundtrips_in_a_temporary_directory() {
        let path = PathBuf::from(std::env::var("DOHC_MACHINE_SAMPLE_ROOT").unwrap());
        let source_bytes =
            machine_annotation::read_bytes(&path.join(machine_annotation::FLASH_SOURCE))
                .unwrap()
                .unwrap();
        let loaded =
            machine_annotation::load_selected(&path, Some(machine_annotation::FLASH_SOURCE))
                .unwrap()
                .unwrap();
        let fixture = Fixture::new(0, true);
        let root = fixture.temp.join(path.file_name().unwrap());
        fs::create_dir(&root).unwrap();
        fs::write(root.join(machine_annotation::FLASH_SOURCE), &source_bytes).unwrap();
        let mut state = load_selected(&fixture.local, &root, None).unwrap();
        assert_eq!(state.segments.len(), loaded.segments.len());
        for segment in &mut state.segments {
            segment.decision = "approved".into();
        }
        save(
            &fixture.local,
            SaveReviewRequest {
                status: None,
                source_path: root.to_string_lossy().into(),
                source_name: Some(machine_annotation::FLASH_SOURCE.into()),
                source_hash: state.source_hash.clone(),
                expected_revision: 0,
                rejection_reason: Some("骨架抖动".into()),
                segments: state.segments,
            },
            "fixture-reviewer",
        )
        .unwrap();
        let mut output: Value =
            serde_json::from_slice(&fs::read(root.join(FLASH_OUTPUT)).unwrap()).unwrap();
        output.as_object_mut().unwrap().remove("_human_review");
        assert_eq!(
            output,
            serde_json::from_slice::<Value>(&source_bytes).unwrap()
        );
        assert_eq!(
            fs::read(path.join(machine_annotation::FLASH_SOURCE)).unwrap(),
            source_bytes
        );
        let preview =
            crate::source::load_episode_preview(&path, None, &AtomicBool::new(false)).unwrap();
        let stream = preview
            .summary
            .streams
            .iter()
            .find(|stream| stream.name == "cam0")
            .unwrap();
        assert_eq!(loaded.frame_count, stream.frame_count);
        println!("Flash sample: {} segments, {} frames, camera range {:?}..{:?}, temporary roundtrip preserved every source field", loaded.segments.len(), loaded.frame_count, stream.first_frame, stream.last_frame);
    }

    #[test]
    fn drafts_approval_autosave_and_reopen_preserve_the_source_and_capture_identity() {
        let f = Fixture::new(0, true);
        let fingerprint =
            crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap();
        let mut state = load(&f.local, &f.root).unwrap();
        state.segments[0].description = "corrected".into();
        state.segments[0].decision = "rejected".into();
        state = f.save(&state).unwrap();
        assert!(f.root.join(OUTPUT).exists());
        assert_eq!(load(&f.local, &f.root).unwrap().segments, state.segments);
        state.segments[0].decision = "approved".into();
        state = f.save(&state).unwrap();
        assert!(f.root.join(OUTPUT).exists());
        for segment in &mut state.segments {
            segment.decision = "approved".into();
        }
        state = f.save(&state).unwrap();
        assert!(state.published);
        let source: Value = serde_json::from_slice(&f.original).unwrap();
        let mut expected = source.clone();
        expected["episode_results"][0]["annotations"][0]["attributes_zh"]["动作描述"] =
            json!("corrected");
        let mut output = f.output();
        output.as_object_mut().unwrap().remove("_human_review");
        assert_eq!(output, expected);
        state.segments[0].end_frame = 7;
        state.segments[0].decision = "pending".into();
        state.segments[1].start_frame = 8;
        state.segments[1].decision = "pending".into();
        state.segments[2].deleted = true;
        state = f.save(&state).unwrap();
        let output = f.output();
        let episode = &output["episode_results"][0];
        assert_eq!(episode["annotation_count"], 2);
        assert_eq!(episode["annotations"][0]["end_frame"], 8);
        assert_eq!(episode["annotations"][1]["start_frame"], 8);
        assert_eq!(episode["segments"][0]["end_frame"], 8);
        assert_eq!(episode["segments"].as_array().unwrap().len(), 2);
        assert_eq!(
            episode["annotations"][0]["attributes"]["unknown"],
            source["episode_results"][0]["annotations"][0]["attributes"]["unknown"]
        );
        assert_eq!(output["episode_results"][1], source["episode_results"][1]);
        assert_eq!(load(&f.local, &f.root).unwrap().segments, state.segments);
        assert_eq!(
            load(&f.temp.join("another-host"), &f.root)
                .unwrap()
                .segments,
            state.segments
        );
        assert_eq!(
            fs::read(f.root.join("bailian_annotation.json")).unwrap(),
            f.original
        );
        assert_eq!(
            crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap(),
            fingerprint
        );
    }

    #[test]
    fn whole_episode_decisions_have_unique_versions_and_edits_reset_approval() {
        let f = Fixture::new(0, true);
        let mut state = load(&f.local, &f.root).unwrap();
        let save_status = |state: &ReviewState, status: &str| {
            save(
                &f.local,
                SaveReviewRequest {
                    source_path: f.root.to_string_lossy().into(),
                    source_name: None,
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
                    rejection_reason: Some("骨架抖动".into()),
                    segments: state.segments.clone(),
                    status: Some(status.into()),
                },
                "reviewer",
            )
        };
        state.segments[0].description = "整理床单".into();
        state = f.save(&state).unwrap();
        assert_eq!(state.status, "pending");
        assert_eq!(state.version_id.len(), 32);
        assert_eq!(
            f.output()["episode_results"][0]["annotations"][0]["attributes_zh"]["动作描述"],
            "整理床单"
        );
        assert_eq!(
            f.output()["episode_results"][0]["annotations"][0]["attributes"]
                ["semantic_description"],
            "action 0"
        );
        let first = state.version_id.clone();
        state = save_status(&state, "approved").unwrap();
        assert_eq!(state.status, "approved");
        assert_eq!(state.previous_version_id, first);
        assert_ne!(state.version_id, first);
        assert_eq!(f.output()["_human_review"]["status"], "approved");
        state.segments[1].deleted = true;
        state = f.save(&state).unwrap();
        assert_eq!(state.status, "pending");
        assert_eq!(
            f.output()["episode_results"][0]["annotations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        state = save_status(&state, "rejected").unwrap();
        assert_eq!(f.output()["_human_review"]["status"], "rejected");
        for item in &mut state.segments {
            item.deleted = true;
        }
        assert!(save_status(&state, "approved").is_err());
        state = save_status(&state, "rejected").unwrap();
        assert_eq!(f.output()["episode_results"][0]["annotations"], json!([]));
        assert_eq!(
            load(&f.temp.join("other-host"), &f.root)
                .unwrap()
                .version_id,
            state.version_id
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn migrates_legacy_review_without_modifying_legacy_or_source_files() {
        let f = Fixture::new(0, true);
        let annotation = source(&f.root).unwrap();
        let mut old = initial(&annotation);
        old.workflow_version = 0;
        old.revision = 5;
        old.published = true;
        old.segments[0].description = "旧版人工修改".into();
        let legacy = reviewed_document(&annotation, &old).unwrap();
        old.output_hash = Some(atomic_json(&f.root.join(LEGACY_OUTPUT), &legacy).unwrap());
        let path = draft_path(&f.local, &f.root.canonicalize().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic_json(&path, &serde_json::to_value(&old).unwrap()).unwrap();
        let restored = load(&f.local, &f.root).unwrap();
        assert_eq!(restored.revision, 5);
        let saved = f.save(&restored).unwrap();
        assert_eq!(saved.revision, 6);
        assert_eq!(saved.workflow_version, 4);
        assert_eq!(saved.segments[0].description, "旧版人工修改");
        assert_eq!(
            load(&f.local, &f.root).unwrap().version_id,
            saved.version_id
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(f.root.join(LEGACY_OUTPUT)).unwrap())
                .unwrap(),
            legacy
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn output_preserves_declared_frame_base_and_interval_convention() {
        for (base, exclusive) in [(0, true), (1, true), (0, false), (1, false)] {
            let f = Fixture::new(base, exclusive);
            let annotation = source(&f.root).unwrap();
            let mut state = initial(&annotation);
            state.segments[0].start_frame = 2;
            state.segments[0].end_frame = 7;
            let output = reviewed_document(&annotation, &state).unwrap();
            for key in ["annotations", "segments"] {
                assert_eq!(
                    output["episode_results"][0][key][0]["start_frame"],
                    2 + base
                );
                assert_eq!(
                    output["episode_results"][0][key][0]["end_frame"],
                    7 + base + u64::from(exclusive)
                );
            }
        }
    }

    #[test]
    fn old_duplicate_indices_and_status_restore_without_losing_human_edits() {
        let f = Fixture::new(0, true);
        let mut old = load(&f.local, &f.root).unwrap();
        old.segments[1].source_index = 0;
        old.segments[2].source_index = 3;
        old.segments[1].decision = "legacy-status".into();
        old.segments[1].description = "保留人工修改的文字".into();
        let path = draft_path(&f.local, &f.root.canonicalize().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = serde_json::to_vec(&old).unwrap();
        fs::write(&path, &original).unwrap();
        let restored = load(&f.local, &f.root).unwrap();
        assert_eq!(restored.segments[1].description, "保留人工修改的文字");
        assert_eq!(restored.segments[1].start_frame, 10);
        assert_eq!(restored.segments[1].end_frame, 19);
        assert_eq!(restored.segments[2].source_index, 3);
        assert_ne!(restored.segments[1].source_index, 3);
        assert_eq!(
            restored
                .segments
                .iter()
                .map(|s| s.source_index)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        assert!(!restored.recovery_warnings.is_empty());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!f.root.join(OUTPUT).exists());
        let backup = f
            .local
            .join("machine-review-recovery")
            .join(format!("{}.json", blake3::hash(&original).to_hex()));
        assert_eq!(fs::read(backup).unwrap(), original);
        let saved = f.save(&restored).unwrap();
        assert!(saved.recovery_warnings.is_empty());
        assert_eq!(
            load(&f.temp.join("fresh"), &f.root)
                .unwrap()
                .segments
                .iter()
                .filter(|s| !s.deleted)
                .count(),
            3
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn unreadable_human_or_local_draft_keeps_the_machine_readable_and_original_backed_up() {
        for broken_draft in [false, true] {
            let f = Fixture::new(0, true);
            let path = if broken_draft {
                draft_path(&f.local, &f.root.canonicalize().unwrap())
            } else {
                f.root.join(OUTPUT)
            };
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let original = b"{\"old\": incomplete";
            fs::write(&path, original).unwrap();
            let restored = load(&f.local, &f.root).unwrap();
            assert_eq!(restored.segments.len(), 3);
            assert_eq!(restored.status, "pending");
            assert!(!restored.recovery_warnings.is_empty());
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(!f.root.join("session.json").exists());
            let backup = f
                .local
                .join("machine-review-recovery")
                .join(format!("{}.json", blake3::hash(original).to_hex()));
            assert_eq!(fs::read(backup).unwrap(), original);
            let saved = f.save(&restored).unwrap();
            assert_eq!(saved.segments.len(), 3);
            assert!(saved.recovery_warnings.is_empty());
            assert_eq!(
                fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
                f.original
            );
        }
    }

    #[test]
    fn invalid_old_ranges_preserve_exact_backup_and_load_the_machine_without_writing_qc() {
        let f = Fixture::new(0, true);
        let mut old = load(&f.local, &f.root).unwrap();
        old.segments[0].end_frame = 900;
        old.segments[0].description = "旧草稿越界内容保留".into();
        let path = draft_path(&f.local, &f.root.canonicalize().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = serde_json::to_vec(&old).unwrap();
        fs::write(&path, &original).unwrap();
        let restored = load(&f.local, &f.root).unwrap();
        assert_eq!(restored.segments[0].end_frame, 9);
        assert!(restored.recovery_warnings[0].contains("[0, 900]"));
        assert_eq!(restored.status, "pending");
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!f.root.join(OUTPUT).exists());
        assert!(!f.root.join("session.json").exists());
        assert!(f
            .save(&old)
            .unwrap_err()
            .to_string()
            .contains("第 1 个片段"));
        assert!(f.save(&restored).is_ok());
        let backup = f
            .local
            .join("machine-review-recovery")
            .join(format!("{}.json", blake3::hash(&original).to_hex()));
        assert_eq!(fs::read(backup).unwrap(), original);
    }

    #[test]
    fn legacy_shared_status_is_recovered_read_only_and_does_not_claim_approval() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        f.save(&state).unwrap();
        let mut doc = f.output();
        let legacy = technical_review(
            &f.root.join(OUTPUT),
            blake3::hash(&fs::read(f.root.join(OUTPUT)).unwrap())
                .to_hex()
                .as_ref(),
        )
        .unwrap()
        .unwrap();
        doc["_human_review"] = serde_json::to_value(legacy).unwrap();
        doc["_human_review"]["status"] = json!("legacy-approved");
        let original = serde_json::to_vec(&doc).unwrap();
        fs::write(f.root.join(OUTPUT), &original).unwrap();
        let fresh = f.temp.join("fresh");
        let restored = load(&fresh, &f.root).unwrap();
        assert_eq!(restored.status, "pending");
        assert!(!restored.recovery_warnings.is_empty());
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), original);
        let backup = fresh
            .join("machine-review-recovery")
            .join(format!("{}.json", blake3::hash(&original).to_hex()));
        assert_eq!(fs::read(backup).unwrap(), original);
    }

    #[test]
    fn human_result_with_old_directory_id_is_loaded_and_resaved_after_relocation() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        f.save(&state).unwrap();
        let mut doc = f.output();
        doc["episode_results"][0]["episode_id"] = json!("original_folder_009");
        doc["asset_id"] = json!("original_folder_009");
        let mut legacy = serde_json::to_value(
            technical_review(
                &f.root.join(OUTPUT),
                blake3::hash(&fs::read(f.root.join(OUTPUT)).unwrap())
                    .to_hex()
                    .as_ref(),
            )
            .unwrap()
            .unwrap(),
        )
        .unwrap();
        legacy["sourceHash"] = json!("older-model-hash");
        doc["_human_review"] = legacy;
        let original = serde_json::to_vec(&doc).unwrap();
        fs::write(f.root.join(OUTPUT), &original).unwrap();
        let restored = load(&f.temp.join("fresh"), &f.root).unwrap();
        assert_eq!(restored.segments.len(), 3);
        assert_eq!(fs::read(f.root.join(OUTPUT)).unwrap(), original);
        let saved = f.save(&restored).unwrap();
        assert_eq!(saved.status, "pending");
        assert_eq!(
            f.output()["episode_results"][0]["episode_id"],
            "original_folder_009"
        );
        assert_eq!(
            fs::read(f.root.join(machine_annotation::DEFAULT_SOURCE)).unwrap(),
            f.original
        );
    }

    #[test]
    fn accepts_stale_human_revisions_and_source_changes_but_rejects_invalid_edits() {
        let f = Fixture::new(0, true);
        let mut state = load(&f.local, &f.root).unwrap();
        let stale = state.clone();
        f.save(&state).unwrap();
        state = f.save(&stale).unwrap();
        assert_eq!(state.revision, 2);
        let mut invalid = state.clone();
        invalid.segments[0].end_frame = 30;
        assert!(f.save(&invalid).is_err());
        invalid = state.clone();
        invalid.segments[0].source_index = 2;
        assert!(f.save(&invalid).is_err());
        fs::write(f.root.join(OUTPUT), b"{\"foreign\":true}").unwrap();
        assert!(f.save(&state).is_err());
        assert_eq!(
            fs::read(f.root.join(OUTPUT)).unwrap(),
            b"{\"foreign\":true}"
        );
        fs::remove_file(f.root.join(OUTPUT)).unwrap();
        let mut changed = f.original.clone();
        changed.push(b' ');
        fs::write(f.root.join("bailian_annotation.json"), changed).unwrap();
        let saved = f.save(&state).unwrap();
        assert_eq!(saved.segments, state.segments);
        assert!(f.root.join(OUTPUT).exists());
    }

    #[test]
    fn changed_model_segment_count_does_not_restore_deleted_or_replace_human_work() {
        let f = Fixture::new(0, true);
        let mut human = load(&f.local, &f.root).unwrap();
        human.segments[0].description = "人工最终动作".into();
        human.segments[1].deleted = true;
        human = f.save(&human).unwrap();
        let mut model: Value = serde_json::from_slice(&f.original).unwrap();
        model["episode_results"][0]["annotations"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        model["episode_results"][0]["segments"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        fs::write(
            f.root.join("bailian_annotation.json"),
            serde_json::to_vec(&model).unwrap(),
        )
        .unwrap();
        assert_eq!(load(&f.local, &f.root).unwrap().segments, human.segments);
        human.segments[0].end_frame = 7;
        let saved = f.save(&human).unwrap();
        assert_eq!(saved.segments[0].description, "人工最终动作");
        let output = f.output();
        assert_eq!(output["episode_results"][0]["annotation_count"], 2);
        assert_eq!(
            output["episode_results"][0]["annotations"][0]["end_frame"],
            8
        );
        let fresh = load(&f.temp.join("another-host"), &f.root).unwrap();
        assert_eq!(
            fresh.segments.iter().filter(|item| !item.deleted).count(),
            2
        );
        assert_eq!(fresh.segments[0].description, "人工最终动作");
        assert!(
            f.local
                .join("machine-review-history")
                .read_dir()
                .unwrap()
                .count()
                > 0
        );
    }

    #[test]
    fn shared_description_wins_over_stale_local_draft_and_model_on_restart() {
        let f = Fixture::new(0, true);
        let local = load(&f.local, &f.root).unwrap();
        let saved = f.save(&local).unwrap();
        let mut output = f.output();
        output["episode_results"][0]["annotations"][0]["start_frame"] = json!(2);
        machine_annotation::patch_description(
            &mut output["episode_results"][0]["annotations"][0],
            "外部人工修改",
        )
        .unwrap();
        atomic_json(&f.root.join(OUTPUT), &output).unwrap();
        let loaded = load(&f.local, &f.root).unwrap();
        assert_eq!(loaded.segments[0].description, "外部人工修改");
        assert_eq!(loaded.segments[0].start_frame, 2);
        assert_eq!(loaded.revision, saved.revision);
        let saved = f.save(&loaded).unwrap();
        assert_eq!(saved.segments[0].description, "外部人工修改");
        assert!(
            f.local
                .join("machine-review-history")
                .read_dir()
                .unwrap()
                .count()
                > 0
        );
    }

    #[test]
    fn stale_retry_finishes_session_after_description_commit_and_keeps_rejection_reason() {
        let f = Fixture::new(0, true);
        let state = load(&f.local, &f.root).unwrap();
        let request = || SaveReviewRequest {
            source_path: f.root.to_string_lossy().into(),
            source_name: None,
            source_hash: state.source_hash.clone(),
            expected_revision: state.revision,
            segments: state.segments.clone(),
            status: Some("rejected".into()),
            rejection_reason: Some("其他原因：人工确认视频缺帧".into()),
        };
        let committed = save(&f.local, request(), "测试审核员").unwrap();
        fs::write(f.root.join("session.json"), b"{}").unwrap();
        let retried = save(&f.local, request(), "测试审核员").unwrap();
        assert_eq!(retried.revision, committed.revision + 1);
        let session: Value =
            serde_json::from_slice(&fs::read(f.root.join("session.json")).unwrap()).unwrap();
        assert_eq!(session["qc"], "不通过：其他原因：人工确认视频缺帧");
        assert_eq!(session["revision"], retried.revision_label);
        assert_eq!(session["reviewerName"], "测试审核员");
        assert!(session["reviewedAt"].is_string());
    }

    #[test]
    fn deleted_segments_are_removed_by_source_identity_even_when_display_order_differs() {
        let f = Fixture::new(0, true);
        let mut raw: Value = serde_json::from_slice(&f.original).unwrap();
        raw["episode_results"][0]["annotations"]
            .as_array_mut()
            .unwrap()
            .reverse();
        fs::write(
            f.root.join("bailian_annotation.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        let annotation = source(&f.root).unwrap();
        assert_eq!(annotation.segments[0].source_index, 2);
        let mut state = initial(&annotation);
        state.segments[0].deleted = true;
        let output = reviewed_document(&annotation, &state).unwrap();
        let episode = &output["episode_results"][0];
        assert_eq!(episode["annotations"][0]["id"], "ann2");
        assert_eq!(episode["annotations"][1]["id"], "ann1");
        assert_eq!(episode["segments"][0]["annotation_id"], "ann1");
        assert_eq!(episode["segments"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn recovers_a_committed_output_when_the_local_draft_update_was_interrupted() {
        let f = Fixture::new(0, true);
        let initial = load(&f.local, &f.root).unwrap();
        let old = f.save(&initial).unwrap();
        let mut next = old.clone();
        for item in &mut next.segments {
            item.decision = "approved".into();
        }
        let committed = f.save(&next).unwrap();
        let path = draft_path(&f.local, &f.root.canonicalize().unwrap());
        atomic_json(
            &path.with_extension("pending.json"),
            &serde_json::to_value(&committed).unwrap(),
        )
        .unwrap();
        atomic_json(&path, &serde_json::to_value(&old).unwrap()).unwrap();
        let recovered = load(&f.local, &f.root).unwrap();
        assert_eq!(recovered.revision, committed.revision);
        assert_eq!(recovered.output_hash, committed.output_hash);
        assert_eq!(recovered.segments, committed.segments);
        assert!(f.save(&recovered).is_ok());
    }
}
