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

#[derive(Deserialize)]
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

fn output_name(annotation: &MachineAnnotation) -> &'static str {
    let _ = annotation;
    OUTPUT
}

fn selected_draft_path(data_root: &Path, root: &Path, annotation: &MachineAnnotation) -> PathBuf {
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
}

fn draft_path(data_root: &Path, root: &Path) -> PathBuf {
    let key = blake3::hash(root.to_string_lossy().as_bytes()).to_hex();
    data_root
        .join("machine-reviews")
        .join(format!("{key}.json"))
}

fn initial(annotation: &MachineAnnotation) -> ReviewState {
    ReviewState {
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
    let draft_path = selected_draft_path(data_root, root, annotation);
    let draft = machine_annotation::read_bytes(&draft_path)?
        .map(|bytes| serde_json::from_slice::<ReviewState>(&bytes))
        .transpose()?;
    let had_draft = draft.is_some();
    let output = match machine_annotation::read_bytes(&root.join(output_name(annotation)))? {
        Some(bytes) => Some(bytes),
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
            validate(annotation, &pending.segments)?;
            return Ok(pending);
        }
    }
    if let Some(draft) = draft {
        if draft.output_hash == output_hash {
            validate(annotation, &draft.segments)?;
            return Ok(draft);
        }
        // The shared human description is authoritative after another host saves.
        // Keep the local draft on disk until the next successful save.
        if output.is_none() {
            let mut retained = draft;
            retained.output_hash = None;
            validate(annotation, &retained.segments)?;
            return Ok(retained);
        }
    }
    if let Some(bytes) = output {
        let document: Value = serde_json::from_slice(&bytes)?;
        let Some(mut review_value) = document.get("_human_review").cloned() else {
            if had_draft && document.get("episode_results").is_none() {
                return Err(failure(
                    "description.json 不是可识别的人工标注，原文件已保留",
                ));
            }
            let mut state = if document.get("episode_results").is_some() {
                initial(&machine_annotation::parse_human(
                    &bytes,
                    &annotation.episode_id,
                )?)
            } else {
                initial(annotation)
            };
            state.output_hash = output_hash;
            return Ok(state);
        };
        if review_value["workflowVersion"].as_u64().unwrap_or(0) >= 4 {
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
            let human = machine_annotation::parse_human(&bytes, &annotation.episode_id)?;
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
                    let reference = machine_annotation::parse_human(
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
        validate(annotation, &state.segments)?;
        return Ok(state);
    }
    Ok(initial(annotation))
}

#[cfg(test)]
pub fn load(data_root: &Path, root: &Path) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = root.canonicalize()?;
    load_inner(data_root, &root, &source(&root)?)
}

pub fn load_selected(
    data_root: &Path,
    root: &Path,
    source_name: Option<&str>,
) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = root.canonicalize()?;
    let annotation = machine_annotation::load_selected(&root, source_name)?
        .ok_or_else(|| failure("未找到机标文件"))?;
    load_inner(data_root, &root, &annotation)
}

fn validate(annotation: &MachineAnnotation, edits: &[ReviewSegment]) -> AppResult<()> {
    if edits.len() > 2000 {
        return Err(failure("片段数量超过 2000"));
    }
    let mut seen = BTreeSet::new();
    for edit in edits {
        if !seen.insert(edit.source_index)
            || edit.start_frame > edit.end_frame
            || edit.end_frame >= annotation.frame_count
            || edit.description.len() > 16_384
            || !["pending", "approved", "rejected"].contains(&edit.decision.as_str())
        {
            return Err(failure("片段范围、状态或索引无效"));
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
        if edit.end_frame != original.end_frame {
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
                if original.is_some_and(|item| item.end_frame != edit.end_frame) {
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
    let mut metadata = state.clone();
    metadata.output_hash = None;
    metadata.workflow_version = 4;
    metadata.segments.retain(|item| !item.deleted);
    let mut published = serde_json::to_value(metadata)?;
    published["reviewRevision"] = published["revision"].clone();
    published["revision"] = json!(state.revision_label);
    published.as_object_mut().unwrap().remove("revisionLabel");
    for segment in published["segments"].as_array_mut().unwrap() {
        let fields = segment.as_object_mut().unwrap();
        fields.remove("decision");
        fields.remove("deleted");
    }
    document["_human_review"] = published;
    Ok(document)
}

// When model identities change, write the human snapshot independently of them.
fn human_document(
    annotation: &MachineAnnotation,
    state: &ReviewState,
    root: &Path,
) -> AppResult<Value> {
    let mut document: Value = machine_annotation::read_bytes(&root.join(OUTPUT))?
        .map(|bytes| serde_json::from_slice(&bytes))
        .transpose()?
        .unwrap_or(serde_json::from_str(&annotation.source_json)?);
    if document.get("episode_results").is_none() {
        document = serde_json::from_str(&annotation.source_json)?;
    }
    let episode = document["episode_results"]
        .as_array_mut()
        .and_then(|items| {
            items
                .iter_mut()
                .find(|item| item["episode_id"].as_str() == Some(&annotation.episode_id))
        })
        .ok_or_else(|| failure("人工 description 中未找到当前记录"))?;
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
    // Publication metadata keeps the internal counter separate from the visible label.
    let mut published = serde_json::to_value(state)?;
    published["outputHash"] = Value::Null;
    published["workflowVersion"] = json!(4);
    published["reviewRevision"] = json!(state.revision);
    published["revision"] = json!(state.revision_label);
    published.as_object_mut().unwrap().remove("revisionLabel");
    published["segments"] = json!(state
        .segments
        .iter()
        .filter(|item| !item.deleted)
        .collect::<Vec<_>>());
    for item in published["segments"].as_array_mut().unwrap() {
        item.as_object_mut().unwrap().remove("deleted");
        item.as_object_mut().unwrap().remove("decision");
    }
    document["_human_review"] = published;
    Ok(document)
}

fn atomic_json(path: &Path, document: &Value) -> AppResult<String> {
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
    result?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
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
    mut request: SaveReviewRequest,
    reviewer: &str,
    username: &str,
) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = Path::new(&request.source_path).canonicalize()?;
    let annotation = machine_annotation::load_selected(
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
            machine_annotation::load_selected(&write_root, Some(&annotation.source_name))?
                .ok_or_else(|| failure("CIFS 目录中未找到相同机标文件"))?;
        if write_annotation.source_hash != annotation.source_hash {
            return Err(failure("CIFS 目录与当前机标不一致，拒绝写入"));
        }
    }
    let draft = selected_draft_path(data_root, &root, &annotation);
    fs::create_dir_all(draft.parent().ok_or_else(|| failure("草稿目录无效"))?)?;
    let _draft_lock = lock_file(&draft.with_extension("lock"))?;
    let output = output_name(&annotation);
    let lock_path = write_root.join(format!(".{}.lock", output.trim_end_matches(".json")));
    let _output_lock = lock_file(&lock_path)?;
    let current = load_inner(data_root, &root, &annotation)?;
    let previous_draft = machine_annotation::read_bytes(&draft)?
        .map(|bytes| serde_json::from_slice::<ReviewState>(&bytes))
        .transpose()?;
    let rebased = request.source_hash != annotation.source_hash
        || request.expected_revision != current.revision
        || previous_draft
            .as_ref()
            .is_some_and(|saved| saved.output_hash != current.output_hash);
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
    let version_id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let expected_output_hash = if current.workflow_version >= 2 {
        current.output_hash.clone()
    } else {
        None
    };
    let change_summary =
        review_change_summary(&current, &request.segments, &status, &rejection_reason);
    let revision_label = format!("{version_id} · {change_summary}");
    let mut state = ReviewState {
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
        updated_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        ..current
    };
    if state.published {
        let output = output_name(&annotation);
        let session_path = write_root.join("session.json");
        let mut session: Value = machine_annotation::read_bytes(&session_path)?
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()?
            .unwrap_or_else(|| json!({}));
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
            let document = if state.source_hash != annotation.source_hash
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
            let mut pending = state.clone();
            pending.output_hash = Some(
                blake3::hash(&serde_json::to_vec_pretty(&document)?)
                    .to_hex()
                    .to_string(),
            );
            atomic_json(
                &draft.with_extension("pending.json"),
                &serde_json::to_value(pending)?,
            )?;
            atomic_json(&write_root.join(output), &document)
        })();
        state.output_hash = Some(result?);
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
    atomic_json(&draft, &serde_json::to_value(&state)?)?;
    let _ = fs::remove_file(draft.with_extension("pending.json"));
    Ok(state)
}

fn validated_rejection_reason(status: &str, reason: Option<&str>) -> AppResult<String> {
    if status != "rejected" {
        return Ok(String::new());
    }
    let reason = reason.unwrap_or_default().trim();
    let fixed = ["骨架抖动", "镜头污渍", "镜头遮挡", "动作错误", "画面过曝"];
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

fn lock_file(path: &Path) -> AppResult<fs::File> {
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
    let file = options.open(path)?;
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
                    || name == FLASH_OUTPUT
                    || name == LEGACY_OUTPUT
                    || name == LEGACY_FLASH_OUTPUT
                    || name == ".review.3.8max.lock"
                    || name == ".review.3.8flash.lock"
                    || name == ".description.lock"
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
            assert_eq!(published["_human_review"]["revision"], session["revision"]);
            for item in published["_human_review"]["segments"].as_array().unwrap() {
                assert!(item.get("decision").is_none() && item.get("deleted").is_none());
            }
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
            let public = output["_human_review"]["segments"].as_array().unwrap();
            assert_eq!(public.len(), 2);
            assert!(public.iter().all(|item| item.get("deleted").is_none()
                && item.get("decision").is_none()
                && item["sourceIndex"] != 1));
            assert_eq!(public[1]["startFrame"], 10);
            assert_eq!(output["_human_review"]["workflowVersion"], 4);
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
                f.output()["_human_review"]["segments"]
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
            output["_human_review"]["segments"]
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
