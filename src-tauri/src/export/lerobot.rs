use super::{
    map_error, output_stem, partial_sibling, unique_directory, ExportAdapter, ExportContext,
};
use crate::error::{AppError, AppResult};
use crate::model::{ProgressPayload, StateRecord};
use crate::source::emit_progress;
use arrow_array::builder::{FixedSizeListBuilder, Float32Builder};
use arrow_array::{ArrayRef, FixedSizeListArray, Float32Array, Int64Array, RecordBatch};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub struct LeRobotV2Adapter;

impl ExportAdapter for LeRobotV2Adapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<PathBuf> {
        validate_lerobot_source(context)?;
        let stem = format!("{}_lerobot_v2", output_stem(context));
        let output = unique_directory(context.destination_parent, &stem);
        let partial = partial_sibling(&output);
        fs::create_dir_all(&partial)?;
        let started = Instant::now();
        let fps = estimate_fps(&context.data.states);

        let data_path = partial.join("data/chunk-000/episode_000000.parquet");
        fs::create_dir_all(data_path.parent().unwrap_or(&partial))?;
        write_parquet(&data_path, &context.data.states, fps)?;
        emit_progress(
            context.app,
            ProgressPayload {
                task: "export".into(),
                phase: "写入 LeRobot Parquet".into(),
                current: 1,
                total: 1,
                bytes_done: fs::metadata(&data_path)?.len(),
                total_bytes: context.data.summary.total_bytes,
                current_path: data_path.display().to_string(),
                elapsed_ms: started.elapsed().as_millis(),
            },
        );

        let ffmpeg = find_ffmpeg(context.app)?;
        let total_video_frames: u64 = context
            .data
            .summary
            .streams
            .iter()
            .map(|stream| stream.frame_count)
            .sum();
        let mut completed_video_frames = 0_u64;
        for stream in &context.data.summary.streams {
            if context.cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let video_path = partial
                .join("videos/chunk-000")
                .join(format!("observation.images.{}", stream.name))
                .join("episode_000000.mp4");
            fs::create_dir_all(video_path.parent().unwrap_or(&partial))?;
            encode_video(
                VideoEncodeJob {
                    ffmpeg: &ffmpeg,
                    source: &context.source.join(&stream.name),
                    destination: &video_path,
                    first_frame: stream.first_frame.unwrap_or(0),
                    frame_count: stream.frame_count,
                    fps,
                    completed_before: completed_video_frames,
                    total_frames: total_video_frames,
                    started,
                },
                context,
            )?;
            completed_video_frames += stream.frame_count;
        }

        let meta_dir = partial.join("meta");
        fs::create_dir_all(&meta_dir)?;
        let features = build_features(context, fps);
        let task_text = context
            .annotation
            .map(|annotation| annotation.task_description.as_str())
            .unwrap_or("DOHC recording");
        let mut info = json!({
            "codebase_version": "v2.1",
            "robot_type": "dohc",
            "total_episodes": 1,
            "total_frames": context.data.states.len(),
            "total_tasks": 1,
            "total_videos": context.data.summary.streams.len(),
            "total_chunks": 1,
            "chunks_size": 1000,
            "fps": fps,
            "clip_start_frame": context.range.start_frame,
            "clip_end_frame": context.range.end_frame,
            "splits": {"train": "0:1"},
            "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
            "video_path": "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
            "features": features
        });
        if let Some(annotation) = context.annotation {
            info["dohc_annotation"] = json!({
                "trajectory_code": annotation.trajectory_code,
                "task_id": annotation.task_id,
                "task_description": annotation.task_description,
                "processed_by": annotation.processed_by,
                "revision": annotation.revision
            });
        }
        write_json(&meta_dir.join("info.json"), &info)?;
        write_json_line(
            &meta_dir.join("tasks.jsonl"),
            &json!({"task_index": 0, "task": task_text}),
        )?;
        write_json_line(
            &meta_dir.join("episodes.jsonl"),
            &json!({"episode_index": 0, "tasks": [task_text], "length": context.data.states.len()}),
        )?;
        let stats = build_stats(&context.data.states, fps);
        write_json(&meta_dir.join("stats.json"), &stats)?;
        write_json_line(
            &meta_dir.join("episodes_stats.jsonl"),
            &json!({"episode_index": 0, "stats": stats}),
        )?;
        fs::write(
            partial.join("README.md"),
            format!(
                "# {}\n\nLeRobot v2.1 dataset exported by DOHC Viewer.\n\nFrame range: {}-{}.\n{}",
                context
                    .annotation
                    .map(|annotation| annotation.trajectory_code.as_str())
                    .unwrap_or(context.data.summary.name.as_str()),
                context.range.start_frame,
                context.range.end_frame,
                context
                    .annotation
                    .map(|annotation| format!(
                        "\nTask: {} ({})\nProcessed by: {} (@{})\n",
                        annotation.task_description,
                        annotation.task_id,
                        annotation.processed_by.display_name,
                        annotation.processed_by.username
                    ))
                    .unwrap_or_default()
            ),
        )?;

        verify_lerobot_output(&partial, context, fps)?;
        crate::storage::publish_noreplace(&partial, &output)?;
        Ok(output)
    }
}

fn validate_lerobot_source(context: &ExportContext<'_>) -> AppResult<()> {
    if context.data.states.is_empty() {
        return Err(AppError::Message("状态数据为空，无法导出 LeRobot".into()));
    }
    if context
        .data
        .states
        .windows(2)
        .any(|pair| pair[1].frame_id != pair[0].frame_id.saturating_add(1))
    {
        return Err(AppError::Message(
            "LeRobot 导出要求裁剪范围内的 frame_id 连续".into(),
        ));
    }
    let first_state = context
        .data
        .states
        .first()
        .and_then(|state| u64::try_from(state.frame_id).ok());
    let last_state = context
        .data
        .states
        .last()
        .and_then(|state| u64::try_from(state.frame_id).ok());
    for stream in &context.data.summary.streams {
        if stream.frame_count != context.data.states.len() as u64 {
            return Err(AppError::Message(format!(
                "{} 有 {} 帧，但状态数据有 {} 条",
                stream.name,
                stream.frame_count,
                context.data.states.len()
            )));
        }
        if stream.missing_frame_count > 0 {
            return Err(AppError::Message(format!("{} 存在缺帧", stream.name)));
        }
        if stream.first_frame != first_state || stream.last_frame != last_state {
            return Err(AppError::Message(format!(
                "{} 的裁剪帧范围与状态时间轴不一致",
                stream.name
            )));
        }
    }
    Ok(())
}

fn verify_lerobot_output(root: &Path, context: &ExportContext<'_>, fps: u32) -> AppResult<()> {
    let meta_dir = root.join("meta");
    for name in [
        "info.json",
        "tasks.jsonl",
        "episodes.jsonl",
        "stats.json",
        "episodes_stats.jsonl",
    ] {
        let path = meta_dir.join(name);
        if !crate::source::is_regular_file(&path) || fs::metadata(&path)?.len() == 0 {
            return Err(AppError::Message(format!(
                "LeRobot 回读验证失败: 缺少 {name}"
            )));
        }
    }
    let info: Value = serde_json::from_reader(File::open(meta_dir.join("info.json"))?)?;
    if info["codebase_version"] != "v2.1"
        || info["fps"] != fps
        || info["total_frames"] != context.data.states.len()
        || info["clip_start_frame"] != context.range.start_frame
        || info["clip_end_frame"] != context.range.end_frame
    {
        return Err(AppError::Message(
            "LeRobot 回读验证失败: info.json 不匹配".into(),
        ));
    }
    let task: Value = serde_json::from_reader(File::open(meta_dir.join("tasks.jsonl"))?)?;
    let expected_task = context
        .annotation
        .map(|annotation| annotation.task_description.as_str())
        .unwrap_or("DOHC recording");
    if task["task"] != expected_task {
        return Err(AppError::Message(
            "LeRobot 回读验证失败: task 标注不匹配".into(),
        ));
    }
    if let Some(annotation) = context.annotation {
        if info["dohc_annotation"]["trajectory_code"] != annotation.trajectory_code
            || info["dohc_annotation"]["task_id"] != annotation.task_id
            || info["dohc_annotation"]["task_description"] != annotation.task_description
            || info["dohc_annotation"]["processed_by"]["username"]
                != annotation.processed_by.username
            || info["dohc_annotation"]["processed_by"]["displayName"]
                != annotation.processed_by.display_name
            || info["dohc_annotation"]["revision"] != annotation.revision
        {
            return Err(AppError::Message(
                "LeRobot 回读验证失败: 数据标注不匹配".into(),
            ));
        }
    }

    let parquet_path = root.join("data/chunk-000/episode_000000.parquet");
    let builder =
        ParquetRecordBatchReaderBuilder::try_new(File::open(&parquet_path)?).map_err(map_error)?;
    if builder
        .schema()
        .field_with_name("observation.capture_time_ns")
        .is_err()
        || builder.schema().field_with_name("action").is_ok()
    {
        return Err(AppError::Message(
            "LeRobot 回读验证失败: Parquet 字段不匹配".into(),
        ));
    }
    let mut rows = 0_usize;
    for batch in builder.build().map_err(map_error)? {
        if context.cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        rows = rows.saturating_add(batch.map_err(map_error)?.num_rows());
    }
    if rows != context.data.states.len() {
        return Err(AppError::Message(format!(
            "LeRobot 回读验证失败: Parquet {rows} 行，预期 {} 行",
            context.data.states.len()
        )));
    }

    for stream in &context.data.summary.streams {
        let video = root
            .join("videos/chunk-000")
            .join(format!("observation.images.{}", stream.name))
            .join("episode_000000.mp4");
        if !crate::source::is_regular_file(&video) || fs::metadata(&video)?.len() == 0 {
            return Err(AppError::Message(format!(
                "LeRobot 回读验证失败: {} 视频为空",
                stream.name
            )));
        }
    }
    Ok(())
}

fn write_parquet(path: &Path, states: &[StateRecord], fps: u32) -> AppResult<()> {
    let capture_times: Vec<i64> = states
        .iter()
        .map(|state| state.capture_time_ns.parse::<i64>().map_err(map_error))
        .collect::<AppResult<_>>()?;
    let frame_indices: Vec<i64> = (0..states.len() as i64).collect();
    let timestamps: Vec<f32> = frame_indices
        .iter()
        .map(|index| *index as f32 / fps as f32)
        .collect();
    let zeroes = vec![0_i64; states.len()];
    let arrays: Vec<(&str, ArrayRef)> = vec![
        (
            "observation.position",
            Arc::new(fixed_list(states.iter().map(|state| &state.position), 3)),
        ),
        (
            "observation.velocity",
            Arc::new(fixed_list(states.iter().map(|state| &state.velocity), 3)),
        ),
        (
            "observation.quaternion",
            Arc::new(fixed_list(states.iter().map(|state| &state.quaternion), 4)),
        ),
        (
            "observation.euler",
            Arc::new(fixed_list(states.iter().map(|state| &state.euler), 3)),
        ),
        (
            "observation.omega",
            Arc::new(fixed_list(states.iter().map(|state| &state.omega), 3)),
        ),
        (
            "observation.confidence",
            Arc::new(Float32Array::from_iter_values(
                states.iter().map(|state| state.confidence as f32),
            )),
        ),
        (
            "observation.capture_time_ns",
            Arc::new(Int64Array::from(capture_times)),
        ),
        ("timestamp", Arc::new(Float32Array::from(timestamps))),
        (
            "frame_index",
            Arc::new(Int64Array::from(frame_indices.clone())),
        ),
        ("episode_index", Arc::new(Int64Array::from(zeroes.clone()))),
        ("index", Arc::new(Int64Array::from(frame_indices))),
        ("task_index", Arc::new(Int64Array::from(zeroes))),
    ];
    let batch = RecordBatch::try_from_iter(arrays).map_err(map_error)?;
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .build();
    let file = File::create_new(path)?;
    let mut writer =
        ArrowWriter::try_new(file, batch.schema(), Some(properties)).map_err(map_error)?;
    writer.write(&batch).map_err(map_error)?;
    writer.close().map_err(map_error)?;
    Ok(())
}

fn fixed_list<'a, const N: usize>(
    values: impl Iterator<Item = &'a [f64; N]>,
    width: i32,
) -> FixedSizeListArray {
    let mut builder = FixedSizeListBuilder::new(Float32Builder::new(), width);
    for row in values {
        for value in row {
            builder.values().append_value(*value as f32);
        }
        builder.append(true);
    }
    builder.finish()
}

struct VideoEncodeJob<'a> {
    ffmpeg: &'a Path,
    source: &'a Path,
    destination: &'a Path,
    first_frame: u64,
    frame_count: u64,
    fps: u32,
    completed_before: u64,
    total_frames: u64,
    started: Instant,
}

fn encode_video(job: VideoEncodeJob<'_>, context: &ExportContext<'_>) -> AppResult<()> {
    let pattern = job.source.join("%d.jpg");
    let mut child = Command::new(job.ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostats")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-framerate")
        .arg(job.fps.to_string())
        .arg("-start_number")
        .arg(job.first_frame.to_string())
        .arg("-i")
        .arg(pattern)
        .arg("-frames:v")
        .arg(job.frame_count.to_string())
        .arg("-an")
        .arg("-c:v")
        .arg("mpeg4")
        .arg("-q:v")
        .arg("2")
        .arg("-g")
        .arg("2")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+faststart")
        .arg(job.destination)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Message("无法读取 FFmpeg 进度".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Message("无法读取 FFmpeg 错误输出".into()))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if let Some(frame) = line
                        .strip_prefix("frame=")
                        .and_then(|value| value.parse::<u64>().ok())
                    {
                        if sender.send(EncodeEvent::Frame(frame)).is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = sender.send(EncodeEvent::ReadError(error.to_string()));
                    return;
                }
            }
        }
        let _ = sender.send(EncodeEvent::Done);
    });
    let stderr_thread = thread::spawn(move || {
        let mut stderr = BufReader::new(stderr);
        let mut message = String::new();
        stderr.read_to_string(&mut message).map(|_| message)
    });

    let mut stdout_error = None;
    let status = loop {
        if context.cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(EncodeEvent::Frame(frame)) => emit_progress(
                context.app,
                ProgressPayload {
                    task: "export".into(),
                    phase: "编码 LeRobot 视频".into(),
                    current: job.completed_before + frame.min(job.frame_count),
                    total: job.total_frames,
                    bytes_done: 0,
                    total_bytes: context.data.summary.total_bytes,
                    current_path: job.destination.display().to_string(),
                    elapsed_ms: job.started.elapsed().as_millis(),
                },
            ),
            Ok(EncodeEvent::ReadError(error)) => stdout_error = Some(error),
            Ok(EncodeEvent::Done) | Err(RecvTimeoutError::Disconnected) => {}
            Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
    };
    stdout_thread
        .join()
        .map_err(|_| AppError::Message("FFmpeg 进度线程异常退出".into()))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| AppError::Message("FFmpeg 错误线程异常退出".into()))??;
    let Some(status) = status else {
        return Err(AppError::Cancelled);
    };
    if let Some(error) = stdout_error {
        return Err(AppError::Message(format!("读取 FFmpeg 进度失败: {error}")));
    }
    if !status.success() {
        return Err(AppError::Message(format!(
            "FFmpeg 编码失败: {}",
            stderr.trim()
        )));
    }
    if !job.destination.is_file() || fs::metadata(job.destination)?.len() == 0 {
        return Err(AppError::Message(format!(
            "FFmpeg 没有生成视频: {}",
            job.destination.display()
        )));
    }
    Ok(())
}

enum EncodeEvent {
    Frame(u64),
    ReadError(String),
    Done,
}

fn find_ffmpeg(app: Option<&AppHandle>) -> AppResult<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("DOHC_FFMPEG") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("bin/ffmpeg.exe"));
            candidates.push(resource_dir.join("bin/ffmpeg"));
            candidates.push(resource_dir.join("ffmpeg.exe"));
            candidates.push(resource_dir.join("ffmpeg"));
        }
    }
    candidates.push(PathBuf::from(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }));
    for candidate in candidates {
        let works = Command::new(&candidate)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if works {
            return Ok(candidate);
        }
    }
    Err(AppError::Message(
        "未找到 FFmpeg；LeRobot v2 视频导出需要随应用分发的 FFmpeg sidecar".into(),
    ))
}

fn build_features(context: &ExportContext<'_>, fps: u32) -> Value {
    let mut features = Map::new();
    features.insert(
        "observation.position".into(),
        numeric_feature(3, json!(["x", "y", "z"])),
    );
    features.insert(
        "observation.velocity".into(),
        numeric_feature(3, json!(["x", "y", "z"])),
    );
    features.insert(
        "observation.quaternion".into(),
        numeric_feature(4, json!(["x", "y", "z", "w"])),
    );
    features.insert(
        "observation.euler".into(),
        numeric_feature(3, json!(["roll", "pitch", "yaw"])),
    );
    features.insert(
        "observation.omega".into(),
        numeric_feature(3, json!(["x", "y", "z"])),
    );
    features.insert(
        "observation.confidence".into(),
        numeric_feature(1, Value::Null),
    );
    features.insert(
        "observation.capture_time_ns".into(),
        json!({"dtype": "int64", "shape": [1], "names": null}),
    );
    for stream in &context.data.summary.streams {
        features.insert(
            format!("observation.images.{}", stream.name),
            json!({
                "dtype": "video",
                "shape": [stream.height.unwrap_or(0), stream.width.unwrap_or(0), 3],
                "names": ["height", "width", "channels"],
                "video_info": {
                    "video.height": stream.height.unwrap_or(0),
                    "video.width": stream.width.unwrap_or(0),
                    "video.codec": "mpeg4",
                    "video.pix_fmt": "yuv420p",
                    "video.is_depth_map": false,
                    "video.fps": fps,
                    "video.channels": 3,
                    "has_audio": false
                }
            }),
        );
    }
    for (name, dtype) in [
        ("timestamp", "float32"),
        ("frame_index", "int64"),
        ("episode_index", "int64"),
        ("index", "int64"),
        ("task_index", "int64"),
    ] {
        features.insert(
            name.into(),
            json!({"dtype": dtype, "shape": [1], "names": null}),
        );
    }
    Value::Object(features)
}

fn numeric_feature(width: usize, names: Value) -> Value {
    json!({"dtype": "float32", "shape": [width], "names": names})
}

fn build_stats(states: &[StateRecord], fps: u32) -> Value {
    let mut stats = Map::new();
    stats.insert(
        "observation.position".into(),
        vector_stats(states.iter().map(|state| state.position.to_vec()).collect()),
    );
    stats.insert(
        "observation.velocity".into(),
        vector_stats(states.iter().map(|state| state.velocity.to_vec()).collect()),
    );
    stats.insert(
        "observation.quaternion".into(),
        vector_stats(
            states
                .iter()
                .map(|state| state.quaternion.to_vec())
                .collect(),
        ),
    );
    stats.insert(
        "observation.euler".into(),
        vector_stats(states.iter().map(|state| state.euler.to_vec()).collect()),
    );
    stats.insert(
        "observation.omega".into(),
        vector_stats(states.iter().map(|state| state.omega.to_vec()).collect()),
    );
    stats.insert(
        "observation.confidence".into(),
        vector_stats(states.iter().map(|state| vec![state.confidence]).collect()),
    );
    stats.insert(
        "observation.capture_time_ns".into(),
        vector_stats(
            states
                .iter()
                .map(|state| {
                    vec![state
                        .capture_time_ns
                        .parse::<i64>()
                        .map(|value| value as f64)
                        .unwrap_or(0.0)]
                })
                .collect(),
        ),
    );
    stats.insert(
        "timestamp".into(),
        vector_stats(
            states
                .iter()
                .enumerate()
                .map(|(index, _)| vec![index as f64 / fps as f64])
                .collect(),
        ),
    );
    for key in ["frame_index", "index"] {
        stats.insert(
            key.into(),
            vector_stats((0..states.len()).map(|index| vec![index as f64]).collect()),
        );
    }
    for key in ["episode_index", "task_index"] {
        stats.insert(key.into(), vector_stats(vec![vec![0.0]; states.len()]));
    }
    Value::Object(stats)
}

fn vector_stats(rows: Vec<Vec<f64>>) -> Value {
    if rows.is_empty() || rows[0].is_empty() {
        return json!({"min": [], "max": [], "mean": [], "std": [], "count": [0]});
    }
    let width = rows[0].len();
    let mut minimum = vec![f64::INFINITY; width];
    let mut maximum = vec![f64::NEG_INFINITY; width];
    let mut mean = vec![0.0; width];
    for row in &rows {
        for (index, value) in row.iter().copied().enumerate() {
            minimum[index] = minimum[index].min(value);
            maximum[index] = maximum[index].max(value);
            mean[index] += value;
        }
    }
    for value in &mut mean {
        *value /= rows.len() as f64;
    }
    let mut variance = vec![0.0; width];
    for row in &rows {
        for (index, value) in row.iter().copied().enumerate() {
            variance[index] += (value - mean[index]).powi(2);
        }
    }
    let standard_deviation: Vec<f64> = variance
        .into_iter()
        .map(|value| (value / rows.len() as f64).sqrt())
        .collect();
    json!({
        "min": minimum,
        "max": maximum,
        "mean": mean,
        "std": standard_deviation,
        "count": [rows.len()]
    })
}

fn estimate_fps(states: &[StateRecord]) -> u32 {
    let mut deltas: Vec<i128> = states
        .windows(2)
        .filter_map(|pair| {
            let left = pair[0].capture_time_ns.parse::<i128>().ok()?;
            let right = pair[1].capture_time_ns.parse::<i128>().ok()?;
            (right > left).then_some(right - left)
        })
        .collect();
    if deltas.is_empty() {
        return 30;
    }
    deltas.sort_unstable();
    let median = deltas[deltas.len() / 2];
    let measured = 1_000_000_000.0 / median as f64;
    let common = [10_u32, 15, 20, 24, 25, 30, 50, 60, 90, 120];
    let nearest = common
        .into_iter()
        .min_by(|left, right| {
            (measured - *left as f64)
                .abs()
                .total_cmp(&(measured - *right as f64).abs())
        })
        .unwrap_or(30);
    if (measured - nearest as f64).abs() / nearest as f64 <= 0.05 {
        nearest
    } else {
        (measured.round() as u32).clamp(1, 240)
    }
}

fn write_json(path: &Path, value: &Value) -> AppResult<()> {
    let mut file = File::create_new(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn write_json_line(path: &Path, value: &Value) -> AppResult<()> {
    let mut file = File::create_new(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}
