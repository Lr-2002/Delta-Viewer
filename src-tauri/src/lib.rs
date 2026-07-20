#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod export;
mod importer;
mod model;
mod source;
mod storage;
mod validation;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use model::{
    EpisodeData, ExportFormat, ExportResult, FramePayload, ImportPreflight, ImportResult,
    PartialImport, ProgressPayload, ScanResult, ValidationReport,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, State};

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

#[tauri::command]
async fn scan_source(
    app: AppHandle,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<ScanResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
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
    path: String,
) -> Result<ValidationReport, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        validation::validate_episode(Path::new(&path), Some(&app), &cancelled)
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
    source::emit_progress(
        Some(&app),
        ProgressPayload {
            task: "import".into(),
            phase: "导入预检".into(),
            current: 0,
            total: 1,
            bytes_done: 0,
            total_bytes: 0,
            current_path: destination_parent.clone(),
            elapsed_ms: 0,
        },
    );
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
    source::emit_progress(
        Some(&app),
        ProgressPayload {
            task: "import".into(),
            phase: "检查导入目标".into(),
            current: 0,
            total: 1,
            bytes_done: 0,
            total_bytes: 0,
            current_path: destination_parent.clone(),
            elapsed_ms: 0,
        },
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        storage::inspect_import(Path::new(&source_path), Path::new(&destination_parent))
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
    source_path: String,
    destination_parent: String,
    format: ExportFormat,
    acknowledge_warnings: bool,
) -> Result<ExportResult, String> {
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        export::export_episode(
            format,
            Path::new(&source_path),
            Path::new(&destination_parent),
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
        .manage(TaskControl::default())
        .invoke_handler(tauri::generate_handler![
            scan_source,
            load_episode,
            validate_episode,
            inspect_import_destination,
            import_episode,
            list_partial_imports,
            cleanup_partial_import,
            export_episode,
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
