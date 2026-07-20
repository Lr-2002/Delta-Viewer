use crate::error::{AppError, AppResult};
use crate::model::{
    RawStateRecord, Severity, StreamValidation, ValidationIssue, ValidationReport, STREAM_NAMES,
};
use crate::source::{emit_progress, scan_episode};
use image::ImageReader;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::AppHandle;

pub fn validate_episode(
    root: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<ValidationReport> {
    let started = Instant::now();
    let summary = scan_episode(root, app, cancelled)?;
    let mut issues = Vec::new();
    let mut checked_files = 0;
    let mut states = Vec::new();

    let states_path = root.join("states.jsonl");
    if !states_path.is_file() {
        issues.push(issue(
            Severity::Error,
            "MISSING_STATES",
            "states",
            "缺少 states.jsonl",
        ));
    } else {
        checked_files += 1;
        let file = File::open(&states_path)?;
        let reader = BufReader::new(file);
        for (line_number, line) in reader.lines().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let line = line?;
            if line.trim().is_empty() {
                issues.push(issue(
                    Severity::Warning,
                    "EMPTY_STATE_LINE",
                    "states",
                    &format!("第 {} 行为空", line_number + 1),
                ));
                continue;
            }
            match serde_json::from_str::<RawStateRecord>(&line) {
                Ok(state) => {
                    if !state_is_finite(&state) {
                        issues.push(issue(
                            Severity::Error,
                            "NON_FINITE_STATE",
                            "states",
                            &format!("第 {} 行包含 NaN 或 Infinity", line_number + 1),
                        ));
                    }
                    states.push(state);
                }
                Err(error) => issues.push(issue(
                    Severity::Error,
                    "INVALID_STATE_JSON",
                    "states",
                    &format!("第 {} 行无法解析: {}", line_number + 1, error),
                )),
            }
        }
    }

    check_state_sequence(&states, &mut issues);
    let total_frames: u64 = summary
        .streams
        .iter()
        .map(|stream| stream.frame_count)
        .sum();
    let mut total_checked_frames = 0_u64;
    let mut stream_reports = Vec::with_capacity(STREAM_NAMES.len());
    for stream in &summary.streams {
        let mut decode_failures = 0;
        let mut dimension_mismatches = 0;
        let mut checked_frames = 0;
        let stream_path = root.join(&stream.name);
        if stream.frame_count == 0 {
            issues.push(issue(
                Severity::Error,
                "EMPTY_STREAM",
                &stream.name,
                "数据流为空或目录不存在",
            ));
        }
        if !stream.missing_frames.is_empty() {
            issues.push(issue(
                Severity::Warning,
                "MISSING_FRAMES",
                &stream.name,
                &format!("缺少 {} 个连续帧位置", stream.missing_frames.len()),
            ));
        }

        if let (Some(first), Some(last)) = (stream.first_frame, stream.last_frame) {
            for frame_id in first..=last {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(AppError::Cancelled);
                }
                let path = stream_path.join(format!("{frame_id}.jpg"));
                if !path.is_file() {
                    continue;
                }
                checked_files += 1;
                checked_frames += 1;
                total_checked_frames += 1;
                match ImageReader::open(&path)
                    .map_err(image::ImageError::IoError)
                    .and_then(|reader| {
                        reader
                            .with_guessed_format()
                            .map_err(image::ImageError::IoError)?
                            .decode()
                    }) {
                    Ok(image) => {
                        if stream.width.is_some_and(|width| width != image.width())
                            || stream.height.is_some_and(|height| height != image.height())
                        {
                            dimension_mismatches += 1;
                            issues.push(issue(
                                Severity::Error,
                                "DIMENSION_MISMATCH",
                                &stream.name,
                                &format!(
                                    "帧 {} 的分辨率为 {}×{}",
                                    frame_id,
                                    image.width(),
                                    image.height()
                                ),
                            ));
                        }
                    }
                    Err(error) => {
                        decode_failures += 1;
                        issues.push(issue(
                            Severity::Error,
                            "DECODE_FAILED",
                            &stream.name,
                            &format!("帧 {} 无法解码: {}", frame_id, error),
                        ));
                    }
                }
                if checked_frames % 8 == 0 || checked_frames == stream.frame_count {
                    emit_progress(
                        app,
                        crate::model::ProgressPayload {
                            task: "validate".into(),
                            phase: "校验图像".into(),
                            current: total_checked_frames,
                            total: total_frames,
                            bytes_done: 0,
                            total_bytes: summary.total_bytes,
                            current_path: path.display().to_string(),
                            elapsed_ms: started.elapsed().as_millis(),
                        },
                    );
                }
            }
        }
        let status = if decode_failures > 0 || dimension_mismatches > 0 || stream.frame_count == 0 {
            "error"
        } else if !stream.missing_frames.is_empty() {
            "warning"
        } else {
            "ok"
        };
        stream_reports.push(StreamValidation {
            name: stream.name.clone(),
            checked_frames,
            decode_failures,
            status: status.into(),
        });
        if stream.frame_count != states.len() as u64 && stream.frame_count > 0 && !states.is_empty()
        {
            issues.push(issue(
                Severity::Warning,
                "COUNT_MISMATCH",
                &stream.name,
                &format!("图像 {} 帧，状态 {} 条", stream.frame_count, states.len()),
            ));
        }
    }

    let status = if issues.iter().any(|item| item.severity == Severity::Error) {
        "error"
    } else if issues.iter().any(|item| item.severity == Severity::Warning) {
        "warning"
    } else {
        "ok"
    };
    emit_progress(
        app,
        crate::model::ProgressPayload {
            task: "validate".into(),
            phase: "检查完成".into(),
            current: 1,
            total: 1,
            bytes_done: summary.total_bytes,
            total_bytes: summary.total_bytes,
            current_path: root.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    Ok(ValidationReport {
        status: status.into(),
        checked_files,
        elapsed_ms: started.elapsed().as_millis(),
        issues,
        streams: stream_reports,
    })
}

fn state_is_finite(state: &RawStateRecord) -> bool {
    state
        .position
        .into_iter()
        .chain(state.velocity)
        .chain(state.quaternion)
        .chain(state.euler)
        .chain(state.omega)
        .chain([state.confidence])
        .all(f64::is_finite)
}

fn check_state_sequence(states: &[RawStateRecord], issues: &mut Vec<ValidationIssue>) {
    if states.is_empty() {
        issues.push(issue(
            Severity::Error,
            "EMPTY_STATES",
            "states",
            "状态数据为空",
        ));
        return;
    }
    for pair in states.windows(2) {
        if pair[1].frame_id != pair[0].frame_id + 1 {
            issues.push(issue(
                Severity::Warning,
                "STATE_FRAME_GAP",
                "states",
                &format!("帧号从 {} 跳到 {}", pair[0].frame_id, pair[1].frame_id),
            ));
        }
        if pair[1].capture_time_ns <= pair[0].capture_time_ns {
            issues.push(issue(
                Severity::Error,
                "TIMESTAMP_NOT_MONOTONIC",
                "states",
                &format!("帧 {} 的时间戳没有递增", pair[1].frame_id),
            ));
        }
    }
    let deltas: Vec<i64> = states
        .windows(2)
        .map(|pair| pair[1].capture_time_ns - pair[0].capture_time_ns)
        .filter(|delta| *delta > 0)
        .collect();
    if deltas.len() >= 3 {
        let mut sorted = deltas.clone();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        if median > 0 && deltas.iter().any(|delta| *delta > median.saturating_mul(3)) {
            issues.push(issue(
                Severity::Warning,
                "TIMESTAMP_GAP",
                "states",
                "检测到明显的时间戳间隔异常",
            ));
        }
    }
}

fn issue(severity: Severity, code: &str, scope: &str, message: &str) -> ValidationIssue {
    ValidationIssue {
        severity,
        code: code.into(),
        scope: scope.into(),
        message: message.into(),
    }
}
