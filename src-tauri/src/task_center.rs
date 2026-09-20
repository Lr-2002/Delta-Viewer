use crate::error::{AppError, AppResult};
use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone, Debug, Serialize)]
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
    scanning: bool,
    children: Vec<TaskNode>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCatalog {
    source_root: String,
    tree: TaskNode,
    stats: ScanStats,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    elapsed_ms: u64,
    qc_reads: usize,
    cache_hits: usize,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScanUpdate {
    Catalog {
        catalog: TaskCatalog,
    },
    Batch {
        node: TaskNode,
    },
    Progress {
        sessions: usize,
        path: String,
        elapsed_ms: u64,
    },
}

#[derive(Default)]
pub struct QcCache(Mutex<HashMap<PathBuf, CachedQc>>);

struct CachedQc {
    modified: SystemTime,
    size: u64,
    checked: Instant,
    status: String,
}

struct ScanContext<'a> {
    root: &'a Path,
    dataset: &'a Path,
    namespace: &'a str,
    remaining: AtomicUsize,
    sessions: AtomicUsize,
    qc_reads: AtomicUsize,
    cache_hits: AtomicUsize,
    started: Instant,
    last_progress: Mutex<Instant>,
    cancelled: &'a AtomicBool,
    cache: &'a QcCache,
    force: bool,
    update: &'a (dyn Fn(ScanUpdate) + Sync),
}

impl ScanContext<'_> {
    fn check_cancelled(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(AppError::Message("任务目录扫描已取消".into()));
        }
        Ok(())
    }

    fn progress(&self, path: &Path) {
        if let Ok(mut last) = self.last_progress.lock() {
            if last.elapsed() >= Duration::from_millis(250) {
                *last = Instant::now();
                (self.update)(ScanUpdate::Progress {
                    sessions: self.sessions.load(Ordering::Relaxed),
                    path: path
                        .strip_prefix(self.root)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .into_owned(),
                    elapsed_ms: self.started.elapsed().as_millis() as u64,
                });
            }
        }
    }
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

#[cfg(test)]
pub fn scan(root: &Path) -> AppResult<TaskCatalog> {
    scan_streaming(
        root,
        &QcCache::default(),
        false,
        &AtomicBool::new(false),
        &|_| {},
    )
}

pub fn scan_streaming(
    root: &Path,
    cache: &QcCache,
    force: bool,
    cancelled: &AtomicBool,
    update: &(dyn Fn(ScanUpdate) + Sync),
) -> AppResult<TaskCatalog> {
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
    let context = ScanContext {
        root: &root,
        dataset,
        namespace: &namespace,
        remaining: AtomicUsize::new(100_000),
        sessions: AtomicUsize::new(0),
        qc_reads: AtomicUsize::new(0),
        cache_hits: AtomicUsize::new(0),
        started: Instant::now(),
        last_progress: Mutex::new(Instant::now() - Duration::from_secs(1)),
        cancelled,
        cache,
        force,
        update,
    };
    // One bounded pool shares work across batches AND sessions in a large batch.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(8)
        .build()
        .map_err(|error| AppError::Message(error.to_string()))?;
    let tree = pool.install(|| visit(&root, 0, &context))?;
    Ok(TaskCatalog {
        source_root: root.to_string_lossy().into_owned(),
        tree,
        stats: ScanStats {
            elapsed_ms: context.started.elapsed().as_millis() as u64,
            qc_reads: context.qc_reads.load(Ordering::Relaxed),
            cache_hits: context.cache_hits.load(Ordering::Relaxed),
        },
    })
}

fn empty_node(path: &Path, context: &ScanContext<'_>) -> TaskNode {
    let ScanContext {
        root,
        dataset,
        namespace,
        ..
    } = context;
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let dataset_relative = path
        .strip_prefix(dataset)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let batch = dataset_relative.split('/').next().unwrap_or("");
    TaskNode {
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
        scanning: true,
        children: vec![],
    }
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn visit(path: &Path, depth: usize, context: &ScanContext<'_>) -> AppResult<TaskNode> {
    context.check_cancelled()?;
    if depth > 32
        || context
            .remaining
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            })
            .is_err()
    {
        return Err(AppError::Message("任务目录超过扫描上限".into()));
    }
    context.progress(path);
    let mut node = empty_node(path, context);
    node.scanning = false;
    let metadata = fs::symlink_metadata(path)?;
    if linked(&metadata) {
        node.error = "跳过链接目录，统计不完整".into();
        node.errors = 1;
        node.incomplete = true;
        return Ok(node);
    }
    let qc_path = path.join("session.json");
    let stamp = fs::symlink_metadata(&qc_path)
        .ok()
        .filter(|info| info.file_type().is_file() && !linked(info))
        .and_then(|info| Some((info.modified().ok()?, info.len())));
    if !context.force {
        if let (Some((modified, size)), Ok(cache)) = (stamp, context.cache.0.lock()) {
            if let Some(cached) = cache.get(&qc_path).filter(|cached| {
                cached.modified == modified
                    && cached.size == size
                    && cached.checked.elapsed() < Duration::from_secs(300)
            }) {
                // Identity is relative to the selected root, so never reuse cached paths.
                node.session = true;
                node.total = 1;
                node.status.clone_from(&cached.status);
                node.approved = usize::from(cached.status == "approved");
                node.rejected = usize::from(cached.status == "rejected");
                node.reviewed = node.approved + node.rejected;
                context.sessions.fetch_add(1, Ordering::Relaxed);
                context.cache_hits.fetch_add(1, Ordering::Relaxed);
                return Ok(node);
            }
        }
    }
    let session_json = crate::machine_annotation::read_bytes(&qc_path);
    if matches!(&session_json, Ok(Some(_))) {
        context.qc_reads.fetch_add(1, Ordering::Relaxed);
    }
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
        || (fs::symlink_metadata(path.join(".session_meta"))
            .is_ok_and(|info| info.is_dir() && !linked(&info))
            && fs::symlink_metadata(path.join(".session_meta/manifest.json"))
                .is_ok_and(|info| info.is_file() && !linked(&info)));
    if node.session {
        context.sessions.fetch_add(1, Ordering::Relaxed);
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
        if node.error.is_empty() {
            if let (Some((modified, size)), Ok(mut cache)) = (stamp, context.cache.0.lock()) {
                // Bound memory independently of how many datasets were opened.
                if cache.len() >= 100_000 {
                    cache.clear();
                }
                cache.insert(
                    qc_path,
                    CachedQc {
                        modified,
                        size,
                        checked: Instant::now(),
                        status: node.status.clone(),
                    },
                );
            }
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
        if depth == 0 {
            let mut listing = node.clone();
            listing.scanning = !directories.is_empty();
            listing.children = directories
                .iter()
                .map(|path| empty_node(path, context))
                .collect();
            (context.update)(ScanUpdate::Catalog {
                catalog: TaskCatalog {
                    source_root: context.root.to_string_lossy().into_owned(),
                    tree: listing,
                    stats: ScanStats::default(),
                },
            });
        }
        let children = directories
            .par_iter()
            .map(|child| {
                let result = visit(child, depth + 1, context);
                context.check_cancelled()?;
                let child = match result {
                    Ok(node) => node,
                    Err(error) => {
                        let mut node = empty_node(child, context);
                        node.scanning = false;
                        node.incomplete = true;
                        node.errors = 1;
                        node.error = error.to_string();
                        node
                    }
                };
                if depth == 0 {
                    (context.update)(ScanUpdate::Batch {
                        node: child.clone(),
                    });
                }
                Ok(child)
            })
            .collect::<AppResult<Vec<_>>>()?;
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
    context.check_cancelled()?;
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_lists_before_qc_and_cache_refreshes_changes_and_manual_scans() {
        let root = std::env::temp_dir().join(format!(
            "task-stream-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for index in 0..1000 {
            let folder = root.join(format!("batch-{}/session-{index}", index % 4));
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("session.json"), r#"{"qc":"通过"}"#).unwrap();
        }
        let cache = QcCache::default();
        let updates = Mutex::new(Vec::new());
        let first = scan_streaming(&root, &cache, false, &AtomicBool::new(false), &|update| {
            if let ScanUpdate::Catalog { catalog } = &update {
                assert_eq!(catalog.tree.children.len(), 4);
                assert!(catalog
                    .tree
                    .children
                    .iter()
                    .all(|node| node.scanning && node.total == 0));
                assert!(
                    cache.0.lock().unwrap().is_empty(),
                    "listing must precede QC reads"
                );
            }
            updates.lock().unwrap().push(update);
        })
        .unwrap();
        assert_eq!(first.tree.reviewed, 1000);
        assert_eq!(first.stats.qc_reads, 1000);
        assert_eq!(
            updates
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, ScanUpdate::Batch { .. }))
                .count(),
            4
        );
        let second =
            scan_streaming(&root, &cache, false, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(second.stats.qc_reads, 0);
        assert_eq!(second.stats.cache_hits, 1000);
        let changed = root.join("batch-0/session-0/session.json");
        fs::write(&changed, r#"{"qc":"不通过"}"#).unwrap();
        let third = scan_streaming(&root, &cache, false, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(
            (
                third.tree.rejected,
                third.stats.qc_reads,
                third.stats.cache_hits
            ),
            (1, 1, 999)
        );
        let forced = scan_streaming(&root, &cache, true, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!((forced.stats.qc_reads, forced.stats.cache_hits), (1000, 0));
        // Reopening a batch has different relative paths but shares QC cache safely.
        let nested = scan_streaming(
            &root.join("batch-0"),
            &cache,
            false,
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        assert!(nested
            .tree
            .children
            .iter()
            .all(|node| !node.relative_path.contains('/')));
        fs::remove_file(changed).unwrap();
        let removed =
            scan_streaming(&root, &cache, false, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(removed.tree.reviewed, 999);
        println!(
            "1000 sessions: cold={}ms, cached={}ms; QC reads 1000 -> 0",
            first.stats.elapsed_ms, second.stats.elapsed_ms
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_after_listing_prevents_session_reads() {
        let root = std::env::temp_dir().join(format!("task-cancel-{}", std::process::id()));
        fs::create_dir_all(root.join("batch/session")).unwrap();
        fs::write(root.join("batch/session/session.json"), "{}").unwrap();
        let cancelled = AtomicBool::new(false);
        let cache = QcCache::default();
        let result = scan_streaming(&root, &cache, false, &cancelled, &|event| {
            if matches!(event, ScanUpdate::Catalog { .. }) {
                cancelled.store(true, Ordering::Release);
            }
        });
        assert!(result.is_err());
        assert!(cache.0.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
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
