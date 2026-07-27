use super::{export_episode, ExportJob};
use crate::annotations;
use crate::error::{AppError, AppResult};
use crate::model::{
    BatchExportCommandRequest, BatchExportItemResult, BatchExportResult, EpisodeAnnotation,
    ExportResult, ProgressPayload,
};
use crate::source;
use crate::validation;
use crate::validation_cache::ValidationCache;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;

pub(crate) struct BatchExportJob<'a> {
    pub request: BatchExportCommandRequest,
    pub data_root: &'a Path,
    pub reports_dir: &'a Path,
    pub cache: &'a ValidationCache,
    pub app: Option<&'a AppHandle>,
    pub cancelled: &'a Arc<AtomicBool>,
}

struct BatchExportRuntime<'a> {
    data_root: &'a Path,
    reports_dir: &'a Path,
    cache: &'a ValidationCache,
    app: Option<&'a AppHandle>,
    cancelled: &'a Arc<AtomicBool>,
    destination_parent: &'a Path,
    format: crate::model::ExportFormat,
    acknowledge_warnings: bool,
}

pub(crate) fn export_annotated_episodes(job: BatchExportJob<'_>) -> AppResult<BatchExportResult> {
    let BatchExportJob {
        request,
        data_root,
        reports_dir,
        cache,
        app,
        cancelled,
    } = job;
    let BatchExportCommandRequest {
        episode_ids,
        destination_parent,
        format,
        acknowledge_warnings,
    } = request;
    let started = Instant::now();
    let annotations = annotations::annotations_by_ids(data_root, &episode_ids)?;
    let requested_count = annotations.len() as u64;
    let destination_parent_path = Path::new(&destination_parent);
    if !destination_parent_path.is_dir() {
        return Err(AppError::Message(format!(
            "BATCH_EXPORT_DESTINATION_INVALID: 批量导出位置不是目录: {}",
            destination_parent_path.display()
        )));
    }
    let runtime = BatchExportRuntime {
        data_root,
        reports_dir,
        cache,
        app,
        cancelled,
        destination_parent: destination_parent_path,
        format,
        acknowledge_warnings,
    };

    let mut items = Vec::with_capacity(annotations.len());
    let mut cancelled_batch = false;
    for (index, annotation) in annotations.into_iter().enumerate() {
        if cancelled.load(Ordering::Acquire) {
            cancelled_batch = true;
            break;
        }
        emit_batch_progress(
            app,
            &annotation,
            index as u64,
            requested_count,
            "重新检查已标注数据",
            started.elapsed().as_millis(),
        );

        let mut validation_status = None;
        let outcome = export_one_annotation(&runtime, &annotation, &mut validation_status);
        let item = match outcome {
            Ok(result) => BatchExportItemResult {
                episode_id: annotation.episode_id.clone(),
                trajectory_code: annotation.trajectory_code.clone(),
                source_path: annotation.episode_root.clone(),
                status: "exported".into(),
                validation_status,
                result: Some(result),
                error: None,
            },
            Err(AppError::Cancelled) => {
                cancelled_batch = true;
                break;
            }
            Err(error) => BatchExportItemResult {
                episode_id: annotation.episode_id.clone(),
                trajectory_code: annotation.trajectory_code.clone(),
                source_path: annotation.episode_root.clone(),
                status: "failed".into(),
                validation_status,
                result: None,
                error: Some(error.to_string()),
            },
        };

        emit_batch_progress(
            app,
            &annotation,
            (index + 1) as u64,
            requested_count,
            "批量导出进度",
            started.elapsed().as_millis(),
        );
        items.push(item);
    }

    let exported_count = items
        .iter()
        .filter(|item| item.status == "exported")
        .count() as u64;
    let failed_count = items.iter().filter(|item| item.status == "failed").count() as u64;
    let total_files = items
        .iter()
        .filter_map(|item| item.result.as_ref())
        .map(|result| result.total_files)
        .sum();
    let total_bytes = items
        .iter()
        .filter_map(|item| item.result.as_ref())
        .map(|result| result.total_bytes)
        .sum();

    Ok(BatchExportResult {
        format: format.as_str().into(),
        destination_parent,
        requested_count,
        exported_count,
        failed_count,
        cancelled: cancelled_batch,
        total_files,
        total_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        items,
    })
}

fn export_one_annotation(
    runtime: &BatchExportRuntime<'_>,
    selected_annotation: &EpisodeAnnotation,
    validation_status: &mut Option<String>,
) -> AppResult<ExportResult> {
    let stored_root = Path::new(&selected_annotation.episode_root);
    let root = fs::canonicalize(stored_root).map_err(|error| {
        AppError::Message(format!(
            "ANNOTATED_SOURCE_UNAVAILABLE: 无法访问 {}: {error}",
            stored_root.display()
        ))
    })?;
    if root != stored_root {
        return Err(AppError::Message(format!(
            "ANNOTATED_SOURCE_MOVED: 已标注源路径身份发生变化: {}",
            stored_root.display()
        )));
    }

    let before = source::episode_fingerprint(&root, runtime.cancelled)?;
    if before != selected_annotation.episode_fingerprint {
        return Err(AppError::Message(format!(
            "ANNOTATED_SOURCE_CHANGED: {} 的数据指纹与保存标注时不一致",
            selected_annotation.trajectory_code
        )));
    }
    let mut report = validation::validate_episode(&root, runtime.app, runtime.cancelled)?;
    let after = source::episode_fingerprint(&root, runtime.cancelled)?;
    if before != after {
        return Err(AppError::Message(format!(
            "ANNOTATED_SOURCE_CHANGED: {} 在检查过程中发生变化",
            selected_annotation.trajectory_code
        )));
    }
    validation::persist_background_report(
        &mut report,
        &after,
        runtime.reports_dir,
        runtime.cancelled,
    )?;
    *validation_status = Some(report.status.clone());
    runtime.cache.store(&root, after.clone(), report)?;
    let trusted_report = runtime.cache.report_for(&root, &after)?;
    let annotation =
        annotations::load_annotation(runtime.data_root, &root, &after)?.ok_or_else(|| {
            AppError::Message(format!(
                "ANNOTATION_NOT_FOUND: {} 的本地标注已不存在",
                selected_annotation.trajectory_code
            ))
        })?;
    if annotation != *selected_annotation {
        return Err(AppError::Message(
            "ANNOTATION_CHANGED: 本地标注在批量导出期间发生变化，请刷新后重试".into(),
        ));
    }

    export_episode(ExportJob {
        format: runtime.format,
        source_path: &root,
        destination_parent: runtime.destination_parent,
        validation_report: &trusted_report,
        annotation: Some(&annotation),
        acknowledge_warnings: runtime.acknowledge_warnings,
        requested_range: None,
        app: runtime.app,
        cancelled: runtime.cancelled,
    })
}

fn emit_batch_progress(
    app: Option<&AppHandle>,
    annotation: &EpisodeAnnotation,
    current: u64,
    total: u64,
    phase: &str,
    elapsed_ms: u128,
) {
    source::emit_progress(
        app,
        ProgressPayload {
            task: "export".into(),
            phase: format!("{phase} {current}/{total}"),
            current,
            total,
            bytes_done: 0,
            total_bytes: 0,
            current_path: annotation.episode_root.clone(),
            elapsed_ms,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{export_annotated_episodes, BatchExportJob};
    use crate::annotations;
    use crate::model::{
        BatchExportCommandRequest, ExportFormat, SaveAnnotationRequest, UserIdentity,
    };
    use crate::source;
    use crate::validation_cache::ValidationCache;
    use image::{ImageBuffer, ImageFormat, Rgb};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn continues_after_unavailable_and_invalid_annotated_sources() {
        let root = test_output("continue-after-failure");
        let data_root = root.join("app-data");
        let available_root = root.join("sources").join("available");
        let missing_root = root.join("sources").join("missing");
        let invalid_root = root.join("sources").join("invalid");
        let destination = root.join("exports");
        let reports = data_root.join("reports");
        create_episode(&available_root);
        create_episode(&missing_root);
        create_episode(&invalid_root);
        fs::remove_dir_all(invalid_root.join("cam2")).unwrap();
        fs::create_dir_all(&destination).unwrap();

        let cancelled = Arc::new(AtomicBool::new(false));
        let available_root = fs::canonicalize(available_root).unwrap();
        let missing_root = fs::canonicalize(missing_root).unwrap();
        let invalid_root = fs::canonicalize(invalid_root).unwrap();
        let available_fingerprint =
            source::episode_fingerprint(&available_root, &cancelled).unwrap();
        let missing_fingerprint = source::episode_fingerprint(&missing_root, &cancelled).unwrap();
        let invalid_fingerprint = source::episode_fingerprint(&invalid_root, &cancelled).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
        };
        let available = annotations::save_annotation(
            &data_root,
            &available_root,
            &available_fingerprint,
            &user,
            annotation_request("可用数据"),
        )
        .unwrap();
        let missing = annotations::save_annotation(
            &data_root,
            &missing_root,
            &missing_fingerprint,
            &user,
            annotation_request("已断开的数据"),
        )
        .unwrap();
        let invalid = annotations::save_annotation(
            &data_root,
            &invalid_root,
            &invalid_fingerprint,
            &user,
            annotation_request("健康检查错误的数据"),
        )
        .unwrap();
        let available_episode_id = available.episode_id.clone();
        fs::remove_dir_all(&missing_root).unwrap();

        let cache = ValidationCache::default();
        let result = export_annotated_episodes(BatchExportJob {
            request: BatchExportCommandRequest {
                episode_ids: vec![missing.episode_id, invalid.episode_id, available.episode_id],
                destination_parent: destination.display().to_string(),
                format: ExportFormat::Mcap,
                acknowledge_warnings: true,
            },
            data_root: &data_root,
            reports_dir: &reports,
            cache: &cache,
            app: None,
            cancelled: &cancelled,
        })
        .unwrap();

        assert_eq!(result.requested_count, 3);
        assert_eq!(result.exported_count, 1);
        assert_eq!(result.failed_count, 2);
        assert!(!result.cancelled);
        assert_eq!(result.items[0].status, "failed");
        assert!(result.items[0]
            .error
            .as_deref()
            .is_some_and(|message| message.contains("ANNOTATED_SOURCE_UNAVAILABLE")));
        assert_eq!(result.items[1].status, "failed");
        assert_eq!(result.items[1].validation_status.as_deref(), Some("error"));
        assert_eq!(result.items[2].status, "exported");
        let output = result.items[2]
            .result
            .as_ref()
            .map(|item| Path::new(&item.output_path))
            .unwrap();
        assert!(output.is_file());
        assert!(cache
            .report_for(&available_root, &available_fingerprint)
            .is_ok());

        let stopped = Arc::new(AtomicBool::new(true));
        let cancelled_result = export_annotated_episodes(BatchExportJob {
            request: BatchExportCommandRequest {
                episode_ids: vec![available_episode_id],
                destination_parent: destination.display().to_string(),
                format: ExportFormat::Mcap,
                acknowledge_warnings: true,
            },
            data_root: &data_root,
            reports_dir: &reports,
            cache: &cache,
            app: None,
            cancelled: &stopped,
        })
        .unwrap();
        assert!(cancelled_result.cancelled);
        assert_eq!(cancelled_result.requested_count, 1);
        assert!(cancelled_result.items.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn annotation_request(description: &str) -> SaveAnnotationRequest {
        SaveAnnotationRequest {
            source_path: String::new(),
            task_id: "close_oven".into(),
            task_description: description.into(),
        }
    }

    fn create_episode(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("states.jsonl"),
            concat!(
                "{\"frame_id\":0,\"capture_time_ns\":1000000000,",
                "\"position\":[0.0,0.0,0.0],\"velocity\":[0.0,0.0,0.0],",
                "\"quaternion\":[0.0,0.0,0.0,1.0],\"euler\":[0.0,0.0,0.0],",
                "\"omega\":[0.0,0.0,0.0],\"confidence\":1.0}\n"
            ),
        )
        .unwrap();
        let image = ImageBuffer::from_pixel(2, 2, Rgb([32_u8, 64_u8, 96_u8]));
        for stream in crate::model::STREAM_NAMES {
            let stream_root = root.join(stream);
            fs::create_dir(&stream_root).unwrap();
            image
                .save_with_format(stream_root.join("0.jpg"), ImageFormat::Jpeg)
                .unwrap();
        }
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-batch-export-{label}-{nonce}"))
    }
}
