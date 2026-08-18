use crate::error::{AppError, AppResult};
use crate::model::{
    EpisodeAnnotation, SupervisionAnnotationCatalog, SupervisionAnnotationEntry,
    SupervisionAnnotationTaskSummary, SupervisionAnnotationUserSummary, SupervisionTaskCatalog,
    SupervisionTaskSummary,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_ANNOTATION_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ANNOTATION_IMPORT_RECORDS: usize = 20_000;
const MAX_ANNOTATION_SEGMENTS: usize = 2_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationCatalogDocument {
    annotations: Vec<EpisodeAnnotation>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AnnotationImport {
    Catalog(AnnotationCatalogDocument),
    List(Vec<EpisodeAnnotation>),
    Single(Box<EpisodeAnnotation>),
}

struct AnnotationUserAccumulator {
    display_name: String,
    trajectory_count: u64,
    segment_count: u64,
    annotated_frame_count: u64,
    tasks: BTreeMap<String, AnnotationTaskAccumulator>,
    entries: Vec<SupervisionAnnotationEntry>,
}

struct AnnotationTaskAccumulator {
    trajectory_count: u64,
    segment_count: u64,
    annotated_frame_count: u64,
}

pub fn import_annotation_catalog(path: &Path) -> AppResult<SupervisionAnnotationCatalog> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_ANNOTATION_IMPORT_BYTES
    {
        return Err(AppError::Message(
            "SUPERVISION_ANNOTATION_JSON_INVALID: 标注 JSON 必须是小于 8 MiB 的普通文件".into(),
        ));
    }
    let source_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            AppError::Message("SUPERVISION_ANNOTATION_JSON_INVALID: 标注 JSON 文件名无效".into())
        })?
        .to_string();
    let imported: AnnotationImport =
        serde_json::from_reader(File::open(path)?).map_err(|error| {
            AppError::Message(format!("SUPERVISION_ANNOTATION_JSON_INVALID: {error}"))
        })?;
    let annotations = match imported {
        AnnotationImport::Catalog(document) => document.annotations,
        AnnotationImport::List(entries) => entries,
        AnnotationImport::Single(entry) => vec![*entry],
    };
    if annotations.is_empty() || annotations.len() > MAX_ANNOTATION_IMPORT_RECORDS {
        return Err(AppError::Message(
            "SUPERVISION_ANNOTATION_JSON_INVALID: 标注数量必须是 1-20000 条".into(),
        ));
    }

    // A file may carry revision history. Supervision counts the authoritative latest revision
    // for each episode so old revisions cannot inflate a person's workload totals.
    let mut latest = BTreeMap::<String, EpisodeAnnotation>::new();
    for annotation in annotations {
        validate_imported_annotation(&annotation)?;
        let replace = latest.get(&annotation.episode_id).is_none_or(|current| {
            (
                annotation.revision,
                annotation.updated_at_ms,
                &annotation.trajectory_code,
            ) > (
                current.revision,
                current.updated_at_ms,
                &current.trajectory_code,
            )
        });
        if replace {
            latest.insert(annotation.episode_id.clone(), annotation);
        }
    }

    let mut users = BTreeMap::<String, AnnotationUserAccumulator>::new();
    for annotation in latest.into_values() {
        let (segment_count, annotated_frame_count) = annotation_frame_totals(&annotation)?;
        let username = annotation.processed_by.username.clone();
        let user = users
            .entry(username.clone())
            .or_insert_with(|| AnnotationUserAccumulator {
                display_name: annotation.processed_by.display_name.clone(),
                trajectory_count: 0,
                segment_count: 0,
                annotated_frame_count: 0,
                tasks: BTreeMap::new(),
                entries: Vec::new(),
            });
        user.trajectory_count = user.trajectory_count.saturating_add(1);
        user.segment_count = user.segment_count.saturating_add(segment_count);
        user.annotated_frame_count = user
            .annotated_frame_count
            .saturating_add(annotated_frame_count);
        let task =
            user.tasks
                .entry(annotation.task_id.clone())
                .or_insert(AnnotationTaskAccumulator {
                    trajectory_count: 0,
                    segment_count: 0,
                    annotated_frame_count: 0,
                });
        task.trajectory_count = task.trajectory_count.saturating_add(1);
        task.segment_count = task.segment_count.saturating_add(segment_count);
        task.annotated_frame_count = task
            .annotated_frame_count
            .saturating_add(annotated_frame_count);
        user.entries.push(SupervisionAnnotationEntry {
            task_id: annotation.task_id,
            trajectory_code: annotation.trajectory_code,
            revision: annotation.revision,
            segment_count,
            annotated_frame_count,
            updated_at_ms: annotation.updated_at_ms,
        });
    }

    Ok(SupervisionAnnotationCatalog {
        source_name,
        users: users
            .into_iter()
            .map(|(username, mut user)| {
                user.entries.sort_by(|left, right| {
                    (&left.task_id, &left.trajectory_code)
                        .cmp(&(&right.task_id, &right.trajectory_code))
                });
                SupervisionAnnotationUserSummary {
                    username,
                    display_name: user.display_name,
                    trajectory_count: user.trajectory_count,
                    segment_count: user.segment_count,
                    annotated_frame_count: user.annotated_frame_count,
                    tasks: user
                        .tasks
                        .into_iter()
                        .map(|(task_id, task)| SupervisionAnnotationTaskSummary {
                            task_id,
                            trajectory_count: task.trajectory_count,
                            segment_count: task.segment_count,
                            annotated_frame_count: task.annotated_frame_count,
                        })
                        .collect(),
                    entries: user.entries,
                }
            })
            .collect(),
    })
}

fn validate_imported_annotation(annotation: &EpisodeAnnotation) -> AppResult<()> {
    for (field, value) in [
        ("episodeId", &annotation.episode_id),
        ("trajectoryCode", &annotation.trajectory_code),
        ("taskId", &annotation.task_id),
        ("processedBy.username", &annotation.processed_by.username),
        (
            "processedBy.displayName",
            &annotation.processed_by.display_name,
        ),
    ] {
        if value.trim().is_empty() || value.len() > 160 {
            return Err(AppError::Message(format!(
                "SUPERVISION_ANNOTATION_JSON_INVALID: {field} 无效"
            )));
        }
    }
    if annotation.revision == 0 || annotation.segments.len() > MAX_ANNOTATION_SEGMENTS {
        return Err(AppError::Message(
            "SUPERVISION_ANNOTATION_JSON_INVALID: 标注修订或片段数量无效".into(),
        ));
    }
    if annotation.clip_start_frame.is_some() != annotation.clip_end_frame.is_some() {
        return Err(AppError::Message(
            "SUPERVISION_ANNOTATION_JSON_INVALID: 裁剪范围必须同时提供起止帧".into(),
        ));
    }
    if annotation
        .clip_start_frame
        .zip(annotation.clip_end_frame)
        .is_some_and(|(start, end)| start > end)
    {
        return Err(AppError::Message(
            "SUPERVISION_ANNOTATION_JSON_INVALID: 裁剪范围无效".into(),
        ));
    }
    Ok(())
}

fn annotation_frame_totals(annotation: &EpisodeAnnotation) -> AppResult<(u64, u64)> {
    if annotation.segments.is_empty() {
        let frame_count = annotation
            .clip_start_frame
            .zip(annotation.clip_end_frame)
            .map(|(start, end)| end.saturating_sub(start).saturating_add(1))
            .unwrap_or_default();
        return Ok((0, frame_count));
    }
    let mut segments = annotation.segments.clone();
    segments.sort_by_key(|segment| segment.start_frame);
    let mut previous_end = None;
    let mut frame_count = 0u64;
    for segment in &segments {
        if segment.start_frame > segment.end_frame
            || previous_end.is_some_and(|end| segment.start_frame <= end)
        {
            return Err(AppError::Message(
                "SUPERVISION_ANNOTATION_JSON_INVALID: 片段范围不可重叠".into(),
            ));
        }
        if let Some((clip_start, clip_end)) =
            annotation.clip_start_frame.zip(annotation.clip_end_frame)
        {
            if segment.start_frame < clip_start || segment.end_frame > clip_end {
                return Err(AppError::Message(
                    "SUPERVISION_ANNOTATION_JSON_INVALID: 片段超出裁剪范围".into(),
                ));
            }
        }
        frame_count = frame_count.saturating_add(
            segment
                .end_frame
                .saturating_sub(segment.start_frame)
                .saturating_add(1),
        );
        previous_end = Some(segment.end_frame);
    }
    Ok((segments.len() as u64, frame_count))
}

pub fn scan_task_catalog(root: &Path, cancelled: &AtomicBool) -> AppResult<SupervisionTaskCatalog> {
    let root = fs::canonicalize(root).map_err(|error| {
        AppError::Message(format!(
            "TASK_CATALOG_UNAVAILABLE: 无法读取任务目录: {error}"
        ))
    })?;
    let metadata = fs::symlink_metadata(&root)?;
    if !metadata.file_type().is_dir() {
        return Err(AppError::Message(
            "TASK_CATALOG_INVALID: 任务来源必须是目录".into(),
        ));
    }

    let directories = read_directories(&root)?;
    let mut tasks: BTreeMap<String, (String, u64, u64, u64, u64)> = BTreeMap::new();
    for entry in &directories {
        ensure_active(cancelled)?;
        let Some(task) = task_name(entry) else {
            continue;
        };
        let key = task.to_ascii_lowercase();
        let row = tasks.entry(key).or_insert((task, 0, 0, 0, 0));
        for episode in episode_directories(entry, cancelled)? {
            let frames = count_state_frames(&episode.join("states.jsonl"), cancelled)?;
            row.2 = row.2.saturating_add(1);
            row.4 = row.4.saturating_add(frames);
            if is_regular_file(&episode.join("description.json"))? {
                row.1 = row.1.saturating_add(1);
                row.3 = row.3.saturating_add(frames);
            }
        }
    }
    if tasks.is_empty() {
        for episode in directories {
            ensure_active(cancelled)?;
            if !is_episode(&episode)? {
                continue;
            }
            let Some(task) = episode_task_name(&episode) else {
                continue;
            };
            let key = task.to_ascii_lowercase();
            let row = tasks.entry(key).or_insert((task, 0, 0, 0, 0));
            let frames = count_state_frames(&episode.join("states.jsonl"), cancelled)?;
            row.2 = row.2.saturating_add(1);
            row.4 = row.4.saturating_add(frames);
            if is_regular_file(&episode.join("description.json"))? {
                row.1 = row.1.saturating_add(1);
                row.3 = row.3.saturating_add(frames);
            }
        }
    }

    Ok(SupervisionTaskCatalog {
        source_path: root.to_string_lossy().into_owned(),
        tasks: tasks
            .into_values()
            .map(|(task, completed, total, completed_frames, total_frames)| {
                SupervisionTaskSummary {
                    task,
                    completed,
                    total,
                    completed_frames,
                    total_frames,
                }
            })
            .collect(),
    })
}

fn count_state_frames(path: &Path, cancelled: &AtomicBool) -> AppResult<u64> {
    let reader = BufReader::new(File::open(path)?);
    let mut count = 0_u64;
    for line in reader.lines() {
        ensure_active(cancelled)?;
        if !line?.trim().is_empty() {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

fn episode_directories(task_root: &Path, cancelled: &AtomicBool) -> AppResult<Vec<PathBuf>> {
    let mut episodes = Vec::new();
    for child in read_directories(task_root)? {
        ensure_active(cancelled)?;
        if is_episode(&child)? {
            episodes.push(child);
            continue;
        }
        for grandchild in read_directories(&child)? {
            ensure_active(cancelled)?;
            if is_episode(&grandchild)? {
                episodes.push(grandchild);
            }
        }
    }
    Ok(episodes)
}

fn read_directories(root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut directories = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "@eaDir" | ".DS_Store")
            || name.starts_with("._")
            || name.starts_with(".Trash-")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            directories.push(entry.path());
        }
    }
    directories.sort();
    Ok(directories)
}

fn task_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let bytes = name.as_bytes();
    let dated = bytes.len() > 11
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'-')
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    dated
        .then(|| name[11..].to_string())
        .filter(|task| !task.is_empty())
}

fn episode_task_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let (prefix, sequence) = name.rsplit_once('_')?;
    if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let task = if prefix.len() > 5
        && prefix.as_bytes()[..4]
            .iter()
            .all(|byte| byte.is_ascii_digit())
        && prefix.as_bytes().get(4) == Some(&b'_')
    {
        &prefix[5..]
    } else {
        prefix
    };
    (!task.is_empty()).then(|| task.to_string())
}

fn is_episode(path: &Path) -> AppResult<bool> {
    is_regular_file(&path.join("states.jsonl"))
}

fn is_regular_file(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ensure_active(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{import_annotation_catalog, scan_task_catalog};
    use crate::model::{EpisodeAnnotation, SegmentAnnotation, UserIdentity};
    use serde_json::json;
    use std::fs::{self, File};
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn merges_dated_tasks_and_counts_description_as_completed() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dohc-supervision-task-catalog-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        for path in [
            "2026-07-24-BedMaking/bed-001",
            "2026-08-11-BedMaking/bed-002",
            "2026-07-10-Picking/SDCARD_processed/pick-001",
            "seed_deliver/ignored",
            "seed_deliver/0724_bedsheet_001",
            "seed_deliver/bedsheet_002",
            "@eaDir/ignored",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        for path in [
            "2026-07-24-BedMaking/bed-001/states.jsonl",
            "2026-08-11-BedMaking/bed-002/states.jsonl",
            "2026-07-10-Picking/SDCARD_processed/pick-001/states.jsonl",
            "seed_deliver/ignored/states.jsonl",
            "seed_deliver/0724_bedsheet_001/states.jsonl",
            "seed_deliver/bedsheet_002/states.jsonl",
        ] {
            File::create(root.join(path)).unwrap();
        }
        File::create(root.join("2026-07-24-BedMaking/bed-001/description.json")).unwrap();
        File::create(root.join("2026-07-10-Picking/SDCARD_processed/pick-001/description.json"))
            .unwrap();
        File::create(root.join("seed_deliver/0724_bedsheet_001/description.json")).unwrap();

        let result = scan_task_catalog(&root, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.tasks.len(), 2);
        let bed = result
            .tasks
            .iter()
            .find(|task| task.task == "BedMaking")
            .unwrap();
        assert_eq!((bed.completed, bed.total), (1, 2));
        assert_eq!((bed.completed_frames, bed.total_frames), (0, 0));
        let picking = result
            .tasks
            .iter()
            .find(|task| task.task == "Picking")
            .unwrap();
        assert_eq!((picking.completed, picking.total), (1, 1));

        let delivered =
            scan_task_catalog(&root.join("seed_deliver"), &AtomicBool::new(false)).unwrap();
        assert_eq!(delivered.tasks.len(), 1);
        assert_eq!(delivered.tasks[0].task, "bedsheet");
        assert_eq!(
            (delivered.tasks[0].completed, delivered.tasks[0].total),
            (1, 2)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_latest_annotations_and_sums_segments_and_frames() {
        let root = test_output("annotation-catalog");
        fs::create_dir(&root).unwrap();
        let path = root.join("annotation-summary.json");
        let records = json!({ "annotations": [
            annotation("episode-a", 1, "alice", "close_oven", "oven-001", vec![segment(0, 9)]),
            annotation("episode-a", 2, "alice", "place_dish", "dish-001", vec![segment(0, 4), segment(5, 9)]),
            annotation("episode-b", 1, "bob", "close_oven", "oven-002", vec![segment(20, 24)])
        ] });
        fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();

        let result = import_annotation_catalog(&path).unwrap();
        assert_eq!(result.source_name, "annotation-summary.json");
        assert_eq!(result.users.len(), 2);
        let alice = result
            .users
            .iter()
            .find(|user| user.username == "alice")
            .unwrap();
        assert_eq!(
            (
                alice.trajectory_count,
                alice.segment_count,
                alice.annotated_frame_count
            ),
            (1, 2, 10)
        );
        assert_eq!(alice.tasks[0].task_id, "place_dish");
        assert_eq!(alice.entries[0].trajectory_code, "dish-001");
        let bob = result
            .users
            .iter()
            .find(|user| user.username == "bob")
            .unwrap();
        assert_eq!(
            (
                bob.trajectory_count,
                bob.segment_count,
                bob.annotated_frame_count
            ),
            (1, 1, 5)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_overlapping_annotation_segments() {
        let root = test_output("annotation-overlap");
        fs::create_dir(&root).unwrap();
        let path = root.join("overlap.json");
        fs::write(
            &path,
            serde_json::to_vec(&annotation(
                "episode-a",
                1,
                "alice",
                "close_oven",
                "oven-001",
                vec![segment(0, 5), segment(5, 9)],
            ))
            .unwrap(),
        )
        .unwrap();

        let error = import_annotation_catalog(&path).unwrap_err().to_string();
        assert!(error.starts_with("SUPERVISION_ANNOTATION_JSON_INVALID:"));
        fs::remove_dir_all(root).unwrap();
    }

    fn annotation(
        episode_id: &str,
        revision: u64,
        username: &str,
        task_id: &str,
        trajectory_code: &str,
        segments: Vec<SegmentAnnotation>,
    ) -> EpisodeAnnotation {
        EpisodeAnnotation {
            format_version: 3,
            episode_id: episode_id.into(),
            episode_root: format!("C:/episodes/{episode_id}"),
            episode_fingerprint: "a".repeat(64),
            trajectory_code: trajectory_code.into(),
            task_id: task_id.into(),
            task_description: task_id.into(),
            processed_by: UserIdentity {
                username: username.into(),
                display_name: username.into(),
                role: Some("operator".into()),
            },
            revision,
            created_at_ms: 1,
            updated_at_ms: revision,
            edit_started_at_ms: 1,
            edit_duration_ms: 0,
            clip_start_frame: Some(0),
            clip_end_frame: Some(99),
            segments,
        }
    }

    fn segment(start_frame: u64, end_frame: u64) -> SegmentAnnotation {
        SegmentAnnotation {
            start_frame,
            end_frame,
            title: "片段".into(),
            note: String::new(),
        }
    }

    fn test_output(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "dohc-supervision-{name}-{}-{nonce}",
            std::process::id()
        ))
    }
}
