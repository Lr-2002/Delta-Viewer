use crate::error::{AppError, AppResult};
use crate::media_stream_server::MediaStreamServer;
use crate::model::VideoSource;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLocation {
    pub source_root: String,
    pub preview_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    source_manifest: ManifestStamp,
    streams: BTreeMap<String, Stream>,
}
#[derive(Deserialize)]
struct ManifestStamp {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stream {
    sources: Vec<SourceStamp>,
    media_fps: f64,
    segments: Vec<Segment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceStamp {
    path: String,
    size: u64,
    modified_seconds: u64,
    sample_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    frame_count: u64,
    variants: Vec<Variant>,
}
#[derive(Deserialize)]
struct Variant {
    width: u32,
    height: u32,
    bandwidth: u64,
    fragments: Vec<Fragment>,
}
#[derive(Deserialize)]
struct Fragment {
    path: String,
    duration: f64,
    size: u64,
}

fn invalid(message: &str) -> AppError {
    AppError::Message(format!("预览不可用：{message}"))
}

pub fn read_location(data_root: &Path) -> AppResult<PreviewLocation> {
    match fs::read(data_root.join("preview-location.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PreviewLocation::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub fn save_location(data_root: &Path, location: PreviewLocation) -> AppResult<PreviewLocation> {
    let source = Path::new(&location.source_root).canonicalize()?;
    let preview = Path::new(&location.preview_root).canonicalize()?;
    if !source.is_dir()
        || !preview.is_dir()
        || source.starts_with(&preview)
        || preview.starts_with(&source)
    {
        return Err(invalid("原片与预览必须是互不包含的独立目录"));
    }
    let location = PreviewLocation {
        source_root: source.display().to_string(),
        preview_root: preview.display().to_string(),
    };
    fs::create_dir_all(data_root)?;
    let temporary = data_root.join(format!("preview-location.{}.partial", std::process::id()));
    fs::write(&temporary, serde_json::to_vec(&location)?)?;
    crate::storage::replace_file_atomic(&temporary, &data_root.join("preview-location.json"))?;
    Ok(location)
}

pub(crate) fn relative_path(value: &str) -> AppResult<PathBuf> {
    if value.is_empty() || value.contains(['\\', ':', '\0', '?', '#']) {
        return Err(invalid("预览路径无效"));
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("预览路径必须位于预览目录内"));
    }
    Ok(path)
}

fn read_bounded(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("清单不是普通文件"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("清单过大"));
    }
    Ok(bytes)
}

fn verify_source(root: &Path, stamp: &SourceStamp, expected_path: &str) -> AppResult<()> {
    let file_path = root.join(relative_path(&stamp.path)?).canonicalize()?;
    if !file_path.starts_with(root) || file_path != Path::new(expected_path) {
        return Err(invalid("预览对应的原片路径不匹配"));
    }
    let mut file = File::open(file_path)?;
    let metadata = file.metadata()?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("原片时间无效"))?
        .as_secs();
    if metadata.len() != stamp.size || modified != stamp.modified_seconds {
        return Err(invalid("原片已变更，需要重新生成预览"));
    }
    let size = metadata.len().min(16384) as usize;
    let mut first = vec![0; size];
    let mut last = vec![0; size];
    file.read_exact(&mut first)?;
    file.seek(SeekFrom::End(-(size as i64)))?;
    file.read_exact(&mut last)?;
    let digest = format!(
        "{:x}",
        Sha256::new()
            .chain_update(first)
            .chain_update(last)
            .finalize()
    );
    if digest != stamp.sample_sha256 {
        return Err(invalid("原片内容与预览不匹配"));
    }
    Ok(())
}

pub fn register_preview(
    data_root: &Path,
    root: &Path,
    stream_name: &str,
    source: &VideoSource,
    server: &MediaStreamServer,
) -> AppResult<Option<Vec<String>>> {
    let location = read_location(data_root)?;
    if location.source_root.is_empty() || location.preview_root.is_empty() {
        return Ok(None);
    }
    let source_root = Path::new(&location.source_root).canonicalize()?;
    let root = root.canonicalize()?;
    let Ok(relative) = root.strip_prefix(&source_root) else {
        return Ok(None);
    };
    let preview_root = Path::new(&location.preview_root).canonicalize()?;
    let directory = match preview_root.join(relative).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !directory.starts_with(&preview_root) {
        return Err(invalid("预览目录越界"));
    }
    let bytes = match read_bounded(&directory.join("preview.json"), 8 * 1024 * 1024) {
        Ok(bytes) => bytes,
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.schema_version != 1
        || !["manifest.json", ".session_meta/manifest.json"]
            .contains(&manifest.source_manifest.path.as_str())
    {
        return Err(invalid("预览格式不支持"));
    }
    let source_manifest = root.join(&manifest.source_manifest.path).canonicalize()?;
    if !source_manifest.starts_with(&root) {
        return Err(invalid("原片清单越界"));
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(read_bounded(&source_manifest, 8 * 1024 * 1024)?)
    );
    if digest != manifest.source_manifest.sha256 {
        return Err(invalid("采集清单已变更"));
    }
    let Some(stream) = manifest.streams.get(stream_name) else {
        return Ok(None);
    };
    if stream.sources.len() != source.paths.len()
        || stream.segments.len() != source.paths.len()
        || !stream.media_fps.is_finite()
        || (stream.media_fps - source.media_fps).abs() > 0.01
    {
        return Err(invalid("预览帧率或分段与原片不一致"));
    }
    for (stamp, path) in stream.sources.iter().zip(&source.paths) {
        verify_source(&root, stamp, path)?;
    }
    let mut playlists = Vec::new();
    for segment in &stream.segments {
        if segment.frame_count == 0 || segment.variants.is_empty() || segment.variants.len() > 4 {
            return Err(invalid("预览分段无效"));
        }
        let mut master = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        for variant in &segment.variants {
            if variant.width == 0
                || variant.width > 8192
                || variant.height == 0
                || variant.height > 2160
                || variant.bandwidth == 0
                || variant.bandwidth > 100_000_000
                || variant.fragments.is_empty()
                || variant.fragments.len() > 20000
            {
                return Err(invalid("预览清晰度参数无效"));
            }
            let duration: f64 = variant.fragments.iter().map(|part| part.duration).sum();
            if !duration.is_finite()
                || (duration - segment.frame_count as f64 / stream.media_fps).abs()
                    > 1.0 / stream.media_fps + 0.02
            {
                return Err(invalid("预览时长与原片帧数不一致"));
            }
            let mut body = String::from(
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n",
            );
            let maximum = variant
                .fragments
                .iter()
                .map(|part| part.duration)
                .fold(0.0, f64::max);
            body.push_str(&format!(
                "#EXT-X-TARGETDURATION:{}\n",
                maximum.ceil() as u64
            ));
            for part in &variant.fragments {
                if !part.duration.is_finite()
                    || part.duration <= 0.0
                    || part.duration > 10.0
                    || part.size == 0
                    || part.size > 32 * 1024 * 1024
                {
                    return Err(invalid("预览分片无效"));
                }
                let relative = relative_path(&part.path)?;
                if relative.extension().and_then(|value| value.to_str()) != Some("ts") {
                    return Err(invalid("预览分片格式无效"));
                }
                let url = server.register_preview_fragment(&directory, &relative, part.size)?;
                body.push_str(&format!("#EXTINF:{:.6},\n{url}\n", part.duration));
            }
            body.push_str("#EXT-X-ENDLIST\n");
            let url = server.register_playlist(body)?;
            master.push_str(&format!(
                "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},FRAME-RATE={:.6}\n{url}\n",
                variant.bandwidth, variant.width, variant.height, stream.media_fps
            ));
        }
        playlists.push(server.register_playlist(master)?);
    }
    Ok(Some(playlists))
}
