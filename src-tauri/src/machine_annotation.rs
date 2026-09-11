use crate::error::{AppError, AppResult};
use crate::model::{MachineAnnotation, MachineSegment};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SEGMENTS: usize = 2000;
pub const DEFAULT_SOURCE: &str = "bailian_annotation.json";
pub const FLASH_SOURCE: &str = "bailian_annotation.qwen3.8-flash.json";

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
    let root = root.canonicalize()?;
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
    end_frame: u64,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    attributes_zh: Value,
}

fn attributes_map(value: &Value) -> AppResult<BTreeMap<String, Value>> {
    match value {
        Value::Null => Ok(BTreeMap::new()),
        Value::Object(values) => Ok(values.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        Value::Array(values) => {
            let mut result = BTreeMap::new();
            for entry in values {
                let key = entry
                    .get("T")
                    .and_then(Value::as_str)
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| invalid("机标属性缺少 T 名称"))?;
                let value = entry
                    .get("value")
                    .ok_or_else(|| invalid("机标属性缺少 value"))?;
                if result.insert(key.into(), value.clone()).is_some() {
                    return Err(invalid("机标属性名称重复，无法确定对应字段"));
                }
            }
            Ok(result)
        }
        _ => Err(invalid("机标属性必须为对象或 T/value 数组")),
    }
}

pub(crate) fn description_field(annotation: &Value) -> AppResult<(&'static str, &'static str)> {
    let zh = attributes_map(&annotation["attributes_zh"])?;
    if zh
        .get("动作描述")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
    {
        Ok(("attributes_zh", "动作描述"))
    } else if attributes_map(&annotation["attributes"])?
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
        if let Some(entry) = entries
            .iter_mut()
            .find(|entry| entry["T"].as_str() == Some(key))
        {
            entry["value"] = description.into();
        } else {
            entries.push(serde_json::json!({"T":key,"value":description}));
        }
    } else {
        if attributes.is_null() {
            *attributes = serde_json::json!({});
        }
        attributes[key] = description.into();
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
    let root = fs::canonicalize(root)?;
    let (name, bytes) = match source_name {
        Some(name) => {
            validate_source_name(name)?;
            (name, read_source_bytes(&root, name)?)
        }
        None => match read_source_bytes(&root, FLASH_SOURCE)? {
            Some(bytes) => (FLASH_SOURCE, Some(bytes)),
            None => (DEFAULT_SOURCE, read_source_bytes(&root, DEFAULT_SOURCE)?),
        },
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    parse_document(
        &bytes,
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        matches!(
            name.rsplit('/').next(),
            Some("description.json" | "desorption.json")
        ),
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
    let document: Document =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
            .map_err(|error| invalid(&format!("机标 JSON 格式无效：{error}")))?;
    if ![3, 4].contains(&document.schema_version) {
        return Err(invalid("不支持的机标版本，当前支持 schema_version 3、4"));
    }
    let mut matches = document
        .episode_results
        .into_iter()
        .filter(|episode| episode.episode_id == episode_name);
    let episode = matches
        .next()
        .ok_or_else(|| invalid("机标 episode_id 与当前数据目录不匹配"))?;
    if matches.next().is_some() {
        return Err(invalid("同一数据存在多份机标结果，无法确定当前结果"));
    }
    if episode.media.frame_count == 0
        || episode.media.frame_count > 9_007_199_254_740_991
        || episode.annotations.len() > MAX_SEGMENTS
    {
        return Err(invalid("帧数无效或机标片段超过 2000 条"));
    }
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
    for (source_index, annotation) in episode.annotations.into_iter().enumerate() {
        let start = annotation.start_frame.checked_sub(base);
        let end = annotation
            .end_frame
            .checked_sub(base + u64::from(exclusive));
        let (Some(start), Some(end)) = (start, end) else {
            return Err(invalid("机标片段帧范围无效"));
        };
        if start > end || end >= episode.media.frame_count {
            return Err(invalid("机标片段为空、倒序或超出视频帧数"));
        }
        let attributes = attributes_map(&annotation.attributes)?;
        let attributes_zh = attributes_map(&annotation.attributes_zh)?;
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
    Ok(MachineAnnotation {
        source_name: DEFAULT_SOURCE.into(),
        source_hash: blake3::hash(bytes).to_hex().to_string(),
        episode_id: episode.episode_id,
        source_json: String::from_utf8_lossy(bytes).into_owned(),
        boundary_method: quality_string("boundary_method"),
        model: quality_string("model"),
        completed_at: episode.completed_at,
        validation_status: quality_string("validation_status"),
        frame_count: episode.media.frame_count,
        warnings,
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(parse(&serde_json::to_vec(&document).unwrap(), "sample").is_err());
        assert!(validate_source_name("../bailian_annotation.json").is_err());
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
        assert!(load_selected(&root, None).is_err());
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
    #[ignore = "Requires an explicitly selected private NAS episode"]
    fn reads_selected_nas_machine_annotation() {
        let path = std::env::var("DOHC_MACHINE_SAMPLE_ROOT").unwrap();
        let source_name = std::env::var("DOHC_MACHINE_SOURCE_NAME").ok();
        let result = load_selected(Path::new(&path), source_name.as_deref())
            .unwrap()
            .unwrap();
        assert!(!result.segments.is_empty());
        println!(
            "Read {} segments, {} source frames, {} warnings",
            result.segments.len(),
            result.frame_count,
            result.warnings.len()
        );
    }
}
