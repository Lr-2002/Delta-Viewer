mod hdf5;
mod lerobot;
mod mcap;

use crate::error::{AppError, AppResult};
use crate::model::{EpisodeData, ExportFormat, ExportRange, ExportResult, ValidationReport};
use crate::{source, storage};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use walkdir::WalkDir;

pub struct ExportContext<'a> {
    pub source: &'a Path,
    pub destination_parent: &'a Path,
    pub data: &'a EpisodeData,
    pub range: ExportRange,
    pub full_range: bool,
    frame_ids: BTreeSet<u64>,
    pub app: Option<&'a AppHandle>,
    pub cancelled: Arc<AtomicBool>,
}

impl ExportContext<'_> {
    pub fn contains_frame(&self, frame_id: u64) -> bool {
        self.frame_ids.contains(&frame_id)
    }
}

trait ExportAdapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<PathBuf>;
}

pub(crate) struct ExportJob<'a> {
    pub format: ExportFormat,
    pub source_path: &'a Path,
    pub destination_parent: &'a Path,
    pub validation_report: &'a ValidationReport,
    pub acknowledge_warnings: bool,
    pub requested_range: Option<ExportRange>,
    pub app: Option<&'a AppHandle>,
    pub cancelled: &'a Arc<AtomicBool>,
}

pub(crate) fn export_episode(job: ExportJob<'_>) -> AppResult<ExportResult> {
    let ExportJob {
        format,
        source_path,
        destination_parent,
        validation_report,
        acknowledge_warnings,
        requested_range,
        app,
        cancelled,
    } = job;
    let started = Instant::now();
    let source_data = source::load_episode(source_path, app, cancelled)?;
    let full_range = episode_range(&source_data)?;
    let range = requested_range.unwrap_or(full_range);
    validate_range(range, full_range)?;
    ensure_export_allowed(validation_report, acknowledge_warnings, range)?;
    if !destination_parent.exists() {
        fs::create_dir_all(destination_parent)?;
    }
    if !destination_parent.is_dir() {
        return Err(AppError::Message(format!(
            "导出位置不是目录: {}",
            destination_parent.display()
        )));
    }
    storage::require_export_destination(
        source_path,
        destination_parent,
        source_data.summary.total_bytes,
    )?;
    let data = select_episode_data(source_path, &source_data, range, cancelled)?;
    let frame_ids = data
        .states
        .iter()
        .filter_map(|state| u64::try_from(state.frame_id).ok())
        .collect();
    let context = ExportContext {
        source: source_path,
        destination_parent,
        data: &data,
        range,
        full_range: range == full_range,
        frame_ids,
        app,
        cancelled: cancelled.clone(),
    };
    let output = match format {
        ExportFormat::Mcap => mcap::McapAdapter.export(&context)?,
        ExportFormat::Hdf5 => hdf5::Hdf5Adapter.export(&context)?,
        ExportFormat::LerobotV2 => lerobot::LeRobotV2Adapter.export(&context)?,
    };
    let (total_files, total_bytes) = output_size(&output)?;
    Ok(ExportResult {
        format: format.as_str().into(),
        output_path: output.display().to_string(),
        total_files,
        total_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        range,
        state_count: data.states.len() as u64,
    })
}

fn ensure_export_allowed(
    report: &ValidationReport,
    acknowledge_warnings: bool,
    range: ExportRange,
) -> AppResult<()> {
    let relevant = report
        .issues
        .iter()
        .filter(|issue| {
            issue
                .frame_id
                .and_then(|frame_id| u64::try_from(frame_id).ok())
                .is_none_or(|frame_id| range.contains(frame_id))
        })
        .collect::<Vec<_>>();
    let error_codes = relevant
        .iter()
        .copied()
        .filter(|issue| issue.severity == crate::model::Severity::Error)
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    if !error_codes.is_empty() {
        let codes = error_codes.join(", ");
        return Err(AppError::Message(format!(
            "EXPORT_BLOCKED_VALIDATION_ERROR: 数据检查存在错误（{codes}）"
        )));
    }
    if relevant
        .iter()
        .any(|issue| issue.severity == crate::model::Severity::Warning)
        && !acknowledge_warnings
    {
        return Err(AppError::Message(
            "EXPORT_WARNING_CONFIRMATION_REQUIRED: 请确认数据警告后再导出".into(),
        ));
    }
    Ok(())
}

fn episode_range(data: &EpisodeData) -> AppResult<ExportRange> {
    let mut frame_ids = data
        .states
        .iter()
        .filter_map(|state| u64::try_from(state.frame_id).ok());
    let Some(first) = frame_ids.next() else {
        return Err(AppError::Message(
            "EXPORT_RANGE_EMPTY: 状态数据中没有可裁剪的非负帧号".into(),
        ));
    };
    let (mut minimum, mut maximum) = (first, first);
    for frame_id in frame_ids {
        minimum = minimum.min(frame_id);
        maximum = maximum.max(frame_id);
    }
    Ok(ExportRange {
        start_frame: minimum,
        end_frame: maximum,
    })
}

fn validate_range(range: ExportRange, available: ExportRange) -> AppResult<()> {
    if range.start_frame > range.end_frame {
        return Err(AppError::Message(
            "EXPORT_RANGE_INVALID: 裁剪起点不能晚于终点".into(),
        ));
    }
    if range.start_frame < available.start_frame || range.end_frame > available.end_frame {
        return Err(AppError::Message(format!(
            "EXPORT_RANGE_OUT_OF_BOUNDS: 裁剪范围 {}-{} 超出可用范围 {}-{}",
            range.start_frame, range.end_frame, available.start_frame, available.end_frame
        )));
    }
    Ok(())
}

fn select_episode_data(
    source_root: &Path,
    source_data: &EpisodeData,
    range: ExportRange,
    cancelled: &AtomicBool,
) -> AppResult<EpisodeData> {
    let states = source_data
        .states
        .iter()
        .filter(|state| {
            u64::try_from(state.frame_id)
                .ok()
                .is_some_and(|frame_id| range.contains(frame_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    if states.is_empty() {
        return Err(AppError::Message(format!(
            "EXPORT_RANGE_EMPTY: 裁剪范围 {}-{} 内没有状态数据",
            range.start_frame, range.end_frame
        )));
    }
    let selected_ids = states
        .iter()
        .filter_map(|state| u64::try_from(state.frame_id).ok())
        .collect::<BTreeSet<_>>();
    let mut streams = Vec::with_capacity(source_data.summary.streams.len());
    let mut total_bytes = fs::metadata(source_root.join("states.jsonl"))
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    let mut total_files = 1_u64;

    for source_stream in &source_data.summary.streams {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let files = source::collect_stream_files(source_root, &source_stream.name, cancelled)?;
        let mut selected = BTreeMap::new();
        let mut stream_bytes = 0_u64;
        for (frame_id, path) in files.frames {
            if !selected_ids.contains(&frame_id) || selected.contains_key(&frame_id) {
                continue;
            }
            stream_bytes = stream_bytes.saturating_add(fs::metadata(&path)?.len());
            selected.insert(frame_id, path);
        }
        let present_ids = selected.keys().copied().collect::<BTreeSet<_>>();
        let missing = selected_ids
            .difference(&present_ids)
            .copied()
            .collect::<Vec<_>>();
        let mut stream = source_stream.clone();
        stream.frame_count = selected.len() as u64;
        stream.first_frame = selected.keys().next().copied();
        stream.last_frame = selected.keys().next_back().copied();
        stream.missing_frame_count = missing.len() as u64;
        stream.missing_frames = missing.into_iter().take(2048).collect();
        stream.total_bytes = stream_bytes;
        total_files = total_files.saturating_add(stream.frame_count);
        total_bytes = total_bytes.saturating_add(stream_bytes);
        streams.push(stream);
    }

    let mut summary = source_data.summary.clone();
    summary.total_files = total_files;
    summary.total_bytes = total_bytes;
    summary.state_count = states.len() as u64;
    summary.start_time_ns = states.first().map(|state| state.capture_time_ns.clone());
    summary.end_time_ns = states.last().map(|state| state.capture_time_ns.clone());
    summary.streams = streams;
    Ok(EpisodeData { summary, states })
}

pub(super) fn output_stem(context: &ExportContext<'_>) -> String {
    let base = crate::importer::sanitize_name(&context.data.summary.name);
    if context.full_range {
        base
    } else {
        format!(
            "{base}_frames_{}-{}",
            context.range.start_frame, context.range.end_frame
        )
    }
}

pub(super) fn unique_file(parent: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = parent.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = parent.join(format!("{stem}_{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}_{}.{}", std::process::id(), extension))
}

pub(super) fn unique_directory(parent: &Path, stem: &str) -> PathBuf {
    let first = parent.join(stem);
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = parent.join(format!("{stem}_{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}_{}", std::process::id()))
}

pub(super) fn partial_sibling(output: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    output.with_file_name(format!(".{name}.partial-{nonce}"))
}

pub(super) fn map_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(error.to_string())
}

fn output_size(path: &Path) -> AppResult<(u64, u64)> {
    if path.is_file() {
        return Ok((1, fs::metadata(path)?.len()));
    }
    let mut files = 0;
    let mut bytes = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(map_error)?;
        if entry.file_type().is_file() {
            files += 1;
            bytes += entry.metadata().map_err(map_error)?.len();
        }
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::{ensure_export_allowed, export_episode, select_episode_data, ExportJob};
    use crate::model::{
        EpisodeData, EpisodeSummary, ExportFormat, ExportRange, Severity, StreamSummary,
        ValidationIssue, ValidationReport, STREAM_NAMES,
    };
    use crate::validation;
    use foxglove::messages::{CompressedImage, PoseInFrame};
    use hdf5_pure::File as HdfFile;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    use prost::Message as ProstMessage;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    #[ignore = "requires DOHC_SAMPLE_ROOT and FFmpeg"]
    fn validates_and_exports_real_sample() {
        let sample =
            PathBuf::from(std::env::var("DOHC_SAMPLE_ROOT").expect("DOHC_SAMPLE_ROOT must be set"));
        let output = test_output("exports");
        fs::create_dir_all(&output).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));

        let report = validation::validate_episode(&sample, None, &cancelled).unwrap();
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.severity == Severity::Error));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "TIMESTAMP_GAP"));
        assert_eq!(
            report
                .issues
                .iter()
                .find(|issue| issue.code == "TIMESTAMP_GAP")
                .and_then(|issue| issue.frame_id),
            Some(180)
        );
        assert_eq!(report.checked_files, 981);

        let health =
            validation::export_report(&report, &sample, &output, None, &cancelled).unwrap();
        let health_report: crate::model::ValidationReport =
            serde_json::from_slice(&fs::read(health.output_path).unwrap()).unwrap();
        assert_eq!(health_report.format_version, 1);
        assert_eq!(health_report.parsed_state_count, 196);

        let clip = ExportRange {
            start_frame: 10,
            end_frame: 19,
        };

        let mcap = export_episode(ExportJob {
            format: ExportFormat::Mcap,
            source_path: &sample,
            destination_parent: &output,
            validation_report: &report,
            acknowledge_warnings: true,
            requested_range: Some(clip),
            app: None,
            cancelled: &cancelled,
        })
        .unwrap();
        assert_eq!(mcap.range, clip);
        assert_eq!(mcap.state_count, 10);
        verify_mcap(Path::new(&mcap.output_path), 10);

        let hdf5 = export_episode(ExportJob {
            format: ExportFormat::Hdf5,
            source_path: &sample,
            destination_parent: &output,
            validation_report: &report,
            acknowledge_warnings: true,
            requested_range: Some(clip),
            app: None,
            cancelled: &cancelled,
        })
        .unwrap();
        verify_hdf5(Path::new(&hdf5.output_path), 10);

        let lerobot = export_episode(ExportJob {
            format: ExportFormat::LerobotV2,
            source_path: &sample,
            destination_parent: &output,
            validation_report: &report,
            acknowledge_warnings: true,
            requested_range: Some(clip),
            app: None,
            cancelled: &cancelled,
        })
        .unwrap();
        verify_lerobot(Path::new(&lerobot.output_path), 10);

        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn requires_warning_acknowledgement() {
        let report = ValidationReport {
            format_version: 1,
            episode_root: "fixture".into(),
            parsed_state_count: 1,
            status: "warning".into(),
            checked_files: 1,
            elapsed_ms: 0,
            issues: vec![ValidationIssue {
                severity: Severity::Warning,
                code: "TIMESTAMP_GAP".into(),
                scope: "states".into(),
                message: "gap".into(),
                frame_id: Some(1),
            }],
            streams: Vec::new(),
        };
        let range = ExportRange {
            start_frame: 0,
            end_frame: 1,
        };
        assert!(ensure_export_allowed(&report, false, range).is_err());
        assert!(ensure_export_allowed(&report, true, range).is_ok());
    }

    #[test]
    fn ignores_frame_issues_outside_selected_range() {
        let range = ExportRange {
            start_frame: 10,
            end_frame: 19,
        };
        let report = ValidationReport {
            format_version: 1,
            episode_root: "fixture".into(),
            parsed_state_count: 20,
            status: "error".into(),
            checked_files: 1,
            elapsed_ms: 0,
            issues: vec![
                ValidationIssue {
                    severity: Severity::Error,
                    code: "FRAME_OUTSIDE".into(),
                    scope: "states".into(),
                    message: "outside".into(),
                    frame_id: Some(2),
                },
                ValidationIssue {
                    severity: Severity::Warning,
                    code: "FRAME_INSIDE".into(),
                    scope: "states".into(),
                    message: "inside".into(),
                    frame_id: Some(12),
                },
            ],
            streams: Vec::new(),
        };
        assert!(ensure_export_allowed(&report, false, range).is_err());
        assert!(ensure_export_allowed(&report, true, range).is_ok());
        assert!(ensure_export_allowed(
            &report,
            true,
            ExportRange {
                start_frame: 0,
                end_frame: 9,
            }
        )
        .is_err());
    }

    #[test]
    fn backend_blocks_export_for_invalid_episode() {
        let source = test_output("invalid-source");
        let output = test_output("blocked-export");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(
            source.join("states.jsonl"),
            concat!(
                "{\"frame_id\":0,\"capture_time_ns\":1,",
                "\"position\":[0,0,0],\"velocity\":[0,0,0],",
                "\"quaternion\":[0,0,0,1],\"euler\":[0,0,0],",
                "\"omega\":[0,0,0],\"confidence\":1}\n"
            ),
        )
        .unwrap();

        let cancelled = Arc::new(AtomicBool::new(false));
        let report = validation::validate_episode(&source, None, &cancelled).unwrap();
        let error = export_episode(ExportJob {
            format: ExportFormat::Mcap,
            source_path: &source,
            destination_parent: &output,
            validation_report: &report,
            acknowledge_warnings: true,
            requested_range: None,
            app: None,
            cancelled: &cancelled,
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("EXPORT_BLOCKED_VALIDATION_ERROR"));
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(output).unwrap();
    }

    fn verify_mcap(path: &Path, state_count: usize) {
        let bytes = fs::read(path).unwrap();
        let summary = mcap::Summary::read(&bytes).unwrap().unwrap();
        assert_eq!(summary.channels.len(), 7);
        assert_eq!(summary.schemas.len(), 3);
        let schemas = summary
            .schemas
            .values()
            .map(|schema| (schema.name.as_str(), schema.encoding.as_str()))
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            schemas,
            [
                ("dohc.State", "jsonschema"),
                ("foxglove.CompressedImage", "protobuf"),
                ("foxglove.PoseInFrame", "protobuf"),
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(summary.stats.unwrap().message_count, state_count as u64 * 7);

        let mut state_messages = 0;
        let mut pose_messages = 0;
        let mut image_messages = 0;
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            match message.channel.topic.as_str() {
                "/dohc/state" => {
                    let _: serde_json::Value = serde_json::from_slice(&message.data).unwrap();
                    state_messages += 1;
                }
                "/dohc/pose" => {
                    let pose = PoseInFrame::decode(message.data.as_ref()).unwrap();
                    assert_eq!(pose.frame_id, "dohc_base");
                    assert!(pose.timestamp.is_some());
                    assert!(pose.pose.is_some());
                    pose_messages += 1;
                }
                topic if topic.starts_with("/dohc/camera/") => {
                    let image = CompressedImage::decode(message.data.as_ref()).unwrap();
                    assert_eq!(image.format, "jpeg");
                    assert!(!image.data.is_empty());
                    assert!(image.timestamp.is_some());
                    image_messages += 1;
                }
                topic => panic!("unexpected MCAP topic: {topic}"),
            }
        }
        assert_eq!(state_messages, state_count);
        assert_eq!(pose_messages, state_count);
        assert_eq!(image_messages, state_count * 5);
    }

    fn verify_hdf5(path: &Path, state_count: usize) {
        let file = HdfFile::open_streaming(path).unwrap();
        assert_eq!(
            file.dataset("states/frame_id").unwrap().shape().unwrap(),
            vec![state_count as u64]
        );
        assert_eq!(
            file.dataset("images/cam0/frame_id")
                .unwrap()
                .shape()
                .unwrap(),
            vec![state_count as u64]
        );
    }

    fn verify_lerobot(path: &Path, state_count: usize) {
        let info: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("meta/info.json")).unwrap()).unwrap();
        assert_eq!(info["codebase_version"], "v2.1");
        assert_eq!(info["total_frames"], state_count);
        assert_eq!(info["fps"], 30);
        let parquet_path = path.join("data/chunk-000/episode_000000.parquet");
        let builder =
            ParquetRecordBatchReaderBuilder::try_new(fs::File::open(parquet_path).unwrap())
                .unwrap();
        assert!(builder
            .schema()
            .field_with_name("observation.capture_time_ns")
            .is_ok());
        let batch = builder.build().unwrap().next().unwrap().unwrap();
        assert_eq!(batch.num_rows(), state_count);
        for stream in ["cam0", "cam1", "cam2", "t265_left", "t265_right"] {
            let video = path
                .join("videos/chunk-000")
                .join(format!("observation.images.{stream}"))
                .join("episode_000000.mp4");
            assert!(fs::metadata(video).unwrap().len() > 0);
        }
    }

    #[test]
    fn selects_one_frame_range_for_all_streams() {
        let source = test_output("range-selection");
        fs::create_dir_all(&source).unwrap();
        let mut states = Vec::new();
        for frame_id in 0..5 {
            states.push(crate::model::StateRecord {
                frame_id,
                capture_time_ns: (1_000_000_000_i64 + frame_id * 10_000_000).to_string(),
                position: [0.0, 0.0, 0.0],
                velocity: [0.0, 0.0, 0.0],
                quaternion: [0.0, 0.0, 0.0, 1.0],
                euler: [0.0, 0.0, 0.0],
                omega: [0.0, 0.0, 0.0],
                confidence: 1.0,
            });
        }
        for stream in STREAM_NAMES {
            let root = source.join(stream);
            fs::create_dir_all(&root).unwrap();
            for frame_id in 0..5 {
                fs::write(root.join(format!("{frame_id}.jpg")), [frame_id as u8]).unwrap();
            }
        }
        fs::write(source.join("states.jsonl"), b"\n").unwrap();
        let streams = STREAM_NAMES
            .into_iter()
            .map(|name| StreamSummary {
                name: name.into(),
                label: name.into(),
                frame_count: 5,
                first_frame: Some(0),
                last_frame: Some(4),
                missing_frames: Vec::new(),
                missing_frame_count: 0,
                total_bytes: 5,
                width: Some(1),
                height: Some(1),
                channels: Some(3),
            })
            .collect();
        let data = EpisodeData {
            summary: EpisodeSummary {
                root: source.display().to_string(),
                name: "fixture".into(),
                total_files: 26,
                total_bytes: 25,
                state_count: 5,
                start_time_ns: None,
                end_time_ns: None,
                streams,
            },
            states,
        };
        let range = ExportRange {
            start_frame: 2,
            end_frame: 3,
        };
        let selected = select_episode_data(&source, &data, range, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            selected
                .states
                .iter()
                .map(|state| state.frame_id)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(selected.summary.state_count, 2);
        assert!(selected
            .summary
            .streams
            .iter()
            .all(|stream| stream.frame_count == 2
                && stream.first_frame == Some(2)
                && stream.last_frame == Some(3)
                && stream.missing_frame_count == 0));
        fs::remove_dir_all(source).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
