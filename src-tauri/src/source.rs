use crate::error::{AppError, AppResult};
use crate::model::{
    EpisodeData, EpisodeSummary, ProgressPayload, RawStateRecord, ScanResult, StateRecord,
    StreamSummary, TaskProgressEvent, VideoSource, STREAM_NAMES,
};
use crate::segment_bin::{self, SegmentEpisodeIndex};
use crate::storage;
use blake3::Hasher;
use image::ImageReader;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

pub(crate) const SOURCE_INDEX_MAX_EPISODES: usize = 64;
pub(crate) const SOURCE_INDEX_MAX_FRAME_PATHS: usize = 250_000;

thread_local! {
    static PROGRESS_OPERATION_ID: Cell<Option<u64>> = const { Cell::new(None) };
}

pub struct ProgressOperationScope {
    previous: Option<u64>,
}

pub fn enter_operation_progress(operation_id: u64) -> ProgressOperationScope {
    let previous = PROGRESS_OPERATION_ID.with(|current| current.replace(Some(operation_id)));
    ProgressOperationScope { previous }
}

impl Drop for ProgressOperationScope {
    fn drop(&mut self) {
        PROGRESS_OPERATION_ID.with(|current| current.set(self.previous));
    }
}

#[derive(Clone)]
pub struct StreamFiles {
    pub frames: Vec<(u64, PathBuf)>,
    pub invalid_names: Vec<String>,
    pub duplicate_ids: Vec<u64>,
}

#[derive(Clone)]
pub struct EpisodeIndex {
    pub summary: EpisodeSummary,
    pub fingerprint: String,
    pub stream_files: BTreeMap<String, StreamFiles>,
    pub segment: Option<SegmentEpisodeIndex>,
}

struct IndexedFile {
    path: PathBuf,
    relative: String,
    len: u64,
    modified_ns: u128,
}

impl EpisodeIndex {
    pub fn frame_path_count(&self) -> usize {
        self.stream_files
            .values()
            .map(|files| files.frames.len())
            .sum()
    }
}

pub fn scan_source_catalog(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<ScanResult> {
    if !root.exists() {
        return Err(AppError::MissingPath(root.display().to_string()));
    }
    if !root.is_dir() {
        return Err(AppError::Message(format!(
            "源路径不是目录: {}",
            root.display()
        )));
    }

    let volume = storage::volume_info(root)?;
    storage::ensure_source_volume(&volume)?;
    let episode_roots = discover_episode_roots(root, cancelled)?;
    if episode_roots.is_empty() {
        return Err(AppError::NoEpisodes(root.display().to_string()));
    }
    let episodes = episode_roots
        .iter()
        .map(|episode_root| catalog_episode_summary(episode_root))
        .collect::<Vec<_>>();
    emit_progress(
        app,
        ProgressPayload {
            task: "scan".into(),
            phase: "已发现记录".into(),
            current: episodes.len() as u64,
            total: episodes.len() as u64,
            bytes_done: 0,
            total_bytes: 0,
            current_path: root.display().to_string(),
            elapsed_ms: 0,
        },
    );
    Ok(ScanResult {
        source_root: root.display().to_string(),
        episodes,
        total_files: 0,
        total_bytes: 0,
        volume,
    })
}

pub fn load_episode(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    let index = scan_episode_index(root, app, cancelled)?;
    load_episode_with_index(root, &index, cancelled)
}

pub fn load_episode_preview(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    if !root.is_dir() {
        return Err(AppError::MissingPath(root.display().to_string()));
    }
    storage::ensure_source_volume(&storage::volume_info(root)?)?;
    if is_segment_episode(root) {
        let index = scan_episode_index(root, app, cancelled)?;
        return load_episode_with_index(root, &index, cancelled);
    }
    let states = read_states(&root.join("states.jsonl"), cancelled)?;
    let mut streams = Vec::with_capacity(STREAM_NAMES.len());
    let mut frame_file_count = 0_u64;
    let mp4_manifest = read_mp4_manifest(root)?;
    for (index, stream_name) in STREAM_NAMES.iter().enumerate() {
        check_cancelled(cancelled)?;
        if let Some(manifest) = mp4_manifest.as_ref() {
            let summary = mp4_stream_summary(root, stream_name, manifest);
            frame_file_count = frame_file_count.saturating_add(summary.frame_count);
            streams.push(summary);
        } else {
            let files = collect_stream_files(root, stream_name, cancelled)?;
            frame_file_count = frame_file_count.saturating_add(files.frames.len() as u64);
            streams.push(preview_stream_summary(stream_name, &files));
        }
        emit_progress(
            app,
            ProgressPayload {
                task: "scan".into(),
                phase: "准备预览".into(),
                current: (index + 1) as u64,
                total: STREAM_NAMES.len() as u64,
                bytes_done: 0,
                total_bytes: 0,
                current_path: root.join(stream_name).display().to_string(),
                elapsed_ms: 0,
            },
        );
    }
    let state_count = states.len() as u64;
    let start_time_ns = states.first().map(|state| state.capture_time_ns.clone());
    let end_time_ns = states.last().map(|state| state.capture_time_ns.clone());
    let (skeleton, skeleton_error) =
        crate::skeleton::load_optional_skeleton(root, &states, cancelled)?;
    Ok(EpisodeData {
        summary: EpisodeSummary {
            root: root.display().to_string(),
            name: episode_name(root),
            indexed: false,
            total_files: frame_file_count
                .saturating_add(u64::from(is_regular_file(&root.join("states.jsonl")))),
            total_bytes: 0,
            state_count,
            start_time_ns,
            end_time_ns,
            streams,
        },
        states,
        skeleton,
        skeleton_error,
    })
}

pub fn load_episode_with_index(
    root: &Path,
    index: &EpisodeIndex,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    if let Some(segment) = index.segment.as_ref() {
        if !root.is_dir() {
            return Err(AppError::MissingPath(root.display().to_string()));
        }
        storage::ensure_source_volume(&storage::volume_info(root)?)?;
        let states = segment
            .states
            .iter()
            .cloned()
            .map(StateRecord::from)
            .collect::<Vec<_>>();
        let (skeleton, skeleton_error) =
            crate::skeleton::load_optional_skeleton(root, &states, cancelled)?;
        return Ok(EpisodeData {
            summary: index.summary.clone(),
            states,
            skeleton,
            skeleton_error,
        });
    }
    load_episode_with_summary(root, index.summary.clone(), cancelled)
}

pub fn load_episode_with_summary(
    root: &Path,
    summary: EpisodeSummary,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    if !root.is_dir() {
        return Err(AppError::MissingPath(root.display().to_string()));
    }
    storage::ensure_source_volume(&storage::volume_info(root)?)?;
    let states_path = root.join("states.jsonl");
    let states = read_states(&states_path, cancelled)?;
    let (skeleton, skeleton_error) =
        crate::skeleton::load_optional_skeleton(root, &states, cancelled)?;
    Ok(EpisodeData {
        summary,
        states,
        skeleton,
        skeleton_error,
    })
}

#[cfg(test)]
pub fn read_frame(
    root: &Path,
    stream: &str,
    frame_id: u64,
    app: Option<&AppHandle>,
) -> AppResult<(String, Vec<u8>)> {
    read_frame_with_index(root, stream, frame_id, None, app)
}

pub fn read_frame_with_index(
    root: &Path,
    stream: &str,
    frame_id: u64,
    index: Option<&EpisodeIndex>,
    app: Option<&AppHandle>,
) -> AppResult<(String, Vec<u8>)> {
    if !STREAM_NAMES.contains(&stream) {
        return Err(AppError::InvalidStream(stream.to_string()));
    }
    if let Some(segment) = index
        .and_then(|index| index.segment.as_ref())
        .filter(|segment| segment.streams.contains_key(stream))
    {
        return Ok((
            "image/jpeg".into(),
            segment_bin::read_frame_payload(segment, stream, frame_id)?,
        ));
    }
    if is_segment_episode(root) {
        let cancelled = AtomicBool::new(false);
        let index = scan_episode_index(root, None, &cancelled)?;
        let segment = index
            .segment
            .as_ref()
            .ok_or_else(|| AppError::Message("segment 索引建立失败".into()))?;
        if segment.streams.contains_key(stream) {
            return Ok((
                "image/jpeg".into(),
                segment_bin::read_frame_payload(segment, stream, frame_id)?,
            ));
        }
    }
    let stream_root = root.join(stream);
    if !is_regular_directory(&stream_root) {
        return Err(AppError::MissingPath(stream_root.display().to_string()));
    }
    let path = stream_root.join(format!("{frame_id}.jpg"));
    if is_regular_file(&path) {
        let bytes = fs::read(&path)?;
        return Ok(("image/jpeg".into(), bytes));
    }
    read_mp4_frame(root, stream, frame_id, app)
}

pub fn jpeg_stream_directory(root: &Path, stream: &str) -> AppResult<Option<PathBuf>> {
    if !STREAM_NAMES.contains(&stream) {
        return Err(AppError::InvalidStream(stream.to_string()));
    }
    let stream_root = root.join(stream);
    let Ok(metadata) = fs::symlink_metadata(&stream_root) else {
        return Ok(None);
    };
    if !metadata.file_type().is_dir() {
        return Ok(None);
    }
    Ok(Some(stream_root.canonicalize()?))
}

fn read_mp4_frame(
    root: &Path,
    stream: &str,
    frame_id: u64,
    app: Option<&AppHandle>,
) -> AppResult<(String, Vec<u8>)> {
    let manifest = read_mp4_manifest(root)?.ok_or_else(|| {
        AppError::MissingPath(
            root.join(stream)
                .join(format!("{frame_id}.jpg"))
                .display()
                .to_string(),
        )
    })?;
    let stream_info = manifest
        .streams
        .get(stream)
        .ok_or_else(|| AppError::InvalidStream(stream.to_string()))?;
    let fps = stream_info
        .get("fps")
        .and_then(|value| value.as_f64())
        .unwrap_or(60.0);
    let relative_frame = frame_id.saturating_sub(manifest.timeline_start_frame);
    let target_index =
        ((relative_frame as f64) * fps / manifest.timeline_fps.max(1.0)).floor() as u64;
    let frame_count = stream_info
        .get("frame_count")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if target_index >= frame_count {
        return Err(AppError::MissingPath(format!(
            "{stream} MP4 帧 {target_index}"
        )));
    }
    let segments = stream_info
        .get("segments")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::Message(format!("{stream} 的 MP4 清单缺少 segments")))?;
    let segment_seconds = manifest.segment_seconds.unwrap_or(300.0).max(1.0);
    let timestamp_seconds = target_index as f64 / fps.max(1.0);
    let segment_index = (timestamp_seconds / segment_seconds).floor() as usize;
    let relative_path = segments
        .get(segment_index)
        .and_then(|value| value.get("path"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::Message(format!("{stream} 找不到对应的 MP4 分段")))?;
    let video_path = root.join(relative_path);
    if !is_regular_file(&video_path) {
        return Err(AppError::MissingPath(video_path.display().to_string()));
    }
    let local_timestamp = timestamp_seconds - segment_index as f64 * segment_seconds;
    let mut failures = Vec::new();
    for ffmpeg in crate::export::lerobot::ffmpeg_candidates(app) {
        let output = Command::new(&ffmpeg)
            .args(["-v", "error", "-ss", &format!("{local_timestamp:.6}"), "-i"])
            .arg(&video_path)
            .args([
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "pipe:1",
            ])
            .output();
        match output {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                return Ok(("image/jpeg".into(), output.stdout));
            }
            Ok(output) => failures.push(format!(
                "{}: {}",
                ffmpeg.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => failures.push(format!("{}: {error}", ffmpeg.display())),
        }
    }
    Err(AppError::Message(format!(
        "没有可用的 FFmpeg 能解码该 MP4: {}",
        failures.join("；")
    )))
}

pub(crate) fn read_mp4_preview_batch(
    root: &Path,
    stream: &str,
    start_frame_id: u64,
    app: Option<&AppHandle>,
) -> AppResult<Vec<(u64, Arc<Vec<u8>>)>> {
    const TIMELINE_FRAMES_PER_BATCH: u64 = 240;

    let manifest = read_mp4_manifest(root)?
        .ok_or_else(|| AppError::Message("当前记录不是 MP4 视频格式".into()))?;
    let stream_info = manifest
        .streams
        .get(stream)
        .ok_or_else(|| AppError::InvalidStream(stream.to_string()))?;
    let fps = stream_info
        .get("fps")
        .and_then(|value| value.as_f64())
        .unwrap_or(60.0)
        .max(1.0);
    let frame_count = stream_info
        .get("frame_count")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let segments = stream_info
        .get("segments")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::Message(format!("{stream} 的 MP4 清单缺少 segments")))?;
    let segment_seconds = manifest.segment_seconds.unwrap_or(300.0).max(1.0);
    let timeline_fps = manifest.timeline_fps.max(1.0);
    let target_for = |timeline_frame: u64| {
        let relative = timeline_frame.saturating_sub(manifest.timeline_start_frame);
        ((relative as f64) * fps / timeline_fps).floor() as u64
    };

    let first_target = target_for(start_frame_id);
    if first_target >= frame_count {
        return Err(AppError::MissingPath(format!(
            "{stream} MP4 帧 {first_target}"
        )));
    }
    let first_timestamp = first_target as f64 / fps;
    let segment_index = (first_timestamp / segment_seconds).floor() as usize;
    let mut timeline_targets = Vec::with_capacity(TIMELINE_FRAMES_PER_BATCH as usize);
    for frame_id in start_frame_id..start_frame_id.saturating_add(TIMELINE_FRAMES_PER_BATCH) {
        let target = target_for(frame_id);
        if target >= frame_count {
            break;
        }
        let target_segment = ((target as f64 / fps) / segment_seconds).floor() as usize;
        if target_segment != segment_index {
            break;
        }
        timeline_targets.push((frame_id, target));
    }
    let last_target = timeline_targets
        .last()
        .map(|(_, target)| *target)
        .ok_or_else(|| AppError::MissingPath(format!("{stream} MP4 帧 {start_frame_id}")))?;
    let decode_count = last_target.saturating_sub(first_target).saturating_add(1);
    let relative_path = segments
        .get(segment_index)
        .and_then(|value| value.get("path"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::Message(format!("{stream} 找不到对应的 MP4 分段")))?;
    let video_path = root.join(relative_path);
    if !is_regular_file(&video_path) {
        return Err(AppError::MissingPath(video_path.display().to_string()));
    }
    let local_timestamp = first_timestamp - segment_index as f64 * segment_seconds;
    let downscale = stream_info
        .get("width")
        .and_then(|value| value.as_u64())
        .is_some_and(|width| width > 1280);
    let mut failures = Vec::new();
    for ffmpeg in crate::export::lerobot::ffmpeg_candidates(app) {
        let mut command = Command::new(&ffmpeg);
        command
            .args(["-v", "error", "-ss", &format!("{local_timestamp:.6}"), "-i"])
            .arg(&video_path)
            .args(["-frames:v", &decode_count.to_string()]);
        if downscale {
            command.args(["-vf", "scale=1280:-2"]);
        }
        let output = command
            .args([
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-q:v",
                "5",
                "pipe:1",
            ])
            .output();
        match output {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                let decoded = split_mjpeg_frames(&output.stdout, decode_count as usize)?;
                return Ok(timeline_targets
                    .into_iter()
                    .map(|(timeline_frame, target)| {
                        let decoded_index = target.saturating_sub(first_target) as usize;
                        (timeline_frame, decoded[decoded_index].clone())
                    })
                    .collect());
            }
            Ok(output) => failures.push(format!(
                "{}: {}",
                ffmpeg.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => failures.push(format!("{}: {error}", ffmpeg.display())),
        }
    }
    Err(AppError::Message(format!(
        "没有可用的 FFmpeg 能连续解码该 MP4: {}",
        failures.join("；")
    )))
}

fn split_mjpeg_frames(bytes: &[u8], expected: usize) -> AppResult<Vec<Arc<Vec<u8>>>> {
    let mut frames = Vec::with_capacity(expected);
    let mut cursor = 0;
    while cursor + 1 < bytes.len() && frames.len() < expected {
        let Some(relative_start) = bytes[cursor..]
            .windows(2)
            .position(|pair| pair == [0xff, 0xd8])
        else {
            break;
        };
        let start = cursor + relative_start;
        let Some(relative_end) = bytes[start + 2..]
            .windows(2)
            .position(|pair| pair == [0xff, 0xd9])
        else {
            break;
        };
        let end = start + 2 + relative_end + 2;
        frames.push(Arc::new(bytes[start..end].to_vec()));
        cursor = end;
    }
    if frames.len() != expected {
        return Err(AppError::Message(format!(
            "MP4 连续预览期望 {expected} 帧，实际解码 {} 帧",
            frames.len()
        )));
    }
    Ok(frames)
}

struct Mp4Manifest {
    segment_seconds: Option<f64>,
    streams: serde_json::Map<String, serde_json::Value>,
    timeline_start_frame: u64,
    timeline_fps: f64,
    hybrid: bool,
}

fn read_mp4_manifest(root: &Path) -> AppResult<Option<Mp4Manifest>> {
    let path = root.join("manifest.json");
    if !is_regular_file(&path) {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_reader(BufReader::new(File::open(path)?))?;
    let storage_format = value.get("storage_format").and_then(|item| item.as_str());
    let hybrid = storage_format == Some("hybrid-h264-jpeg-segment-v1");
    if storage_format != Some("h264-split-mp4-v1") && !hybrid {
        return Ok(None);
    }
    let streams = value
        .get("streams")
        .and_then(|item| item.as_object())
        .cloned()
        .ok_or_else(|| AppError::Message("MP4 manifest.json 缺少 streams".into()))?;
    Ok(Some(Mp4Manifest {
        segment_seconds: value.get("segment_seconds").and_then(|item| item.as_f64()),
        streams,
        timeline_start_frame: if hybrid {
            hybrid_timeline_start_frame(root).unwrap_or_default()
        } else {
            0
        },
        timeline_fps: if hybrid { 30.0 } else { 60.0 },
        hybrid,
    }))
}

fn hybrid_timeline_start_frame(root: &Path) -> Option<u64> {
    let path = root.join("t265/manifest.json");
    let value: serde_json::Value =
        serde_json::from_reader(BufReader::new(File::open(path).ok()?)).ok()?;
    value
        .get("segments")?
        .as_array()?
        .first()?
        .get("first_batch_id")?
        .as_u64()
}

fn segment_folder_for_episode(root: &Path) -> Option<PathBuf> {
    if segment_bin::is_segment_folder(root) {
        return Some(root.to_path_buf());
    }
    let nested = root.join("t265/segments");
    read_mp4_manifest(root)
        .ok()
        .flatten()
        .is_some_and(|manifest| manifest.hybrid && segment_bin::is_segment_folder(&nested))
        .then_some(nested)
}

pub(crate) fn is_mp4_episode(root: &Path) -> bool {
    read_mp4_manifest(root).ok().flatten().is_some()
}

pub(crate) fn is_segment_episode(root: &Path) -> bool {
    segment_folder_for_episode(root).is_some()
}

pub(crate) fn is_mp4_stream(root: &Path, stream: &str) -> bool {
    read_mp4_manifest(root)
        .ok()
        .flatten()
        .and_then(|manifest| manifest.streams.get(stream).cloned())
        .and_then(|info| info.get("frame_count").and_then(|value| value.as_u64()))
        .is_some_and(|frame_count| frame_count > 0)
}

pub(crate) fn video_source(root: &Path, stream: &str) -> AppResult<VideoSource> {
    if !STREAM_NAMES.contains(&stream) {
        return Err(AppError::InvalidStream(stream.to_string()));
    }
    let canonical_root = root.canonicalize()?;
    let manifest = read_mp4_manifest(&canonical_root)?
        .ok_or_else(|| AppError::Message("当前记录不是 MP4 视频格式".into()))?;
    let info = manifest
        .streams
        .get(stream)
        .ok_or_else(|| AppError::InvalidStream(stream.to_string()))?;
    let fps = info
        .get("fps")
        .and_then(|value| value.as_f64())
        .unwrap_or(60.0);
    let segments = info
        .get("segments")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::Message(format!("{stream} 的 MP4 清单缺少 segments")))?;
    let mut paths = Vec::with_capacity(segments.len());
    for segment in segments {
        let relative = segment
            .get("path")
            .and_then(|value| value.as_str())
            .ok_or_else(|| AppError::Message(format!("{stream} 的 MP4 分段路径无效")))?;
        let path = canonical_root.join(relative).canonicalize()?;
        if !path.starts_with(&canonical_root) || !is_regular_file(&path) {
            return Err(AppError::Message(format!(
                "MP4 分段不在当前记录内: {relative}"
            )));
        }
        paths.push(path.display().to_string());
    }
    if paths.is_empty() {
        return Err(AppError::Message(format!("{stream} 没有 MP4 分段")));
    }
    Ok(VideoSource {
        fps,
        segment_seconds: manifest.segment_seconds.unwrap_or(300.0).max(1.0),
        start_frame: manifest.timeline_start_frame,
        paths,
    })
}

pub fn scan_episode(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeSummary> {
    scan_episode_index(root, app, cancelled).map(|index| index.summary)
}

pub fn scan_episode_index(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeIndex> {
    if !root.is_dir() {
        return Err(AppError::MissingPath(root.display().to_string()));
    }

    storage::ensure_source_volume(&storage::volume_info(root)?)?;
    let segment_folder = segment_folder_for_episode(root);
    let segment = match segment_folder.as_deref() {
        Some(folder) => segment_bin::scan_segment_folder(folder, cancelled)?,
        None => None,
    };
    let direct_segment = segment_folder.as_deref() == Some(root);
    let indexed_files = if direct_segment {
        collect_segment_indexed_files(root, cancelled)?
    } else {
        collect_indexed_files(root, cancelled)?
    };
    let total_files = indexed_files.len() as u64;
    let total_bytes = indexed_files
        .iter()
        .map(|file| file.len)
        .fold(0_u64, u64::saturating_add);
    let fingerprint = fingerprint_indexed_files(&indexed_files);
    if let Some(segment) = segment {
        let mp4_manifest = read_mp4_manifest(root)?;
        let streams = STREAM_NAMES
            .iter()
            .map(|stream_name| {
                if segment.streams.contains_key(*stream_name) {
                    segment_stream_summary(&segment, stream_name)
                } else if let Some(manifest) = mp4_manifest.as_ref() {
                    Ok(mp4_stream_summary(root, stream_name, manifest))
                } else {
                    Ok(empty_stream_summary(stream_name))
                }
            })
            .collect::<AppResult<Vec<_>>>()?;
        let state_count = segment.states.len() as u64;
        let start_time_ns = segment
            .states
            .first()
            .map(|state| state.capture_time_ns.to_string());
        let end_time_ns = segment
            .states
            .last()
            .map(|state| state.capture_time_ns.to_string());
        return Ok(EpisodeIndex {
            summary: EpisodeSummary {
                root: root.display().to_string(),
                name: episode_name(root),
                indexed: true,
                total_files,
                total_bytes,
                state_count,
                start_time_ns,
                end_time_ns,
                streams,
            },
            fingerprint,
            stream_files: BTreeMap::new(),
            segment: Some(segment),
        });
    }
    let states_path = root.join("states.jsonl");
    let (state_count, start_time_ns, end_time_ns) = summarize_states(&states_path, cancelled)?;

    let mp4_manifest = read_mp4_manifest(root)?;
    let mut streams = Vec::with_capacity(STREAM_NAMES.len());
    let mut stream_files_by_name = BTreeMap::new();
    for (index, stream_name) in STREAM_NAMES.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let (stream_files, stream_total_bytes) =
            collect_stream_files_from_index(root, stream_name, &indexed_files);
        streams.push(if let Some(manifest) = mp4_manifest.as_ref() {
            mp4_stream_summary(root, stream_name, manifest)
        } else {
            scan_stream_from_files(
                root,
                stream_name,
                &stream_files,
                stream_total_bytes,
                cancelled,
            )?
        });
        stream_files_by_name.insert((*stream_name).to_string(), stream_files);
        emit_progress(
            app,
            ProgressPayload {
                task: "scan".into(),
                phase: "读取流索引".into(),
                current: (index + 1) as u64,
                total: STREAM_NAMES.len() as u64,
                bytes_done: 0,
                total_bytes,
                current_path: root.join(stream_name).display().to_string(),
                elapsed_ms: 0,
            },
        );
    }

    Ok(EpisodeIndex {
        summary: EpisodeSummary {
            root: root.display().to_string(),
            name: episode_name(root),
            indexed: true,
            total_files,
            total_bytes,
            state_count,
            start_time_ns,
            end_time_ns,
            streams,
        },
        fingerprint,
        stream_files: stream_files_by_name,
        segment: None,
    })
}

fn segment_stream_summary(
    segment: &SegmentEpisodeIndex,
    stream_name: &str,
) -> AppResult<StreamSummary> {
    let Some(frames) = segment.streams.get(stream_name) else {
        return Ok(empty_stream_summary(stream_name));
    };
    let frame_ids = frames
        .iter()
        .map(|frame| frame.frame_id)
        .collect::<BTreeSet<_>>();
    let first_frame = frame_ids.first().copied();
    let last_frame = frame_ids.last().copied();
    let missing_frame_count = match (first_frame, last_frame) {
        (Some(first), Some(last)) => (u128::from(last) - u128::from(first) + 1)
            .saturating_sub(frame_ids.len() as u128)
            .min(u128::from(u64::MAX)) as u64,
        _ => 0,
    };
    let missing_frames = match (first_frame, last_frame) {
        (Some(first), Some(last)) => (first..=last)
            .filter(|frame| !frame_ids.contains(frame))
            .take(2048)
            .collect(),
        _ => Vec::new(),
    };
    let dimensions = frames.first().map_or(Ok(None), |frame| {
        let bytes = segment_bin::read_frame_at(segment, frame)?;
        let image = image::load_from_memory(&bytes).map_err(|error| {
            AppError::Message(format!(
                "SEGMENT_BIN_INVALID: {stream_name} 首帧 {} 无法解码: {error}",
                frame.frame_id
            ))
        })?;
        Ok::<Option<(u32, u32, u8)>, AppError>(Some((
            image.width(),
            image.height(),
            image.color().channel_count(),
        )))
    })?;
    Ok(StreamSummary {
        name: stream_name.to_string(),
        label: stream_label(stream_name).to_string(),
        frame_count: frame_ids.len() as u64,
        first_frame,
        last_frame,
        missing_frames,
        missing_frame_count,
        total_bytes: frames
            .iter()
            .map(|frame| u64::from(frame.payload_len))
            .sum(),
        width: dimensions.map(|value| value.0),
        height: dimensions.map(|value| value.1),
        channels: dimensions.map(|value| value.2),
    })
}

fn mp4_stream_summary(root: &Path, stream_name: &str, manifest: &Mp4Manifest) -> StreamSummary {
    let info = manifest.streams.get(stream_name);
    let fps = info
        .and_then(|item| item.get("fps"))
        .and_then(|item| item.as_f64())
        .unwrap_or(manifest.timeline_fps)
        .max(1.0);
    let frame_count = info
        .and_then(|item| item.get("frame_count"))
        .and_then(|item| item.as_u64())
        .unwrap_or_default();
    let total_bytes = info
        .and_then(|item| item.get("size"))
        .and_then(|item| item.as_u64())
        .unwrap_or_else(|| {
            info.and_then(|item| item.get("segments"))
                .and_then(|item| item.as_array())
                .into_iter()
                .flatten()
                .filter_map(|segment| segment.get("path").and_then(|path| path.as_str()))
                .filter_map(|relative| fs::metadata(root.join(relative)).ok())
                .map(|metadata| metadata.len())
                .sum()
        });
    let first_frame = (frame_count > 0).then_some(manifest.timeline_start_frame);
    let last_frame = mp4_stream_last_timeline_frame(
        manifest.timeline_start_frame,
        manifest.timeline_fps,
        fps,
        frame_count,
    );
    StreamSummary {
        name: stream_name.to_string(),
        label: stream_label(stream_name).to_string(),
        frame_count,
        first_frame,
        last_frame,
        missing_frames: Vec::new(),
        missing_frame_count: 0,
        total_bytes,
        width: info
            .and_then(|item| item.get("width"))
            .and_then(|item| item.as_u64())
            .and_then(|value| u32::try_from(value).ok()),
        height: info
            .and_then(|item| item.get("height"))
            .and_then(|item| item.as_u64())
            .and_then(|value| u32::try_from(value).ok()),
        channels: Some(3),
    }
}

fn mp4_stream_last_timeline_frame(
    timeline_start_frame: u64,
    timeline_fps: f64,
    stream_fps: f64,
    frame_count: u64,
) -> Option<u64> {
    if frame_count == 0 {
        return None;
    }
    let timeline_span =
        ((frame_count as f64) * timeline_fps.max(1.0) / stream_fps.max(1.0)).ceil() as u64;
    timeline_start_frame.checked_add(timeline_span.saturating_sub(1))
}

pub fn collect_files(root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        check_cancelled(cancelled)?;
        let entry = entry.map_err(|error| AppError::Message(error.to_string()))?;
        if entry.file_type().is_file()
            && !is_platform_metadata_file_name(entry.file_name())
            && !crate::episode_metadata::is_description_partial_path(root, entry.path())
        {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort_by(|left, right| {
        left.strip_prefix(root)
            .unwrap_or(left)
            .to_string_lossy()
            .cmp(&right.strip_prefix(root).unwrap_or(right).to_string_lossy())
    });
    Ok(files)
}

pub fn episode_fingerprint(root: &Path, cancelled: &AtomicBool) -> AppResult<String> {
    storage::ensure_source_volume(&storage::volume_info(root)?)?;
    let files = if segment_bin::is_segment_folder(root) {
        collect_segment_indexed_files(root, cancelled)?
    } else {
        collect_indexed_files(root, cancelled)?
    };
    Ok(fingerprint_indexed_files(&files))
}

fn collect_segment_indexed_files(
    root: &Path,
    cancelled: &AtomicBool,
) -> AppResult<Vec<IndexedFile>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || segment_bin::segment_number_from_name(&entry.file_name()).is_none()
        {
            continue;
        }
        let metadata = entry.metadata()?;
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        files.push(IndexedFile {
            path: entry.path(),
            relative: entry.file_name().to_string_lossy().into_owned(),
            len: metadata.len(),
            modified_ns,
        });
    }
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(files)
}

fn collect_indexed_files(root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<IndexedFile>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        check_cancelled(cancelled)?;
        let entry = entry.map_err(|error| AppError::Message(error.to_string()))?;
        if !entry.file_type().is_file()
            || is_platform_metadata_file_name(entry.file_name())
            || crate::episode_metadata::is_description_path(root, entry.path())
            || crate::episode_metadata::is_description_partial_path(root, entry.path())
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| AppError::Message(error.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| AppError::Message(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        files.push(IndexedFile {
            path: entry.path().to_path_buf(),
            relative,
            len: metadata.len(),
            modified_ns,
        });
    }
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(files)
}

fn fingerprint_indexed_files(files: &[IndexedFile]) -> String {
    let mut hasher = Hasher::new();
    for path in files {
        hasher.update(path.relative.as_bytes());
        hasher.update(&[0]);
        hasher.update(&path.len.to_le_bytes());
        hasher.update(&path.modified_ns.to_le_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn discover_episode_roots(root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<PathBuf>> {
    let (root_is_episode, child_directories) = inspect_episode_directory(root, cancelled)?;
    if root_is_episode {
        return Ok(vec![root.to_path_buf()]);
    }

    let mut roots = Vec::new();
    for path in child_directories {
        check_cancelled(cancelled)?;
        if inspect_episode_directory(&path, cancelled)?.0 {
            roots.push(path);
        }
    }
    roots.sort();
    Ok(roots)
}

fn inspect_episode_directory(
    root: &Path,
    cancelled: &AtomicBool,
) -> AppResult<(bool, Vec<PathBuf>)> {
    let mut child_directories = Vec::new();
    for entry in fs::read_dir(root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let name = entry.file_name();
            if name.to_str().is_some_and(|value| value.starts_with('.'))
                || name == OsStr::new("System Volume Information")
            {
                continue;
            }
            if STREAM_NAMES
                .iter()
                .any(|stream_name| name == OsStr::new(stream_name))
            {
                return Ok((true, Vec::new()));
            }
            child_directories.push(entry.path());
        } else if file_type.is_file() {
            let name = entry.file_name();
            if name == OsStr::new("states.jsonl")
                || segment_bin::segment_number_from_name(&name).is_some()
            {
                return Ok((true, Vec::new()));
            }
        }
    }
    Ok((false, child_directories))
}

fn catalog_episode_summary(root: &Path) -> EpisodeSummary {
    EpisodeSummary {
        root: root.display().to_string(),
        name: episode_name(root),
        indexed: false,
        total_files: 0,
        total_bytes: 0,
        state_count: 0,
        start_time_ns: None,
        end_time_ns: None,
        streams: STREAM_NAMES
            .iter()
            .map(|name| empty_stream_summary(name))
            .collect(),
    }
}

fn episode_name(root: &Path) -> String {
    root.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("episode")
        .to_string()
}

fn stream_label(stream_name: &str) -> &str {
    match stream_name {
        "cam0" => "Camera 0",
        "cam1" => "Camera 1",
        "cam2" => "Camera 2",
        "t265_left" => "T265 Left",
        "t265_right" => "T265 Right",
        _ => stream_name,
    }
}

fn empty_stream_summary(stream_name: &str) -> StreamSummary {
    StreamSummary {
        name: stream_name.to_string(),
        label: stream_label(stream_name).to_string(),
        frame_count: 0,
        first_frame: None,
        last_frame: None,
        missing_frames: Vec::new(),
        missing_frame_count: 0,
        total_bytes: 0,
        width: None,
        height: None,
        channels: None,
    }
}

fn preview_stream_summary(stream_name: &str, stream_files: &StreamFiles) -> StreamSummary {
    let frame_ids = stream_files
        .frames
        .iter()
        .map(|(frame_id, _)| *frame_id)
        .collect::<BTreeSet<_>>();
    let first_frame = frame_ids.first().copied();
    let last_frame = frame_ids.last().copied();
    let missing_frame_count = match (first_frame, last_frame) {
        (Some(first), Some(last)) => (u128::from(last) - u128::from(first) + 1)
            .saturating_sub(frame_ids.len() as u128)
            .min(u128::from(u64::MAX)) as u64,
        _ => 0,
    };
    let missing_frames = match (first_frame, last_frame) {
        (Some(first), Some(last)) => (first..=last)
            .filter(|frame| !frame_ids.contains(frame))
            .take(2048)
            .collect(),
        _ => Vec::new(),
    };
    StreamSummary {
        name: stream_name.to_string(),
        label: stream_label(stream_name).to_string(),
        frame_count: frame_ids.len() as u64,
        first_frame,
        last_frame,
        missing_frames,
        missing_frame_count,
        total_bytes: 0,
        width: None,
        height: None,
        channels: None,
    }
}

fn collect_stream_files_from_index(
    root: &Path,
    stream_name: &str,
    indexed_files: &[IndexedFile],
) -> (StreamFiles, u64) {
    let stream_root = root.join(stream_name);
    let mut frames = Vec::new();
    let mut invalid_names = Vec::new();
    let mut total_bytes = 0_u64;
    for file in indexed_files {
        if file.path.parent() != Some(stream_root.as_path())
            || !file
                .path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        {
            continue;
        }
        let Some(stem) = file.path.file_stem().and_then(|value| value.to_str()) else {
            invalid_names.push(
                file.path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            );
            continue;
        };
        match stem.parse::<u64>() {
            Ok(frame_id) => {
                frames.push((frame_id, file.path.clone()));
                total_bytes = total_bytes.saturating_add(file.len);
            }
            Err(_) => invalid_names.push(
                file.path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }
    (finish_stream_files(frames, invalid_names), total_bytes)
}

fn scan_stream_from_files(
    root: &Path,
    stream_name: &str,
    stream_files: &StreamFiles,
    total_bytes: u64,
    cancelled: &AtomicBool,
) -> AppResult<StreamSummary> {
    let stream_root = root.join(stream_name);
    let label = stream_label(stream_name);
    if !is_regular_directory(&stream_root) {
        return Ok(StreamSummary {
            name: stream_name.to_string(),
            label: label.to_string(),
            frame_count: 0,
            first_frame: None,
            last_frame: None,
            missing_frames: Vec::new(),
            missing_frame_count: 0,
            total_bytes: 0,
            width: None,
            height: None,
            channels: None,
        });
    }

    let mut frames = BTreeMap::<u64, PathBuf>::new();
    for (frame_id, path) in &stream_files.frames {
        check_cancelled(cancelled)?;
        frames.entry(*frame_id).or_insert_with(|| path.clone());
    }

    let first_frame = frames.keys().next().copied();
    let last_frame = frames.keys().next_back().copied();
    let missing_frame_count = match (first_frame, last_frame) {
        (Some(first), Some(last)) => (u128::from(last) - u128::from(first) + 1)
            .saturating_sub(frames.len() as u128)
            .min(u128::from(u64::MAX)) as u64,
        _ => 0,
    };
    let missing_frames = match (first_frame, last_frame) {
        (Some(first), Some(last)) if last >= first => {
            let frame_set: BTreeSet<u64> = frames.keys().copied().collect();
            (first..=last)
                .filter(|frame| !frame_set.contains(frame))
                .take(2048)
                .collect()
        }
        _ => Vec::new(),
    };

    let (width, height) = frames
        .values()
        .next()
        .and_then(|path| {
            ImageReader::open(path)
                .ok()?
                .with_guessed_format()
                .ok()?
                .into_dimensions()
                .ok()
        })
        .map_or((None, None), |(width, height)| (Some(width), Some(height)));

    Ok(StreamSummary {
        name: stream_name.to_string(),
        label: label.to_string(),
        frame_count: frames.len() as u64,
        first_frame,
        last_frame,
        missing_frames,
        missing_frame_count,
        total_bytes,
        width,
        height,
        channels: None,
    })
}

fn summarize_states(
    path: &Path,
    cancelled: &AtomicBool,
) -> AppResult<(u64, Option<String>, Option<String>)> {
    if !is_regular_file(path) {
        return Ok((0, None, None));
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut count = 0;
    let mut first = None;
    let mut last = None;
    for line in reader.lines() {
        check_cancelled(cancelled)?;
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(timestamp) = value.get("capture_time_ns").and_then(|item| item.as_i64()) {
                let timestamp = timestamp.to_string();
                first.get_or_insert_with(|| timestamp.clone());
                last = Some(timestamp);
            }
        }
    }
    Ok((count, first, last))
}

fn read_states(path: &Path, cancelled: &AtomicBool) -> AppResult<Vec<StateRecord>> {
    if !is_regular_file(path) {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut states = Vec::new();
    for line in reader.lines() {
        check_cancelled(cancelled)?;
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(raw) = serde_json::from_str::<RawStateRecord>(&line) {
            states.push(raw.into());
        }
    }
    Ok(states)
}

pub fn collect_stream_files(
    root: &Path,
    stream_name: &str,
    cancelled: &AtomicBool,
) -> AppResult<StreamFiles> {
    let stream_root = root.join(stream_name);
    if !is_regular_directory(&stream_root) {
        return Ok(StreamFiles {
            frames: Vec::new(),
            invalid_names: Vec::new(),
            duplicate_ids: Vec::new(),
        });
    }

    let mut frames = Vec::new();
    let mut invalid_names = Vec::new();
    for entry in fs::read_dir(stream_root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if is_platform_metadata_file_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            invalid_names.push(entry.file_name().to_string_lossy().into_owned());
            continue;
        };
        match stem.parse::<u64>() {
            Ok(frame_id) => frames.push((frame_id, path)),
            Err(_) => invalid_names.push(entry.file_name().to_string_lossy().into_owned()),
        }
    }
    Ok(finish_stream_files(frames, invalid_names))
}

fn finish_stream_files(
    mut frames: Vec<(u64, PathBuf)>,
    mut invalid_names: Vec<String>,
) -> StreamFiles {
    frames.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.as_os_str().cmp(right.1.as_os_str()))
    });
    invalid_names.sort();
    let mut duplicate_ids = frames
        .windows(2)
        .filter_map(|pair| (pair[0].0 == pair[1].0).then_some(pair[0].0))
        .collect::<Vec<_>>();
    duplicate_ids.dedup();
    StreamFiles {
        frames,
        invalid_names,
        duplicate_ids,
    }
}

fn is_platform_metadata_file_name(name: &OsStr) -> bool {
    name == OsStr::new(".DS_Store") || name.to_str().is_some_and(|name| name.starts_with("._"))
}

pub fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn is_regular_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

pub fn emit_progress_for_operation(
    app: Option<&AppHandle>,
    operation_id: u64,
    payload: ProgressPayload,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "task-progress",
            TaskProgressEvent {
                progress: payload,
                operation_id,
            },
        );
    }
}

pub fn emit_progress(app: Option<&AppHandle>, payload: ProgressPayload) {
    if let Some(operation_id) = PROGRESS_OPERATION_ID.with(Cell::get) {
        emit_progress_for_operation(app, operation_id, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collect_files, collect_stream_files, load_episode, load_episode_preview,
        load_episode_with_index, mp4_stream_last_timeline_frame, read_frame, read_frame_with_index,
        read_mp4_preview_batch, scan_episode, scan_episode_index, scan_source_catalog,
        split_mjpeg_frames, video_source,
    };
    use super::{episode_fingerprint, read_states};
    use std::fs::{self, File};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn maps_mp4_source_counts_to_the_shared_timeline_end() {
        assert_eq!(
            mp4_stream_last_timeline_frame(0, 60.0, 30.0, 527),
            Some(1053)
        );
        assert_eq!(
            mp4_stream_last_timeline_frame(0, 60.0, 15.0, 263),
            Some(1051)
        );
        assert_eq!(
            mp4_stream_last_timeline_frame(10_000, 30.0, 30.0, 527),
            Some(10_526)
        );
        assert_eq!(mp4_stream_last_timeline_frame(0, 60.0, 60.0, 0), None);
    }

    #[test]
    fn splits_concatenated_mjpeg_preview_frames() {
        let bytes = [
            0xff, 0xd8, 1, 2, 0xff, 0xd9, 0xff, 0xd8, 3, 4, 5, 0xff, 0xd9,
        ];
        let frames = split_mjpeg_frames(&bytes, 2).unwrap();
        assert_eq!(frames[0].as_slice(), &[0xff, 0xd8, 1, 2, 0xff, 0xd9]);
        assert_eq!(frames[1].as_slice(), &[0xff, 0xd8, 3, 4, 5, 0xff, 0xd9]);
        assert!(split_mjpeg_frames(&bytes, 3).is_err());
    }

    #[test]
    fn loads_valid_states_around_a_corrupt_line() {
        let path = test_output("states");
        fs::write(
            &path,
            concat!(
                "{\"frame_id\":0,\"capture_time_ns\":1,\"position\":[0,0,0],",
                "\"velocity\":[0,0,0],\"quaternion\":[0,0,0,1],\"euler\":[0,0,0],",
                "\"omega\":[0,0,0],\"confidence\":1}\n",
                "not json\n",
                "{\"frame_id\":2,\"capture_time_ns\":3,\"position\":[0,0,0],",
                "\"velocity\":[0,0,0],\"quaternion\":[0,0,0,1],\"euler\":[0,0,0],",
                "\"omega\":[0,0,0],\"confidence\":1}\n"
            ),
        )
        .unwrap();

        let states = read_states(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].frame_id, 0);
        assert_eq!(states[1].frame_id, 2);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn fingerprint_changes_when_episode_files_change() {
        let root = test_output("fingerprint");
        fs::create_dir(&root).unwrap();
        let path = root.join("states.jsonl");
        fs::write(&path, b"one").unwrap();
        let cancelled = AtomicBool::new(false);
        let before = episode_fingerprint(&root, &cancelled).unwrap();
        fs::write(path, b"different length").unwrap();
        let after = episode_fingerprint(&root, &cancelled).unwrap();
        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn catalog_and_preview_avoid_deep_episode_metadata() {
        let source = test_output("catalog-preview");
        let episode = source.join("episode-a");
        fs::create_dir_all(episode.join("cam0")).unwrap();
        fs::write(
            episode.join("states.jsonl"),
            concat!(
                "{\"frame_id\":0,\"capture_time_ns\":1,\"position\":[0,0,0],",
                "\"velocity\":[0,0,0],\"quaternion\":[0,0,0,1],\"euler\":[0,0,0],",
                "\"omega\":[0,0,0],\"confidence\":1}\n"
            ),
        )
        .unwrap();
        fs::write(episode.join("cam0/0.jpg"), b"preview does not decode JPEG").unwrap();
        let cancelled = AtomicBool::new(false);

        let catalog = scan_source_catalog(&source, None, &cancelled).unwrap();
        assert_eq!(catalog.episodes.len(), 1);
        assert!(!catalog.episodes[0].indexed);
        assert_eq!(catalog.episodes[0].total_files, 0);
        assert_eq!(catalog.episodes[0].state_count, 0);
        assert_eq!(catalog.episodes[0].streams.len(), 5);

        let preview = load_episode_preview(&episode, None, &cancelled).unwrap();
        assert!(!preview.summary.indexed);
        assert_eq!(preview.states.len(), 1);
        assert_eq!(preview.summary.streams[0].frame_count, 1);
        assert_eq!(preview.summary.streams[0].width, None);

        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn loads_hybrid_mp4_and_nested_segment_fixture_from_the_record_root() {
        let root = test_output("hybrid-record-root");
        fs::create_dir_all(root.join("cam0")).unwrap();
        fs::create_dir_all(root.join("t265/segments")).unwrap();
        fs::write(root.join("cam0/cam0-00000.mp4"), b"test mp4 placeholder").unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "storage_format": "hybrid-h264-jpeg-segment-v1",
                "batch_count": 1,
                "streams": {
                    "cam0": {
                        "fps": 30,
                        "frame_count": 1,
                        "segments": [{"path": "cam0/cam0-00000.mp4", "size": 20}],
                        "size": 20
                    },
                    "cam1": {"fps": 15, "frame_count": 0, "segments": [], "size": 0},
                    "cam2": {"fps": 15, "frame_count": 0, "segments": [], "size": 0}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("t265/manifest.json"),
            br#"{"storage_format":"jpeg-segment-v1","segments":[{"first_batch_id":1}]}"#,
        )
        .unwrap();
        crate::segment_bin::write_test_segment(&root.join("t265/segments/segment-000000.bin"), 1);

        let cancelled = AtomicBool::new(false);
        let index = scan_episode_index(&root, None, &cancelled).unwrap();
        assert!(index.segment.is_some());
        assert_eq!(index.summary.state_count, 1);
        assert_eq!(index.summary.streams[0].frame_count, 1);
        assert_eq!(index.summary.streams[0].first_frame, Some(1));
        assert_eq!(index.summary.streams[3].frame_count, 1);
        let data = load_episode_with_index(&root, &index, &cancelled).unwrap();
        assert_eq!(data.states[0].frame_id, 1);
        let video = video_source(&root, "cam0").unwrap();
        assert_eq!(video.start_frame, 1);
        assert_eq!(video.paths.len(), 1);
        let (_, bytes) = read_frame_with_index(&root, "t265_left", 1, Some(&index), None).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1, 1));
        let report =
            crate::validation::validate_episode_with_index(&root, &index, None, &cancelled)
                .unwrap();
        assert!(report
            .issues
            .iter()
            .all(|issue| issue.severity != crate::model::Severity::Error));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_macos_metadata_in_stats_streams_and_fingerprint() {
        let root = test_output("macos-metadata");
        let stream = root.join("cam0");
        fs::create_dir_all(&stream).unwrap();
        fs::write(root.join("states.jsonl"), b"state\n").unwrap();
        fs::write(stream.join("0.jpg"), b"frame").unwrap();
        let cancelled = AtomicBool::new(false);

        let fingerprint_before = episode_fingerprint(&root, &cancelled).unwrap();
        fs::write(root.join(".DS_Store"), b"finder metadata").unwrap();
        fs::write(root.join("._states.jsonl"), b"appledouble state metadata").unwrap();
        fs::write(stream.join("._0.jpg"), b"appledouble image metadata").unwrap();

        let files = collect_files(&root, &cancelled).unwrap();
        assert_eq!(files, vec![stream.join("0.jpg"), root.join("states.jsonl")]);
        let stream_files = collect_stream_files(&root, "cam0", &cancelled).unwrap();
        assert_eq!(stream_files.frames.len(), 1);
        assert!(stream_files.invalid_names.is_empty());
        let summary = scan_episode(&root, None, &cancelled).unwrap();
        assert_eq!(summary.total_files, 2);
        assert_eq!(summary.total_bytes, 11);
        assert_eq!(summary.streams[0].frame_count, 1);
        assert_eq!(
            episode_fingerprint(&root, &cancelled).unwrap(),
            fingerprint_before
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn description_metadata_is_importable_but_does_not_change_capture_fingerprint() {
        let root = test_output("description-metadata");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("states.jsonl"), b"state\n").unwrap();
        let cancelled = AtomicBool::new(false);
        let fingerprint_before = episode_fingerprint(&root, &cancelled).unwrap();

        fs::write(
            root.join("description.json"),
            b"{\"formatVersion\":1,\"description\":\"test\"}\n",
        )
        .unwrap();
        fs::write(root.join(".description.json.partial-stale"), b"partial").unwrap();

        let files = collect_files(&root, &cancelled).unwrap();
        assert_eq!(
            files,
            vec![root.join("description.json"), root.join("states.jsonl")]
        );
        let summary = scan_episode(&root, None, &cancelled).unwrap();
        assert_eq!(summary.total_files, 1);
        assert_eq!(summary.total_bytes, 6);
        assert_eq!(
            episode_fingerprint(&root, &cancelled).unwrap(),
            fingerprint_before
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_file_or_stream_symlinks() {
        use std::os::unix::fs::symlink;

        let root = test_output("symlinks");
        let outside = test_output("symlinks-outside");
        fs::create_dir_all(root.join("cam0")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("states.jsonl"), b"\n").unwrap();
        fs::write(outside.join("0.jpg"), b"external").unwrap();
        symlink(outside.join("0.jpg"), root.join("cam0/0.jpg")).unwrap();
        symlink(&outside, root.join("cam1")).unwrap();
        let cancelled = AtomicBool::new(false);

        let files = collect_files(&root, &cancelled).unwrap();
        assert_eq!(files.len(), 1);
        let summary = scan_episode(&root, None, &cancelled).unwrap();
        assert_eq!(summary.streams[0].frame_count, 0);
        assert_eq!(summary.streams[1].frame_count, 0);

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    #[ignore = "requires a private h264-split-mp4-v1 episode and FFmpeg"]
    fn loads_private_mp4_episode_and_decodes_a_synchronized_frame() {
        let root = PathBuf::from(
            std::env::var_os("DOHC_MP4_SAMPLE_ROOT")
                .expect("DOHC_MP4_SAMPLE_ROOT must point to the mounted episode"),
        );
        let cancelled = AtomicBool::new(false);
        let catalog = scan_source_catalog(root.parent().unwrap(), None, &cancelled).unwrap();
        assert!(catalog
            .episodes
            .iter()
            .any(|episode| episode.root == root.display().to_string()));
        assert!(catalog
            .episodes
            .iter()
            .all(|episode| !episode.name.starts_with('.')));
        let data = load_episode(&root, None, &cancelled).unwrap();
        assert_eq!(data.states.len(), 1055);
        assert_eq!(data.summary.streams[0].frame_count, 527);
        assert_eq!(data.summary.streams[0].last_frame, Some(1053));
        assert_eq!(data.summary.streams[1].last_frame, Some(1051));
        assert_eq!(data.summary.streams[2].last_frame, Some(1051));
        assert_eq!(data.summary.streams[3].frame_count, 1054);
        assert_eq!(data.summary.streams[3].last_frame, Some(1053));
        let native_video = video_source(&root, "cam0").unwrap();
        assert_eq!(native_video.paths.len(), 1);
        assert_eq!(native_video.fps, 30.0);
        let (mime, bytes) = read_frame(&root, "cam0", 60, None).unwrap();
        assert_eq!(mime, "image/jpeg");
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (3840, 2160));
        let preview = read_mp4_preview_batch(&root, "cam0", 60, None).unwrap();
        assert_eq!(preview.len(), 240);
        assert_eq!(preview.first().unwrap().0, 60);
        assert_eq!(preview.last().unwrap().0, 299);
        let preview_image = image::load_from_memory(preview.first().unwrap().1.as_slice()).unwrap();
        assert_eq!(preview_image.width(), 1280);
        let report = crate::validation::validate_episode(&root, None, &cancelled).unwrap();
        assert!(report
            .issues
            .iter()
            .all(|issue| issue.code != "COUNT_MISMATCH"));
    }

    #[test]
    #[ignore = "requires a private jpeg-segment-v1 folder"]
    fn loads_private_segment_folder_as_one_continuous_episode() {
        let root = PathBuf::from(
            std::env::var_os("DOHC_SEGMENT_SAMPLE_ROOT")
                .expect("DOHC_SEGMENT_SAMPLE_ROOT must point to the mounted segments folder"),
        );
        let cancelled = AtomicBool::new(false);
        let catalog = scan_source_catalog(&root, None, &cancelled).unwrap();
        assert_eq!(catalog.episodes.len(), 1);
        assert_eq!(catalog.episodes[0].root, root.display().to_string());

        let index = scan_episode_index(&root, None, &cancelled).unwrap();
        assert_eq!(index.summary.total_files, 6);
        assert_eq!(index.summary.total_bytes, 1_385_226_321);
        assert_eq!(index.summary.state_count, 10_229);
        assert_eq!(
            index.summary.start_time_ns.as_deref(),
            Some("1787292420820316679")
        );
        assert_eq!(
            index.summary.end_time_ns.as_deref(),
            Some("1787292761793255497")
        );
        assert_eq!(index.summary.streams[3].frame_count, 10_229);
        assert_eq!(index.summary.streams[4].frame_count, 10_229);
        assert_eq!(index.summary.streams[3].first_frame, Some(1));
        assert_eq!(index.summary.streams[3].last_frame, Some(10_229));
        assert_eq!(
            (
                index.summary.streams[3].width,
                index.summary.streams[3].height
            ),
            (Some(848), Some(800))
        );

        let data = load_episode_with_index(&root, &index, &cancelled).unwrap();
        assert_eq!(data.states.len(), 10_229);
        assert_eq!(data.states.first().unwrap().frame_id, 1);
        assert_eq!(data.states.last().unwrap().frame_id, 10_229);
        for frame_id in [1, 10_229] {
            let (_, bytes) =
                read_frame_with_index(&root, "t265_left", frame_id, Some(&index), None).unwrap();
            let image = image::load_from_memory(&bytes).unwrap();
            assert_eq!((image.width(), image.height()), (848, 800));
        }

        let report =
            crate::validation::validate_episode_with_index(&root, &index, None, &cancelled)
                .unwrap();
        assert_eq!(report.parsed_state_count, 10_229);
        assert!(report.streams[..3]
            .iter()
            .all(|stream| stream.checked_frames == 0));
        assert_eq!(
            report
                .streams
                .iter()
                .find(|stream| stream.name == "t265_left")
                .unwrap()
                .checked_frames,
            5
        );
        assert!(report
            .issues
            .iter()
            .all(|issue| issue.severity != crate::model::Severity::Error));
    }

    #[test]
    #[ignore = "requires the private dated recording batch"]
    fn loads_private_dated_hybrid_recordings_from_their_top_level_folders() {
        let batch_root = PathBuf::from(
            std::env::var_os("DOHC_DATED_BATCH_ROOT")
                .expect("DOHC_DATED_BATCH_ROOT must point to the mounted recording batch"),
        );
        let cancelled = AtomicBool::new(false);
        let catalog = scan_source_catalog(&batch_root, None, &cancelled).unwrap();
        assert_eq!(catalog.episodes.len(), 19);
        assert!(catalog
            .episodes
            .iter()
            .all(|episode| episode.name.starts_with("2026")));

        let mut hybrid_count = 0;
        let mut incomplete_count = 0;
        let mut legacy_mp4_count = 0;
        for episode in &catalog.episodes {
            let manifest: serde_json::Value = serde_json::from_reader(
                File::open(PathBuf::from(&episode.root).join("manifest.json")).unwrap(),
            )
            .unwrap();
            match manifest
                .get("storage_format")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
            {
                "hybrid-h264-jpeg-segment-v1" => {
                    hybrid_count += 1;
                    let root = PathBuf::from(&episode.root);
                    let index = scan_episode_index(&root, None, &cancelled).unwrap();
                    assert!(index.segment.is_some(), "{}", episode.name);
                    assert!(index.summary.state_count > 0, "{}", episode.name);
                    assert!(index.summary.streams[0].frame_count > 0, "{}", episode.name);
                    assert!(index.summary.streams[3].frame_count > 0, "{}", episode.name);
                    assert!(index.summary.streams[4].frame_count > 0, "{}", episode.name);
                    let first_frame = index.summary.streams[3].first_frame.unwrap();
                    let last_frame = index.summary.streams[3].last_frame.unwrap();
                    assert_eq!(index.summary.streams[0].first_frame, Some(first_frame));
                    let video = video_source(&root, "cam0").unwrap();
                    assert_eq!(video.start_frame, first_frame);
                    assert!(!video.paths.is_empty());
                    for frame_id in [first_frame, last_frame] {
                        let (_, bytes) =
                            read_frame_with_index(&root, "t265_left", frame_id, Some(&index), None)
                                .unwrap();
                        image::load_from_memory(&bytes).unwrap();
                    }
                    let report = crate::validation::validate_episode_with_index(
                        &root, &index, None, &cancelled,
                    )
                    .unwrap();
                    assert!(
                        report
                            .issues
                            .iter()
                            .all(|issue| issue.severity != crate::model::Severity::Error),
                        "{}: {:?}",
                        episode.name,
                        report.issues
                    );
                }
                "jpeg-stream-v1" => {
                    incomplete_count += 1;
                    let root = PathBuf::from(&episode.root);
                    let report =
                        crate::validation::validate_episode(&root, None, &cancelled).unwrap();
                    assert_eq!(report.status, "error");
                }
                "h264-split-mp4-v1" => legacy_mp4_count += 1,
                format => panic!("unexpected storage format {format}"),
            }
        }
        assert_eq!(hybrid_count, 15);
        assert_eq!(incomplete_count, 3);
        assert_eq!(legacy_mp4_count, 1);
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
