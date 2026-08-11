use crate::error::{AppError, AppResult};
use crate::model::SegmentAnnotation;
use crate::storage;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DESCRIPTION_FILE_NAME: &str = "description.json";
const DESCRIPTION_FORMAT_VERSION: u32 = 2;
const DESCRIPTION_MAX_BYTES: u64 = 256 * 1024;
const DESCRIPTION_PARTIAL_PREFIX: &str = ".description.json.partial-";

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpisodeDescription {
    format_version: u32,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    clip_start_frame: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clip_end_frame: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    segments: Vec<SegmentAnnotation>,
}

pub fn write_description_with_segments(
    episode_root: &Path,
    description: &str,
    clip_start_frame: Option<u64>,
    clip_end_frame: Option<u64>,
    segments: &[SegmentAnnotation],
) -> AppResult<PathBuf> {
    let root_metadata = fs::symlink_metadata(episode_root)?;
    if !root_metadata.file_type().is_dir() {
        return Err(AppError::Message(
            "SOURCE_DESCRIPTION_WRITE_FAILED: episode 根路径不是普通目录".into(),
        ));
    }

    let output = episode_root.join(DESCRIPTION_FILE_NAME);
    match fs::symlink_metadata(&output) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(AppError::Message(format!(
                "SOURCE_DESCRIPTION_WRITE_FAILED: {} 已存在但不是普通文件",
                output.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::Message(format!(
                "SOURCE_DESCRIPTION_WRITE_FAILED: 无法检查 {}: {error}",
                output.display()
            )));
        }
    }

    let document = EpisodeDescription {
        format_version: DESCRIPTION_FORMAT_VERSION,
        description: description.into(),
        clip_start_frame,
        clip_end_frame,
        segments: segments.to_vec(),
    };
    let partial = episode_root.join(format!(
        "{DESCRIPTION_PARTIAL_PREFIX}{}-{}",
        std::process::id(),
        unix_nanos()
    ));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        serde_json::to_writer_pretty(&mut file, &document)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        let decoded = read_description(&partial)?;
        if decoded != document {
            return Err(AppError::Message(
                "SOURCE_DESCRIPTION_WRITE_FAILED: description.json 回读不一致".into(),
            ));
        }
        storage::replace_file_atomic(&partial, &output)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(AppError::Message(format!(
            "SOURCE_DESCRIPTION_WRITE_FAILED: 无法写入 {}: {error}",
            output.display()
        )));
    }
    Ok(output)
}

pub fn is_description_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root) && path.file_name() == Some(OsStr::new(DESCRIPTION_FILE_NAME))
}

pub fn is_description_partial_path(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(DESCRIPTION_PARTIAL_PREFIX))
}

fn read_description(path: &Path) -> AppResult<EpisodeDescription> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > DESCRIPTION_MAX_BYTES {
        return Err(AppError::Message(
            "SOURCE_DESCRIPTION_INVALID: description.json 不是有效的普通文件".into(),
        ));
    }
    Ok(serde_json::from_reader(File::open(path)?)?)
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{read_description, write_description_with_segments, DESCRIPTION_FILE_NAME};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_and_atomically_replaces_description() {
        let root = test_output("replace");
        fs::create_dir_all(&root).unwrap();

        let first = write_description_with_segments(&root, "第一次描述", None, None, &[]).unwrap();
        assert_eq!(first, root.join(DESCRIPTION_FILE_NAME));
        assert_eq!(read_description(&first).unwrap().description, "第一次描述");

        let second =
            write_description_with_segments(&root, "更新后的描述", None, None, &[]).unwrap();
        assert_eq!(second, first);
        assert_eq!(
            read_description(&second).unwrap().description,
            "更新后的描述"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_replace_a_non_file_description_target() {
        let root = test_output("non-file");
        fs::create_dir_all(root.join(DESCRIPTION_FILE_NAME)).unwrap();

        let error = write_description_with_segments(&root, "不能写入", None, None, &[])
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("SOURCE_DESCRIPTION_WRITE_FAILED:"));
        assert!(root.join(DESCRIPTION_FILE_NAME).is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-description-{label}-{nonce}"))
    }
}
