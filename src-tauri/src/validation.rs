use crate::error::{AppError, AppResult};
use crate::model::{
    ProgressPayload, RawStateRecord, ReportExportResult, Severity, StreamValidation,
    ValidationIssue, ValidationReport, STREAM_NAMES,
};
use crate::source::{collect_stream_files, emit_progress, is_regular_file, scan_episode};
use crate::{importer, storage};
use image::ImageReader;
use std::collections::BTreeSet;
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
    if !is_regular_file(&states_path) {
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
                    if state.capture_time_ns < 0 {
                        issues.push(issue_at(
                            Severity::Error,
                            "INVALID_TIMESTAMP",
                            "states",
                            &format!("第 {} 行的 capture_time_ns 为负数", line_number + 1),
                            state.frame_id,
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
                Err(error) => {
                    let code = if contains_non_finite_token(&line)
                        || error.to_string().contains("number out of range")
                    {
                        "NON_FINITE_STATE"
                    } else {
                        "INVALID_STATE_JSON"
                    };
                    issues.push(issue(
                        Severity::Error,
                        code,
                        "states",
                        &format!("第 {} 行无法解析: {}", line_number + 1, error),
                    ));
                }
            }
        }
    }

    check_state_sequence(&states, &mut issues);
    let state_frame_ids = states
        .iter()
        .filter_map(|state| u64::try_from(state.frame_id).ok())
        .collect::<BTreeSet<_>>();
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
        let stream_files = collect_stream_files(root, &stream.name, cancelled)?;
        let mut stream_has_error = false;
        if stream.frame_count == 0 {
            issues.push(issue(
                Severity::Error,
                "EMPTY_STREAM",
                &stream.name,
                "数据流为空或目录不存在",
            ));
            stream_has_error = true;
        }
        if stream.missing_frame_count > 0 {
            issues.push(issue_at(
                Severity::Warning,
                "MISSING_FRAMES",
                &stream.name,
                &format!("缺少 {} 个连续帧位置", stream.missing_frame_count),
                stream
                    .missing_frames
                    .first()
                    .and_then(|frame| i64::try_from(*frame).ok())
                    .unwrap_or_default(),
            ));
        }
        if let Some(name) = stream_files.invalid_names.first() {
            issues.push(issue(
                Severity::Error,
                "INVALID_FRAME_FILENAME",
                &stream.name,
                &format!("图像文件名不能映射为非负十进制帧号: {name}"),
            ));
            stream_has_error = true;
        }
        if let Some(frame_id) = stream_files.duplicate_ids.first().copied() {
            issues.push(issue_at(
                Severity::Error,
                "DUPLICATE_FRAME_ID",
                &stream.name,
                &format!("多个图像文件映射到帧 {frame_id}"),
                i64::try_from(frame_id).unwrap_or(i64::MAX),
            ));
            stream_has_error = true;
        }

        let stream_frame_ids = stream_files
            .frames
            .iter()
            .map(|(frame_id, _)| *frame_id)
            .collect::<BTreeSet<_>>();
        if !state_frame_ids.is_empty()
            && state_frame_ids.len() == stream_frame_ids.len()
            && state_frame_ids != stream_frame_ids
        {
            if let Some(frame_id) = state_frame_ids
                .symmetric_difference(&stream_frame_ids)
                .next()
                .copied()
            {
                issues.push(issue_at(
                    Severity::Error,
                    "FRAME_ID_MISMATCH",
                    &stream.name,
                    "图像帧号集合与状态帧号集合不一致",
                    i64::try_from(frame_id).unwrap_or(i64::MAX),
                ));
                stream_has_error = true;
            }
        }

        let mut expected_dimensions: Option<(u32, u32)> = None;
        for (frame_id, path) in &stream_files.frames {
            if cancelled.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            checked_files += 1;
            checked_frames += 1;
            total_checked_frames += 1;
            match ImageReader::open(path)
                .map_err(image::ImageError::IoError)
                .and_then(|reader| {
                    reader
                        .with_guessed_format()
                        .map_err(image::ImageError::IoError)?
                        .decode()
                }) {
                Ok(image) => {
                    let dimensions = (image.width(), image.height());
                    if let Some(expected) = expected_dimensions {
                        if expected != dimensions {
                            dimension_mismatches += 1;
                            issues.push(issue_at(
                                Severity::Error,
                                "DIMENSION_MISMATCH",
                                &stream.name,
                                &format!(
                                    "帧 {} 的分辨率为 {}×{}，预期 {}×{}",
                                    frame_id, dimensions.0, dimensions.1, expected.0, expected.1
                                ),
                                i64::try_from(*frame_id).unwrap_or(i64::MAX),
                            ));
                            stream_has_error = true;
                        }
                    } else {
                        expected_dimensions = Some(dimensions);
                    }
                }
                Err(error) => {
                    decode_failures += 1;
                    stream_has_error = true;
                    issues.push(issue_at(
                        Severity::Error,
                        "DECODE_FAILED",
                        &stream.name,
                        &format!("帧 {} 无法解码: {}", frame_id, error),
                        i64::try_from(*frame_id).unwrap_or(i64::MAX),
                    ));
                }
            }
            if checked_frames % 8 == 0 || checked_frames == stream_files.frames.len() as u64 {
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
        let status = if stream_has_error || decode_failures > 0 || dimension_mismatches > 0 {
            "error"
        } else if stream.missing_frame_count > 0 {
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
        storage::publish_noreplace(&partial, &output)?;
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

fn contains_non_finite_token(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        for token in [b"NaN".as_slice(), b"Infinity".as_slice()] {
            if bytes[index..].starts_with(token) {
                let before = index
                    .checked_sub(1)
                    .and_then(|position| bytes.get(position));
                let after = bytes.get(index + token.len());
                let boundary = |value: Option<&u8>| {
                    value.is_none_or(|value| !value.is_ascii_alphanumeric() && *value != b'_')
                };
                if boundary(before) && boundary(after) {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
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
        if pair[0].frame_id.checked_add(1) != Some(pair[1].frame_id) {
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
        .map(|pair| {
            pair[1]
                .capture_time_ns
                .saturating_sub(pair[0].capture_time_ns)
        })
        .filter(|delta| *delta > 0)
        .collect();
    if deltas.len() >= 3 {
        let mut sorted = deltas.clone();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        if median > 0 {
            let gap = states.windows(2).find(|pair| {
                pair[1]
                    .capture_time_ns
                    .saturating_sub(pair[0].capture_time_ns)
                    > median.saturating_mul(3)
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
    use super::{check_state_sequence, export_report, validate_episode};
    use crate::model::{RawStateRecord, ValidationReport, STREAM_NAMES};
    use image::codecs::jpeg::JpegEncoder;
    use image::ExtendedColorType;
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

    #[test]
    fn detects_every_state_issue_code() {
        let missing = valid_episode("missing-states", &[0, 1, 2, 3]);
        fs::remove_file(missing.join("states.jsonl")).unwrap();
        assert_codes(&missing, &["MISSING_STATES", "EMPTY_STATES"]);
        fs::remove_dir_all(missing).unwrap();

        let empty = valid_episode("empty-states", &[0]);
        fs::write(empty.join("states.jsonl"), b"\n").unwrap();
        assert_codes(&empty, &["EMPTY_STATE_LINE", "EMPTY_STATES"]);
        fs::remove_dir_all(empty).unwrap();

        let invalid = valid_episode("invalid-state", &[0]);
        fs::write(invalid.join("states.jsonl"), b"not json\n").unwrap();
        assert_codes(&invalid, &["INVALID_STATE_JSON", "EMPTY_STATES"]);
        fs::remove_dir_all(invalid).unwrap();

        let non_finite = valid_episode("non-finite", &[0]);
        fs::write(non_finite.join("states.jsonl"), state_line(0, 0, "NaN")).unwrap();
        assert_codes(&non_finite, &["NON_FINITE_STATE", "EMPTY_STATES"]);
        fs::remove_dir_all(non_finite).unwrap();

        let negative = valid_episode("negative-frame", &[0]);
        fs::write(negative.join("states.jsonl"), state_line(-1, 0, "1.0")).unwrap();
        assert_codes(&negative, &["INVALID_FRAME_ID"]);
        fs::remove_dir_all(negative).unwrap();

        let negative_time = valid_episode("negative-time", &[0]);
        fs::write(negative_time.join("states.jsonl"), state_line(0, -1, "1.0")).unwrap();
        assert_codes(&negative_time, &["INVALID_TIMESTAMP"]);
        fs::remove_dir_all(negative_time).unwrap();

        let sequence = valid_episode("sequence", &[0, 1, 2, 3]);
        fs::write(
            sequence.join("states.jsonl"),
            [
                state_line(0, 0, "1.0"),
                state_line(2, 10, "1.0"),
                state_line(3, 5, "1.0"),
                state_line(4, 15, "1.0"),
                state_line(5, 105, "1.0"),
            ]
            .concat(),
        )
        .unwrap();
        assert_codes(
            &sequence,
            &[
                "STATE_FRAME_GAP",
                "TIMESTAMP_NOT_MONOTONIC",
                "TIMESTAMP_GAP",
            ],
        );
        fs::remove_dir_all(sequence).unwrap();
    }

    #[test]
    fn detects_every_image_issue_code() {
        let empty = valid_episode("empty-stream", &[0]);
        fs::remove_dir_all(empty.join("cam0")).unwrap();
        assert_codes(&empty, &["EMPTY_STREAM"]);
        fs::remove_dir_all(empty).unwrap();

        let missing = valid_episode("missing-frame", &[0, 1, 2]);
        fs::remove_file(missing.join("cam0/1.jpg")).unwrap();
        let report = report(&missing);
        assert!(has_code(&report, "MISSING_FRAMES"));
        assert_eq!(
            report
                .issues
                .iter()
                .find(|issue| issue.code == "MISSING_FRAMES")
                .and_then(|issue| issue.frame_id),
            Some(1)
        );
        fs::remove_dir_all(missing).unwrap();

        let corrupt = valid_episode("decode", &[0]);
        fs::write(corrupt.join("cam0/0.jpg"), b"not jpeg").unwrap();
        assert_codes(&corrupt, &["DECODE_FAILED"]);
        fs::remove_dir_all(corrupt).unwrap();

        let dimensions = valid_episode("dimensions", &[0, 1]);
        write_jpeg(&dimensions.join("cam0/1.jpg"), 2, 1);
        assert_codes(&dimensions, &["DIMENSION_MISMATCH"]);
        fs::remove_dir_all(dimensions).unwrap();

        let count = valid_episode("count", &[0, 1]);
        fs::remove_file(count.join("cam0/1.jpg")).unwrap();
        assert_codes(&count, &["COUNT_MISMATCH"]);
        fs::remove_dir_all(count).unwrap();

        let invalid_name = valid_episode("invalid-name", &[0]);
        write_jpeg(&invalid_name.join("cam0/not-a-frame.jpg"), 1, 1);
        assert_codes(&invalid_name, &["INVALID_FRAME_FILENAME"]);
        fs::remove_dir_all(invalid_name).unwrap();

        let duplicate = valid_episode("duplicate", &[0]);
        write_jpeg(&duplicate.join("cam0/00.jpg"), 1, 1);
        assert_codes(&duplicate, &["DUPLICATE_FRAME_ID"]);
        fs::remove_dir_all(duplicate).unwrap();

        let mismatch = valid_episode("frame-mismatch", &[0, 1]);
        fs::rename(mismatch.join("cam0/0.jpg"), mismatch.join("cam0/10.jpg")).unwrap();
        fs::rename(mismatch.join("cam0/1.jpg"), mismatch.join("cam0/11.jpg")).unwrap();
        assert_codes(&mismatch, &["FRAME_ID_MISMATCH"]);
        fs::remove_dir_all(mismatch).unwrap();
    }

    #[test]
    fn scans_sparse_extreme_frame_ranges_without_expanding_them() {
        let root = valid_episode("sparse-range", &[0]);
        write_jpeg(&root.join("cam0/1000000.jpg"), 1, 1);
        let summary = crate::source::scan_episode(&root, None, &AtomicBool::new(false)).unwrap();
        let cam0 = summary
            .streams
            .iter()
            .find(|stream| stream.name == "cam0")
            .unwrap();
        assert_eq!(cam0.missing_frame_count, 999_999);
        assert_eq!(cam0.missing_frames.len(), 2048);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_load_and_validation_leave_the_source_unchanged() {
        let root = valid_episode("source-read-only", &[0, 1]);
        let cancelled = AtomicBool::new(false);
        let before = tree_digest(&root);

        crate::source::scan_source(&root, None, &cancelled).unwrap();
        crate::source::load_episode(&root, None, &cancelled).unwrap();
        validate_episode(&root, None, &cancelled).unwrap();
        crate::source::episode_fingerprint(&root, &cancelled).unwrap();

        assert_eq!(tree_digest(&root), before);
        fs::remove_dir_all(root).unwrap();
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

    fn report(root: &std::path::Path) -> ValidationReport {
        validate_episode(root, None, &AtomicBool::new(false)).unwrap()
    }

    fn assert_codes(root: &std::path::Path, expected: &[&str]) {
        let report = report(root);
        for code in expected {
            assert!(
                has_code(&report, code),
                "missing {code}; got {:?}",
                report
                    .issues
                    .iter()
                    .map(|issue| issue.code.as_str())
                    .collect::<Vec<_>>()
            );
        }
    }

    fn has_code(report: &ValidationReport, code: &str) -> bool {
        report.issues.iter().any(|issue| issue.code == code)
    }

    fn valid_episode(label: &str, frame_ids: &[u64]) -> PathBuf {
        let root = test_output(label);
        fs::create_dir_all(&root).unwrap();
        for stream in STREAM_NAMES {
            let stream_root = root.join(stream);
            fs::create_dir(&stream_root).unwrap();
            for frame_id in frame_ids {
                write_jpeg(&stream_root.join(format!("{frame_id}.jpg")), 1, 1);
            }
        }
        let states = frame_ids
            .iter()
            .enumerate()
            .map(|(index, frame_id)| state_line(*frame_id as i64, index as i64 * 10, "1.0"))
            .collect::<String>();
        fs::write(root.join("states.jsonl"), states).unwrap();
        root
    }

    fn state_line(frame_id: i64, capture_time_ns: i64, confidence: &str) -> String {
        format!(
            "{{\"frame_id\":{frame_id},\"capture_time_ns\":{capture_time_ns},\"position\":[0,0,0],\"velocity\":[0,0,0],\"quaternion\":[0,0,0,1],\"euler\":[0,0,0],\"omega\":[0,0,0],\"confidence\":{confidence}}}\n"
        )
    }

    fn write_jpeg(path: &std::path::Path, width: u32, height: u32) {
        let pixels = vec![127_u8; width as usize * height as usize * 3];
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes)
            .encode(&pixels, width, height, ExtendedColorType::Rgb8)
            .unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn tree_digest(root: &std::path::Path) -> String {
        let cancelled = AtomicBool::new(false);
        let files = crate::source::collect_files(root, &cancelled).unwrap();
        let mut hasher = blake3::Hasher::new();
        for path in files {
            let relative = path.strip_prefix(root).unwrap().to_string_lossy();
            hasher.update(relative.as_bytes());
            hasher.update(&[0]);
            hasher.update(&fs::read(path).unwrap());
        }
        hasher.finalize().to_hex().to_string()
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
