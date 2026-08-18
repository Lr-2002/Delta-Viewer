use crate::error::{AppError, AppResult};
use crate::model::{SupervisionTaskCatalog, SupervisionTaskSummary};
use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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
    use super::scan_task_catalog;
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
}
