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

pub const OUTPUT: &str = "bailian_annotation_reviewed.json";
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSegment {
    pub source_index: usize,
    pub start_frame: u64,
    pub end_frame: u64,
    pub description: String,
    pub deleted: bool,
    pub decision: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewState {
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
    pub source_hash: String,
    pub expected_revision: u64,
    pub segments: Vec<ReviewSegment>,
}

fn failure(message: &str) -> AppError {
    AppError::Message(format!("MACHINE_REVIEW: {message}"))
}

fn source(root: &Path) -> AppResult<MachineAnnotation> {
    machine_annotation::load(root)?.ok_or_else(|| failure("未找到机标文件"))
}

fn draft_path(data_root: &Path, root: &Path) -> PathBuf {
    let key = blake3::hash(root.to_string_lossy().as_bytes()).to_hex();
    data_root
        .join("machine-reviews")
        .join(format!("{key}.json"))
}

fn initial(annotation: &MachineAnnotation) -> ReviewState {
    ReviewState {
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
    }
}

fn load_inner(
    data_root: &Path,
    root: &Path,
    annotation: &MachineAnnotation,
) -> AppResult<ReviewState> {
    let draft = machine_annotation::read_bytes(&draft_path(data_root, root))?
        .map(|bytes| serde_json::from_slice::<ReviewState>(&bytes))
        .transpose()?;
    let output = machine_annotation::read_bytes(&root.join(OUTPUT))?;
    let output_hash = output
        .as_ref()
        .map(|bytes| blake3::hash(bytes).to_hex().to_string());
    // A committed NAS write can outlive a failed local draft update.
    if let Some(bytes) =
        machine_annotation::read_bytes(&draft_path(data_root, root).with_extension("pending.json"))?
    {
        let pending: ReviewState = serde_json::from_slice(&bytes)?;
        if pending.source_hash == annotation.source_hash
            && pending.output_hash.is_some()
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
        if draft.source_hash != annotation.source_hash {
            return Err(failure("原机标已改变，已有草稿未覆盖，请先备份处理旧草稿"));
        }
        if draft.output_hash == output_hash {
            validate(annotation, &draft.segments)?;
            return Ok(draft);
        }
        return Err(failure(
            "复核结果已被另一主机修改，本机草稿已保留，请先解决冲突",
        ));
    }
    if let Some(bytes) = output {
        let document: Value = serde_json::from_slice(&bytes)?;
        let mut state: ReviewState = serde_json::from_value(
            document
                .get("_human_review")
                .cloned()
                .ok_or_else(|| failure("已有同名 JSON 不是 Viewer 复核结果，拒绝覆盖"))?,
        )?;
        if state.source_hash != annotation.source_hash {
            return Err(failure("复核结果与原机标不匹配"));
        }
        state.output_hash = output_hash;
        validate(annotation, &state.segments)?;
        return Ok(state);
    }
    Ok(initial(annotation))
}

pub fn load(data_root: &Path, root: &Path) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = root.canonicalize()?;
    load_inner(data_root, &root, &source(&root)?)
}

fn validate(annotation: &MachineAnnotation, edits: &[ReviewSegment]) -> AppResult<()> {
    if edits.len() != annotation.segments.len() {
        return Err(failure("片段数量不匹配"));
    }
    let known: BTreeSet<_> = annotation
        .segments
        .iter()
        .map(|item| item.source_index)
        .collect();
    let mut seen = BTreeSet::new();
    for edit in edits {
        if !known.contains(&edit.source_index)
            || !seen.insert(edit.source_index)
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
        let edit = edits.get(&index).ok_or_else(|| failure("片段索引不匹配"))?;
        for key in ["segment_id", "id"] {
            if let Some(id) = value[key].as_str() {
                if mirrors
                    .insert(id.into(), edit)
                    .is_some_and(|other| other.source_index != index)
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
            .find(|item| item.source_index == index)
            .ok_or_else(|| failure("片段索引无效"))?;
        if edit.start_frame != original.start_frame {
            value["start_frame"] = json!(edit.start_frame + base);
        }
        if edit.end_frame != original.end_frame {
            value["end_frame"] = json!(edit.end_frame + base + u64::from(exclusive));
        }
        if edit.description != original.description {
            if !value["attributes"].is_object() {
                value["attributes"] = json!({});
            }
            value["attributes"]["semantic_description"] = json!(edit.description);
        }
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
            let edit = linked.or_else(|| (matching.len() == 1).then(|| edits[&matching[0].0]));
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
        *segments = updated;
    }
    if patched.len() != annotation.segments.len() && episode.get("annotation_count").is_some() {
        episode["annotation_count"] = json!(patched.len());
    }
    episode["annotations"] = Value::Array(patched);
    let mut metadata = state.clone();
    metadata.output_hash = None;
    document["_human_review"] = serde_json::to_value(metadata)?;
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

pub fn save(
    data_root: &Path,
    request: SaveReviewRequest,
    reviewer: &str,
) -> AppResult<ReviewState> {
    let _guard = SAVE_LOCK.lock().map_err(|_| failure("保存锁不可用"))?;
    let root = Path::new(&request.source_path).canonicalize()?;
    let draft = draft_path(data_root, &root);
    fs::create_dir_all(draft.parent().ok_or_else(|| failure("草稿目录无效"))?)?;
    let _draft_lock = lock_file(&draft.with_extension("lock"))?;
    let annotation = source(&root)?;
    let current = load_inner(data_root, &root, &annotation)?;
    if request.source_hash != annotation.source_hash
        || request.expected_revision != current.revision
    {
        return Err(failure("数据已改变，请重新读取后再保存"));
    }
    validate(&annotation, &request.segments)?;
    let retained: Vec<_> = request
        .segments
        .iter()
        .filter(|item| !item.deleted)
        .collect();
    let approved = !retained.is_empty() && retained.iter().all(|item| item.decision == "approved");
    let mut state = ReviewState {
        segments: request.segments,
        revision: current.revision + 1,
        published: current.published || approved,
        reviewer: reviewer.into(),
        updated_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        ..current
    };
    if state.published {
        let lock_path = root.join(".bailian_annotation_reviewed.lock");
        let _output_lock = lock_file(&lock_path)?;
        let result = (|| -> AppResult<String> {
            let actual = machine_annotation::read_bytes(&root.join(OUTPUT))?
                .map(|bytes| blake3::hash(&bytes).to_hex().to_string());
            if actual != state.output_hash {
                return Err(failure("复核结果已改变，拒绝覆盖"));
            }
            let document = reviewed_document(&annotation, &state)?;
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
            atomic_json(&root.join(OUTPUT), &document)
        })();
        state.output_hash = Some(result?);
    }
    atomic_json(&draft, &serde_json::to_value(&state)?)?;
    let _ = fs::remove_file(draft.with_extension("pending.json"));
    Ok(state)
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
                    source_path: self.root.to_string_lossy().into(),
                    source_hash: state.source_hash.clone(),
                    expected_revision: state.revision,
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
    fn drafts_approval_autosave_and_reopen_preserve_the_source_and_capture_identity() {
        let f = Fixture::new(0, true);
        let fingerprint =
            crate::source::episode_fingerprint(&f.root, &AtomicBool::new(false)).unwrap();
        let mut state = load(&f.local, &f.root).unwrap();
        state.segments[0].description = "corrected".into();
        state.segments[0].decision = "rejected".into();
        state = f.save(&state).unwrap();
        assert!(!f.root.join(OUTPUT).exists());
        assert_eq!(load(&f.local, &f.root).unwrap().segments, state.segments);
        state.segments[0].decision = "approved".into();
        state = f.save(&state).unwrap();
        assert!(!f.root.join(OUTPUT).exists());
        for segment in &mut state.segments {
            segment.decision = "approved".into();
        }
        state = f.save(&state).unwrap();
        assert!(state.published);
        let source: Value = serde_json::from_slice(&f.original).unwrap();
        let mut expected = source.clone();
        expected["episode_results"][0]["annotations"][0]["attributes"]["semantic_description"] =
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
    fn refuses_stale_revisions_source_changes_foreign_outputs_and_invalid_edits() {
        let f = Fixture::new(0, true);
        let mut state = load(&f.local, &f.root).unwrap();
        let stale = state.clone();
        state = f.save(&state).unwrap();
        assert!(f.save(&stale).is_err());
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
        assert!(f.save(&state).is_err());
        assert!(!f.root.join(OUTPUT).exists());
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
