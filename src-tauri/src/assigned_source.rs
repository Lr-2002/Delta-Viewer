use crate::error::{AppError, AppResult};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FORMAT_VERSION: u32 = 1;
const MAX_BYTES: u64 = 8 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignedSourceRecord {
    format_version: u32,
    source_root: String,
}

pub fn load(data_root: &Path) -> AppResult<Option<String>> {
    let path = record_path(data_root);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_BYTES {
        return Err(AppError::Message(
            "ASSIGNED_SOURCE_INVALID: 本机 NAS 根目录配置无效".into(),
        ));
    }
    let record: AssignedSourceRecord = serde_json::from_reader(File::open(path)?)?;
    if record.format_version != FORMAT_VERSION || record.source_root.trim().is_empty() {
        return Err(AppError::Message(
            "ASSIGNED_SOURCE_INVALID: 本机 NAS 根目录配置无效".into(),
        ));
    }
    Ok(Some(record.source_root))
}

pub fn save(data_root: &Path, source_root: &Path) -> AppResult<String> {
    let canonical = fs::canonicalize(source_root)?;
    if !fs::symlink_metadata(&canonical)?.file_type().is_dir() {
        return Err(AppError::Message(
            "ASSIGNED_SOURCE_INVALID: 请选择已挂载的 NAS 目录".into(),
        ));
    }
    let value = canonical.to_string_lossy().into_owned();
    let record = AssignedSourceRecord {
        format_version: FORMAT_VERSION,
        source_root: value.clone(),
    };
    let output = record_path(data_root);
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("ASSIGNED_SOURCE_INVALID: 配置路径无效".into()))?;
    fs::create_dir_all(parent)?;
    let partial = parent.join(format!(".assigned-source.partial-{}", unix_nanos()));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&partial)?;
        serde_json::to_writer_pretty(&mut file, &record)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        if output.exists() {
            storage::replace_file_atomic(&partial, &output)?;
        } else {
            storage::publish_noreplace(&partial, &output)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    Ok(value)
}

fn record_path(data_root: &Path) -> PathBuf {
    data_root.join("assigned-source.json")
}
fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::{load, save};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stores_and_replaces_only_the_local_mounted_root() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dohc-assigned-source-{}-{nonce}",
            std::process::id()
        ));
        let data_root = root.join("data");
        let first = root.join("nas-one");
        let second = root.join("nas-two");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();

        assert_eq!(load(&data_root).unwrap(), None);
        let first_saved = save(&data_root, &first).unwrap();
        assert_eq!(load(&data_root).unwrap(), Some(first_saved));
        let second_saved = save(&data_root, &second).unwrap();
        assert_eq!(load(&data_root).unwrap(), Some(second_saved));

        fs::remove_dir_all(root).unwrap();
    }
}
