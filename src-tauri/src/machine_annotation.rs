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
    attributes: BTreeMap<String, Value>,
}

fn invalid(message: &str) -> AppError {
    AppError::Message(format!("MACHINE_ANNOTATION_INVALID: {message}"))
}

pub fn load(root: &Path) -> AppResult<Option<MachineAnnotation>> {
    let root = fs::canonicalize(root)?;
    let path = root.join("bailian_annotation.json");
    let Some(bytes) = read_bytes(&path)? else {
        return Ok(None);
    };
    parse(
        &bytes,
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
    )
    .map(Some)
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

fn parse(bytes: &[u8], episode_name: &str) -> AppResult<MachineAnnotation> {
    let document: Document =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
            .map_err(|error| invalid(&format!("机标 JSON 格式无效：{error}")))?;
    if document.schema_version != 3 {
        return Err(invalid("不支持的机标版本，当前支持 schema_version 3"));
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
        segments.push(MachineSegment {
            source_index,
            segment_id: annotation.segment_id,
            label: annotation.label_code,
            description: annotation
                .attributes
                .get("semantic_description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            start_frame: start,
            end_frame: end,
            attributes: annotation.attributes,
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
    Ok(MachineAnnotation {
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
        assert_eq!(result.segments[0].description, "Standing");
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
    #[ignore = "Requires an explicitly selected private NAS episode"]
    fn reads_selected_nas_machine_annotation() {
        let path = std::env::var("DOHC_MACHINE_SAMPLE_ROOT").unwrap();
        let result = load(Path::new(&path)).unwrap().unwrap();
        assert!(!result.segments.is_empty());
        println!(
            "Read {} segments, {} source frames, {} warnings",
            result.segments.len(),
            result.frame_count,
            result.warnings.len()
        );
    }
}
