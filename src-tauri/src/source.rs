use crate::error::{AppError, AppResult};
use crate::model::{
    EpisodeData, EpisodeSummary, ProgressPayload, RawStateRecord, ScanResult, StateRecord,
    StreamSummary, STREAM_NAMES,
};
use crate::storage;
use image::ImageReader;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

pub fn scan_source(
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
    storage::ensure_local_source(&volume)?;
    let episodes = discover_episode_roots(root)?;
    if episodes.is_empty() {
        return Err(AppError::NoEpisodes(root.display().to_string()));
    }

    let started = Instant::now();
    let mut summaries = Vec::with_capacity(episodes.len());
    for (index, episode_root) in episodes.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        emit_progress(
            app,
            ProgressPayload {
                task: "scan".into(),
                phase: "扫描目录".into(),
                current: index as u64,
                total: episodes.len() as u64,
                bytes_done: 0,
                total_bytes: 0,
                current_path: episode_root.display().to_string(),
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
        summaries.push(scan_episode(episode_root, app, cancelled)?);
    }

    let total_files = summaries.iter().map(|item| item.total_files).sum();
    let total_bytes = summaries.iter().map(|item| item.total_bytes).sum();
    emit_progress(
        app,
        ProgressPayload {
            task: "scan".into(),
            phase: "扫描完成".into(),
            current: summaries.len() as u64,
            total: summaries.len() as u64,
            bytes_done: total_bytes,
            total_bytes,
            current_path: root.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    Ok(ScanResult {
        source_root: root.display().to_string(),
        episodes: summaries,
        total_files,
        total_bytes,
        volume,
    })
}

pub fn load_episode(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    let summary = scan_episode(root, app, cancelled)?;
    let states_path = root.join("states.jsonl");
    let states = read_states(&states_path)?;
    Ok(EpisodeData { summary, states })
}

pub fn read_frame(root: &Path, stream: &str, frame_id: u64) -> AppResult<(String, Vec<u8>)> {
    if !STREAM_NAMES.contains(&stream) {
        return Err(AppError::InvalidStream(stream.to_string()));
    }
    let path = root.join(stream).join(format!("{frame_id}.jpg"));
    let bytes = fs::read(&path)?;
    Ok(("image/jpeg".into(), bytes))
}

pub fn scan_episode(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeSummary> {
    if !root.is_dir() {
        return Err(AppError::MissingPath(root.display().to_string()));
    }

    let all_files = collect_files(root)?;
    let total_files = all_files.len() as u64;
    let total_bytes = all_files
        .iter()
        .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .sum();
    let states_path = root.join("states.jsonl");
    let (state_count, start_time_ns, end_time_ns) = summarize_states(&states_path)?;

    let mut streams = Vec::with_capacity(STREAM_NAMES.len());
    for (index, stream_name) in STREAM_NAMES.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        streams.push(scan_stream(root, stream_name)?);
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

    Ok(EpisodeSummary {
        root: root.display().to_string(),
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("episode")
            .to_string(),
        total_files,
        total_bytes,
        state_count,
        start_time_ns,
        end_time_ns,
        streams,
    })
}

pub fn collect_files(root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Message(error.to_string()))?;
        if entry.file_type().is_file() {
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

fn discover_episode_roots(root: &Path) -> AppResult<Vec<PathBuf>> {
    if is_episode_marker(root) {
        return Ok(vec![root.to_path_buf()]);
    }

    let mut roots = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() && is_episode_marker(&path) {
            roots.push(path);
        }
    }
    roots.sort();
    Ok(roots)
}

fn is_episode_marker(root: &Path) -> bool {
    if root.join("states.jsonl").is_file() {
        return true;
    }
    STREAM_NAMES.iter().any(|name| root.join(name).is_dir())
}

fn scan_stream(root: &Path, stream_name: &str) -> AppResult<StreamSummary> {
    let stream_root = root.join(stream_name);
    let label = match stream_name {
        "cam0" => "Camera 0",
        "cam1" => "Camera 1",
        "cam2" => "Camera 2",
        "t265_left" => "T265 Left",
        "t265_right" => "T265 Right",
        _ => stream_name,
    };
    if !stream_root.is_dir() {
        return Ok(StreamSummary {
            name: stream_name.to_string(),
            label: label.to_string(),
            frame_count: 0,
            first_frame: None,
            last_frame: None,
            missing_frames: Vec::new(),
            total_bytes: 0,
            width: None,
            height: None,
            channels: None,
        });
    }

    let mut frames = BTreeMap::<u64, PathBuf>::new();
    let mut total_bytes = 0;
    for entry in fs::read_dir(&stream_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(frame_id) = stem.parse::<u64>() else {
            continue;
        };
        total_bytes += entry.metadata()?.len();
        frames.insert(frame_id, path);
    }

    let first_frame = frames.keys().next().copied();
    let last_frame = frames.keys().next_back().copied();
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
        total_bytes,
        width,
        height,
        channels: None,
    })
}

fn summarize_states(path: &Path) -> AppResult<(u64, Option<String>, Option<String>)> {
    if !path.is_file() {
        return Ok((0, None, None));
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut count = 0;
    let mut first = None;
    let mut last = None;
    for line in reader.lines() {
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

fn read_states(path: &Path) -> AppResult<Vec<StateRecord>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut states = Vec::new();
    for (line_number, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let raw = serde_json::from_str::<RawStateRecord>(&line).map_err(|error| {
            AppError::Message(format!(
                "states.jsonl 第 {} 行无效: {}",
                line_number + 1,
                error
            ))
        })?;
        states.push(raw.into());
    }
    Ok(states)
}

pub fn emit_progress(app: Option<&AppHandle>, payload: ProgressPayload) {
    if let Some(app) = app {
        let _ = app.emit("task-progress", payload);
    }
}
