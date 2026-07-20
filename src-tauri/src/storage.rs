use crate::error::{AppError, AppResult};
use crate::model::{ImportPreflight, PartialImport, PreflightIssue, VolumeInfo};
use crate::source::collect_files;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PARTIAL_MARKER_SUFFIX: &str = ".dohc-partial.json";
const PARTIAL_FORMAT_VERSION: u32 = 1;
const MANIFEST_MIN_RESERVE: u64 = 1024 * 1024;
const MANIFEST_BYTES_PER_FILE: u64 = 256;
const EXPORT_MIN_RESERVE: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialMarker {
    format_version: u32,
    app_identifier: String,
    kind: String,
    directory_name: String,
    source_name: String,
    created_at_ms: u64,
}

pub fn volume_info(path: &Path) -> AppResult<VolumeInfo> {
    if !path.is_dir() {
        return Err(AppError::MissingPath(path.display().to_string()));
    }
    let stats = fs2::statvfs(path)?;
    let (root, filesystem, drive_type) = platform_volume_details(path);
    Ok(VolumeInfo {
        root,
        filesystem,
        drive_type,
        total_bytes: stats.total_space(),
        available_bytes: stats.available_space(),
    })
}

pub fn ensure_local_source(volume: &VolumeInfo) -> AppResult<()> {
    if volume.drive_type == "remote" {
        return Err(AppError::Message(
            "不支持网络映射盘；请选择本机可移动介质或本地目录".into(),
        ));
    }
    Ok(())
}

pub fn inspect_import(source: &Path, destination_parent: &Path) -> AppResult<ImportPreflight> {
    if !source.is_dir() {
        return Err(AppError::MissingPath(source.display().to_string()));
    }
    if !destination_parent.is_dir() {
        return Err(AppError::MissingPath(
            destination_parent.display().to_string(),
        ));
    }

    let source = fs::canonicalize(source)?;
    let destination_parent = fs::canonicalize(destination_parent)?;
    let files = collect_files(&source)?;
    if files.is_empty() {
        return Err(AppError::Message("源目录没有可导入文件".into()));
    }
    let mut source_bytes = 0_u64;
    let mut largest_file_bytes = 0_u64;
    for path in &files {
        let size = fs::metadata(path)?.len();
        source_bytes = source_bytes.saturating_add(size);
        largest_file_bytes = largest_file_bytes.max(size);
    }
    let manifest_reserve = (files.len() as u64)
        .saturating_mul(MANIFEST_BYTES_PER_FILE)
        .max(MANIFEST_MIN_RESERVE);
    let required_bytes = source_bytes.saturating_add(manifest_reserve);
    let volume = volume_info(&destination_parent)?;
    let partials = list_partial_imports(&destination_parent)?;
    let mut issues = Vec::new();

    if destination_parent.starts_with(&source) {
        issues.push(preflight_issue(
            "DESTINATION_INSIDE_SOURCE",
            "导入目录不能是源记录本身或其子目录",
        ));
    }
    if volume.drive_type == "remote" {
        issues.push(preflight_issue(
            "REMOTE_DESTINATION",
            "不支持网络映射盘作为导入目标",
        ));
    }
    if volume.filesystem.as_deref().is_some_and(is_unsupported_fat) {
        issues.push(preflight_issue(
            "UNSUPPORTED_FILESYSTEM",
            "FAT/FAT32 不支持大文件，导入目标请使用 NTFS 或 exFAT",
        ));
    }
    if volume.available_bytes < required_bytes {
        issues.push(preflight_issue(
            "INSUFFICIENT_SPACE",
            &format!(
                "目标可用空间 {} 字节，小于导入所需 {} 字节",
                volume.available_bytes, required_bytes
            ),
        ));
    }

    Ok(ImportPreflight {
        can_import: issues.is_empty(),
        source_bytes,
        required_bytes,
        largest_file_bytes,
        volume,
        issues,
        partials,
    })
}

pub fn require_import_preflight(preflight: &ImportPreflight) -> AppResult<()> {
    if preflight.can_import {
        return Ok(());
    }
    let details = preflight
        .issues
        .iter()
        .map(|issue| format!("{}: {}", issue.code, issue.message))
        .collect::<Vec<_>>()
        .join("；");
    Err(AppError::Message(format!("导入预检失败：{details}")))
}

pub fn require_export_destination(
    source: &Path,
    destination_parent: &Path,
    source_bytes: u64,
) -> AppResult<()> {
    let volume = require_local_destination(source, destination_parent)?;
    let reserve = (source_bytes / 20).max(EXPORT_MIN_RESERVE);
    let required_bytes = source_bytes.saturating_add(reserve);
    if volume.available_bytes < required_bytes {
        return Err(AppError::Message(format!(
            "INSUFFICIENT_SPACE: 目标可用空间 {} 字节，小于导出预估所需 {} 字节",
            volume.available_bytes, required_bytes
        )));
    }
    Ok(())
}

pub fn require_local_destination(
    source: &Path,
    destination_parent: &Path,
) -> AppResult<VolumeInfo> {
    let source = fs::canonicalize(source)?;
    let destination_parent = fs::canonicalize(destination_parent)?;
    if destination_parent.starts_with(&source) {
        return Err(AppError::Message(
            "EXPORT_DESTINATION_INSIDE_SOURCE: 导出目录不能是源记录本身或其子目录".into(),
        ));
    }
    let volume = volume_info(&destination_parent)?;
    if volume.drive_type == "remote" {
        return Err(AppError::Message(
            "REMOTE_DESTINATION: 不支持网络映射盘作为导出目标".into(),
        ));
    }
    if volume.filesystem.as_deref().is_some_and(is_unsupported_fat) {
        return Err(AppError::Message(
            "UNSUPPORTED_FILESYSTEM: FAT/FAT32 不支持导出目标，请使用 NTFS 或 exFAT".into(),
        ));
    }
    Ok(volume)
}

pub fn create_import_partial(
    destination_parent: &Path,
    safe_name: &str,
    source_name: &str,
) -> AppResult<PathBuf> {
    let created_at_ms = unix_millis();
    let nonce = format!("{}-{}", unix_nanos(), std::process::id());
    let directory_name = format!("{safe_name}.partial-{nonce}");
    let partial = destination_parent.join(&directory_name);
    fs::create_dir(&partial)?;

    let marker = PartialMarker {
        format_version: PARTIAL_FORMAT_VERSION,
        app_identifier: "com.dohc.viewer".into(),
        kind: "import".into(),
        directory_name,
        source_name: source_name.into(),
        created_at_ms,
    };
    let marker_path = partial_marker_path(&partial)?;
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&marker_path)?;
        serde_json::to_writer_pretty(&mut file, &marker)?;
        use std::io::Write;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&marker_path);
        let _ = fs::remove_dir(&partial);
        return Err(error);
    }
    Ok(partial)
}

pub fn finalize_import_partial(partial: &Path) -> AppResult<()> {
    verified_partial(partial)?;
    fs::remove_file(partial_marker_path(partial)?)?;
    Ok(())
}

pub fn list_partial_imports(destination_parent: &Path) -> AppResult<Vec<PartialImport>> {
    if !destination_parent.is_dir() {
        return Ok(Vec::new());
    }
    let mut partials = Vec::new();
    for entry in fs::read_dir(destination_parent)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_dir() {
            continue;
        }
        let Ok(marker) = verified_partial(&path) else {
            continue;
        };
        partials.push(PartialImport {
            path: path.display().to_string(),
            name: marker.directory_name,
            source_name: marker.source_name,
            created_at_ms: marker.created_at_ms,
        });
    }
    partials.sort_by_key(|item| item.created_at_ms);
    Ok(partials)
}

pub fn cleanup_partial_import(destination_parent: &Path, partial_path: &Path) -> AppResult<()> {
    let parent = fs::canonicalize(destination_parent)?;
    let metadata = fs::symlink_metadata(partial_path)?;
    if !metadata.file_type().is_dir() {
        return Err(AppError::Message("拒绝清理：目标不是普通目录".into()));
    }
    let partial = fs::canonicalize(partial_path)?;
    if partial.parent() != Some(parent.as_path()) {
        return Err(AppError::Message(
            "拒绝清理：partial 不在所选导入目录内".into(),
        ));
    }
    verified_partial(&partial)?;
    fs::remove_dir_all(partial)?;
    fs::remove_file(partial_marker_path(partial_path)?)?;
    Ok(())
}

fn verified_partial(path: &Path) -> AppResult<PartialMarker> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Message("拒绝清理：partial 名称无效".into()))?;
    if !name.contains(".partial-") {
        return Err(AppError::Message("拒绝清理：目录名不是 partial".into()));
    }
    let marker_path = partial_marker_path(path)?;
    let marker_metadata = fs::symlink_metadata(&marker_path)?;
    if !marker_metadata.file_type().is_file() || marker_metadata.len() > 16 * 1024 {
        return Err(AppError::Message("拒绝清理：partial 标记无效".into()));
    }
    let file = File::open(marker_path)?;
    let marker: PartialMarker = serde_json::from_reader(file)?;
    if marker.format_version != PARTIAL_FORMAT_VERSION
        || marker.app_identifier != "com.dohc.viewer"
        || marker.kind != "import"
        || marker.directory_name != name
    {
        return Err(AppError::Message("拒绝清理：partial 标记不匹配".into()));
    }
    Ok(marker)
}

fn partial_marker_path(partial: &Path) -> AppResult<PathBuf> {
    let parent = partial
        .parent()
        .ok_or_else(|| AppError::Message("partial 缺少父目录".into()))?;
    let name = partial
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Message("partial 名称无效".into()))?;
    Ok(parent.join(format!(".{name}{PARTIAL_MARKER_SUFFIX}")))
}

fn preflight_issue(code: &str, message: &str) -> PreflightIssue {
    PreflightIssue {
        code: code.into(),
        message: message.into(),
    }
}

fn is_unsupported_fat(filesystem: &str) -> bool {
    let normalized = filesystem.trim().to_ascii_uppercase();
    normalized.starts_with("FAT") && normalized != "EXFAT"
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

#[cfg(windows)]
fn platform_volume_details(path: &Path) -> (String, Option<String>, String) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetVolumeInformationW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut volume_path = vec![0_u16; 512];
    let found = unsafe {
        GetVolumePathNameW(
            wide_path.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    };
    if found == 0 {
        return (path.display().to_string(), None, "unknown".into());
    }
    let root_end = volume_path
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(volume_path.len());
    let root = String::from_utf16_lossy(&volume_path[..root_end]);
    let drive_type = match unsafe { GetDriveTypeW(volume_path.as_ptr()) } {
        DRIVE_REMOVABLE => "removable",
        DRIVE_FIXED => "fixed",
        DRIVE_REMOTE => "remote",
        DRIVE_CDROM => "optical",
        DRIVE_RAMDISK => "ramdisk",
        _ => "unknown",
    }
    .to_string();

    let mut filesystem_name = vec![0_u16; 64];
    let found = unsafe {
        GetVolumeInformationW(
            volume_path.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem_name.as_mut_ptr(),
            filesystem_name.len() as u32,
        )
    };
    let filesystem = (found != 0).then(|| {
        let end = filesystem_name
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(filesystem_name.len());
        String::from_utf16_lossy(&filesystem_name[..end])
    });
    (
        root,
        filesystem.filter(|value| !value.is_empty()),
        drive_type,
    )
}

#[cfg(not(windows))]
fn platform_volume_details(path: &Path) -> (String, Option<String>, String) {
    (path.display().to_string(), None, "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_partial_import, create_import_partial, inspect_import, is_unsupported_fat,
        list_partial_imports,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_legacy_fat_but_allows_exfat() {
        assert!(is_unsupported_fat("FAT32"));
        assert!(is_unsupported_fat("fat16"));
        assert!(!is_unsupported_fat("exFAT"));
        assert!(!is_unsupported_fat("NTFS"));
    }

    #[test]
    fn only_lists_and_cleans_marked_partial_directories() {
        let root = test_output("partials");
        fs::create_dir_all(&root).unwrap();
        let marked = create_import_partial(&root, "episode", "source").unwrap();
        let unmarked = root.join("other.partial-123");
        fs::create_dir(&unmarked).unwrap();
        fs::write(marked.join("copied.bin"), b"data").unwrap();

        let partials = list_partial_imports(&root).unwrap();
        assert_eq!(partials.len(), 1);
        assert_eq!(PathBuf::from(&partials[0].path), marked);
        assert!(cleanup_partial_import(&root, &unmarked).is_err());
        assert!(unmarked.is_dir());
        cleanup_partial_import(&root, &marked).unwrap();
        assert!(!marked.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_preflight_rejects_destination_inside_source() {
        let source = test_output("nested-source");
        let destination = source.join("destination");
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("states.jsonl"), b"{}\n").unwrap();

        let preflight = inspect_import(&source, &destination).unwrap();
        assert!(!preflight.can_import);
        assert!(preflight
            .issues
            .iter()
            .any(|issue| issue.code == "DESTINATION_INSIDE_SOURCE"));

        fs::remove_dir_all(source).unwrap();
    }

    fn test_output(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dohc-viewer-{label}-{nonce}"))
    }
}
