use crate::error::{AppError, AppResult};
use crate::identity;
use crate::model::{
    AnnotatedEpisodeSummary, CreateTaskRequest, EpisodeAnnotation, SaveAnnotationRequest,
    TaskDefinition, UserIdentity,
};
use crate::storage;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ANNOTATION_FORMAT_VERSION: u32 = 3;
const RESERVATION_FORMAT_VERSION: u32 = 1;
const TASK_FORMAT_VERSION: u32 = 2;
const TASK_TEMPLATE_CONFIG_FORMAT_VERSION: u32 = 1;
const MAX_RECORD_BYTES: u64 = 256 * 1024;
const MAX_TASKS: usize = 500;
const MAX_TASK_TEMPLATE_SEGMENTS: usize = 100;
const MAX_BATCH_EPISODES: usize = 10_000;
static ANNOTATION_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrajectoryReservation {
    format_version: u32,
    trajectory_code: String,
    episode_id: String,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTaskDefinition {
    format_version: u32,
    task: TaskDefinition,
    created_by: UserIdentity,
    created_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskTemplateConfig {
    format_version: u32,
    tasks: Vec<TaskTemplate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskTemplate {
    label: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    descriptions: Vec<String>,
    #[serde(default)]
    segments: Vec<String>,
}

fn built_in_task_definitions() -> Vec<TaskDefinition> {
    vec![TaskDefinition {
        id: "close_oven".into(),
        label: "关闭烤箱".into(),
        code_prefix: "oven".into(),
        default_description: "关闭烤箱门，并确认烤箱门完全闭合。".into(),
        description_options: vec!["关闭烤箱门，并确认烤箱门完全闭合。".into()],
        default_segments: Vec::new(),
    }]
}

pub fn task_definitions(data_root: &Path) -> AppResult<Vec<TaskDefinition>> {
    let mut tasks = built_in_task_definitions();
    let directory = tasks_dir(data_root);
    if !directory.is_dir() {
        return Ok(tasks);
    }

    let mut custom = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let record: StoredTaskDefinition = read_json(&entry.path())?;
        let task = validate_stored_task(&record)?;
        if tasks
            .iter()
            .chain(custom.iter())
            .any(|existing| existing.id == task.id || existing.code_prefix == task.code_prefix)
        {
            return Err(AppError::Message(format!(
                "TASK_DEFINITION_CONFLICT: 任务 {} 的 ID 或编码前缀重复",
                task.label
            )));
        }
        custom.push(task);
        if tasks.len() + custom.len() > MAX_TASKS {
            return Err(AppError::Message(
                "TASK_LIMIT_EXCEEDED: 本地任务数量超过 500".into(),
            ));
        }
    }
    custom.sort_by(|left, right| {
        left.label
            .to_lowercase()
            .cmp(&right.label.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    tasks.extend(custom);
    Ok(tasks)
}

pub fn create_task(
    data_root: &Path,
    user: &UserIdentity,
    request: CreateTaskRequest,
) -> AppResult<TaskDefinition> {
    let _guard = annotation_mutation_guard()?;
    identity::validate_user_identity(user)?;
    let label = validate_task_label(&request.label)?;
    let code_prefix = task_code_prefix(&label)?;
    let tasks = task_definitions(data_root)?;
    if tasks.len() >= MAX_TASKS {
        return Err(AppError::Message(
            "TASK_LIMIT_EXCEEDED: 本地任务数量已达到 500".into(),
        ));
    }
    if tasks.iter().any(|task| {
        task.id == code_prefix
            || task.code_prefix == code_prefix
            || task.label.to_lowercase() == label.to_lowercase()
    }) {
        return Err(AppError::Message(format!(
            "TASK_EXISTS: 任务名称或自动编码 {code_prefix} 已存在"
        )));
    }

    let task = TaskDefinition {
        id: code_prefix.clone(),
        label: label.clone(),
        code_prefix,
        default_description: label.clone(),
        description_options: vec![label],
        default_segments: Vec::new(),
    };
    let record = StoredTaskDefinition {
        format_version: TASK_FORMAT_VERSION,
        task: task.clone(),
        created_by: user.clone(),
        created_at_ms: unix_millis(),
    };
    write_json_noreplace(&record, &task_record_path(data_root, &task.id))?;
    Ok(task)
}

pub fn ensure_assigned_tasks(
    data_root: &Path,
    user: &UserIdentity,
    assigned: &[(String, String)],
) -> AppResult<Vec<TaskDefinition>> {
    let _guard = annotation_mutation_guard()?;
    identity::validate_user_identity(user)?;
    let mut tasks = task_definitions(data_root)?;
    for (label, detail) in assigned {
        let label_matches = tasks
            .iter()
            .any(|task| task.label.eq_ignore_ascii_case(label));
        if label_matches {
            continue;
        }
        if tasks.len() >= MAX_TASKS {
            return Err(AppError::Message(
                "TASK_LIMIT_EXCEEDED: 本地任务数量已达到 500".into(),
            ));
        }
        let label = validate_task_label(label)?;
        let description = validate_description(detail)?;
        let code_prefix = task_code_prefix(&label)?;
        if tasks
            .iter()
            .any(|task| task.id == code_prefix || task.code_prefix == code_prefix)
        {
            // A server assignment may use a storage/task-directory name whose
            // generated prefix is already occupied by a built-in task (for
            // example `oven` and built-in `close_oven`). Reuse the existing
            // definition; the assignment endpoint remains the source of the
            // operator's task name and episode selection.
            continue;
        }
        let task = TaskDefinition {
            id: code_prefix.clone(),
            label,
            code_prefix,
            default_description: description.clone(),
            description_options: vec![description],
            default_segments: Vec::new(),
        };
        let record = StoredTaskDefinition {
            format_version: TASK_FORMAT_VERSION,
            task: task.clone(),
            created_by: user.clone(),
            created_at_ms: unix_millis(),
        };
        write_json_noreplace(&record, &task_record_path(data_root, &task.id))?;
        tasks.push(task);
    }
    Ok(tasks)
}

pub fn import_task_template_config(
    data_root: &Path,
    user: &UserIdentity,
    source_path: &Path,
) -> AppResult<Vec<TaskDefinition>> {
    let _guard = annotation_mutation_guard()?;
    identity::validate_user_identity(user)?;
    let config = read_task_template_config(source_path)?;
    if config.format_version != TASK_TEMPLATE_CONFIG_FORMAT_VERSION
        || config.tasks.is_empty()
        || config.tasks.len() > MAX_TASKS
    {
        return Err(AppError::Message(
            "TASK_TEMPLATE_CONFIG_INVALID: 任务模板配置格式无效".into(),
        ));
    }

    let existing = task_definitions(data_root)?;
    if existing.len() + config.tasks.len() > MAX_TASKS {
        return Err(AppError::Message(
            "TASK_LIMIT_EXCEEDED: 导入后本地任务数量将超过 500".into(),
        ));
    }

    let mut imported = Vec::with_capacity(config.tasks.len());
    let mut ids = BTreeSet::new();
    let mut prefixes = BTreeSet::new();
    for template in config.tasks {
        let task = task_from_template(template)?;
        if !ids.insert(task.id.clone())
            || !prefixes.insert(task.code_prefix.clone())
            || existing
                .iter()
                .any(|current| current.id == task.id || current.code_prefix == task.code_prefix)
        {
            return Err(AppError::Message(format!(
                "TASK_EXISTS: 任务名称或自动编码 {} 已存在",
                task.code_prefix
            )));
        }
        imported.push(task);
    }

    let directory = tasks_dir(data_root);
    fs::create_dir_all(&directory)?;
    let created_at_ms = unix_millis();
    let mut created = Vec::with_capacity(imported.len());
    for task in &imported {
        let record = StoredTaskDefinition {
            format_version: TASK_FORMAT_VERSION,
            task: task.clone(),
            created_by: user.clone(),
            created_at_ms,
        };
        let output = task_record_path(data_root, &task.id);
        if let Err(error) = write_json_noreplace(&record, &output) {
            for path in created {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        created.push(output);
    }
    task_definitions(data_root)
}

pub fn delete_task(data_root: &Path, user: &UserIdentity, task_id: &str) -> AppResult<()> {
    let _guard = annotation_mutation_guard()?;
    identity::validate_user_identity(user)?;
    let task = task_definition(data_root, task_id)?;
    if built_in_task_definitions()
        .iter()
        .any(|builtin| builtin.id == task.id)
    {
        return Err(AppError::Message("TASK_BUILT_IN: 内置任务不能删除".into()));
    }
    if task_has_annotation_reference(data_root, &task.id)? {
        return Err(AppError::Message(format!(
            "TASK_IN_USE: 任务 {} 已被标注引用，不能删除",
            task.label
        )));
    }
    let path = task_record_path(data_root, &task.id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| AppError::Message(format!("TASK_NOT_FOUND: 任务文件不可用: {error}")))?;
    if !metadata.file_type().is_file() {
        return Err(AppError::Message(
            "TASK_RECORD_INVALID: 任务文件不是普通文件".into(),
        ));
    }
    fs::remove_file(path)?;
    Ok(())
}

pub fn suggest_trajectory_code(data_root: &Path, task_id: &str) -> AppResult<String> {
    let task = task_definition(data_root, task_id)?;
    let reservations_dir = reservations_dir(data_root);
    let mut maximum = 0_u64;
    if reservations_dir.is_dir() {
        for entry in fs::read_dir(&reservations_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if let Some(number) = trajectory_number(stem, &task.code_prefix) {
                maximum = maximum.max(number);
            }
        }
    }
    let next = maximum
        .checked_add(1)
        .ok_or_else(|| AppError::Message("轨迹编号已耗尽".into()))?;
    Ok(format!("{}-{next:03}", task.code_prefix))
}

pub fn load_annotation(
    data_root: &Path,
    episode_root: &Path,
    fingerprint: &str,
) -> AppResult<Option<EpisodeAnnotation>> {
    validate_fingerprint(fingerprint)?;
    let episode_id = episode_id(episode_root, fingerprint);
    let directory = annotations_dir(data_root).join(&episode_id);
    if !directory.is_dir() {
        return Ok(None);
    }

    load_latest_annotation(
        data_root,
        &directory,
        &episode_id,
        episode_root,
        fingerprint,
    )
}

pub fn list_annotations(data_root: &Path) -> AppResult<Vec<AnnotatedEpisodeSummary>> {
    let directory = annotations_dir(data_root);
    if !directory.is_dir() {
        return Ok(Vec::new());
    }

    let mut annotations = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let episode_id = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                AppError::Message("ANNOTATION_RECORD_INVALID: 标注目录名称无效".into())
            })?;
        validate_episode_id(&episode_id)?;
        let annotation =
            load_latest_annotation_from_identity(data_root, &entry.path(), &episode_id)?
                .ok_or_else(|| {
                    AppError::Message(format!(
                        "ANNOTATION_RECORD_INVALID: 标注 {episode_id} 没有可用修订"
                    ))
                })?;
        let source_available = fs::symlink_metadata(Path::new(&annotation.episode_root))
            .is_ok_and(|metadata| metadata.file_type().is_dir());
        annotations.push(AnnotatedEpisodeSummary {
            annotation,
            source_available,
        });
    }
    annotations.sort_by(|left, right| {
        right
            .annotation
            .updated_at_ms
            .cmp(&left.annotation.updated_at_ms)
            .then_with(|| {
                left.annotation
                    .trajectory_code
                    .cmp(&right.annotation.trajectory_code)
            })
    });
    Ok(annotations)
}

pub fn annotations_by_ids(
    data_root: &Path,
    episode_ids: &[String],
) -> AppResult<Vec<EpisodeAnnotation>> {
    if episode_ids.is_empty() {
        return Err(AppError::Message(
            "BATCH_EXPORT_EMPTY: 请至少选择一条已标注数据".into(),
        ));
    }
    if episode_ids.len() > MAX_BATCH_EPISODES {
        return Err(AppError::Message(format!(
            "BATCH_EXPORT_LIMIT_EXCEEDED: 单次最多导出 {MAX_BATCH_EPISODES} 条数据"
        )));
    }

    let mut unique = BTreeSet::new();
    for episode_id in episode_ids {
        validate_episode_id(episode_id)?;
        if !unique.insert(episode_id.as_str()) {
            return Err(AppError::Message(format!(
                "BATCH_EXPORT_DUPLICATE: episode {episode_id} 被重复选择"
            )));
        }
    }

    let mut available = list_annotations(data_root)?
        .into_iter()
        .map(|item| (item.annotation.episode_id.clone(), item.annotation))
        .collect::<HashMap<_, _>>();
    episode_ids
        .iter()
        .map(|episode_id| {
            available.remove(episode_id).ok_or_else(|| {
                AppError::Message(format!("ANNOTATION_NOT_FOUND: 找不到本地标注 {episode_id}"))
            })
        })
        .collect()
}

fn load_latest_annotation_from_identity(
    data_root: &Path,
    directory: &Path,
    stored_episode_id: &str,
) -> AppResult<Option<EpisodeAnnotation>> {
    let mut identity: Option<(PathBuf, String)> = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let record: EpisodeAnnotation = read_json(&entry.path())?;
        let candidate = (
            PathBuf::from(&record.episode_root),
            record.episode_fingerprint.clone(),
        );
        if identity
            .as_ref()
            .is_some_and(|current| current != &candidate)
        {
            return Err(AppError::Message(format!(
                "ANNOTATION_IDENTITY_CONFLICT: 标注 {stored_episode_id} 的源身份冲突"
            )));
        }
        identity = Some(candidate);
    }
    let Some((episode_root, fingerprint)) = identity else {
        return Ok(None);
    };
    validate_fingerprint(&fingerprint)?;
    if episode_id(&episode_root, &fingerprint) != stored_episode_id {
        return Err(AppError::Message(format!(
            "ANNOTATION_IDENTITY_MISMATCH: 标注 {stored_episode_id} 的目录身份与源路径/指纹不一致"
        )));
    }
    load_latest_annotation(
        data_root,
        directory,
        stored_episode_id,
        &episode_root,
        &fingerprint,
    )
}

fn load_latest_annotation(
    data_root: &Path,
    directory: &Path,
    episode_id: &str,
    episode_root: &Path,
    fingerprint: &str,
) -> AppResult<Option<EpisodeAnnotation>> {
    let mut latest: Option<EpisodeAnnotation> = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let record: EpisodeAnnotation = read_json(&path)?;
        validate_stored_annotation(data_root, &record, episode_id, episode_root, fingerprint)?;
        if latest
            .as_ref()
            .is_some_and(|current| current.revision == record.revision && current != &record)
        {
            return Err(AppError::Message(
                "ANNOTATION_REVISION_CONFLICT: 标注修订冲突".into(),
            ));
        }
        if latest
            .as_ref()
            .is_none_or(|current| record.revision > current.revision)
        {
            latest = Some(record);
        }
    }
    Ok(latest)
}

#[cfg(test)]
pub fn save_annotation(
    data_root: &Path,
    episode_root: &Path,
    fingerprint: &str,
    user: &UserIdentity,
    request: SaveAnnotationRequest,
) -> AppResult<EpisodeAnnotation> {
    let _guard = annotation_mutation_guard()?;
    save_annotation_locked(data_root, episode_root, fingerprint, user, request)
}

fn save_annotation_locked(
    data_root: &Path,
    episode_root: &Path,
    fingerprint: &str,
    user: &UserIdentity,
    request: SaveAnnotationRequest,
) -> AppResult<EpisodeAnnotation> {
    validate_fingerprint(fingerprint)?;
    identity::validate_user_identity(user)?;
    let task = task_definition(data_root, &request.task_id)?;
    let task_description = validate_description(&request.task_description)?;
    validate_segments(
        request.clip_start_frame,
        request.clip_end_frame,
        &request.segments,
    )?;
    let id = episode_id(episode_root, fingerprint);
    let existing = load_annotation(data_root, episode_root, fingerprint)?;
    let trajectory_code =
        if let Some(record) = existing.as_ref().filter(|record| record.task_id == task.id) {
            let code = validate_trajectory_code(&record.trajectory_code, &task.code_prefix)?;
            reserve_existing_trajectory(data_root, &code, &id)?;
            code
        } else {
            reserve_next_trajectory(data_root, &task, &id)?
        };
    let now = unix_millis();
    let revision = existing
        .as_ref()
        .map(|record| record.revision)
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| AppError::Message("标注修订号已耗尽".into()))?;
    let edit_started_at_ms = validate_edit_started_at(request.edit_started_at_ms, now)?;
    let annotation = EpisodeAnnotation {
        format_version: ANNOTATION_FORMAT_VERSION,
        episode_id: id.clone(),
        episode_root: episode_root.display().to_string(),
        episode_fingerprint: fingerprint.into(),
        trajectory_code,
        task_id: task.id,
        task_description,
        processed_by: user.clone(),
        revision,
        created_at_ms: existing
            .as_ref()
            .map(|record| record.created_at_ms)
            .unwrap_or(now),
        updated_at_ms: now,
        edit_started_at_ms,
        edit_duration_ms: now.saturating_sub(edit_started_at_ms),
        clip_start_frame: request.clip_start_frame,
        clip_end_frame: request.clip_end_frame,
        segments: request.segments,
    };

    let directory = annotations_dir(data_root).join(id);
    fs::create_dir_all(&directory)?;
    let output = directory.join(format!("revision-{revision:08}.json"));
    if output.exists() {
        return Err(AppError::Message(
            "ANNOTATION_REVISION_CONFLICT: 标注已被其他进程更新，请重新载入".into(),
        ));
    }
    if let Err(error) = write_json_noreplace(&annotation, &output) {
        if output.exists() {
            return Err(AppError::Message(
                "ANNOTATION_REVISION_CONFLICT: 标注已被其他进程更新，请重新载入".into(),
            ));
        }
        return Err(error);
    }
    Ok(annotation)
}

pub fn save_annotation_with_source_description(
    data_root: &Path,
    episode_root: &Path,
    fingerprint: &str,
    user: &UserIdentity,
    request: SaveAnnotationRequest,
) -> AppResult<EpisodeAnnotation> {
    let _guard = annotation_mutation_guard()?;
    validate_fingerprint(fingerprint)?;
    identity::validate_user_identity(user)?;
    task_definition(data_root, &request.task_id)?;
    let description = validate_description(&request.task_description)?;
    validate_segments(
        request.clip_start_frame,
        request.clip_end_frame,
        &request.segments,
    )?;
    crate::episode_metadata::write_description_with_segments(
        episode_root,
        &description,
        request.clip_start_frame,
        request.clip_end_frame,
        &request.segments,
    )?;
    save_annotation_locked(data_root, episode_root, fingerprint, user, request).map_err(|error| {
        AppError::Message(format!(
            "LOCAL_ANNOTATION_SAVE_FAILED_SOURCE_DESCRIPTION_SAVED: description.json 已写入，但本机标注修订保存失败: {error}"
        ))
    })
}

fn task_has_annotation_reference(data_root: &Path, task_id: &str) -> AppResult<bool> {
    let directory = annotations_dir(data_root);
    if !directory.is_dir() {
        return Ok(false);
    }
    for episode in fs::read_dir(directory)? {
        let episode = episode?;
        if !episode.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(episode.path())? {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let annotation: EpisodeAnnotation = read_json(&entry.path())?;
            if annotation.task_id == task_id {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn annotation_mutation_guard() -> AppResult<MutexGuard<'static, ()>> {
    ANNOTATION_MUTATION_LOCK
        .lock()
        .map_err(|_| AppError::Message("ANNOTATION_LOCK_POISONED: 本地标注写锁不可用".into()))
}

fn validate_edit_started_at(value: u64, now: u64) -> AppResult<u64> {
    const MAX_EDIT_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
    const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
    if value == 0 || value > now.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(AppError::Message(
            "ANNOTATION_EDIT_TIME_INVALID: 标注修改开始时间无效".into(),
        ));
    }
    if now.saturating_sub(value) > MAX_EDIT_DURATION_MS {
        return Err(AppError::Message(
            "ANNOTATION_EDIT_TIME_INVALID: 单次标注修改不能超过 24 小时".into(),
        ));
    }
    Ok(value)
}

fn task_definition(data_root: &Path, task_id: &str) -> AppResult<TaskDefinition> {
    task_definitions(data_root)?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| AppError::Message(format!("UNKNOWN_TASK: 不支持的任务 {task_id}")))
}

fn validate_task_label(value: &str) -> AppResult<String> {
    if value.chars().any(char::is_control) {
        return Err(AppError::Message(
            "INVALID_TASK_NAME: 任务名称不能包含控制字符".into(),
        ));
    }
    let label = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(1..=64).contains(&label.chars().count()) {
        return Err(AppError::Message(
            "INVALID_TASK_NAME: 任务名称需为 1-64 个字符".into(),
        ));
    }
    Ok(label)
}

fn task_code_prefix(label: &str) -> AppResult<String> {
    let mut prefix = String::new();
    let mut separator_pending = false;
    for character in label.chars() {
        if character.is_alphanumeric() {
            if separator_pending && !prefix.is_empty() {
                prefix.push('-');
            }
            prefix.extend(character.to_lowercase());
            separator_pending = false;
        } else {
            separator_pending = true;
        }
    }
    let prefix = prefix
        .chars()
        .take(48)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if prefix.is_empty() {
        return Err(AppError::Message(
            "INVALID_TASK_NAME: 任务名称必须包含文字或数字".into(),
        ));
    }
    Ok(prefix)
}

fn validate_description(value: &str) -> AppResult<String> {
    let description = value.trim();
    let count = description.chars().count();
    if !(1..=500).contains(&count)
        || description
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AppError::Message(
            "任务描述需为 1-500 个不含控制字符的文本".into(),
        ));
    }
    Ok(description.into())
}

fn read_task_template_config(path: &Path) -> AppResult<TaskTemplateConfig> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_RECORD_BYTES {
        return Err(AppError::Message(
            "TASK_TEMPLATE_CONFIG_INVALID: 任务模板配置文件无效".into(),
        ));
    }
    Ok(serde_json::from_reader(File::open(path)?)?)
}

fn task_from_template(template: TaskTemplate) -> AppResult<TaskDefinition> {
    let label = validate_task_label(&template.label)?;
    let code_prefix = task_code_prefix(&label)?;
    let mut description_options = Vec::new();
    if let Some(description) = template.description {
        append_description_option(&mut description_options, description)?;
    }
    for description in template.descriptions {
        append_description_option(&mut description_options, description)?;
    }
    let Some(default_description) = description_options.first().cloned() else {
        return Err(AppError::Message(
            "TASK_TEMPLATE_DESCRIPTION_REQUIRED: 每个任务模板至少需要一个 description 或 descriptions 条目".into(),
        ));
    };
    let default_segments = normalize_default_segments(template.segments)?;
    Ok(TaskDefinition {
        id: code_prefix.clone(),
        label,
        code_prefix,
        default_description,
        description_options,
        default_segments,
    })
}

fn normalize_task_definition(task: TaskDefinition) -> AppResult<TaskDefinition> {
    let label = validate_task_label(&task.label)?;
    let code_prefix = task_code_prefix(&label)?;
    if task.id != code_prefix || task.code_prefix != code_prefix {
        return Err(AppError::Message(
            "TASK_RECORD_INVALID: 本地任务记录无效".into(),
        ));
    }
    let default_description = validate_description(&task.default_description)?;
    let mut description_options = Vec::new();
    append_description_option(&mut description_options, default_description.clone())?;
    for description in task.description_options {
        append_description_option(&mut description_options, description)?;
    }
    let default_segments = normalize_default_segments(task.default_segments)?;
    Ok(TaskDefinition {
        id: code_prefix.clone(),
        label,
        code_prefix,
        default_description,
        description_options,
        default_segments,
    })
}

fn append_description_option(options: &mut Vec<String>, value: String) -> AppResult<()> {
    let description = validate_description(&value)?;
    if !options.iter().any(|current| current == &description) {
        options.push(description);
    }
    Ok(())
}

fn normalize_default_segments(segments: Vec<String>) -> AppResult<Vec<String>> {
    if segments.len() > MAX_TASK_TEMPLATE_SEGMENTS {
        return Err(AppError::Message(format!(
            "TASK_TEMPLATE_SEGMENT_LIMIT: 默认片段不能超过 {MAX_TASK_TEMPLATE_SEGMENTS} 个"
        )));
    }
    let mut normalized = Vec::with_capacity(segments.len());
    for segment in segments {
        let label = validate_description(&segment)?;
        if label.chars().count() > 100 || label.contains('\n') || label.contains('\r') {
            return Err(AppError::Message(
                "TASK_TEMPLATE_SEGMENT_INVALID: 默认片段名称需为 1-100 个单行字符".into(),
            ));
        }
        normalized.push(label);
    }
    Ok(normalized)
}

fn validate_stored_task(record: &StoredTaskDefinition) -> AppResult<TaskDefinition> {
    identity::validate_user_identity(&record.created_by)?;
    if !matches!(record.format_version, 1 | TASK_FORMAT_VERSION) || record.created_at_ms == 0 {
        return Err(AppError::Message(
            "TASK_RECORD_INVALID: 本地任务记录无效".into(),
        ));
    }
    let task = normalize_task_definition(record.task.clone())?;
    if record.format_version == 1
        && (record.task.default_description != task.label
            || !record.task.description_options.is_empty()
            || !record.task.default_segments.is_empty())
    {
        return Err(AppError::Message(
            "TASK_RECORD_INVALID: 本地任务记录无效".into(),
        ));
    }
    Ok(task)
}

fn validate_trajectory_code(value: &str, prefix: &str) -> AppResult<String> {
    let code = value.trim().to_ascii_lowercase();
    let Some(number) = trajectory_number(&code, prefix) else {
        return Err(AppError::Message(format!(
            "INVALID_TRAJECTORY_CODE: 轨迹编码必须使用 {prefix}-001 格式"
        )));
    };
    if number == 0 {
        return Err(AppError::Message(
            "INVALID_TRAJECTORY_CODE: 轨迹序号必须从 001 开始".into(),
        ));
    }
    if code != format!("{prefix}-{number:03}") {
        return Err(AppError::Message(format!(
            "INVALID_TRAJECTORY_CODE: 轨迹编码必须使用 {prefix}-{number:03}"
        )));
    }
    Ok(code)
}

fn trajectory_number(value: &str, prefix: &str) -> Option<u64> {
    let suffix = value.strip_prefix(prefix)?.strip_prefix('-')?;
    if suffix.len() < 3 || !suffix.bytes().all(|value| value.is_ascii_digit()) {
        return None;
    }
    suffix.parse().ok()
}

fn reserve_existing_trajectory(
    data_root: &Path,
    trajectory_code: &str,
    episode_id: &str,
) -> AppResult<()> {
    let directory = reservations_dir(data_root);
    fs::create_dir_all(&directory)?;
    let output = directory.join(format!("{trajectory_code}.json"));
    if output.exists() {
        let existing: TrajectoryReservation = read_json(&output)?;
        if existing.format_version != RESERVATION_FORMAT_VERSION
            || existing.trajectory_code != trajectory_code
            || existing.episode_id != episode_id
        {
            return Err(AppError::Message(format!(
                "TRAJECTORY_CODE_EXISTS: 轨迹编码 {trajectory_code} 已被其他数据使用"
            )));
        }
        return Ok(());
    }
    let reservation = TrajectoryReservation {
        format_version: RESERVATION_FORMAT_VERSION,
        trajectory_code: trajectory_code.into(),
        episode_id: episode_id.into(),
        created_at_ms: unix_millis(),
    };
    match write_json_noreplace(&reservation, &output) {
        Ok(()) => Ok(()),
        Err(_) if output.exists() => {
            let existing: TrajectoryReservation = read_json(&output)?;
            if existing.episode_id == episode_id && existing.trajectory_code == trajectory_code {
                Ok(())
            } else {
                Err(AppError::Message(format!(
                    "TRAJECTORY_CODE_EXISTS: 轨迹编码 {trajectory_code} 已被其他数据使用"
                )))
            }
        }
        Err(error) => Err(error),
    }
}

fn reserve_next_trajectory(
    data_root: &Path,
    task: &TaskDefinition,
    episode_id: &str,
) -> AppResult<String> {
    let directory = reservations_dir(data_root);
    fs::create_dir_all(&directory)?;
    let mut maximum = 0_u64;
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(number) = trajectory_number(stem, &task.code_prefix) else {
            continue;
        };
        let reservation: TrajectoryReservation = read_json(&path)?;
        if reservation.format_version != RESERVATION_FORMAT_VERSION
            || reservation.trajectory_code != stem
            || reservation.created_at_ms == 0
        {
            return Err(AppError::Message(format!(
                "TRAJECTORY_RESERVATION_INVALID: 轨迹占号记录 {stem} 无效"
            )));
        }
        if reservation.episode_id == episode_id {
            return Ok(stem.to_string());
        }
        maximum = maximum.max(number);
    }

    let mut number = maximum
        .checked_add(1)
        .ok_or_else(|| AppError::Message("轨迹编号已耗尽".into()))?;
    loop {
        let trajectory_code = format!("{}-{number:03}", task.code_prefix);
        let output = directory.join(format!("{trajectory_code}.json"));
        let reservation = TrajectoryReservation {
            format_version: RESERVATION_FORMAT_VERSION,
            trajectory_code: trajectory_code.clone(),
            episode_id: episode_id.into(),
            created_at_ms: unix_millis(),
        };
        match write_json_noreplace(&reservation, &output) {
            Ok(()) => return Ok(trajectory_code),
            Err(_) if output.exists() => {
                let existing: TrajectoryReservation = read_json(&output)?;
                if existing.format_version == RESERVATION_FORMAT_VERSION
                    && existing.trajectory_code == trajectory_code
                    && existing.episode_id == episode_id
                {
                    return Ok(trajectory_code);
                }
                number = number
                    .checked_add(1)
                    .ok_or_else(|| AppError::Message("轨迹编号已耗尽".into()))?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn validate_stored_annotation(
    data_root: &Path,
    annotation: &EpisodeAnnotation,
    episode_id: &str,
    episode_root: &Path,
    fingerprint: &str,
) -> AppResult<()> {
    let task = task_definition(data_root, &annotation.task_id)?;
    identity::validate_user_identity(&annotation.processed_by)?;
    if !(1..=ANNOTATION_FORMAT_VERSION).contains(&annotation.format_version)
        || annotation.episode_id != episode_id
        || annotation.episode_root != episode_root.display().to_string()
        || annotation.episode_fingerprint != fingerprint
        || annotation.revision == 0
        || validate_trajectory_code(&annotation.trajectory_code, &task.code_prefix)?
            != annotation.trajectory_code
        || validate_description(&annotation.task_description)? != annotation.task_description
        || (annotation.format_version >= 2
            && (annotation.edit_started_at_ms == 0
                || annotation.edit_started_at_ms > annotation.updated_at_ms
                || annotation.edit_duration_ms
                    != annotation
                        .updated_at_ms
                        .saturating_sub(annotation.edit_started_at_ms)))
    {
        return Err(AppError::Message("标注记录格式无效".into()));
    }
    validate_segments(
        annotation.clip_start_frame,
        annotation.clip_end_frame,
        &annotation.segments,
    )?;
    Ok(())
}

fn validate_segments(
    clip_start_frame: Option<u64>,
    clip_end_frame: Option<u64>,
    segments: &[crate::model::SegmentAnnotation],
) -> AppResult<()> {
    let (Some(clip_start), Some(clip_end)) = (clip_start_frame, clip_end_frame) else {
        return if clip_start_frame.is_none() && clip_end_frame.is_none() && segments.is_empty() {
            Ok(())
        } else {
            Err(AppError::Message("片段保存范围不完整".into()))
        };
    };
    if clip_start > clip_end || segments.is_empty() || segments.len() > 10_000 {
        return Err(AppError::Message("片段保存范围无效".into()));
    }
    for (index, segment) in segments.iter().enumerate() {
        if segment.start_frame > segment.end_frame
            || segment.title.trim().is_empty()
            || segment.title.chars().count() > 100
            || segment.note.chars().count() > 500
        {
            return Err(AppError::Message("片段标注格式无效".into()));
        }
        if index == 0 && segment.start_frame != clip_start {
            return Err(AppError::Message("片段没有覆盖保留范围起点".into()));
        }
        if let Some(previous) = index.checked_sub(1).and_then(|value| segments.get(value)) {
            if previous.end_frame.checked_add(1) != Some(segment.start_frame) {
                return Err(AppError::Message("片段之间存在重叠或空隙".into()));
            }
        }
    }
    if segments
        .last()
        .is_none_or(|segment| segment.end_frame != clip_end)
    {
        return Err(AppError::Message("片段没有覆盖保留范围终点".into()));
    }
    Ok(())
}

fn validate_fingerprint(fingerprint: &str) -> AppResult<()> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(AppError::Message("数据指纹格式无效".into()));
    }
    Ok(())
}

fn validate_episode_id(episode_id: &str) -> AppResult<()> {
    if episode_id.len() != 64 || !episode_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(AppError::Message(
            "ANNOTATION_ID_INVALID: 本地标注 episode ID 无效".into(),
        ));
    }
    Ok(())
}

fn episode_id(episode_root: &Path, fingerprint: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(episode_root.as_os_str().to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(fingerprint.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn annotations_dir(data_root: &Path) -> PathBuf {
    data_root.join("annotations")
}

fn tasks_dir(data_root: &Path) -> PathBuf {
    data_root.join("tasks")
}

fn task_record_path(data_root: &Path, task_id: &str) -> PathBuf {
    let mut hasher = blake3::Hasher::new();
    hasher.update(task_id.as_bytes());
    let digest = hasher.finalize().to_hex().to_string();
    tasks_dir(data_root).join(format!("{}.json", &digest[..24]))
}

fn reservations_dir(data_root: &Path) -> PathBuf {
    data_root.join("trajectory-codes")
}

fn write_json_noreplace<T>(value: &T, output: &Path) -> AppResult<()>
where
    T: Serialize + DeserializeOwned + PartialEq,
{
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("本地记录路径缺少父目录".into()))?;
    fs::create_dir_all(parent)?;
    let partial = parent.join(format!(
        ".{}.partial-{}-{}",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("annotation.json"),
        unix_nanos(),
        std::process::id()
    ));
    let result = (|| -> AppResult<()> {
        let mut file = open_private_new(&partial)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let decoded: T = read_json(&partial)?;
        if &decoded != value {
            return Err(AppError::Message("本地记录回读验证失败".into()));
        }
        storage::publish_noreplace(&partial, output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_RECORD_BYTES {
        return Err(AppError::Message("本地记录文件无效".into()));
    }
    Ok(serde_json::from_reader(File::open(path)?)?)
}

fn open_private_new(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        annotations_by_ids, create_task, delete_task, ensure_assigned_tasks,
        import_task_template_config, list_annotations, load_annotation, save_annotation,
        save_annotation_with_source_description, suggest_trajectory_code, task_definitions,
        ANNOTATION_FORMAT_VERSION,
    };
    use crate::model::{CreateTaskRequest, SaveAnnotationRequest, UserIdentity};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    const FINGERPRINT_ONE: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";
    const FINGERPRINT_TWO: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn assigned_task_reuses_builtin_when_code_prefix_is_occupied() {
        let root = test_output("assigned-task-prefix-collision");
        fs::create_dir_all(&root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: Some("operator".into()),
        };

        let tasks =
            ensure_assigned_tasks(&root, &user, &[("oven".into(), "关闭烤箱门".into())]).unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "close_oven");
        assert_eq!(tasks[0].code_prefix, "oven");
        assert!(!root.join("tasks").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assigns_unique_codes_and_keeps_annotation_history() {
        let root = test_output("annotation");
        fs::create_dir_all(&root).unwrap();
        let episode_one = Path::new("/local/episode-one");
        let episode_two = Path::new("/local/episode-two");
        let alice = UserIdentity {
            username: "alice".into(),
            display_name: "Alice".into(),
            role: None,
        };
        let bob = UserIdentity {
            username: "bob".into(),
            display_name: "Bob".into(),
            role: None,
        };
        assert_eq!(task_definitions(&root).unwrap()[0].id, "close_oven");
        assert_eq!(
            suggest_trajectory_code(&root, "close_oven").unwrap(),
            "oven-001"
        );

        let first = save_annotation(
            &root,
            episode_one,
            FINGERPRINT_ONE,
            &alice,
            request("close_oven", "关闭烤箱门"),
        )
        .unwrap();
        assert_eq!(first.format_version, ANNOTATION_FORMAT_VERSION);
        assert_eq!(first.trajectory_code, "oven-001");
        assert_eq!(first.revision, 1);
        assert_eq!(first.processed_by.username, "alice");
        assert_eq!(
            suggest_trajectory_code(&root, "close_oven").unwrap(),
            "oven-002"
        );

        let second = save_annotation(
            &root,
            episode_one,
            FINGERPRINT_ONE,
            &bob,
            request("close_oven", "关闭烤箱门并确认完全闭合"),
        )
        .unwrap();
        assert_eq!(second.trajectory_code, "oven-001");
        assert_eq!(second.revision, 2);
        assert_eq!(second.created_at_ms, first.created_at_ms);
        assert_eq!(second.processed_by.username, "bob");
        assert_eq!(
            load_annotation(&root, episode_one, FINGERPRINT_ONE)
                .unwrap()
                .unwrap(),
            second
        );

        let other = save_annotation(
            &root,
            episode_two,
            FINGERPRINT_TWO,
            &alice,
            request("close_oven", "另一条轨迹"),
        )
        .unwrap();
        assert_eq!(other.trajectory_code, "oven-002");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_local_tasks_and_uses_task_name_for_automatic_codes() {
        let root = test_output("custom-task");
        fs::create_dir_all(&root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        let task = create_task(
            &root,
            &user,
            CreateTaskRequest {
                label: "  整理餐具  ".into(),
            },
        )
        .unwrap();
        assert_eq!(task.id, "整理餐具");
        assert_eq!(task.code_prefix, "整理餐具");
        assert_eq!(task.default_description, "整理餐具");
        assert_eq!(task_definitions(&root).unwrap().len(), 2);
        assert_eq!(
            suggest_trajectory_code(&root, &task.id).unwrap(),
            "整理餐具-001"
        );

        let annotation = save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request(&task.id, "整理左侧餐具"),
        )
        .unwrap();
        assert_eq!(annotation.trajectory_code, "整理餐具-001");
        let switched = save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request("close_oven", "关闭烤箱门"),
        )
        .unwrap();
        assert_eq!(switched.trajectory_code, "oven-001");
        let restored = save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request(&task.id, "整理右侧餐具"),
        )
        .unwrap();
        assert_eq!(restored.trajectory_code, "整理餐具-001");
        assert_eq!(restored.revision, 3);
        assert!(create_task(
            &root,
            &user,
            CreateTaskRequest {
                label: "整理餐具".into(),
            },
        )
        .is_err());
        assert!(create_task(
            &root,
            &user,
            CreateTaskRequest {
                label: "---".into(),
            },
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_task_templates_with_selectable_descriptions_and_segments() {
        let root = test_output("task-template-config");
        fs::create_dir_all(&root).unwrap();
        let config = root.join("tray-template.json");
        fs::write(
            &config,
            r#"{
  "formatVersion": 1,
  "tasks": [{
    "label": "操作烤盘",
    "description": "将烤盘放到烤箱中",
    "descriptions": ["将烤盘从烤箱中取出"],
    "segments": ["打开烤箱", "拿起烤盘", "将烤盘放到烤箱中", "合上烤箱"]
  }]
}"#,
        )
        .unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };

        let tasks = import_task_template_config(&root, &user, &config).unwrap();
        let task = tasks.iter().find(|task| task.id == "操作烤盘").unwrap();
        assert_eq!(task.default_description, "将烤盘放到烤箱中");
        assert_eq!(
            task.description_options,
            ["将烤盘放到烤箱中", "将烤盘从烤箱中取出"]
        );
        assert_eq!(
            task.default_segments,
            ["打开烤箱", "拿起烤盘", "将烤盘放到烤箱中", "合上烤箱"]
        );
        assert_eq!(task_definitions(&root).unwrap(), tasks);
        assert!(import_task_template_config(&root, &user, &config).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletes_unused_custom_tasks_but_preserves_referenced_tasks() {
        let root = test_output("delete-task");
        fs::create_dir_all(&root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        let task = create_task(
            &root,
            &user,
            CreateTaskRequest {
                label: "整理餐具".into(),
            },
        )
        .unwrap();
        delete_task(&root, &user, &task.id).unwrap();
        assert_eq!(task_definitions(&root).unwrap().len(), 1);

        let task = create_task(
            &root,
            &user,
            CreateTaskRequest {
                label: "整理餐具".into(),
            },
        )
        .unwrap();
        save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request(&task.id, "整理餐具"),
        )
        .unwrap();
        save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request("close_oven", "关闭烤箱门"),
        )
        .unwrap();
        let error = delete_task(&root, &user, &task.id).unwrap_err().to_string();
        assert!(error.starts_with("TASK_IN_USE:"));
        assert!(delete_task(&root, &user, "close_oven").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saves_description_metadata_without_changing_capture_fingerprint() {
        let root = test_output("episode-metadata");
        let episode = root.join("episode");
        fs::create_dir_all(&episode).unwrap();
        fs::write(episode.join("states.jsonl"), b"state\n").unwrap();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let fingerprint = crate::source::episode_fingerprint(&episode, &cancelled).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        let mut request = request("close_oven", "关闭烤箱门");
        request.clip_start_frame = Some(0);
        request.clip_end_frame = Some(9);
        request.segments = vec![crate::model::SegmentAnnotation {
            start_frame: 0,
            end_frame: 9,
            title: "片段 1".into(),
            note: "完整动作".into(),
        }];
        let saved =
            save_annotation_with_source_description(&root, &episode, &fingerprint, &user, request)
                .unwrap();
        assert_eq!(saved.segments[0].note, "完整动作");
        let description: serde_json::Value =
            serde_json::from_slice(&fs::read(episode.join("description.json")).unwrap()).unwrap();
        assert_eq!(description["formatVersion"], 2);
        assert_eq!(description["description"], "关闭烤箱门");
        assert_eq!(description["clipStartFrame"], 0);
        assert_eq!(description["clipEndFrame"], 9);
        assert_eq!(description["segments"][0]["startFrame"], 0);
        assert_eq!(description["segments"][0]["endFrame"], 9);
        assert_eq!(description["segments"][0]["title"], "片段 1");
        assert_eq!(description["segments"][0]["note"], "完整动作");
        assert_eq!(
            crate::source::episode_fingerprint(&episode, &cancelled).unwrap(),
            fingerprint
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_annotation_before_writing_source_description() {
        let root = test_output("invalid-source-description");
        let episode = root.join("episode");
        fs::create_dir_all(&episode).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };

        assert!(save_annotation_with_source_description(
            &root,
            &episode,
            FINGERPRINT_ONE,
            &user,
            request("unknown", "不应写入"),
        )
        .is_err());
        assert!(!episode.join("description.json").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_description_failure_does_not_create_local_revision() {
        let root = test_output("source-description-target");
        let episode = root.join("episode");
        fs::create_dir_all(episode.join("description.json")).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };

        let error = save_annotation_with_source_description(
            &root,
            &episode,
            FINGERPRINT_ONE,
            &user,
            request("close_oven", "不应只保存到本机"),
        )
        .unwrap_err()
        .to_string();

        assert!(error.starts_with("SOURCE_DESCRIPTION_WRITE_FAILED:"));
        assert!(!root.join("annotations").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_latest_annotations_and_preserves_requested_batch_order() {
        let root = test_output("annotation-list");
        let first_root = root.join("episodes").join("first");
        let second_root = root.join("episodes").join("second");
        fs::create_dir_all(&first_root).unwrap();
        fs::create_dir_all(&second_root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        let first = save_annotation(
            &root,
            &first_root,
            FINGERPRINT_ONE,
            &user,
            request("close_oven", "第一条初始描述"),
        )
        .unwrap();
        let first_latest = save_annotation(
            &root,
            &first_root,
            FINGERPRINT_ONE,
            &user,
            request("close_oven", "第一条最新描述"),
        )
        .unwrap();
        let second = save_annotation(
            &root,
            &second_root,
            FINGERPRINT_TWO,
            &user,
            request("close_oven", "第二条描述"),
        )
        .unwrap();
        fs::remove_dir_all(&second_root).unwrap();

        let listed = list_annotations(&root).unwrap();
        assert_eq!(listed.len(), 2);
        let first_item = listed
            .iter()
            .find(|item| item.annotation.episode_id == first.episode_id)
            .unwrap();
        assert_eq!(first_item.annotation, first_latest);
        assert!(first_item.source_available);
        let second_item = listed
            .iter()
            .find(|item| item.annotation.episode_id == second.episode_id)
            .unwrap();
        assert!(!second_item.source_available);

        let selected = annotations_by_ids(
            &root,
            &[second.episode_id.clone(), first.episode_id.clone()],
        )
        .unwrap();
        assert_eq!(selected[0].episode_id, second.episode_id);
        assert_eq!(selected[1].episode_id, first.episode_id);
        assert!(
            annotations_by_ids(&root, &[first.episode_id.clone(), first.episode_id.clone()])
                .is_err()
        );

        let forged_id = if first.episode_id == "f".repeat(64) {
            "e".repeat(64)
        } else {
            "f".repeat(64)
        };
        let forged_directory = root.join("annotations").join(&forged_id);
        fs::create_dir(&forged_directory).unwrap();
        let mut forged = first_latest;
        forged.episode_id = forged_id;
        fs::write(
            forged_directory.join("revision-00000001.json"),
            serde_json::to_vec_pretty(&forged).unwrap(),
        )
        .unwrap();
        assert!(list_annotations(&root)
            .unwrap_err()
            .to_string()
            .contains("ANNOTATION_IDENTITY_MISMATCH"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_tasks_and_invalid_annotation_input() {
        let root = test_output("invalid-annotation");
        fs::create_dir_all(&root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        assert!(save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request("unknown", "关闭烤箱门"),
        )
        .is_err());
        let invalid_user = UserIdentity {
            username: "../operator".into(),
            display_name: "Operator".into(),
            role: None,
        };
        assert!(save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &invalid_user,
            request("close_oven", "关闭烤箱门"),
        )
        .is_err());
        assert!(save_annotation(
            &root,
            Path::new("/episode"),
            FINGERPRINT_ONE,
            &user,
            request("close_oven", ""),
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn request(task_id: &str, description: &str) -> SaveAnnotationRequest {
        SaveAnnotationRequest {
            source_path: "/episode".into(),
            task_id: task_id.into(),
            task_description: description.into(),
            edit_started_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            clip_start_frame: None,
            clip_end_frame: None,
            segments: Vec::new(),
        }
    }

    fn test_output(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-annotations-{name}-{nonce}"))
    }
}
