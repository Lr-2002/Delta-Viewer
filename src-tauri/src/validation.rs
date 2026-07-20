use crate::error::{AppError, AppResult};
use crate::model::{
    ProgressPayload, RawStateRecord, ReportExportResult, Severity, StreamValidation,
    ValidationIssue, ValidationReport, STREAM_NAMES,
};
use crate::source::{emit_progress, scan_episode};
use crate::{importer, storage};
use image::ImageReader;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
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
                    if state.frame_id < 0 {
                        issues.push(issue(
                            Severity::Error,
                            "INVALID_FRAME_ID",
                            "states",
                            &format!("第 {} 行的 frame_id 为负数", line_number + 1),
                        ));
                    }
                    if !state_is_finite(&state) {
                        issues.push(issue_at(
                            Severity::Error,
                            "NON_FINITE_STATE",
                            "states",
                            &format!("第 {} 行包含 NaN 或 Infinity", line_number + 1),
                            state.frame_id,
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
            issues.push(issue_at(
                Severity::Warning,
                "MISSING_FRAMES",
                &stream.name,
                &format!("缺少 {} 个连续帧位置", stream.missing_frames.len()),
                stream
                    .missing_frames
                    .first()
                    .and_then(|frame| i64::try_from(*frame).ok())
                    .unwrap_or_default(),
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
                            issues.push(issue_at(
                                Severity::Error,
                                "DIMENSION_MISMATCH",
                                &stream.name,
                                &format!(
                                    "帧 {} 的分辨率为 {}×{}",
                                    frame_id,
                                    image.width(),
                                    image.height()
                                ),
                                i64::try_from(frame_id).unwrap_or(i64::MAX),
                            ));
                        }
                    }
                    Err(error) => {
                        decode_failures += 1;
                        issues.push(issue_at(
                            Severity::Error,
                            "DECODE_FAILED",
                            &stream.name,
                            &format!("帧 {} 无法解码: {}", frame_id, error),
                            i64::try_from(frame_id).unwrap_or(i64::MAX),
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
        format_version: 1,
        episode_root: root.display().to_string(),
        parsed_state_count: states.len() as u64,
        status: status.into(),
        checked_files,
        elapsed_ms: started.elapsed().as_millis(),
        issues,
        streams: stream_reports,
    })
}

pub fn export_report(
    report: &ValidationReport,
    source_root: &Path,
    destination_parent: &Path,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<ReportExportResult> {
    if !destination_parent.is_dir() {
        return Err(AppError::MissingPath(
            destination_parent.display().to_string(),
        ));
    }
    let volume = storage::require_local_destination(source_root, destination_parent)?;
    if volume.available_bytes < 1024 * 1024 {
        return Err(AppError::Message(
            "INSUFFICIENT_SPACE: 导出检查报告至少需要 1 MiB 可用空间".into(),
        ));
    }
    check_cancelled(cancelled)?;
    let started = Instant::now();
    let source_name = source_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("episode");
    let stem = format!("{}.health", importer::sanitize_name(source_name));
    let output = unique_report_path(destination_parent, &stem);
    let partial = report_partial_path(&output);

    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        serde_json::to_writer_pretty(&mut file, report)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        check_cancelled(cancelled)?;

        let decoded: ValidationReport = serde_json::from_reader(File::open(&partial)?)?;
        if decoded.format_version != report.format_version
            || decoded.episode_root != report.episode_root
            || decoded.status != report.status
        {
            return Err(AppError::Message("检查报告回读验证失败".into()));
        }
        fs::rename(&partial, &output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }

    let total_bytes = fs::metadata(&output)?.len();
    emit_progress(
        app,
        ProgressPayload {
            task: "validate".into(),
            phase: "检查报告已导出".into(),
            current: 1,
            total: 1,
            bytes_done: total_bytes,
            total_bytes,
            current_path: output.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
    Ok(ReportExportResult {
        output_path: output.display().to_string(),
        total_bytes,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

fn unique_report_path(parent: &Path, stem: &str) -> PathBuf {
    let first = parent.join(format!("{stem}.json"));
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = parent.join(format!("{stem}_{index}.json"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}_{}.json", std::process::id()))
}

fn report_partial_path(output: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("health.json");
    output.with_file_name(format!(".{name}.partial-{nonce}"))
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
            issues.push(issue_at(
                Severity::Warning,
                "STATE_FRAME_GAP",
                "states",
                &format!("帧号从 {} 跳到 {}", pair[0].frame_id, pair[1].frame_id),
                pair[1].frame_id,
            ));
        }
        if pair[1].capture_time_ns <= pair[0].capture_time_ns {
            issues.push(issue_at(
                Severity::Error,
                "TIMESTAMP_NOT_MONOTONIC",
                "states",
                &format!("帧 {} 的时间戳没有递增", pair[1].frame_id),
                pair[1].frame_id,
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
        if median > 0 {
            let gap = states.windows(2).find(|pair| {
                pair[1].capture_time_ns - pair[0].capture_time_ns > median.saturating_mul(3)
            });
            if let Some(pair) = gap {
                issues.push(issue_at(
                    Severity::Warning,
                    "TIMESTAMP_GAP",
                    "states",
                    "检测到明显的时间戳间隔异常",
                    pair[1].frame_id,
                ));
            }
        }
    }
}

fn issue(severity: Severity, code: &str, scope: &str, message: &str) -> ValidationIssue {
    ValidationIssue {
        severity,
        code: code.into(),
        scope: scope.into(),
        message: message.into(),
        frame_id: None,
    }
}

fn issue_at(
    severity: Severity,
    code: &str,
    scope: &str,
    message: &str,
    frame_id: i64,
) -> ValidationIssue {
    ValidationIssue {
        severity,
        code: code.into(),
        scope: scope.into(),
        message: message.into(),
        frame_id: Some(frame_id),
    }
}

#[cfg(test)]
mod tests {
    use super::{check_state_sequence, export_report};
    use crate::model::{RawStateRecord, ValidationReport};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn exports_versioned_report_without_overwriting() {
        let root = test_output("report");
        let source = root.join("episode");
        let destination = root.join("reports");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let report = ValidationReport {
            format_version: 1,
            episode_root: source.display().to_string(),
            parsed_state_count: 3,
            status: "warning".into(),
            checked_files: 4,
            elapsed_ms: 10,
            issues: Vec::new(),
            streams: Vec::new(),
        };
        let cancelled = AtomicBool::new(false);

        let first = export_report(&report, &source, &destination, None, &cancelled).unwrap();
        let second = export_report(&report, &source, &destination, None, &cancelled).unwrap();
        assert_ne!(first.output_path, second.output_path);
        let decoded: ValidationReport =
            serde_json::from_slice(&fs::read(first.output_path).unwrap()).unwrap();
        assert_eq!(decoded.format_version, 1);
        assert_eq!(decoded.parsed_state_count, 3);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sequence_issues_include_jump_frames() {
        let states = vec![
            state(0, 0),
            state(1, 10),
            state(2, 20),
            state(3, 100),
            state(4, 110),
        ];
        let mut issues = Vec::new();
        check_state_sequence(&states, &mut issues);
        let gap = issues
            .iter()
            .find(|issue| issue.code == "TIMESTAMP_GAP")
            .unwrap();
        assert_eq!(gap.frame_id, Some(3));

        let mut frame_issues = Vec::new();
        check_state_sequence(&[state(0, 0), state(2, 10)], &mut frame_issues);
        let frame_gap = frame_issues
            .iter()
            .find(|issue| issue.code == "STATE_FRAME_GAP")
            .unwrap();
        assert_eq!(frame_gap.frame_id, Some(2));
    }

    fn state(frame_id: i64, capture_time_ns: i64) -> RawStateRecord {
        RawStateRecord {
            frame_id,
            capture_time_ns,
            position: [0.0; 3],
            velocity: [0.0; 3],
            quaternion: [0.0, 0.0, 0.0, 1.0],
            euler: [0.0; 3],
            omega: [0.0; 3],
            confidence: 1.0,
        }
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
