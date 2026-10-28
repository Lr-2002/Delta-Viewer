//! Read-only, bounded diagnostics used only after playback has failed.
use crate::error::{AppError, AppResult};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};

pub(crate) fn inspect_mp4(
    root: &Path,
    relative: &Path,
    expected_bytes: Option<u64>,
) -> AppResult<Option<String>> {
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Ok(Some(
            "VIDEO_MANIFEST_INVALID: 视频清单异常：分段路径不在当前数据目录内。".into(),
        ));
    }
    let path = root.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A vanished/disconnected root is not evidence of an absent video.
            fs::read_dir(root)?;
            return Ok(Some(format!(
                "VIDEO_FILE_MISSING: 视频文件缺失：{}。请检查是否传输完整，或从原件补齐。",
                relative.display()
            )));
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || !path.canonicalize()?.starts_with(root) {
        return Ok(Some(format!(
            "VIDEO_READ_FAILED: 视频读取失败：{} 不是当前目录内的普通文件。",
            relative.display()
        )));
    }
    let damaged = |reason: &str| {
        Some(format!(
            "VIDEO_FILE_DAMAGED: 视频文件损坏：{}（{}）。请从完整原件恢复。",
            relative.display(),
            reason
        ))
    };
    let size = metadata.len();
    if size < 8 {
        return Ok(damaged("文件为空或文件头不完整"));
    }
    let mut file = File::open(&path)?;
    let mut offset = 0_u64;
    let mut has_moov = false;
    // Skip media payloads with seek; never scan/read an entire 4K video.
    for _ in 0..64 {
        if offset == size {
            if !has_moov {
                return Ok(damaged("缺少 moov 播放索引，视频未完成封装或已被截断"));
            }
            return Ok(if expected_bytes.is_some_and(|expected| expected != size) {
                Some(format!("VIDEO_MANIFEST_INVALID: 视频清单异常：{} 实际为 {} 字节，清单为 {} 字节；尚不能据此确认文件损坏。", relative.display(), size, expected_bytes.unwrap()))
            } else {
                None
            });
        }
        if size - offset < 8 {
            return Ok(damaged("文件尾部被截断"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let short_size = u32::from_be_bytes(header[..4].try_into().unwrap());
        let mut header_size = 8;
        let atom_size = match short_size {
            0 => size - offset,
            1 => {
                if size - offset < 16 {
                    return Ok(damaged("扩展文件头被截断"));
                }
                let mut extended = [0_u8; 8];
                file.read_exact(&mut extended)?;
                header_size = 16;
                u64::from_be_bytes(extended)
            }
            value => u64::from(value),
        };
        if atom_size < header_size || atom_size > size - offset {
            return Ok(damaged("容器声明长度超出实际文件，文件不完整"));
        }
        has_moov |= &header[4..] == b"moov";
        offset += atom_size;
    }
    // Bounded inspection is inconclusive; do not manufacture a corruption verdict.
    Ok(None)
}

pub(crate) fn diagnostic_io_error(error: AppError) -> String {
    format!("VIDEO_READ_FAILED: 视频读取失败，无法完成文件检查；原始错误：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn distinguishes_missing_truncated_unfinalized_and_unknown_without_writes() {
        let root = std::env::temp_dir().join(format!(
            "delta-media-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("clip.mp4");
        let check = |expected| inspect_mp4(&root, Path::new("clip.mp4"), expected).unwrap();
        assert!(check(None).unwrap().starts_with("VIDEO_FILE_MISSING:"));
        for bytes in [
            vec![],
            b"\0\0\0\x20mdatpayload".to_vec(),
            b"\0\0\0\0mdatpayload".to_vec(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(check(None).unwrap().starts_with("VIDEO_FILE_DAMAGED:"));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let valid = b"\0\0\0\x08moov\0\0\0\x08mdat";
        fs::write(&path, valid).unwrap();
        assert!(check(Some(16)).is_none());
        assert!(check(Some(32))
            .unwrap()
            .starts_with("VIDEO_MANIFEST_INVALID:"));
        assert!(inspect_mp4(&root, Path::new("../clip.mp4"), None)
            .unwrap()
            .unwrap()
            .starts_with("VIDEO_MANIFEST_INVALID:"));
        fs::remove_dir_all(&root).unwrap();
        assert!(inspect_mp4(&root, Path::new("clip.mp4"), None).is_err());
    }
}
