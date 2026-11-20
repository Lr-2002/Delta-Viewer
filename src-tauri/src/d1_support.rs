//! Account-scoped local support packages. No network access or arbitrary source paths.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_ARCHIVE_BYTES: usize = 4 * 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_STORED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RECORDS: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub device_id: String,
    pub bundle_id: String,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub collected_at_ms: u64,
    pub cleanup_warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub directory: String,
    pub records: Vec<Receipt>,
}

pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}

fn directory(root: &Path, owner: &str) -> Result<std::path::PathBuf, String> {
    let mut path = root.to_path_buf();
    for segment in [
        "reports".to_string(),
        "device-support".into(),
        sha(owner.as_bytes()),
    ] {
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err("SUPPORT_STORAGE_INVALID: 日志保存目录不安全".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&path).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        .map_err(|e| e.to_string())?;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}

fn regular_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("SUPPORT_FILE_INVALID".into());
    }
    use std::io::Read;
    let mut content = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > limit {
        return Err("SUPPORT_FILE_TOO_LARGE".into());
    }
    Ok(content)
}

fn records(directory: &Path) -> Result<Vec<Receipt>, String> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_uuid(&id) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let content = regular_file(&entry.path().join("receipt.json"), 8192)?;
        let mut receipt: Receipt =
            serde_json::from_slice(&content).map_err(|_| "SUPPORT_RECORD_INVALID")?;
        if receipt.bundle_id != id
            || !valid_uuid(&receipt.device_id)
            || !(1..=MAX_ARCHIVE_BYTES).contains(&receipt.bytes)
            || receipt.sha256.len() != 64
            || !receipt
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("SUPPORT_RECORD_INVALID".into());
        }
        // Never trust a persisted path supplied by an older/tampered receipt.
        receipt.path = entry
            .path()
            .join("bundle.tar.gz")
            .to_string_lossy()
            .into_owned();
        found.push(receipt);
    }
    found.sort_by(|a, b| {
        b.collected_at_ms
            .cmp(&a.collected_at_ms)
            .then_with(|| b.bundle_id.cmp(&a.bundle_id))
    });
    Ok(found)
}

fn prune(directory: &Path, now: u64) -> Result<(), String> {
    let mut total = 0;
    for (index, receipt) in records(directory)?.into_iter().enumerate() {
        let expired = now.saturating_sub(receipt.collected_at_ms) > RETENTION.as_millis() as u64;
        let over_limit = total + receipt.bytes as u64 > MAX_STORED_BYTES || index >= MAX_RECORDS;
        if !expired && !over_limit {
            total += receipt.bytes as u64;
            continue;
        }
        let folder = directory.join(&receipt.bundle_id);
        // Remove only these two owned regular files; never recurse into user content.
        for name in ["bundle.tar.gz", "receipt.json"] {
            let path = folder.join(name);
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("SUPPORT_RETENTION_INVALID".into());
            }
        }
        fs::remove_file(folder.join("bundle.tar.gz")).map_err(|e| e.to_string())?;
        fs::remove_file(folder.join("receipt.json")).map_err(|e| e.to_string())?;
        fs::remove_dir(folder).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn inventory(root: &Path, owner: &str) -> Result<Inventory, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let directory = directory(root, owner)?;
    prune(&directory, now_ms()?)?;
    Ok(Inventory {
        directory: directory.to_string_lossy().into_owned(),
        records: records(&directory)?,
    })
}

fn write_new(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    if regular_file(path, content.len() as u64)? != content {
        return Err("SUPPORT_SAVE_VERIFY_FAILED".into());
    }
    Ok(())
}

pub fn save(
    root: &Path,
    owner: &str,
    device_id: &str,
    bundle_id: &str,
    digest: &str,
    archive: &[u8],
) -> Result<Receipt, String> {
    if !valid_uuid(device_id)
        || !valid_uuid(bundle_id)
        || archive.is_empty()
        || archive.len() > MAX_ARCHIVE_BYTES
        || sha(archive) != digest
    {
        return Err("SUPPORT_SAVE_INVALID".into());
    }
    let state = inventory(root, owner)?;
    let directory = Path::new(&state.directory);
    let output = directory.join(bundle_id);
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let partial = directory.join(format!(
        ".{}.{}.partial",
        bundle_id,
        u64::from_le_bytes(nonce)
    ));
    fs::create_dir(&partial).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut receipt = Receipt {
        device_id: device_id.into(),
        bundle_id: bundle_id.into(),
        path: output.join("bundle.tar.gz").to_string_lossy().into_owned(),
        bytes: archive.len(),
        sha256: digest.into(),
        collected_at_ms: now_ms()?,
        cleanup_warning: None,
    };
    let result = (|| {
        write_new(&partial.join("bundle.tar.gz"), archive)?;
        write_new(
            &partial.join("receipt.json"),
            &serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
        )?;
        crate::storage::publish_noreplace(&partial, &output).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(partial.join("bundle.tar.gz"));
        let _ = fs::remove_file(partial.join("receipt.json"));
        let _ = fs::remove_dir(&partial);
    }
    result?;
    if prune(directory, now_ms()?).is_err() {
        receipt.cleanup_warning =
            Some("支持包已保存，但本机保留策略清理失败，请检查日志保存目录。".into());
    }
    Ok(receipt)
}

pub fn export(
    root: &Path,
    owner: &str,
    bundle_id: &str,
    destination: &Path,
) -> Result<String, String> {
    if !valid_uuid(bundle_id) {
        return Err("SUPPORT_BUNDLE_ID_INVALID".into());
    }
    let state = inventory(root, owner)?;
    let receipt = state
        .records
        .into_iter()
        .find(|r| r.bundle_id == bundle_id)
        .ok_or("SUPPORT_RECORD_NOT_FOUND: 支持包不存在或已到保留期限")?;
    let archive = regular_file(Path::new(&receipt.path), MAX_ARCHIVE_BYTES as u64)?;
    if archive.len() != receipt.bytes || sha(&archive) != receipt.sha256 {
        return Err("SUPPORT_DIGEST_MISMATCH: 本地支持包校验失败".into());
    }
    let parent = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    if !parent.is_dir() {
        return Err("SUPPORT_DESTINATION_INVALID".into());
    }
    let output = parent.join(format!(
        "D1-{}-support-{}.tar.gz",
        receipt.device_id, bundle_id
    ));
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let partial = parent.join(format!(".D1-support-{}.partial", u64::from_le_bytes(nonce)));
    let result = (|| {
        write_new(&partial, &archive)?;
        crate::storage::publish_noreplace(&partial, &output).map_err(|e| e.to_string())?;
        Ok(output.to_string_lossy().into_owned())
    })();
    let _ = fs::remove_file(&partial);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let mut nonce = [0u8; 8];
            getrandom::fill(&mut nonce).unwrap();
            let path =
                std::env::temp_dir().join(format!("d1-support-test-{}", u64::from_le_bytes(nonce)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const DEVICE: &str = "b18a915d-f012-4c96-8dcb-56391da07c92";
    const BUNDLE: &str = "c28a915d-f012-4c96-8dcb-56391da07c92";

    #[test]
    fn saved_bundles_are_verified_account_scoped_and_exported_without_replace() {
        let root = Temp::new();
        let output = Temp::new();
        let bytes = b"verified support bundle";
        let digest = sha(bytes);
        let first = save(root.path(), "offline-local", DEVICE, BUNDLE, &digest, bytes).unwrap();
        assert_eq!(
            regular_file(Path::new(&first.path), MAX_ARCHIVE_BYTES as u64).unwrap(),
            bytes
        );
        assert_eq!(
            inventory(root.path(), "another-owner")
                .unwrap()
                .records
                .len(),
            0
        );
        assert_eq!(
            inventory(root.path(), "offline-local")
                .unwrap()
                .records
                .len(),
            1
        );
        let exported = export(root.path(), "offline-local", BUNDLE, output.path()).unwrap();
        assert_eq!(fs::read(&exported).unwrap(), bytes);
        assert!(export(root.path(), "offline-local", BUNDLE, output.path()).is_err());
    }

    #[test]
    fn rejects_bad_digest_and_prunes_expired_records_only() {
        let root = Temp::new();
        assert!(save(
            root.path(),
            "owner",
            DEVICE,
            BUNDLE,
            "0".repeat(64).as_str(),
            b"bad"
        )
        .is_err());
        let directory = directory(root.path(), "owner").unwrap();
        let old_id = "d28a915d-f012-4c96-8dcb-56391da07c92";
        let folder = directory.join(old_id);
        fs::create_dir(&folder).unwrap();
        let bytes = b"old";
        let receipt = Receipt {
            device_id: DEVICE.into(),
            bundle_id: old_id.into(),
            path: String::new(),
            bytes: bytes.len(),
            sha256: sha(bytes),
            collected_at_ms: 1,
            cleanup_warning: None,
        };
        fs::write(folder.join("bundle.tar.gz"), bytes).unwrap();
        fs::write(
            folder.join("receipt.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        prune(&directory, now_ms().unwrap()).unwrap();
        assert!(!folder.exists());
    }
}
