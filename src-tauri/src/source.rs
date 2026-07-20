use crate::error::{AppError, AppResult};
use crate::model::{
    EpisodeData, EpisodeSummary, ProgressPayload, RawStateRecord, ScanResult, StateRecord,
    StreamSummary, STREAM_NAMES,
};
use crate::storage;
use blake3::Hasher;
use image::ImageReader;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

pub struct StreamFiles {
    pub frames: Vec<(u64, PathBuf)>,
    pub invalid_names: Vec<String>,
    pub duplicate_ids: Vec<u64>,
}

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
    let episodes = discover_episode_roots(root, cancelled)?;
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
    let states = read_states(&states_path, cancelled)?;
    Ok(EpisodeData { summary, states })
}

pub fn read_frame(root: &Path, stream: &str, frame_id: u64) -> AppResult<(String, Vec<u8>)> {
    if !STREAM_NAMES.contains(&stream) {
        return Err(AppError::InvalidStream(stream.to_string()));
    }
    let stream_root = root.join(stream);
    if !is_regular_directory(&stream_root) {
        return Err(AppError::MissingPath(stream_root.display().to_string()));
    }
    let path = stream_root.join(format!("{frame_id}.jpg"));
    if !is_regular_file(&path) {
        return Err(AppError::MissingPath(path.display().to_string()));
    }
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

    storage::ensure_local_source(&storage::volume_info(root)?)?;
    let all_files = collect_files(root, cancelled)?;
    let total_files = all_files.len() as u64;
    let mut total_bytes = 0_u64;
    for path in &all_files {
        check_cancelled(cancelled)?;
        total_bytes = total_bytes.saturating_add(fs::metadata(path)?.len());
    }
    let states_path = root.join("states.jsonl");
    let (state_count, start_time_ns, end_time_ns) = summarize_states(&states_path, cancelled)?;

    let mut streams = Vec::with_capacity(STREAM_NAMES.len());
    for (index, stream_name) in STREAM_NAMES.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        streams.push(scan_stream(root, stream_name, cancelled)?);
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

pub fn collect_files(root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        check_cancelled(cancelled)?;
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

pub fn episode_fingerprint(root: &Path, cancelled: &AtomicBool) -> AppResult<String> {
    storage::ensure_local_source(&storage::volume_info(root)?)?;
    let files = collect_files(root, cancelled)?;
    let mut hasher = Hasher::new();
    for path in files {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| AppError::Message(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = fs::metadata(&path)?;
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        hasher.update(relative.as_bytes());
        hasher.update(&[0]);
        hasher.update(&metadata.len().to_le_bytes());
        hasher.update(&modified_ns.to_le_bytes());
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn discover_episode_roots(root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<PathBuf>> {
    if is_episode_marker(root) {
        return Ok(vec![root.to_path_buf()]);
    }

    let mut roots = Vec::new();
    for entry in fs::read_dir(root)? {
        check_cancelled(cancelled)?;
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() && is_episode_marker(&path) {
            roots.push(path);
        }
    }
    roots.sort();
    Ok(roots)
}

fn is_episode_marker(root: &Path) -> bool {
    if is_regular_file(&root.join("states.jsonl")) {
        return true;
    }
    STREAM_NAMES
        .iter()
        .any(|name| is_regular_directory(&root.join(name)))
}

fn scan_stream(root: &Path, stream_name: &str, cancelled: &AtomicBool) -> AppResult<StreamSummary> {
    let stream_root = root.join(stream_name);
    let label = match stream_name {
        "cam0" => "Camera 0",
        "cam1" => "Camera 1",
        "cam2" => "Camera 2",
        "t265_left" => "T265 Left",
        "t265_right" => "T265 Right",
        _ => stream_name,
    };
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

    let stream_files = collect_stream_files(root, stream_name, cancelled)?;
    let mut frames = BTreeMap::<u64, PathBuf>::new();
    let mut total_bytes = 0_u64;
    for (frame_id, path) in stream_files.frames {
        check_cancelled(cancelled)?;
        total_bytes = total_bytes.saturating_add(fs::metadata(&path)?.len());
        frames.entry(frame_id).or_insert(path);
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
    Ok(StreamFiles {
        frames,
        invalid_names,
        duplicate_ids,
    })
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

pub fn emit_progress(app: Option<&AppHandle>, payload: ProgressPayload) {
    if let Some(app) = app {
        let _ = app.emit("task-progress", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_files, episode_fingerprint, read_states, scan_episode};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
