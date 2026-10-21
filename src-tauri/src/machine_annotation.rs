use crate::error::{AppError, AppResult};
use crate::model::{MachineAnnotation, MachineSegment};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;

mod identity;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SEGMENTS: usize = 2000;
pub const DEFAULT_SOURCE: &str = "bailian_annotation.json";
pub const FLASH_SOURCE: &str = "bailian_annotation.qwen3.8-flash.json";
pub const MANUAL_SOURCE: &str = "manual";

// A read-only template lets human-only reviews use the same persistence contract.
pub fn load_for_review(
    root: &Path,
    source_name: Option<&str>,
) -> AppResult<Option<MachineAnnotation>> {
    if source_name != Some(MANUAL_SOURCE) {
        let annotation = load_selected(root, source_name)?;
        if annotation.is_some() || source_name.is_some() {
            return Ok(annotation);
        }
    }
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    let camera = crate::source::review_camera_summary(&root)?;
    if camera.frame_count == 0 {
        return Ok(None);
    }
    let episode_id = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let document = serde_json::json!({
        "schema_version": 4,
        "annotation_source": "human",
        "episode_results": [{
            "episode_id": episode_id,
            "media": {"frame_count": camera.frame_count, "frame_index_base": 0, "interval_convention": "[start,end)"},
            "annotations": [], "segments": []
        }]
    });
    let mut annotation = parse_human(&serde_json::to_vec(&document)?, episode_id)?;
    annotation.source_name = MANUAL_SOURCE.into();
    annotation.warnings.clear();
    Ok(Some(annotation))
}

pub(crate) fn validate_source_name(name: &str) -> AppResult<()> {
    let file = name
        .strip_prefix(".session_meta/")
        .or_else(|| name.strip_prefix("./"))
        .unwrap_or(name);
    let valid = (matches!(file, "description.json" | "desorption.json")
        || (file.starts_with("bailian") && file.ends_with(".json")))
        && !file.contains(['/', '\\', ':', '\0']);
    if !valid {
        return Err(invalid("不支持的机标文件名"));
    }
    Ok(())
}

pub fn list_sources(root: &Path) -> AppResult<Vec<String>> {
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    let mut names = Vec::new();
    for directory in [root.to_path_buf(), root.join(".session_meta")] {
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.is_dir() || directory.canonicalize()? != directory => {
                return Err(invalid("机标目录必须为普通目录"))
            }
            Ok(_) => {}
        }
        let entries = fs::read_dir(&directory)?;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_file()
                && (matches!(name.as_str(), "description.json" | "desorption.json")
                    || (name.starts_with("bailian") && name.ends_with(".json")))
            {
                validate_source_name(&name)?;
                // Preserve distinct root and metadata files with the same name.
                names.push(if directory == root {
                    format!("./{name}")
                } else {
                    format!(".session_meta/{name}")
                });
            }
        }
    }
    names.sort_by_key(|name| {
        (
            !(name.ends_with("/description.json") || name.ends_with("/desorption.json")),
            name.clone(),
        )
    });
    Ok(names)
}

#[derive(Deserialize)]
struct Document {
    schema_version: u64,
    #[serde(default)]
    asset_id: Value,
    episode_results: Vec<Episode>,
}

#[derive(Deserialize)]
struct Episode {
    episode_id: String,
    annotations: Vec<Annotation>,
    media: Media,
    completed_at: Option<String>,
    #[serde(default)]
    quality: Value,
}

#[derive(Deserialize)]
struct Media {
    frame_count: u64,
    frame_index_base: Option<u64>,
    interval_convention: Option<String>,
}

#[derive(Deserialize)]
struct Annotation {
    segment_id: Option<String>,
    label_code: String,
    start_frame: u64,
    end_frame: Option<u64>,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    attributes_zh: Value,
}

#[derive(Default)]
struct ParsedAttributes {
    values: BTreeMap<String, Value>,
    issues: BTreeSet<&'static str>,
}

// Optional model attributes must not hide valid action boundaries or descriptions.
// Normalize only the reading view; keep every original entry in source_json.
fn attributes_map(value: &Value) -> ParsedAttributes {
    let mut parsed = ParsedAttributes::default();
    match value {
        Value::Null => {}
        Value::Object(values) => {
            parsed.values = values.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        }
        Value::Array(values) => {
            let mut ambiguous = BTreeSet::new();
            for entry in values {
                let Some(key) = entry
                    .get("T")
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                else {
                    parsed.issues.insert("属性缺少 T 名称或格式异常");
                    continue;
                };
                let value = entry.get("value").unwrap_or_else(|| {
                    parsed.issues.insert("属性缺少 value，未猜测缺失值");
                    &Value::Null
                });
                if ambiguous.contains(key) {
                    continue;
                }
                if let Some(previous) = parsed.values.get(key) {
                    parsed.issues.insert("存在重复属性");
                    let blank = |v: &Value| v.is_null() || v.as_str() == Some("");
                    if previous == value || blank(value) {
                        continue;
                    }
                    if !blank(previous) {
                        parsed.values.remove(key);
                        ambiguous.insert(key.to_owned());
                        parsed.issues.insert("重复属性值冲突，未自动选择");
                        continue;
                    }
                }
                parsed.values.insert(key.into(), value.clone());
            }
        }
        _ => {
            parsed.issues.insert("属性不是对象或 T/value 数组");
        }
    }
    parsed
}

pub(crate) fn description_field(annotation: &Value) -> AppResult<(&'static str, &'static str)> {
    let zh = attributes_map(&annotation["attributes_zh"]);
    if zh
        .values
        .get("动作描述")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
    {
        Ok(("attributes_zh", "动作描述"))
    } else if attributes_map(&annotation["attributes"])
        .values
        .get("semantic_description")
        .and_then(Value::as_str)
        .is_some_and(has_chinese)
    {
        Ok(("attributes", "semantic_description"))
    } else {
        Ok(("attributes_zh", "动作描述"))
    }
}

fn has_chinese(text: &str) -> bool {
    text.chars()
        .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
}

pub(crate) fn patch_description(annotation: &mut Value, description: &str) -> AppResult<()> {
    let (field, key) = description_field(annotation)?;
    let attributes = &mut annotation[field];
    if let Some(entries) = attributes.as_array_mut() {
        let mut patched = false;
        for entry in entries
            .iter_mut()
            .filter(|entry| entry["T"].as_str() == Some(key))
        {
            entry["value"] = description.into();
            patched = true;
        }
        if !patched {
            entries.push(serde_json::json!({"T":key,"value":description}));
        }
    } else if attributes.is_object() || attributes.is_null() {
        if attributes.is_null() {
            *attributes = serde_json::json!({});
        }
        attributes[key] = description.into();
    } else {
        // Preserve a malformed legacy payload instead of overwriting it when a
        // reviewer explicitly supplies the missing description in human output.
        *attributes = serde_json::json!([attributes.clone(), {"T":key,"value":description}]);
    }
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::Message(format!("MACHINE_ANNOTATION_INVALID: {message}"))
}

#[cfg(test)]
pub fn load(root: &Path) -> AppResult<Option<MachineAnnotation>> {
    load_selected(root, Some(DEFAULT_SOURCE))
}

pub fn load_selected(
    root: &Path,
    source_name: Option<&str>,
) -> AppResult<Option<MachineAnnotation>> {
    let root = crate::dataset_layout::resolve(root)?.canonicalize()?;
    if let Some(name) = source_name {
        validate_source_name(name)?;
        return load_named(&root, name);
    }
    let mut first_error = None;
    for name in [FLASH_SOURCE, DEFAULT_SOURCE] {
        match load_named(&root, name) {
            Ok(Some(annotation)) => return Ok(Some(annotation)),
            Ok(None) => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    // Discover other Bailian exports and human results only when the preferred
    // conventional files could not be loaded; don't add directory IO to the hot path.
    for name in list_sources(&root)?.into_iter().take(64) {
        match load_named(&root, &name) {
            Ok(Some(mut annotation)) => {
                if first_error.is_some() {
                    annotation.warnings.push("优先机标来源无法解析，已兼容读取当前目录中的其他 JSON 来源，可在机标来源菜单切换。".into());
                }
                return Ok(Some(annotation));
            }
            Ok(None) => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

fn load_named(root: &Path, name: &str) -> AppResult<Option<MachineAnnotation>> {
    let Some(bytes) = read_source_bytes(root, name)? else {
        return Ok(None);
    };
    parse_with_boundary_policy(
        &bytes,
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        matches!(
            name.rsplit('/').next(),
            Some("description.json" | "desorption.json")
        ),
        !matches!(
            name.rsplit('/').next(),
            Some("description.json" | "desorption.json")
        ),
        Some(root),
    )
    .map(|mut annotation| {
        annotation.source_name = name.into();
        Some(annotation)
    })
}

fn read_source_bytes(root: &Path, name: &str) -> AppResult<Option<Vec<u8>>> {
    if let Some(file) = name.strip_prefix("./") {
        return read_bytes(&root.join(file));
    }
    if matches!(name, "description.json" | "desorption.json") {
        return read_bytes(&root.join(name));
    }
    let directory = root.join(".session_meta");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || directory.canonicalize()? != directory {
                return Err(invalid("机标元数据目录不能是符号链接或非目录文件"));
            }
            if let Some(file) = name.strip_prefix(".session_meta/") {
                return read_bytes(&directory.join(file));
            }
            if let Some(bytes) = read_bytes(&directory.join(name))? {
                return Ok(Some(bytes));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if name.starts_with(".session_meta/") {
        return Ok(None);
    }
    read_bytes(&root.join(name))
}

pub(crate) fn read_bytes(path: &Path) -> AppResult<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_BYTES {
        return Err(invalid("机标必须是最大 8 MiB 的普通文件"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(invalid("机标文件类型或大小无效"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(invalid("不读取机标文件的符号链接"));
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("机标文件超过 8 MiB"));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
fn parse(bytes: &[u8], episode_name: &str) -> AppResult<MachineAnnotation> {
    parse_document(bytes, episode_name, false)
}

pub(crate) fn parse_human(bytes: &[u8], episode_name: &str) -> AppResult<MachineAnnotation> {
    parse_document(bytes, episode_name, true)
}

fn parse_document(bytes: &[u8], episode_name: &str, human: bool) -> AppResult<MachineAnnotation> {
    parse_with_boundary_policy(bytes, episode_name, human, !human, None)
}

pub(crate) fn parse_human_in_directory(
    bytes: &[u8],
    episode_name: &str,
    root: &Path,
) -> AppResult<MachineAnnotation> {
    parse_with_boundary_policy(bytes, episode_name, true, false, Some(root))
}

// A source reference for comparing descriptions, not a saved human result.
pub(crate) fn parse_review_reference(
    bytes: &[u8],
    episode_name: &str,
) -> AppResult<MachineAnnotation> {
    parse_with_boundary_policy(bytes, episode_name, true, true, None)
}

fn parse_with_boundary_policy(
    bytes: &[u8],
    episode_name: &str,
    human: bool,
    allow_inference: bool,
    root: Option<&Path>,
) -> AppResult<MachineAnnotation> {
    let document: Document =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
            .map_err(|error| invalid(&format!("机标 JSON 格式无效：{error}")))?;
    if ![3, 4].contains(&document.schema_version) {
        return Err(invalid("不支持的机标版本，当前支持 schema_version 3、4"));
    }
    let (index, identity_warning, identity_verified) =
        identity::select(&document, episode_name, root)?;
    let episode = document.episode_results.into_iter().nth(index).unwrap();
    if episode.media.frame_count == 0
        || episode.media.frame_count > 9_007_199_254_740_991
        || episode.annotations.len() > MAX_SEGMENTS
    {
        return Err(invalid("帧数无效或机标片段超过 2000 条"));
    }
    let camera_frames = root
        .and_then(|root| crate::source::review_camera_summary(root).ok())
        .map(|camera| camera.frame_count)
        .filter(|count| *count > 0 && *count <= 9_007_199_254_740_991);
    let mut warnings = Vec::new();
    let exclusive = match episode.media.interval_convention.as_deref() {
        Some("[start,end)") => true,
        Some("[start,end]") => false,
        None => {
            warnings.push("旧机标未声明区间规则，暂按 [start,end) 解读；请核对片段边界。".into());
            true
        }
        _ => return Err(invalid("不支持的机标区间规则")),
    };
    let base = episode.media.frame_index_base.unwrap_or(0);
    if base > 1 {
        return Err(invalid("机标帧号起点必须为 0 或 1"));
    }
    if episode.media.frame_index_base.is_none() {
        warnings.push("旧机标未声明帧号起点，暂按 0 起始解读。".into());
    }
    let mut segments = Vec::new();
    let mut attribute_warnings = Vec::new();
    let mut affected_attribute_groups = 0;
    let mut inferred_end_frames = Vec::new();
    let starts: Vec<_> = episode
        .annotations
        .iter()
        .map(|item| item.start_frame)
        .collect();
    let starts_ordered = starts.windows(2).all(|pair| pair[0] < pair[1]);
    for (source_index, annotation) in episode.annotations.into_iter().enumerate() {
        let end_frame = match annotation.end_frame {
            Some(end) => end,
            None => {
                // A provisional boundary, never a replacement in the source JSON.
                // Human results stay strict; only a following ordered segment supplies evidence.
                let next = starts.get(source_index + 1).copied().filter(|next| {
                    allow_inference && starts_ordered && *next > annotation.start_frame
                });
                let end = next.and_then(|next| next.checked_sub(u64::from(!exclusive)))
                    .ok_or_else(|| invalid(&format!("第 {} 个片段 end_frame 缺失或为 null，且没有可用于推定的后续片段；请修正机标边界或选择其他来源", source_index + 1)))?;
                inferred_end_frames.push(source_index);
                warnings.push(format!("第 {} 个片段 end_frame 缺失或为 null，暂按下一片段起始帧推定为 {end}；请人工核对，原机标未修改。", source_index + 1));
                end
            }
        };
        let start = annotation.start_frame.checked_sub(base);
        let end = end_frame.checked_sub(base + u64::from(exclusive));
        let (Some(start), Some(end)) = (start, end) else {
            return Err(invalid("机标片段帧范围无效"));
        };
        if start > end || end >= camera_frames.unwrap_or(0).max(episode.media.frame_count) {
            return Err(invalid(&format!(
                "第 {} 个机标片段为空、倒序或超出已知视频帧数，原范围 [{}, {}]",
                source_index + 1,
                annotation.start_frame,
                end_frame
            )));
        }
        let mut attributes = attributes_map(&annotation.attributes);
        let mut attributes_zh = attributes_map(&annotation.attributes_zh);
        for (field, key, parsed) in [
            ("英文属性", "semantic_description", &mut attributes),
            ("中文属性", "动作描述", &mut attributes_zh),
        ] {
            if parsed
                .values
                .get(key)
                .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                parsed.issues.insert("动作描述不是文本，未自动转换");
            }
            if !parsed.issues.is_empty() {
                affected_attribute_groups += 1;
                if attribute_warnings.len() < 50 {
                    attribute_warnings.push(format!("第 {} 个片段的{field}：{}。可读字段及片段已保留，请核对动作描述；原机标未修改。", source_index + 1, parsed.issues.iter().copied().collect::<Vec<_>>().join("；")));
                }
            }
        }
        let attributes = attributes.values;
        let attributes_zh = attributes_zh.values;
        let description = attributes_zh
            .get("动作描述")
            .and_then(Value::as_str)
            .filter(|text| human || has_chinese(text))
            .or_else(|| {
                attributes
                    .get("semantic_description")
                    .and_then(Value::as_str)
                    .filter(|text| human || has_chinese(text))
            })
            .unwrap_or_default()
            .to_owned();
        segments.push(MachineSegment {
            source_index,
            segment_id: annotation.segment_id,
            label: annotation.label_code,
            description,
            start_frame: start,
            end_frame: end,
            attributes,
        });
    }
    segments.sort_by_key(|segment| (segment.start_frame, segment.end_frame));
    if affected_attribute_groups > attribute_warnings.len() {
        attribute_warnings.push(format!("共 {affected_attribute_groups} 组片段属性需核对，此处仅列出前 50 组；完整内容保留在原 JSON 中。"));
    }
    let quality_string = |key: &str| {
        episode
            .quality
            .get(key)
            .and_then(Value::as_str)
            .map(String::from)
    };
    if quality_string("validation_status").as_deref() != Some("passed") {
        warnings.push("机标尚未通过模型流水线校验。".into());
    }
    if let Some(issues) = episode.quality.get("issues").and_then(Value::as_array) {
        warnings.extend(issues.iter().filter_map(Value::as_str).map(String::from));
    }
    let frame_count = camera_frames
        .filter(|count| {
            *count > 0
                && *count <= 9_007_199_254_740_991
                && segments.iter().all(|segment| segment.end_frame < *count)
        })
        .unwrap_or(episode.media.frame_count);
    let timeline_warning = (frame_count != episode.media.frame_count).then(|| format!(
        "机标声明 {} 帧，当前视频 {} 帧；所有片段均在当前视频范围内，已按实际视频帧数加载。原始片段边界未缩放、未截断，原机标未修改。",
        episode.media.frame_count, frame_count,
    ));
    Ok(MachineAnnotation {
        source_name: DEFAULT_SOURCE.into(),
        source_hash: blake3::hash(bytes).to_hex().to_string(),
        episode_id: episode.episode_id,
        source_json: String::from_utf8_lossy(bytes).into_owned(),
        boundary_method: quality_string("boundary_method"),
        model: quality_string("model"),
        completed_at: episode.completed_at,
        validation_status: quality_string("validation_status"),
        frame_count,
        timeline_warning,
        attribute_warnings,
        warnings,
        identity_warning,
        identity_verified,
        inferred_end_frames,
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_end_uses_next_ordered_start_with_warning_and_preserves_source() {
        for (base, exclusive) in [(0, true), (1, true), (0, false), (1, false)] {
            let mut document = fixture();
            let episode = &mut document["episode_results"][0];
            episode["media"]["frame_index_base"] = base.into();
            episode["media"]["interval_convention"] = if exclusive {
                "[start,end)"
            } else {
                "[start,end]"
            }
            .into();
            episode["annotations"][0]["start_frame"] = base.into();
            episode["annotations"][0]["end_frame"] = Value::Null;
            episode["annotations"][1]["start_frame"] = (23 + base).into();
            episode["annotations"][1]["end_frame"] = (29 + base + u64::from(exclusive)).into();
            let bytes = serde_json::to_vec(&document).unwrap();
            let result = parse(&bytes, "sample").unwrap();
            assert_eq!(result.segments.len(), 2);
            assert_eq!(result.segments[0].end_frame, 22);
            assert_eq!(result.inferred_end_frames, vec![0]);
            assert!(result
                .warnings
                .iter()
                .any(|item| item.contains("暂按下一片段")));
            assert_eq!(result.source_json.as_bytes(), bytes);
            assert_eq!(
                result.source_hash,
                blake3::hash(&bytes).to_hex().to_string()
            );
            assert!(parse_human(&bytes, "sample").is_err());
        }
    }

    #[test]
    fn missing_end_does_not_guess_terminal_unordered_or_invalid_boundaries() {
        for case in [
            "terminal",
            "unordered",
            "duplicate",
            "negative",
            "text",
            "overflow",
            "start-null",
        ] {
            let mut document = fixture();
            let rows = &mut document["episode_results"][0]["annotations"];
            rows[0]["end_frame"] = Value::Null;
            match case {
                "terminal" => rows[1]["end_frame"] = Value::Null,
                "unordered" => rows[0]["start_frame"] = 24.into(),
                "duplicate" => rows[1]["start_frame"] = 0.into(),
                "negative" => rows[0]["end_frame"] = (-1).into(),
                "text" => rows[0]["end_frame"] = "23".into(),
                "overflow" => rows[1]["start_frame"] = 99.into(),
                "start-null" => rows[0]["start_frame"] = Value::Null,
                _ => unreachable!(),
            }
            assert!(
                parse(&serde_json::to_vec(&document).unwrap(), "sample").is_err(),
                "{case}"
            );
        }
    }

    #[test]
    fn discovers_distinct_sources_and_validates_human_and_machine_ranges() {
        let root = std::env::temp_dir()
            .join(format!(
                "viewer-sources-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("sample");
        fs::create_dir_all(root.join(".session_meta")).unwrap();
        let document = fixture();
        let bytes = serde_json::to_vec(&document).unwrap();
        for name in [
            "bailian_new-model.json",
            ".session_meta/bailian_new-model.json",
            "description.json",
            "desorption.json",
        ] {
            fs::write(root.join(name), &bytes).unwrap();
        }
        let names = list_sources(&root).unwrap();
        assert_eq!(names.len(), 4);
        assert!(names.contains(&"./bailian_new-model.json".into()));
        assert!(names.contains(&".session_meta/bailian_new-model.json".into()));
        for name in names {
            let loaded = load_selected(&root, Some(&name)).unwrap().unwrap();
            assert_eq!(loaded.source_name, name);
            assert_eq!(loaded.segments[0].end_frame, 22);
        }
        let mut invalid = document;
        invalid["episode_results"][0]["annotations"][0]["end_frame"] = 999.into();
        for name in ["bailian_new-model.json", "description.json"] {
            fs::write(root.join(name), serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(load_selected(&root, Some(&format!("./{name}"))).is_err());
        }
        for name in [
            "../bailian.json",
            ".session_meta/../description.json",
            "./bailian.json:stream.json",
        ] {
            assert!(validate_source_name(name).is_err());
        }
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    fn fixture() -> Value {
        serde_json::json!({"schema_version":3,"episode_results":[{
            "episode_id":"sample","annotations":[
                {"label_code":"stand","start_frame":0,"end_frame":23,"attributes":{"semantic_description":"Standing"}},
                {"label_code":"walk","start_frame":23,"end_frame":30}],
            "media":{"frame_count":30,"frame_index_base":0,"interval_convention":"[start,end)"},
            "quality":{"model":"test","validation_status":"passed"}
        }]})
    }
    #[test]
    fn reads_v4_bilingual_attributes_and_preserves_raw_json() {
        let mut document = fixture();
        document["schema_version"] = 4.into();
        let episode = &mut document["episode_results"][0];
        episode["quality"] = serde_json::json!({"model":"qwen3.8-flash","validation_status":"needs_review","issues":["Check posture"]});
        episode["annotations"][0]["attributes"] = serde_json::json!([
            {"T":"semantic_description","value":"Standing","confidence":0.9},
            {"T":"body_part","value":"双手"}
        ]);
        episode["annotations"][0]["attributes_zh"] =
            serde_json::json!([{"T":"动作描述","value":"静止状态"}]);
        let bytes = serde_json::to_vec(&document).unwrap();
        let result = parse(&bytes, "sample").unwrap();
        assert_eq!(result.segments[0].description, "静止状态");
        assert_eq!(result.segments[0].attributes["body_part"], "双手");
        assert_eq!(result.segments[0].end_frame, 22);
        assert_eq!(result.source_json.as_bytes(), bytes);
        assert!(result.warnings.contains(&"Check posture".into()));
        let attrs = &mut document["episode_results"][0]["annotations"][0]["attributes"];
        attrs
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"T":"body_part","value":"other"}));
        let duplicate = parse(&serde_json::to_vec(&document).unwrap(), "sample").unwrap();
        assert_eq!(duplicate.segments[0].description, "静止状态");
        assert!(!duplicate.segments[0].attributes.contains_key("body_part"));
        assert!(duplicate.attribute_warnings[0].contains("重复属性值冲突"));
        assert!(validate_source_name("../bailian_annotation.json").is_err());
    }
    #[test]
    fn malformed_optional_attributes_preserve_valid_segments_and_descriptions() {
        let mut document = fixture();
        document["schema_version"] = 4.into();
        document["episode_results"][0]["annotations"][0]["attributes"] = serde_json::json!([
            {"T":"interaction_method","unexpected_key":"legacy value","extra":17},
            {"T":"body_part","value":"双手"},
            null, {"value":"unnamed"},
            {"T":"body_part","value":"双手"}
        ]);
        document["episode_results"][0]["annotations"][0]["attributes_zh"] =
            serde_json::json!([{"T":"动作描述","value":"双手整理物品"}]);
        let bytes = serde_json::to_vec(&document).unwrap();
        for human in [false, true] {
            let parsed = parse_document(&bytes, "sample", human).unwrap();
            assert_eq!(parsed.segments.len(), 2);
            assert_eq!(parsed.segments[0].description, "双手整理物品");
            assert_eq!(
                parsed.segments[0].attributes["interaction_method"],
                Value::Null
            );
            assert_eq!(parsed.segments[0].attributes["body_part"], "双手");
            assert!(parsed.attribute_warnings[0].contains("缺少 value"));
            assert_eq!(parsed.source_json.as_bytes(), bytes);
        }
    }

    #[test]
    fn missing_or_conflicting_descriptions_stay_editable_without_guessing_text() {
        for attrs in [
            serde_json::json!([{"T":"动作描述"}]),
            serde_json::json!([{"T":"动作描述","value":"描述甲"},{"T":"动作描述","value":"描述乙"}]),
            serde_json::json!([{"T":"动作描述","value":42}]),
            serde_json::json!("legacy opaque payload"),
        ] {
            let mut document = fixture();
            let row = &mut document["episode_results"][0]["annotations"][0];
            row["attributes_zh"] = attrs.clone();
            let parsed = parse(&serde_json::to_vec(&document).unwrap(), "sample").unwrap();
            assert_eq!(parsed.segments[0].description, "");
            assert!(!parsed.attribute_warnings.is_empty());
            let row = &mut document["episode_results"][0]["annotations"][0];
            patch_description(row, "人工核对文字").unwrap();
            let parsed = parse_human(&serde_json::to_vec(&document).unwrap(), "sample").unwrap();
            assert_eq!(parsed.segments[0].description, "人工核对文字");
            assert_eq!(parsed.segments[0].end_frame, 22);
            if attrs.is_string() {
                assert_eq!(
                    document["episode_results"][0]["annotations"][0]["attributes_zh"][0],
                    attrs
                );
            }
        }
    }

    #[test]
    fn normalizes_exclusive_intervals_without_shared_boundary() {
        let mut source = fixture();
        source["episode_results"][0]["annotations"][0]["segment_id"] = "seg_test".into();
        source["episode_results"][0]["quality"]["boundary_method"] =
            "observed_sample_frames".into();
        let bytes = serde_json::to_vec(&source).unwrap();
        let result = parse(&bytes, "sample").unwrap();
        assert_eq!(result.source_json.as_bytes(), bytes);
        assert_eq!(result.segments[0].segment_id.as_deref(), Some("seg_test"));
        assert_eq!(
            result.boundary_method.as_deref(),
            Some("observed_sample_frames")
        );
        assert_eq!(result.segments[0].end_frame, 22);
        assert_eq!(result.segments[1].start_frame, 23);
        assert_eq!(result.segments[1].end_frame, 29);
        assert!(result.warnings.is_empty());
        assert_eq!(result.segments[0].description, "");
    }
    #[test]
    fn rejects_wrong_episode_unsupported_schema_and_invalid_ranges() {
        assert!(parse(&serde_json::to_vec(&fixture()).unwrap(), "other").is_err());
        for (pointer, value) in [
            ("/schema_version", serde_json::json!(99)),
            (
                "/episode_results/0/annotations/0/end_frame",
                serde_json::json!(0),
            ),
            (
                "/episode_results/0/annotations/0/end_frame",
                serde_json::json!(31),
            ),
        ] {
            let mut document = fixture();
            *document.pointer_mut(pointer).unwrap() = value;
            assert!(parse(&serde_json::to_vec(&document).unwrap(), "sample").is_err());
        }
    }
    #[test]
    fn legacy_metadata_shows_explicit_assumptions() {
        let mut document = fixture();
        document["episode_results"][0]["media"] = serde_json::json!({"frame_count":30});
        let result = parse(&serde_json::to_vec(&document).unwrap(), "sample").unwrap();
        assert_eq!(result.warnings.len(), 2);
        assert_eq!(result.segments[0].end_frame, 22);
    }
    #[test]
    fn supports_one_based_inclusive_intervals() {
        let mut document = fixture();
        document["episode_results"][0]["media"]["frame_index_base"] = 1.into();
        document["episode_results"][0]["media"]["interval_convention"] = "[start,end]".into();
        document["episode_results"][0]["annotations"][0]["start_frame"] = 1.into();
        let result = parse(&serde_json::to_vec(&document).unwrap(), "sample").unwrap();
        assert_eq!(result.segments[0].start_frame, 0);
        assert_eq!(result.segments[0].end_frame, 22);
    }
    #[test]
    fn file_loading_is_bounded_and_read_only() {
        let temp = std::env::temp_dir().join(format!(
            "dohc-machine-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("sample");
        fs::create_dir_all(&root).unwrap();
        assert!(load(&root).unwrap().is_none());
        let path = root.join("bailian_annotation.json");
        let bytes = serde_json::to_vec(&fixture()).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert_eq!(load(&root).unwrap().unwrap().segments.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(!root.join("description.json").exists());
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(load(&root).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn automatic_selection_prefers_metadata_flash_and_preserves_root_fallback() {
        let temp = std::env::temp_dir().join(format!(
            "dohc-machine-selection-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("sample");
        let metadata = root.join(".session_meta");
        fs::create_dir_all(&metadata).unwrap();
        let bytes = serde_json::to_vec(&fixture()).unwrap();
        fs::write(root.join(DEFAULT_SOURCE), &bytes).unwrap();
        let mut flash = fixture();
        flash["schema_version"] = 4.into();
        let flash_bytes = serde_json::to_vec(&flash).unwrap();
        fs::write(metadata.join(FLASH_SOURCE), &flash_bytes).unwrap();
        let selected = load_selected(&root, None).unwrap().unwrap();
        assert_eq!(selected.source_name, FLASH_SOURCE);
        assert_eq!(selected.source_json.as_bytes(), flash_bytes);
        assert_eq!(load(&root).unwrap().unwrap().source_json.as_bytes(), bytes);
        fs::write(metadata.join(FLASH_SOURCE), b"invalid json").unwrap();
        assert_eq!(
            load_selected(&root, None).unwrap().unwrap().source_name,
            DEFAULT_SOURCE
        );
        assert!(load_selected(&root, Some(FLASH_SOURCE)).is_err());
        fs::remove_file(metadata.join(FLASH_SOURCE)).unwrap();
        assert_eq!(
            load_selected(&root, None).unwrap().unwrap().source_name,
            DEFAULT_SOURCE
        );
        fs::write(root.join(FLASH_SOURCE), &flash_bytes).unwrap();
        assert_eq!(
            load_selected(&root, None).unwrap().unwrap().source_name,
            FLASH_SOURCE
        );
        fs::remove_dir_all(&metadata).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, &metadata).unwrap();
            assert!(load_selected(&root, None).is_err());
            fs::remove_file(&metadata).unwrap();
        }
        fs::write(&metadata, b"not a directory").unwrap();
        assert!(load_selected(&root, None).is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn automatic_loading_discovers_other_bailian_json_without_conventional_names() {
        let temp = std::env::temp_dir().join(format!(
            "viewer-other-machine-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("sample");
        fs::create_dir_all(root.join(".session_meta")).unwrap();
        let bytes = serde_json::to_vec(&fixture()).unwrap();
        fs::write(root.join("bailian_other_model.json"), &bytes).unwrap();
        let loaded = load_selected(&root, None).unwrap().unwrap();
        assert_eq!(loaded.source_name, "./bailian_other_model.json");
        assert_eq!(loaded.source_json.as_bytes(), bytes);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    #[ignore = "Requires an explicitly selected private NAS episode"]
    fn reads_selected_nas_machine_annotation() {
        let path = std::env::var("DOHC_MACHINE_SAMPLE_ROOT").unwrap();
        let source_name = std::env::var("DOHC_MACHINE_SOURCE_NAME").ok();
        let result = load_selected(Path::new(&path), source_name.as_deref())
            .unwrap()
            .unwrap();
        assert!(!result.segments.is_empty());
        println!(
            "Read {} segments, {} source frames, {} warnings, {} attribute warnings; identity verification: {}",
            result.segments.len(),
            result.frame_count,
            result.warnings.len(),
            result.attribute_warnings.len(),
            if result.identity_warning.is_some() && result.identity_verified {
                "renamed folder verified"
            } else if result.identity_warning.is_some() {
                "directory compatibility; source unverified"
            } else {
                "exact episode id"
            },
        );
    }
}
