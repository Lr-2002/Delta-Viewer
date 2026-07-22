use crate::error::{AppError, AppResult};
use crate::model::{OperationErrorRecord, RecordOperationErrorRequest, UserIdentity};
use crate::storage;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const OPERATION_ERROR_FORMAT_VERSION: u32 = 1;
const MAX_HISTORY_ENTRIES: usize = 200;
const MAX_HISTORY_FILE_BYTES: u64 = 64 * 1024;

pub fn record_error(
    data_root: &Path,
    processed_by: UserIdentity,
    request: RecordOperationErrorRequest,
) -> AppResult<OperationErrorRecord> {
    let operation = normalize_operation(&request.operation);
    let message = truncate_text(request.message.trim(), 8 * 1024);
    if message.is_empty() {
        return Err(AppError::Message("操作错误消息不能为空".into()));
    }
    let source_path = request
        .source_path
        .map(|value| truncate_text(value.trim(), 4 * 1024))
        .filter(|value| !value.is_empty());
    let occurred_at_ms = unix_millis();
    let nonce = unix_nanos();
    let code = classify_error(&message).to_string();
    let mut id_hasher = blake3::Hasher::new();
    id_hasher.update(&occurred_at_ms.to_le_bytes());
    id_hasher.update(&nonce.to_le_bytes());
    id_hasher.update(operation.as_bytes());
    id_hasher.update(message.as_bytes());
    id_hasher.update(processed_by.username.as_bytes());
    let id = id_hasher.finalize().to_hex().to_string();
    let record = OperationErrorRecord {
        format_version: OPERATION_ERROR_FORMAT_VERSION,
        id: id.clone(),
        occurred_at_ms,
        operation: operation.clone(),
        code,
        message,
        source_path,
        processed_by,
    };

    let history_dir = history_dir(data_root);
    fs::create_dir_all(&history_dir)?;
    let file_name = format!("{occurred_at_ms}-{operation}-{}.json", &id[..16]);
    let output = history_dir.join(&file_name);
    let partial = history_dir.join(format!(".{file_name}.partial-{nonce}"));
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

        let decoded: OperationErrorRecord = serde_json::from_reader(File::open(&partial)?)?;
        if decoded != record {
            return Err(AppError::Message("操作错误历史回读验证失败".into()));
        }
        storage::publish_noreplace(&partial, &output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    Ok(record)
}

pub fn list_errors(data_root: &Path) -> AppResult<Vec<OperationErrorRecord>> {
    let history_dir = history_dir(data_root);
    if !history_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(history_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_HISTORY_FILE_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_reader::<_, OperationErrorRecord>(File::open(path)?)
        else {
            continue;
        };
        if record.format_version == OPERATION_ERROR_FORMAT_VERSION {
            records.push(record);
        }
    }
    records.sort_by(|left, right| {
        right
            .occurred_at_ms
            .cmp(&left.occurred_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
    records.truncate(MAX_HISTORY_ENTRIES);
    Ok(records)
}

fn history_dir(data_root: &Path) -> std::path::PathBuf {
    data_root.join("reports").join("operation-errors")
}

fn classify_error(message: &str) -> &'static str {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("operation not allowed")
        || normalized.contains("operation not permitted")
        || normalized.contains("permission denied")
        || normalized.contains("access is denied")
        || message.contains("权限")
        || message.contains("不允许")
    {
        "PERMISSION_DENIED"
    } else if normalized.contains("no space left")
        || normalized.contains("insufficient_space")
        || message.contains("空间不足")
    {
        "INSUFFICIENT_SPACE"
    } else if normalized.contains("not found") || message.contains("路径不存在") {
        "PATH_NOT_FOUND"
    } else {
        "OPERATION_FAILED"
    }
}

fn normalize_operation(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .take(64)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "unknown_operation".into()
    } else {
        normalized
    }
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
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
    use super::{classify_error, list_errors, record_error};
    use crate::model::{RecordOperationErrorRequest, UserIdentity};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn classifies_platform_permission_messages() {
        assert_eq!(
            classify_error("Operation not permitted (os error 1)"),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            classify_error("Access is denied. (os error 5)"),
            "PERMISSION_DENIED"
        );
    }

    #[test]
    fn persists_and_lists_error_records() {
        let root = test_output("operation-history");
        let user = UserIdentity {
            username: "operator".into(),
            display_name: "Operator".into(),
        };
        let recorded = record_error(
            &root,
            user,
            RecordOperationErrorRequest {
                operation: "import_episode".into(),
                message: "Operation not allowed".into(),
                source_path: Some("/Volumes/CARD/session-001".into()),
            },
        )
        .unwrap();

        let listed = list_errors(&root).unwrap();
        assert_eq!(listed, vec![recorded]);
        fs::remove_dir_all(root).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
