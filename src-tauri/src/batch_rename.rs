//! Explicit user-requested batch rename. Never rewrite recording identities/QC.
use crate::dataset_layout::{self, Move, Registry};
use crate::error::{AppError, AppResult};
use crate::{machine_review, storage};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub source_path: String,
    pub destination_path: String,
    pub warning: String,
}

fn invalid(message: &str) -> AppError {
    AppError::Message(format!("BATCH_RENAME_FAILED: {message}"))
}

fn ordinary_directory(path: &Path) -> AppResult<()> {
    for component in path.ancestors() {
        let info = fs::symlink_metadata(component)?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err(invalid("目录不能经过符号链接"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if info.file_attributes() & 0x400 != 0 {
                return Err(invalid("目录不能经过重解析链接"));
            }
        }
    }
    Ok(())
}

pub fn source(path: &Path, data: &Path) -> AppResult<PathBuf> {
    let resolved = dataset_layout::resolve(path)?;
    ordinary_directory(&resolved)?;
    let canonical = resolved.canonicalize()?;
    if Path::new(&storage::volume_info(&canonical)?.root).canonicalize()? == canonical {
        return Err(invalid(
            "不能更名磁盘或共享卷的根目录，请选择里面的单批文件夹",
        ));
    }
    if canonical.starts_with(data.canonicalize()?.join("cloud-qc")) {
        return Err(invalid("云端下载工作区不能更名，请在云端管理原始任务"));
    }
    if canonical.parent().is_none()
        || canonical.file_name().is_none()
        || dataset_layout::grouping_name(
            &canonical.file_name().unwrap_or_default().to_string_lossy(),
        )
        || canonical
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("Delta-D1") || n == "一汽data")
        || dataset_layout::batch_root(&canonical).is_some_and(|batch| batch != canonical)
        || ["session.json", ".session_meta", "manifest.json"]
            .iter()
            .any(|n| canonical.join(n).exists())
    {
        return Err(invalid(
            "请选择单批数据文件夹；不能更名根目录、分组目录或单条记录",
        ));
    }
    Ok(canonical)
}

pub fn claim_key(path: &Path) -> AppResult<Option<String>> {
    let Some(share) = dataset_layout::share_root(path) else {
        return Ok(None);
    };
    let relative = path
        .strip_prefix(share)
        .map_err(|_| invalid("目录越界"))?
        .to_string_lossy()
        .replace('\\', "/");
    let (dataset, batch) = relative
        .split_once('/')
        .ok_or_else(|| invalid("请选择单批数据目录"))?;
    Ok(Some(dataset_layout::batch_key(
        dataset,
        batch,
        &Registry::read(path)?,
    )))
}

/// The prepared mapping is persisted BEFORE the directory rename. If a process
/// dies after the atomic rename, Registry::read recognizes old-missing/new-present
/// and resolves it. A full disk thus cannot strand a successfully renamed batch.
pub fn rename(data: &Path, source: &Path, name: &str) -> AppResult<RenameResult> {
    let source = self::source(source, data)?;
    if name.trim() != name
        || name.len() > 200
        || name.starts_with('.')
        || crate::importer::sanitize_name(name) != name
        || name.is_empty()
    {
        return Err(invalid(
            "名称不能为空、超过 200 字节或包含路径分隔符、保留名称、首尾空白及末尾句点",
        ));
    }
    let old_name = source.file_name().unwrap_or_default().to_string_lossy();
    if name.eq_ignore_ascii_case(&old_name) {
        return Err(invalid("请输入不同的文件夹名（不支持仅改变大小写）"));
    }
    if dataset_layout::dated(&old_name)
        && (!dataset_layout::dated(name) || name.get(..10) != old_name.get(..10))
    {
        return Err(invalid(
            "请保留批次原有 YYYY-MM-DD 采集日期前缀，只修改后面的名称",
        ));
    }
    if dataset_layout::grouping_name(name) {
        return Err(invalid("不能使用数据分组名称"));
    }
    let parent = source.parent().ok_or_else(|| invalid("目录没有父路径"))?;
    let destination = parent.join(name);
    let (anchor, registry_file) =
        dataset_layout::registry_location(&source)?.unwrap_or_else(|| {
            (
                parent.to_path_buf(),
                parent.join(".delta-viewer-layout.json"),
            )
        });
    let registry_parent = registry_file
        .parent()
        .ok_or_else(|| invalid("映射目录无效"))?;
    fs::create_dir_all(registry_parent)?;
    ordinary_directory(registry_parent)?;
    let _lock = machine_review::lock_file(&registry_parent.join(".delta-viewer-layout.lock"))?;
    // Recheck under the shared lock; no replace is also enforced by the OS.
    ordinary_directory(&source)?;
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err(invalid("目标名称已存在，未覆盖任何数据")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut registry = Registry::read(&source)?;
    let old = source
        .strip_prefix(&anchor)
        .map_err(|_| invalid("源目录越界"))?
        .to_string_lossy()
        .replace('\\', "/");
    let new = destination
        .strip_prefix(&anchor)
        .map_err(|_| invalid("目标目录越界"))?
        .to_string_lossy()
        .replace('\\', "/");
    if registry.moves.len() >= 9999
        || registry
            .moves
            .iter()
            .any(|m| m.source == old || m.source == new || m.destination == new)
    {
        return Err(invalid("该名称已在迁移历史中使用，请选择新名称"));
    }
    let marker_file = source.join(".delta-viewer-batch.json");
    let marker = match crate::machine_annotation::read_bytes(&marker_file)? {
        Some(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)?,
        None => {
            let id = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| invalid("系统时间无效"))?
                    .as_nanos()
            );
            let marker = serde_json::json!({"formatVersion":1,"renameId":id});
            machine_review::atomic_json(&marker_file, &marker)?;
            marker
        }
    };
    let id = marker["renameId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("批次更名标识无效"))?;
    let mut extra = std::collections::BTreeMap::new();
    extra.insert("renameId".into(), serde_json::json!(id));
    registry.moves.push(Move {
        source: old,
        destination: new,
        state: "prepared".into(),
        extra,
    });
    machine_review::atomic_json(&registry_file, &serde_json::to_value(&registry)?)?;
    // Cache aliases before touching the folder; pending queue remains unchanged.
    registry
        .moves
        .last_mut()
        .ok_or_else(|| invalid("映射缺失"))?
        .state = "completed".into();
    cache_completed(data, &source, &registry_file, &registry)?;
    if let Err(error) = storage::publish_noreplace(&source, &destination) {
        // Keep prepared intent: source still exists, so it never resolves to the
        // destination. Refresh local aliases to the actual filesystem state.
        let _ = dataset_layout::cache_registry(data, &source);
        return Err(invalid(&format!(
            "系统未能更名，可能有其他程序占用或目录不可写：{error}。关闭外部播放器后重试。"
        )));
    }
    let warning =
        match machine_review::atomic_json(&registry_file, &serde_json::to_value(&registry)?) {
            Ok(_) => String::new(),
            Err(e) => format!("文件夹已更名，已保留可恢复迁移记录；最终映射写入待重试：{e}"),
        };
    Ok(RenameResult {
        source_path: source.to_string_lossy().into_owned(),
        destination_path: destination.to_string_lossy().into_owned(),
        warning,
    })
}

fn cache_completed(data: &Path, source: &Path, file: &Path, registry: &Registry) -> AppResult<()> {
    if dataset_layout::share_root(source).is_some() {
        machine_review::atomic_json(
            &data.join("dataset-layout.json"),
            &serde_json::to_value(registry)?,
        )?;
    } else {
        let cache = data.join("local-directory-layouts.json");
        let _lock = machine_review::lock_file(&data.join(".local-directory-layouts.lock"))?;
        let mut values: serde_json::Map<String, serde_json::Value> =
            crate::machine_annotation::read_bytes(&cache)?
                .map(|bytes| serde_json::from_slice(&bytes))
                .transpose()?
                .unwrap_or_default();
        values.insert(
            file.parent()
                .unwrap_or(source)
                .to_string_lossy()
                .into_owned(),
            serde_json::to_value(registry)?,
        );
        machine_review::atomic_json(&cache, &serde_json::Value::Object(values))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn fixture_root(parent: &Path) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        loop {
            let root = parent.join(format!(
                "viewer-rename-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => return root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create isolated fixture {}: {error}", root.display()),
            }
        }
    }

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = fixture_root(&std::env::temp_dir().canonicalize().unwrap());
        eprintln!("isolated batch rename fixture: {}", root.display());
        let data = root.join("app");
        let source = root.join("share/Delta-D1/D1-Daily/2026-09-16-Old");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(source.join("001")).unwrap();
        fs::write(
            source.join("001/session.json"),
            b"{\"qc\":{\"status\":\"approved\"}}",
        )
        .unwrap();
        fs::write(source.join("001/description.json"), b"{\"segments\":[]}").unwrap();
        (root, data, source)
    }

    #[test]
    fn concurrent_fixtures_never_share_or_remove_each_others_directory() {
        let parent = fixture_root(&std::env::temp_dir().canonicalize().unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let parent = parent.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let root = fixture_root(&parent);
                    fs::write(root.join("owned"), b"fixture").unwrap();
                    root
                })
            })
            .collect();
        let roots: std::collections::BTreeSet<_> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(roots.len(), 16);
        for root in roots {
            assert_eq!(fs::read(root.join("owned")).unwrap(), b"fixture");
            fs::remove_dir_all(root).unwrap();
        }
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn rename_preserves_recording_bytes_claim_identity_old_paths_and_offline_aliases() {
        let (root, data, source) = fixture();
        let key = claim_key(&source).unwrap();
        let result = rename(&data, &source, "2026-09-16-New").unwrap();
        let destination = PathBuf::from(result.destination_path);
        assert!(!source.exists());
        assert_eq!(claim_key(&destination).unwrap(), key);
        assert_eq!(
            dataset_layout::resolve(&source.join("001")).unwrap(),
            destination.join("001")
        );
        assert_eq!(
            fs::read(destination.join("001/session.json")).unwrap(),
            b"{\"qc\":{\"status\":\"approved\"}}"
        );
        assert_eq!(
            fs::read(destination.join("001/description.json")).unwrap(),
            b"{\"segments\":[]}"
        );
        let again = rename(&data, &destination, "2026-09-16-Third").unwrap();
        let third = PathBuf::from(again.destination_path);
        assert_eq!(claim_key(&third).unwrap(), key);
        assert_eq!(
            dataset_layout::resolve(&source.join("001")).unwrap(),
            third.join("001")
        );
        fs::rename(root.join("share"), root.join("offline")).unwrap();
        let aliases = dataset_layout::historical_paths_cached(&data, &third.join("001")).unwrap();
        assert!(aliases.contains(&source.join("001")));
        assert!(aliases.contains(&destination.join("001")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_rename_recovers_only_matching_target_and_failed_prepared_intent_retries() {
        let (root, data, source) = fixture();
        let result = rename(&data, &source, "2026-09-16-New").unwrap();
        let destination = PathBuf::from(result.destination_path);
        let (_, file) = dataset_layout::registry_location(&destination)
            .unwrap()
            .unwrap();
        let mut registry: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        registry["moves"][0]["state"] = json!("prepared");
        fs::write(&file, serde_json::to_vec(&registry).unwrap()).unwrap();
        assert_eq!(dataset_layout::resolve(&source).unwrap(), destination);
        fs::write(
            destination.join(".delta-viewer-batch.json"),
            b"{\"renameId\":\"wrong\"}",
        )
        .unwrap();
        assert!(dataset_layout::resolve(&source).is_err());
        fs::rename(&destination, &source).unwrap();
        assert_eq!(dataset_layout::resolve(&source).unwrap(), source);
        assert!(rename(&data, &source, "2026-09-16-New").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_existing_target_invalid_names_root_group_episode_and_changed_date() {
        let (root, data, source) = fixture();
        fs::create_dir(source.with_file_name("2026-09-16-Existing")).unwrap();
        for name in [
            "../bad",
            "CON",
            "bad.",
            "",
            "2026-09-17-Wrong",
            "2026-09-16-Existing",
            "2026-09-16-old",
        ] {
            assert!(rename(&data, &source, name).is_err(), "{name}");
            assert!(source.join("001/session.json").exists());
        }
        for folder in [
            source.parent().unwrap().to_path_buf(),
            source.parent().unwrap().parent().unwrap().to_path_buf(),
            source.join("001"),
        ] {
            assert!(rename(&data, &folder, "New").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_external_batch_rename_keeps_offline_aliases_and_claim_keys() {
        let (root, data, _) = fixture();
        let source = root.join("USB/Old batch");
        fs::create_dir_all(source.join("001")).unwrap();
        fs::write(source.join("001/session.json"), b"{}").unwrap();
        let previous_key = dataset_layout::batch_key("Old batch", "001", &Registry::default());
        let result = rename(&data, &source, "New batch").unwrap();
        let destination = PathBuf::from(result.destination_path);
        let registry = Registry::read(&destination).unwrap();
        assert_eq!(
            dataset_layout::batch_key("New batch", "001", &registry),
            previous_key
        );
        assert_eq!(
            dataset_layout::resolve(&source.join("001")).unwrap(),
            destination.join("001")
        );
        fs::rename(root.join("USB"), root.join("unplugged")).unwrap();
        assert_eq!(
            dataset_layout::historical_paths_cached(&data, &destination.join("001")).unwrap(),
            vec![PathBuf::from(
                source
                    .join("001")
                    .to_string_lossy()
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&source.join("001").to_string_lossy())
            )]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_components() {
        let (root, data, source) = fixture();
        let link = root.join("linked");
        std::os::unix::fs::symlink(source.parent().unwrap(), &link).unwrap();
        assert!(rename(
            &data,
            &link.join(source.file_name().unwrap()),
            "2026-09-16-New"
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
