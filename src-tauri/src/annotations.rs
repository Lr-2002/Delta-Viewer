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
use std::time::{SystemTime, UNIX_EPOCH};

pub const ANNOTATION_FORMAT_VERSION: u32 = 2;
const RESERVATION_FORMAT_VERSION: u32 = 1;
const TASK_FORMAT_VERSION: u32 = 1;
const MAX_RECORD_BYTES: u64 = 256 * 1024;
const MAX_TASKS: usize = 500;
const MAX_BATCH_EPISODES: usize = 10_000;

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

fn built_in_task_definitions() -> Vec<TaskDefinition> {
    vec![TaskDefinition {
        id: "close_oven".into(),
        label: "关闭烤箱".into(),
        code_prefix: "oven".into(),
        default_description: "关闭烤箱门，并确认烤箱门完全闭合。".into(),
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
        validate_stored_task(&record)?;
        if tasks
            .iter()
            .chain(custom.iter())
            .any(|task| task.id == record.task.id || task.code_prefix == record.task.code_prefix)
        {
            return Err(AppError::Message(format!(
                "TASK_DEFINITION_CONFLICT: 任务 {} 的 ID 或编码前缀重复",
                record.task.label
            )));
        }
        custom.push(record.task);
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
        default_description: label,
    };
    let record = StoredTaskDefinition {
        format_version: TASK_FORMAT_VERSION,
        task: task.clone(),
        created_by: user.clone(),
        created_at_ms: unix_millis(),
    };
    let directory = tasks_dir(data_root);
    fs::create_dir_all(&directory)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(task.id.as_bytes());
    let digest = hasher.finalize().to_hex().to_string();
    write_json_noreplace(&record, &directory.join(format!("{}.json", &digest[..24])))?;
    Ok(task)
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

pub fn save_annotation(
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

fn validate_stored_task(record: &StoredTaskDefinition) -> AppResult<()> {
    identity::validate_user_identity(&record.created_by)?;
    let label = validate_task_label(&record.task.label)?;
    let prefix = task_code_prefix(&label)?;
    if record.format_version != TASK_FORMAT_VERSION
        || record.created_at_ms == 0
        || record.task.label != label
        || record.task.id != prefix
        || record.task.code_prefix != prefix
        || record.task.default_description != label
    {
        return Err(AppError::Message(
            "TASK_RECORD_INVALID: 本地任务记录无效".into(),
        ));
    }
    Ok(())
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
        annotations_by_ids, create_task, list_annotations, load_annotation, save_annotation,
        suggest_trajectory_code, task_definitions, ANNOTATION_FORMAT_VERSION,
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
    fn assigns_unique_codes_and_keeps_annotation_history() {
        let root = test_output("annotation");
        fs::create_dir_all(&root).unwrap();
        let episode_one = Path::new("/local/episode-one");
        let episode_two = Path::new("/local/episode-two");
        let alice = UserIdentity {
            username: "alice".into(),
            display_name: "Alice".into(),
        };
        let bob = UserIdentity {
            username: "bob".into(),
            display_name: "Bob".into(),
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
    fn lists_latest_annotations_and_preserves_requested_batch_order() {
        let root = test_output("annotation-list");
        let first_root = root.join("episodes").join("first");
        let second_root = root.join("episodes").join("second");
        fs::create_dir_all(&first_root).unwrap();
        fs::create_dir_all(&second_root).unwrap();
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
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
