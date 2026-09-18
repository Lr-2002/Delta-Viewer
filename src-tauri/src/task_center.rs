use crate::error::{AppError, AppResult};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNode {
    name: String,
    relative_path: String,
    batch_key: String,
    session: bool,
    status: String,
    error: String,
    total: usize,
    reviewed: usize,
    approved: usize,
    rejected: usize,
    errors: usize,
    incomplete: bool,
    children: Vec<TaskNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCatalog {
    source_root: String,
    tree: TaskNode,
}

pub fn default_source() -> Option<String> {
    #[cfg(windows)]
    {
        Some(r"\\10.1.40.2\Datasets\Delta-D1".into())
    }
    #[cfg(not(windows))]
    {
        let mut roots = vec![
            "/volume8/Datasets".into(),
            "/Volumes/Datasets".into(),
            "/mnt/Datasets".into(),
            "/mnt/datasets".into(),
        ];
        if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
            let gvfs = std::path::PathBuf::from(runtime).join("gvfs");
            if let Ok(entries) = fs::read_dir(gvfs) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with("smb-share:")
                        && name.contains("server=10.1.40.2,")
                        && name.ends_with("share=datasets")
                    {
                        roots.push(entry.path());
                    }
                }
            }
        }
        roots
            .into_iter()
            .map(|root: std::path::PathBuf| root.join("Delta-D1"))
            .find(|root| root.is_dir())
            .map(|root| {
                crate::storage::review_write_root(&root)
                    .unwrap_or(root)
                    .to_string_lossy()
                    .into_owned()
            })
    }
}

pub fn scan(root: &Path) -> AppResult<TaskCatalog> {
    let root = root.canonicalize()?;
    // Reuse the verified mapping to an already-mounted identical SMB share.
    // Kernel CIFS avoids serial GVFS round trips; all operations here are reads.
    let root = crate::storage::review_write_root(&root).unwrap_or(root);
    if !root.is_dir() {
        return Err(AppError::Message("请选择数据根目录".into()));
    }
    let dataset = root
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Delta-D1"))
        })
        .unwrap_or(&root);
    let namespace = dataset
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let remaining = AtomicUsize::new(100_000);
    let tree = visit(&root, &root, dataset, &namespace, 0, &remaining)?;
    Ok(TaskCatalog {
        source_root: root.to_string_lossy().into_owned(),
        tree,
    })
}

fn visit(
    root: &Path,
    path: &Path,
    dataset: &Path,
    namespace: &str,
    depth: usize,
    remaining: &AtomicUsize,
) -> AppResult<TaskNode> {
    if depth > 32
        || remaining
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            })
            .is_err()
    {
        return Err(AppError::Message("任务目录超过扫描上限".into()));
    }
    let relative = path
        .strip_prefix(root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let dataset_relative = path
        .strip_prefix(dataset)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let batch = dataset_relative.split('/').next().unwrap_or("");
    let mut node = TaskNode {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        relative_path: relative.clone(),
        batch_key: format!(
            "{:x}",
            Sha256::digest(format!("{namespace}\n{batch}").as_bytes())
        ),
        session: false,
        status: "pending".into(),
        error: String::new(),
        total: 0,
        reviewed: 0,
        approved: 0,
        rejected: 0,
        errors: 0,
        incomplete: false,
        children: vec![],
    };
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked {
        node.error = "跳过链接目录，统计不完整".into();
        node.errors = 1;
        node.incomplete = true;
        return Ok(node);
    }
    let session_json = crate::machine_annotation::read_bytes(&path.join("session.json"));
    let entries = if matches!(&session_json, Ok(Some(_))) {
        Vec::new()
    } else {
        match fs::read_dir(path).and_then(|entries| entries.collect::<Result<Vec<_>, _>>()) {
            Ok(entries) => entries,
            Err(error) => {
                node.error = error.to_string();
                node.errors = 1;
                node.incomplete = true;
                return Ok(node);
            }
        }
    };
    // Stop at a session so no camera payloads or frame directories are scanned.
    node.session = matches!(&session_json, Ok(Some(_)))
        || entries.iter().any(|entry| {
            matches!(
                entry.file_name().to_str(),
                Some("session.json" | "states.jsonl" | "manifest.json" | "cam0")
            )
        })
        || path.join(".session_meta/manifest.json").is_file();
    if node.session {
        node.total = 1;
        match session_json {
            Ok(Some(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(value) if value.is_object() => {
                    let qc = value.get("qc");
                    match qc.and_then(|value| value.as_str()).map(str::trim) {
                        Some("通过") => {
                            node.status = "approved".into();
                            node.approved = 1;
                            node.reviewed = 1;
                        }
                        Some(text)
                            if text == "不通过"
                                || text.starts_with("不通过：")
                                || text.starts_with("不通过:") =>
                        {
                            node.status = "rejected".into();
                            node.rejected = 1;
                            node.reviewed = 1;
                        }
                        Some("" | "待审核" | "未审核") | None
                            if qc.is_none_or(|value| value.is_null() || value.is_string()) => {}
                        _ => node.error = "QC 结果无法识别".into(),
                    }
                }
                Ok(_) => node.error = "session.json 不是对象".into(),
                Err(error) => node.error = error.to_string(),
            },
            Ok(None) => {}
            Err(error) => node.error = error.to_string(),
        }
        if !node.error.is_empty() {
            node.errors = 1;
            node.status = "error".into();
        }
    } else {
        let mut entries = entries;
        entries.sort_by_key(|entry| entry.file_name());
        let mut directories = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.')
                || name == "@eaDir"
                || name == "Delta-Viewer-Previews"
            {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() || kind.is_symlink() {
                directories.push(entry.path());
            }
        }
        let children = if depth == 0 && directories.len() > 1 {
            std::thread::scope(|scope| -> AppResult<Vec<TaskNode>> {
                let handles: Vec<_> = directories
                    .chunks(directories.len().div_ceil(8))
                    .map(|chunk| {
                        scope.spawn(move || {
                            chunk
                                .iter()
                                .map(|child| {
                                    visit(root, child, dataset, namespace, depth + 1, remaining)
                                })
                                .collect::<AppResult<Vec<_>>>()
                        })
                    })
                    .collect();
                let mut children = Vec::new();
                for handle in handles {
                    children.extend(
                        handle
                            .join()
                            .map_err(|_| AppError::Message("目录扫描线程失败".into()))??,
                    );
                }
                Ok(children)
            })?
        } else {
            directories
                .iter()
                .map(|child| visit(root, child, dataset, namespace, depth + 1, remaining))
                .collect::<AppResult<Vec<_>>>()?
        };
        for child in children {
            node.total += child.total;
            node.reviewed += child.reviewed;
            node.approved += child.approved;
            node.rejected += child.rejected;
            node.errors += child.errors;
            node.incomplete |= child.incomplete;
            node.children.push(child);
        }
    }
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an explicitly selected mounted task root; reads QC only"]
    fn scans_selected_mounted_root_read_only() {
        let root = std::env::var("DELTA_TASK_SAMPLE_ROOT").unwrap();
        let start = std::time::Instant::now();
        let catalog = scan(Path::new(&root)).unwrap();
        println!(
            "batches={} total={} reviewed={} errors={} elapsed={:?}",
            catalog.tree.children.len(),
            catalog.tree.total,
            catalog.tree.reviewed,
            catalog.tree.errors,
            start.elapsed()
        );
        assert!(!catalog.tree.incomplete);
        assert!(catalog.tree.total >= catalog.tree.reviewed);
    }
    #[test]
    fn progress_reads_only_root_qc_and_ignores_camera_contents() {
        let root = std::env::temp_dir().join(format!(
            "task-center-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, json) in [
            ("a", r#"{"qc":"通过"}"#),
            ("b", r#"{"qc":"不通过：轨迹不动"}"#),
            ("c", "{}"),
            ("d", r#"{"qc":true}"#),
        ] {
            let folder = root.join("batch").join(name);
            fs::create_dir_all(folder.join("cam0/nested")).unwrap();
            fs::write(folder.join("session.json"), json).unwrap();
            fs::write(folder.join("cam0/nested/session.json"), r#"{"qc":"通过"}"#).unwrap();
        }
        let catalog = scan(&root).unwrap();
        assert_eq!(
            (
                catalog.tree.total,
                catalog.tree.reviewed,
                catalog.tree.errors
            ),
            (4, 2, 1)
        );
        assert_eq!((catalog.tree.approved, catalog.tree.rejected), (1, 1));
        assert_eq!(catalog.tree.children[0].children.len(), 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_selection_preserves_batch_identity_and_rescan_reads_changed_qc() {
        let temporary =
            std::env::temp_dir().join(format!("task-center-nested-{}", std::process::id()));
        let root = temporary.join("Delta-D1");
        let session = root.join("batch/session");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("session.json"), "{}").unwrap();
        let full = scan(&root).unwrap();
        let nested = scan(&root.join("batch")).unwrap();
        assert_eq!(
            full.tree.children[0].batch_key,
            nested.tree.children[0].batch_key
        );
        assert_eq!(full.tree.reviewed, 0);
        fs::write(session.join("session.json"), r#"{"qc":"不通过"}"#).unwrap();
        assert_eq!(scan(&root).unwrap().tree.reviewed, 1);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, root.join("linked")).unwrap();
            assert!(scan(&root).unwrap().tree.incomplete);
        }
        fs::remove_dir_all(temporary).unwrap();
    }
}
