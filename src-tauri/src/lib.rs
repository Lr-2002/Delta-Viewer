#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod export;
mod importer;
mod model;
mod source;
mod storage;
mod validation;
mod validation_cache;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use model::{
    EpisodeData, ExportFormat, ExportResult, FramePayload, ImportPreflight, ImportResult,
    PartialImport, ProgressPayload, ReportExportResult, ScanResult, ValidationReport,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, State};
use validation_cache::ValidationCache;

#[derive(Clone)]
pub struct TaskControl {
    cancelled: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
}

impl Default for TaskControl {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            active: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl TaskControl {
    fn start(&self) -> Result<TaskGuard, String> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有任务正在运行，请先等待或取消当前任务".to_string())?;
        self.cancelled.store(false, Ordering::Release);
        Ok(TaskGuard {
            active: self.active.clone(),
        })
    }
}

struct TaskGuard {
    active: Arc<AtomicBool>,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

fn emit_task_start(app: &AppHandle, task: &str, phase: &str, path: &str) {
    source::emit_progress(
        Some(app),
        ProgressPayload {
            task: task.into(),
            phase: phase.into(),
            current: 0,
            total: 1,
            bytes_done: 0,
            total_bytes: 0,
            current_path: path.into(),
            elapsed_ms: 0,
        },
    );
}

#[tauri::command]
async fn scan_source(
    app: AppHandle,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<ScanResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    emit_task_start(&app, "scan", "准备扫描", &path);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        source::scan_source(Path::new(&path), Some(&app), &cancelled)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn load_episode(
    app: AppHandle,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<EpisodeData, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    emit_task_start(&app, "scan", "准备加载记录", &path);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        source::load_episode(Path::new(&path), Some(&app), &cancelled)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn validate_episode(
    app: AppHandle,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    path: String,
) -> Result<ValidationReport, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    let cache = cache.inner().clone();
    emit_task_start(&app, "validate", "准备数据检查", &path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ValidationReport> {
        let _task = task;
        let root = Path::new(&path);
        let before = source::episode_fingerprint(root, &cancelled)?;
        let report = validation::validate_episode(root, Some(&app), &cancelled)?;
        let after = source::episode_fingerprint(root, &cancelled)?;
        if before != after {
            return Err(error::AppError::Message(
                "数据在检查过程中发生变化，请重新检查".into(),
            ));
        }
        cache.store(root, after, report.clone())?;
        Ok(report)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_episode(
    app: AppHandle,
    control: State<'_, TaskControl>,
    source_path: String,
    destination_parent: String,
) -> Result<ImportResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    emit_task_start(&app, "import", "导入预检", &destination_parent);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        importer::import_episode(
            Path::new(&source_path),
            Path::new(&destination_parent),
            Some(&app),
            &cancelled,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_import_destination(
    app: AppHandle,
    control: State<'_, TaskControl>,
    source_path: String,
    destination_parent: String,
) -> Result<ImportPreflight, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    emit_task_start(&app, "import", "检查导入目标", &destination_parent);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        storage::inspect_import(
            Path::new(&source_path),
            Path::new(&destination_parent),
            &cancelled,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cleanup_partial_import(
    control: State<'_, TaskControl>,
    destination_parent: String,
    partial_path: String,
) -> Result<(), String> {
    let task = control.start()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        storage::cleanup_partial_import(Path::new(&destination_parent), Path::new(&partial_path))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
#[tauri::command]
async fn list_partial_imports(destination_parent: String) -> Result<Vec<PartialImport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::list_partial_imports(Path::new(&destination_parent))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn export_episode(
    app: AppHandle,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    source_path: String,
    destination_parent: String,
    format: ExportFormat,
    acknowledge_warnings: bool,
) -> Result<ExportResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    let cache = cache.inner().clone();
    emit_task_start(&app, "export", "准备导出", &source_path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ExportResult> {
        let _task = task;
        let root = Path::new(&source_path);
        let fingerprint = source::episode_fingerprint(root, &cancelled)?;
        let report = cache.report_for(root, &fingerprint)?;
        export::export_episode(
            format,
            root,
            Path::new(&destination_parent),
            &report,
            acknowledge_warnings,
            Some(&app),
            &cancelled,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn export_validation_report(
    app: AppHandle,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    source_path: String,
    destination_parent: String,
) -> Result<ReportExportResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    let cache = cache.inner().clone();
    emit_task_start(&app, "export", "准备导出检查报告", &source_path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ReportExportResult> {
        let _task = task;
        let root = Path::new(&source_path);
        let fingerprint = source::episode_fingerprint(root, &cancelled)?;
        let report = cache.report_for(root, &fingerprint)?;
        validation::export_report(
            &report,
            root,
            Path::new(&destination_parent),
            Some(&app),
            &cancelled,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_task(control: State<'_, TaskControl>) {
    control.cancelled.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn read_frame(root: String, stream: String, frame_id: u64) -> Result<FramePayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mime_type, bytes) = source::read_frame(Path::new(&root), &stream, frame_id)?;
        Ok::<FramePayload, error::AppError>(FramePayload {
            mime_type,
            data: BASE64.encode(bytes),
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(TaskControl::default())
        .manage(ValidationCache::default())
        .invoke_handler(tauri::generate_handler![
            scan_source,
            load_episode,
            validate_episode,
            inspect_import_destination,
            import_episode,
            list_partial_imports,
            cleanup_partial_import,
            export_episode,
            export_validation_report,
            cancel_task,
            read_frame
        ])
        .run(tauri::generate_context!())
        .expect("error while running DOHC Viewer");
}

#[cfg(test)]
mod tests {
    use super::TaskControl;

    #[test]
    fn allows_only_one_long_task() {
        let control = TaskControl::default();
        let first = control.start().unwrap();
        assert!(control.start().is_err());
        drop(first);
        assert!(control.start().is_ok());
    }
}
