#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod export;
mod importer;
mod model;
mod source;
mod validation;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use model::{
    EpisodeData, ExportFormat, ExportResult, FramePayload, ImportResult, ScanResult,
    ValidationReport,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Clone)]
pub struct TaskControl {
    cancelled: Arc<AtomicBool>,
}

impl Default for TaskControl {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
async fn scan_source(
    app: AppHandle,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<ScanResult, String> {
    control.cancelled.store(false, Ordering::Relaxed);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    control.cancelled.store(false, Ordering::Relaxed);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    control.cancelled.store(false, Ordering::Relaxed);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    control.cancelled.store(false, Ordering::Relaxed);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
async fn export_episode(
    app: AppHandle,
    control: State<'_, TaskControl>,
    source_path: String,
    destination_parent: String,
    format: ExportFormat,
) -> Result<ExportResult, String> {
    control.cancelled.store(false, Ordering::Relaxed);
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export::export_episode(
            format,
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
            import_episode,
            export_episode,
            cancel_task,
            read_frame
        ])
        .run(tauri::generate_context!())
        .expect("error while running DOHC Viewer");
}
