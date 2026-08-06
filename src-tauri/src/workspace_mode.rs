use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::model::WorkspaceMode;
use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MODE_RECORD_FORMAT_VERSION: u32 = 1;
const MAX_MODE_RECORD_BYTES: u64 = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceModeRecord {
    format_version: u32,
    selection: Option<WorkspaceMode>,
    changed_at_ms: u64,
}

pub fn restore(data_root: &Path, state: &AuthState) -> AppResult<()> {
    let directory = records_dir(data_root);
    if !directory.is_dir() {
        return state.set_workspace_mode(None);
    }
    let mut latest: Option<(PathBuf, WorkspaceModeRecord)> = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
        {
            continue;
        }
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.len() > MAX_MODE_RECORD_BYTES {
            return Err(AppError::Message("工作模式记录超出大小限制".into()));
        }
        let record: WorkspaceModeRecord = serde_json::from_reader(File::open(&path)?)?;
        validate_record(&record)?;
        if latest.as_ref().is_none_or(|(latest_path, latest_record)| {
            (record.changed_at_ms, &path) > (latest_record.changed_at_ms, latest_path)
        }) {
            latest = Some((path, record));
        }
    }
    state.set_workspace_mode(latest.and_then(|(_, record)| record.selection))
}

pub fn select(
    data_root: &Path,
    state: &AuthState,
    selection: Option<WorkspaceMode>,
) -> AppResult<()> {
    let record = WorkspaceModeRecord {
        format_version: MODE_RECORD_FORMAT_VERSION,
        selection,
        changed_at_ms: unix_millis(),
    };
    let directory = records_dir(data_root);
    fs::create_dir_all(&directory)?;
    let nonce = unix_nanos();
    let output = directory.join(format!("mode-{}-{nonce}.json", record.changed_at_ms));
    write_record_noreplace(&record, &output, nonce)?;
    state.set_workspace_mode(record.selection)
}

fn records_dir(data_root: &Path) -> PathBuf {
    data_root.join("workspace-mode")
}

fn validate_record(record: &WorkspaceModeRecord) -> AppResult<()> {
    if record.format_version != MODE_RECORD_FORMAT_VERSION || record.changed_at_ms == 0 {
        return Err(AppError::Message("工作模式记录格式无效".into()));
    }
    Ok(())
}

fn write_record_noreplace(
    record: &WorkspaceModeRecord,
    output: &Path,
    nonce: u128,
) -> AppResult<()> {
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("工作模式记录路径无效".into()))?;
    let partial = parent.join(format!(".mode.partial-{nonce}"));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&partial)?;
        serde_json::to_writer_pretty(&mut file, record)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let verified: WorkspaceModeRecord = serde_json::from_reader(File::open(&partial)?)?;
        if verified != *record {
            return Err(AppError::Message("工作模式记录回读验证失败".into()));
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

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::{restore, select};
    use crate::identity::AuthState;
    use crate::model::WorkspaceMode;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn restores_the_latest_mode_selection() {
        let root = std::env::temp_dir().join(format!(
            "dohc-workspace-mode-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = AuthState::default();
        select(&root, &state, Some(WorkspaceMode::Offline)).unwrap();
        select(&root, &state, Some(WorkspaceMode::Managed)).unwrap();
        let restored = AuthState::default();
        restore(&root, &restored).unwrap();
        assert_eq!(
            restored.workspace_mode().unwrap(),
            Some(WorkspaceMode::Managed)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
