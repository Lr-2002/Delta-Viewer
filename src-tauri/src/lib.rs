#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod annotations;
mod error;
mod export;
mod identity;
mod importer;
mod model;
mod operation_history;
mod skeleton;
mod source;
mod storage;
pub mod stress;
mod updater;
mod user_center;
mod validation;
mod validation_cache;
mod workspace_mode;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use identity::AuthState;
use model::{
    AnnotatedEpisodeSummary, AppUpdateInfo, AuthStatus, BatchExportCommandRequest,
    BatchExportResult, CreateTaskRequest, EpisodeAnnotation, EpisodeData, ExportCommandRequest,
    ExportResult, FramePayload, ImportPreflight, ImportResult, LoginRequest, OperationErrorRecord,
    PartialImport, ProgressPayload, RecordOperationErrorRequest, ReportExportResult,
    SaveAnnotationRequest, ScanResult, TaskDefinition, UserCenterStatus, UserIdentity,
    ValidationReport, WorkspaceMode,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use validation_cache::ValidationCache;

#[derive(Clone)]
pub struct TaskControl {
    active: Arc<Mutex<Option<ActiveTask>>>,
}

struct ActiveTask {
    operation_id: u64,
    cancelled: Arc<AtomicBool>,
}

impl Default for TaskControl {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
        }
    }
}

impl TaskControl {
    fn start(&self, operation_id: u64) -> Result<TaskGuard, String> {
        if operation_id == 0 {
            return Err("操作标识无效".to_string());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "任务控制状态不可用，请重试".to_string())?;
        if active.is_some() {
            return Err("已有任务正在运行，请先等待或取消当前任务".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveTask {
            operation_id,
            cancelled: cancelled.clone(),
        });
        Ok(TaskGuard {
            active: self.active.clone(),
            operation_id,
            cancelled,
        })
    }

    fn cancel(&self, operation_id: u64) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        let Some(active) = active.as_ref() else {
            return false;
        };
        if active.operation_id != operation_id {
            return false;
        }
        active.cancelled.store(true, Ordering::Release);
        true
    }
}

struct TaskGuard {
    active: Arc<Mutex<Option<ActiveTask>>>,
    operation_id: u64,
    cancelled: Arc<AtomicBool>,
}

impl TaskGuard {
    fn cancelled(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    #[cfg(test)]
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if active.as_ref().is_some_and(|current| {
            current.operation_id == self.operation_id
                && Arc::ptr_eq(&current.cancelled, &self.cancelled)
        }) {
            *active = None;
        }
    }
}

fn emit_task_start(app: &AppHandle, operation_id: u64, task: &str, phase: &str, path: &str) {
    source::emit_progress_for_operation(
        Some(app),
        operation_id,
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
async fn check_for_app_update(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<AppUpdateInfo, String> {
    auth.require_managed_user()
        .map_err(|error| error.to_string())?;
    updater::check(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn install_app_update(
    app: AppHandle,
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    operation_id: u64,
) -> Result<bool, String> {
    auth.require_managed_user()
        .map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(
        &app,
        operation_id,
        "update",
        "检查应用更新",
        "http://39.155.172.162:17879/latest.json",
    );
    let _progress = source::enter_operation_progress(operation_id);
    let installed = updater::download_and_install(&app, operation_id, &cancelled)
        .await
        .map_err(|error| error.to_string())?;
    drop(task);
    if installed {
        app.restart();
    }
    Ok(false)
}

#[tauri::command]
async fn get_auth_status(app: AppHandle, auth: State<'_, AuthState>) -> Result<AuthStatus, String> {
    let data_root = app_data_root(&app)?;
    workspace_mode::restore(&data_root, auth.inner()).map_err(|error| error.to_string())?;
    user_center::auth_status(&data_root, auth.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn select_workspace_mode(
    app: AppHandle,
    auth: State<'_, AuthState>,
    mode: WorkspaceMode,
) -> Result<AuthStatus, String> {
    let data_root = app_data_root(&app)?;
    workspace_mode::select(&data_root, auth.inner(), Some(mode))
        .map_err(|error| error.to_string())?;
    user_center::auth_status(&data_root, auth.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn clear_workspace_mode(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<AuthStatus, String> {
    let data_root = app_data_root(&app)?;
    workspace_mode::select(&data_root, auth.inner(), None).map_err(|error| error.to_string())?;
    user_center::auth_status(&data_root, auth.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn configure_user_center(
    app: AppHandle,
    auth: State<'_, AuthState>,
    config_path: String,
) -> Result<UserCenterStatus, String> {
    auth.require_managed_mode()
        .map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    user_center::configure(&data_root, Path::new(&config_path))
        .await
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
    user_center::login(&data_root, &auth, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn logout_account(auth: State<'_, AuthState>) -> Result<(), String> {
    identity::logout_account(auth.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_task_definitions(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<Vec<TaskDefinition>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || annotations::task_definitions(&data_root))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn create_task_definition(
    app: AppHandle,
    auth: State<'_, AuthState>,
    request: CreateTaskRequest,
) -> Result<TaskDefinition, String> {
    let user = auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        annotations::create_task(&data_root, &user, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
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
async fn list_annotated_episodes(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<Vec<AnnotatedEpisodeSummary>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || annotations::list_annotations(&data_root))
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
    operation_id: u64,
) -> Result<ScanResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(&app, operation_id, "scan", "准备扫描", &path);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
    operation_id: u64,
) -> Result<EpisodeData, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(&app, operation_id, "scan", "准备加载记录", &path);
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
    operation_id: u64,
) -> Result<ValidationReport, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    let cache = cache.inner().clone();
    let reports_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用报告目录: {error}"))?
        .join("reports");
    emit_task_start(&app, operation_id, "validate", "准备数据检查", &path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ValidationReport> {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
    operation_id: u64,
) -> Result<ImportResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(
        &app,
        operation_id,
        "import",
        "导入预检",
        &destination_parent,
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
async fn prepare_import_workspace(
    app: AppHandle,
    auth: State<'_, AuthState>,
    source_path: String,
) -> Result<String, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::managed_import_root(&data_root, Path::new(&source_path))
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn record_operation_error(
    app: AppHandle,
    auth: State<'_, AuthState>,
    request: RecordOperationErrorRequest,
) -> Result<OperationErrorRecord, String> {
    let user = auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        operation_history::record_error(&data_root, user, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_operation_errors(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<Vec<OperationErrorRecord>, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let data_root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || operation_history::list_errors(&data_root))
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
    operation_id: u64,
) -> Result<ImportPreflight, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(
        &app,
        operation_id,
        "import",
        "检查导入目标",
        &destination_parent,
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
    app: AppHandle,
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    destination_parent: String,
    partial_path: String,
    operation_id: u64,
) -> Result<(), String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    emit_task_start(
        &app,
        operation_id,
        "import",
        "清理未完成导入",
        &partial_path,
    );
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<()> {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
        if cancelled.load(Ordering::Acquire) {
            return Err(error::AppError::Cancelled);
        }
        storage::cleanup_partial_import(Path::new(&destination_parent), Path::new(&partial_path))?;
        if cancelled.load(Ordering::Acquire) {
            return Err(error::AppError::Cancelled);
        }
        Ok(())
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
    operation_id: u64,
) -> Result<ExportResult, String> {
    let exported_by = auth.require_user().map_err(|error| error.to_string())?;
    let ExportCommandRequest {
        source_path,
        destination_parent,
        format,
        acknowledge_warnings,
        range,
    } = request;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    let cache = cache.inner().clone();
    let data_root = app_data_root(&app)?;
    emit_task_start(&app, operation_id, "export", "准备导出", &source_path);
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ExportResult> {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
            exported_by: &exported_by,
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
async fn export_annotated_episodes(
    app: AppHandle,
    auth: State<'_, AuthState>,
    control: State<'_, TaskControl>,
    cache: State<'_, ValidationCache>,
    request: BatchExportCommandRequest,
    operation_id: u64,
) -> Result<BatchExportResult, String> {
    let user = auth.require_user().map_err(|error| error.to_string())?;
    let destination_parent = request.destination_parent.clone();
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    let cache = cache.inner().clone();
    let data_root = app_data_root(&app)?;
    let reports_dir = data_root.join("reports");
    emit_task_start(
        &app,
        operation_id,
        "export",
        "准备批量导出",
        &destination_parent,
    );
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<BatchExportResult> {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
        export::export_annotated_episodes(export::BatchExportJob {
            request,
            data_root: &data_root,
            reports_dir: &reports_dir,
            cache: &cache,
            processed_by: user,
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
    operation_id: u64,
) -> Result<ReportExportResult, String> {
    auth.require_user().map_err(|error| error.to_string())?;
    let task = control.start(operation_id)?;
    let cancelled = task.cancelled();
    let cache = cache.inner().clone();
    emit_task_start(
        &app,
        operation_id,
        "export",
        "准备导出检查报告",
        &source_path,
    );
    tauri::async_runtime::spawn_blocking(move || -> error::AppResult<ReportExportResult> {
        let _task = task;
        let _progress = source::enter_operation_progress(operation_id);
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
fn cancel_task(control: State<'_, TaskControl>, operation_id: u64) -> bool {
    control.cancel(operation_id)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AuthState::default())
        .manage(TaskControl::default())
        .manage(ValidationCache::default())
        .invoke_handler(tauri::generate_handler![
            get_auth_status,
            select_workspace_mode,
            clear_workspace_mode,
            check_for_app_update,
            install_app_update,
            configure_user_center,
            login_account,
            logout_account,
            list_task_definitions,
            create_task_definition,
            suggest_trajectory_code,
            load_episode_annotation,
            save_episode_annotation,
            list_annotated_episodes,
            scan_source,
            load_episode,
            validate_episode,
            prepare_import_workspace,
            inspect_import_destination,
            import_episode,
            list_partial_imports,
            cleanup_partial_import,
            record_operation_error,
            list_operation_errors,
            export_episode,
            export_annotated_episodes,
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
        let first = control.start(1).unwrap();
        assert!(control.start(2).is_err());
        drop(first);
        assert!(control.start(2).is_ok());
    }

    #[test]
    fn delayed_cancellation_cannot_target_a_new_operation() {
        let control = TaskControl::default();
        let first = control.start(101).unwrap();

        assert!(!control.cancel(202));
        assert!(!first.is_cancelled());
        assert!(control.cancel(101));
        assert!(first.is_cancelled());

        drop(first);
        let second = control.start(202).unwrap();
        assert!(!control.cancel(101));
        assert!(!second.is_cancelled());
    }
}
