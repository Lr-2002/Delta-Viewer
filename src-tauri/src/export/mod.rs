mod hdf5;
mod lerobot;
mod mcap;

use crate::error::{AppError, AppResult};
use crate::model::{EpisodeData, ExportFormat, ExportResult, ValidationReport};
use crate::{source, storage};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use tauri::AppHandle;
use walkdir::WalkDir;

pub struct ExportContext<'a> {
    pub source: &'a Path,
    pub destination_parent: &'a Path,
    pub data: &'a EpisodeData,
    pub app: Option<&'a AppHandle>,
    pub cancelled: &'a AtomicBool,
}

trait ExportAdapter {
    fn export(&self, context: &ExportContext<'_>) -> AppResult<PathBuf>;
}

pub fn export_episode(
    format: ExportFormat,
    source_path: &Path,
    destination_parent: &Path,
    validation_report: &ValidationReport,
    acknowledge_warnings: bool,
    app: Option<&AppHandle>,
    cancelled: &AtomicBool,
) -> AppResult<ExportResult> {
    ensure_export_allowed(validation_report, acknowledge_warnings)?;
    if !destination_parent.exists() {
        fs::create_dir_all(destination_parent)?;
    }
    if !destination_parent.is_dir() {
        return Err(AppError::Message(format!(
            "导出位置不是目录: {}",
            destination_parent.display()
        )));
    }
    let started = Instant::now();
    let data = source::load_episode(source_path, app, cancelled)?;
    storage::require_export_destination(source_path, destination_parent, data.summary.total_bytes)?;
    let context = ExportContext {
        source: source_path,
        destination_parent,
        data: &data,
        app,
        cancelled,
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
    })
}

fn ensure_export_allowed(report: &ValidationReport, acknowledge_warnings: bool) -> AppResult<()> {
    if report.status == "error" {
        let codes = report
            .issues
            .iter()
            .filter(|issue| issue.severity == crate::model::Severity::Error)
            .map(|issue| issue.code.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::Message(format!(
            "EXPORT_BLOCKED_VALIDATION_ERROR: 数据检查存在错误（{codes}）"
        )));
    }
    if report.status == "warning" && !acknowledge_warnings {
        return Err(AppError::Message(
            "EXPORT_WARNING_CONFIRMATION_REQUIRED: 请确认数据警告后再导出".into(),
        ));
    }
    Ok(())
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
    use super::{ensure_export_allowed, export_episode};
    use crate::model::{ExportFormat, Severity, ValidationIssue, ValidationReport};
    use crate::validation;
    use hdf5_pure::File as HdfFile;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    #[ignore = "requires DOHC_SAMPLE_ROOT and FFmpeg"]
    fn validates_and_exports_real_sample() {
        let sample =
            PathBuf::from(std::env::var("DOHC_SAMPLE_ROOT").expect("DOHC_SAMPLE_ROOT must be set"));
        let output = test_output("exports");
        fs::create_dir_all(&output).unwrap();
        let cancelled = AtomicBool::new(false);

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

        let mcap = export_episode(
            ExportFormat::Mcap,
            &sample,
            &output,
            &report,
            true,
            None,
            &cancelled,
        )
        .unwrap();
        verify_mcap(Path::new(&mcap.output_path));

        let hdf5 = export_episode(
            ExportFormat::Hdf5,
            &sample,
            &output,
            &report,
            true,
            None,
            &cancelled,
        )
        .unwrap();
        verify_hdf5(Path::new(&hdf5.output_path));

        let lerobot = export_episode(
            ExportFormat::LerobotV2,
            &sample,
            &output,
            &report,
            true,
            None,
            &cancelled,
        )
        .unwrap();
        verify_lerobot(Path::new(&lerobot.output_path));

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
        assert!(ensure_export_allowed(&report, false).is_err());
        assert!(ensure_export_allowed(&report, true).is_ok());
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

        let report = validation::validate_episode(&source, None, &AtomicBool::new(false)).unwrap();
        let error = export_episode(
            ExportFormat::Mcap,
            &source,
            &output,
            &report,
            true,
            None,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("EXPORT_BLOCKED_VALIDATION_ERROR"));
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(output).unwrap();
    }

    fn verify_mcap(path: &Path) {
        let bytes = fs::read(path).unwrap();
        let summary = mcap::Summary::read(&bytes).unwrap().unwrap();
        assert_eq!(summary.channels.len(), 6);
        assert_eq!(summary.schemas.len(), 1);
    }

    fn verify_hdf5(path: &Path) {
        let file = HdfFile::open_streaming(path).unwrap();
        assert_eq!(
            file.dataset("states/frame_id").unwrap().shape().unwrap(),
            vec![196]
        );
        assert_eq!(
            file.dataset("images/cam0/frame_id")
                .unwrap()
                .shape()
                .unwrap(),
            vec![196]
        );
    }

    fn verify_lerobot(path: &Path) {
        let info: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("meta/info.json")).unwrap()).unwrap();
        assert_eq!(info["codebase_version"], "v2.1");
        assert_eq!(info["total_frames"], 196);
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
        assert_eq!(batch.num_rows(), 196);
        for stream in ["cam0", "cam1", "cam2", "t265_left", "t265_right"] {
            let video = path
                .join("videos/chunk-000")
                .join(format!("observation.images.{stream}"))
                .join("episode_000000.mp4");
            assert!(fs::metadata(video).unwrap().len() > 0);
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
