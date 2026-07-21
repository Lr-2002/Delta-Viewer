#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod annotations;
mod error;
mod export;
mod identity;
mod importer;
mod model;
mod source;
mod storage;
pub mod stress;
mod validation;
mod validation_cache;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use identity::AuthState;
use model::{
    AuthStatus, EpisodeAnnotation, EpisodeData, ExportCommandRequest, ExportResult, FramePayload,
    ImportPreflight, ImportResult, LoginRequest, PartialImport, ProgressPayload,
    RegisterAccountRequest, ReportExportResult, SaveAnnotationRequest, ScanResult, TaskDefinition,
    UserIdentity, ValidationReport,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
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

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用本地数据目录: {error}"))
}

#[tauri::command]
async fn get_auth_status(app: AppHandle, auth: State<'_, AuthState>) -> Result<AuthStatus, String> {
    let data_root = app_data_root(&app)?;
    let auth = auth.inner().clone();
    tauri::async_runtime::spawn_blocking(move || identity::auth_status(&data_root, &auth))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn register_account(
    app: AppHandle,
    auth: State<'_, AuthState>,
    request: RegisterAccountRequest,
) -> Result<UserIdentity, String> {
    let data_root = app_data_root(&app)?;
    let auth = auth.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        identity::register_account(&data_root, &auth, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn login_account(
    app: AppHandle,
    auth: State<'_, AuthState>,
    request: LoginRequest,
) -> Result<UserIdentity, String> {
    let data_root = app_data_root(&app)?;
    let auth = auth.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        identity::login_account(&data_root, &auth, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn logout_account(auth: State<'_, AuthState>) -> Result<(), String> {
    identity::logout_account(auth.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_task_definitions(auth: State<'_, AuthState>) -> Result<Vec<TaskDefinition>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    Ok(annotations::task_definitions())
}

#[tauri::command]
async fn suggest_trajectory_code(
    app: AppHandle,
    auth: State<'_, AuthState>,
    task_id: String,
) -> Result<String, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        annotations::suggest_trajectory_code(&data_root, &task_id)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn load_episode_annotation(
    app: AppHandle,
    auth: State<'_, AuthState>,
    source_path: String,
) -> Result<Option<EpisodeAnnotation>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<Option<EpisodeAnnotation>> {
        let root = std::fs::canonicalize(Path::new(&source_path))?;
        let fingerprint = source::episode_fingerprint(&root, &AtomicBool::new(false))?;
        annotations::load_annotation(&data_root, &root, &fingerprint)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_episode_annotation(
    app: AppHandle,
    auth: State<'_, AuthState>,
    request: SaveAnnotationRequest,
) -> Result<EpisodeAnnotation, String> {
    let user = auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<EpisodeAnnotation> {
        let root = std::fs::canonicalize(Path::new(&request.source_path))?;
        let fingerprint = source::episode_fingerprint(&root, &AtomicBool::new(false))?;
        annotations::save_annotation(&data_root, &root, &fingerprint, &user, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn scan_source(
    app: AppHandle,
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<ScanResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    path: String,
) -> Result<EpisodeData, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    path: String,
) -> Result<ValidationReport, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    let cache = cache.inner().clone();
    let reports_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用报告目录: {error}"))?
        .join("reports");
    emit_task_start(&app, "validate", "准备数据检查", &path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ValidationReport> {
        let _task = task;
        let root = Path::new(&path);
        let before = source::episode_fingerprint(root, &cancelled)?;
        let mut report = validation::validate_episode(root, Some(&app), &cancelled)?;
        let after = source::episode_fingerprint(root, &cancelled)?;
        if before != after {
            return Err(error::AppError::Message(
                "数据在检查过程中发生变化，请重新检查".into(),
            ));
        }
        validation::persist_background_report(&mut report, &after, &reports_dir, &cancelled)?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    source_path: String,
    destination_parent: String,
) -> Result<ImportResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    source_path: String,
    destination_parent: String,
) -> Result<ImportPreflight, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    destination_parent: String,
    partial_path: String,
) -> Result<(), String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
async fn list_partial_imports(
    auth: State<'_, AuthState>,
    destination_parent: String,
) -> Result<Vec<PartialImport>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    request: ExportCommandRequest,
) -> Result<ExportResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let ExportCommandRequest {
        source_path,
        destination_parent,
        format,
        acknowledge_warnings,
        range,
    } = request;
    let task = control.start()?;
    let cancelled = control.cancelled.clone();
    let cache = cache.inner().clone();
    let data_root = app_data_root(&app)?;
    emit_task_start(&app, "export", "准备导出", &source_path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ExportResult> {
        let _task = task;
        let root = Path::new(&source_path);
        let fingerprint = source::episode_fingerprint(root, &cancelled)?;
        let report = cache.report_for(root, &fingerprint)?;
        let canonical_root = std::fs::canonicalize(root)?;
        let annotation = annotations::load_annotation(&data_root, &canonical_root, &fingerprint)?;
        export::export_episode(export::ExportJob {
            format,
            source_path: root,
            destination_parent: Path::new(&destination_parent),
            validation_report: &report,
            annotation: annotation.as_ref(),
            acknowledge_warnings,
            requested_range: range,
            app: Some(&app),
            cancelled: &cancelled,
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn export_validation_report(
    app: AppHandle,
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    source_path: String,
    destination_parent: String,
) -> Result<ReportExportResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
async fn read_frame(
    auth: State<'_, AuthState>,
    root: String,
    stream: String,
    frame_id: u64,
) -> Result<FramePayload, String> {
    auth.require_user().map_err(|error| error.to_string())?;
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
        .manage(AuthState::default())
        .manage(TaskControl::default())
        .manage(ValidationCache::default())
        .invoke_handler(tauri::generate_handler![
            get_auth_status,
            register_account,
            login_account,
            logout_account,
            list_task_definitions,
            suggest_trajectory_code,
            load_episode_annotation,
            save_episode_annotation,
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
