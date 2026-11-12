//! Explicit, temporary video-only cache. Source roots and review destinations never change.
use crate::error::{AppError, AppResult};
use fs2::FileExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const MAX_EPISODE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const MARKER: &[u8] = b"D1 Manager temporary playback cache v1\n";

fn new_id() -> AppResult<String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| AppError::Message("无法创建安全的本地缓存标识".into()))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone, Default)]
pub struct PlaybackCache(Arc<Mutex<Option<Prepared>>>);

struct Prepared {
    root: PathBuf,
    files: HashMap<PathBuf, CachedFile>,
    _directory: DirectoryLease,
}

struct CachedFile {
    path: PathBuf,
    source: Stamp,
    local: Stamp,
}

#[derive(Clone, PartialEq)]
struct Stamp {
    bytes: u64,
    modified: SystemTime,
}

impl Stamp {
    fn read(path: &Path) -> AppResult<Self> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Message("本地播放只支持普通视频文件".into()));
        }
        Self::from_metadata(&metadata)
    }

    fn from_metadata(metadata: &Metadata) -> AppResult<Self> {
        Ok(Self {
            bytes: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

struct DirectoryLease {
    path: PathBuf,
    lock: Option<File>,
}

impl Drop for DirectoryLease {
    fn drop(&mut self) {
        self.lock.take();
        // Delete only our own, flat, marker-verified temporary directory.
        let _ = remove_owned_directory(&self.path);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheResult {
    pub files: usize,
    pub bytes: u64,
}

fn cancelled(flag: &AtomicBool) -> AppResult<()> {
    if flag.load(Ordering::Acquire) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

fn private_file(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

fn private_directory(path: &Path) -> AppResult<()> {
    fs::create_dir_all(path)?;
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(AppError::Message("本地播放缓存目录无效".into()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn owned_files(path: &Path) -> AppResult<Vec<PathBuf>> {
    if !fs::symlink_metadata(path)?.file_type().is_dir() || fs::read(path.join(".owner"))? != MARKER
    {
        return Err(AppError::Message(
            "非本软件创建的视频缓存，保留原文件".into(),
        ));
    }
    let mut files = Vec::new();
    for item in fs::read_dir(path)? {
        let item = item?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if !item.file_type()?.is_file()
            || !(name == ".lease"
                || name == ".owner"
                || name
                    .strip_suffix(".mp4")
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())))
        {
            return Err(AppError::Message("视频缓存含未知文件，保留原文件".into()));
        }
        files.push(item.path());
    }
    Ok(files)
}

fn remove_owned_directory(path: &Path) -> AppResult<()> {
    let files = owned_files(path)?;
    for file in files.iter().filter(|path| {
        path.file_name()
            .is_none_or(|name| name != ".lease" && name != ".owner")
    }) {
        fs::remove_file(file)?;
    }
    fs::remove_file(path.join(".lease"))?;
    fs::remove_file(path.join(".owner"))?;
    fs::remove_dir(path)?;
    Ok(())
}

fn cleanup_unused(root: &Path) -> AppResult<u64> {
    let mut retained_bytes = 0_u64;
    for item in fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_prefix("episode-")
            .or_else(|| name.strip_prefix(".partial-"));
        if !item.file_type()?.is_dir()
            || !id.is_some_and(|s| s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        {
            continue;
        }
        let Ok(files) = owned_files(&item.path()) else {
            continue;
        };
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(item.path().join(".lease"))?;
        if FileExt::try_lock_exclusive(&lock).is_ok() {
            drop(lock);
            if remove_owned_directory(&item.path()).is_ok() {
                continue;
            }
        }
        for file in files {
            retained_bytes =
                retained_bytes.saturating_add(fs::metadata(file).map(|m| m.len()).unwrap_or(0));
        }
    }
    Ok(retained_bytes)
}

impl PlaybackCache {
    pub fn clear(&self) {
        if let Ok(mut active) = self.0.lock() {
            active.take();
        }
    }

    pub fn prepare(
        &self,
        data: &Path,
        root: &Path,
        paths: Vec<PathBuf>,
        flag: &AtomicBool,
        progress: impl FnMut(&str, u64, u64, &Path),
    ) -> AppResult<CacheResult> {
        self.prepare_with_limit(data, root, paths, flag, MAX_EPISODE_BYTES, progress)
    }

    fn prepare_with_limit(
        &self,
        data: &Path,
        root: &Path,
        paths: Vec<PathBuf>,
        flag: &AtomicBool,
        max_episode_bytes: u64,
        mut progress: impl FnMut(&str, u64, u64, &Path),
    ) -> AppResult<CacheResult> {
        cancelled(flag)?;
        let root = root.canonicalize()?;
        let mut unique = HashSet::new();
        let mut plan = Vec::new();
        let mut total = 0_u64;
        for path in paths {
            let path = path.canonicalize()?;
            if !path.starts_with(&root)
                || path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_none_or(|s| !s.eq_ignore_ascii_case("mp4"))
            {
                return Err(AppError::Message("视频路径不在当前录制内".into()));
            }
            if !unique.insert(path.clone()) {
                continue;
            }
            let stamp = Stamp::read(&path)?;
            total = total
                .checked_add(stamp.bytes)
                .ok_or_else(|| AppError::Message("视频容量超出限制".into()))?;
            plan.push((path, stamp));
        }
        if plan.is_empty() || plan.len() > 512 || total == 0 || total > max_episode_bytes {
            return Err(AppError::Message(
                "本地流畅播放支持单条录制最多 4 GiB、512 个 MP4 分段；可继续使用源目录播放".into(),
            ));
        }
        let cache_root = data.join("playback-cache-v1");
        private_directory(&cache_root)?;
        let maintenance_path = cache_root.join(".maintenance");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let maintenance = options.open(maintenance_path)?;
        FileExt::try_lock_exclusive(&maintenance)
            .map_err(|_| AppError::Message("另一个窗口正在准备本地播放，请稍后重试".into()))?;
        let retained = cleanup_unused(&cache_root)?;
        if retained.saturating_add(total) > MAX_CACHE_BYTES
            || fs2::available_space(&cache_root)? < total.saturating_add(RESERVE_BYTES)
        {
            return Err(AppError::Message(
                "本机视频缓存空间不足，请释放磁盘空间或继续使用源目录播放".into(),
            ));
        }
        let id = new_id()?;
        let partial = cache_root.join(format!(".partial-{id}"));
        private_directory(&partial)?;
        // Keep ownership readable even while Windows exclusively locks .lease.
        // Otherwise another process cannot verify/count an active cache.
        let mut marker = private_file(&partial.join(".owner"))?;
        marker.write_all(MARKER)?;
        marker.sync_all()?;
        drop(marker);
        let lock = private_file(&partial.join(".lease"))?;
        FileExt::try_lock_exclusive(&lock)?;
        let mut directory = DirectoryLease {
            path: partial.clone(),
            lock: Some(lock),
        };
        let mut files = HashMap::new();
        let mut done = 0;
        let mut buffer = vec![0_u8; 1024 * 1024];
        for (index, (path, stamp)) in plan.iter().enumerate() {
            cancelled(flag)?;
            let mut input = File::open(path)?;
            if Stamp::from_metadata(&input.metadata()?)? != *stamp {
                return Err(AppError::Message(
                    "视频在缓存前发生变化，请重新打开录制".into(),
                ));
            }
            let local_path = partial.join(format!("{index}.mp4"));
            let mut output = private_file(&local_path)?;
            let mut hash = blake3::Hasher::new();
            let mut left = stamp.bytes;
            while left > 0 {
                cancelled(flag)?;
                let wanted = left.min(buffer.len() as u64) as usize;
                let count = input.read(&mut buffer[..wanted])?;
                if count == 0 {
                    return Err(AppError::Message("源视频被截断，缓存未启用".into()));
                }
                output.write_all(&buffer[..count])?;
                hash.update(&buffer[..count]);
                left -= count as u64;
                done += count as u64;
                progress("缓存当前录制的视频", done, total * 2, path);
            }
            output.sync_all()?;
            drop(output);
            if Stamp::read(path)? != *stamp || Stamp::from_metadata(&input.metadata()?)? != *stamp {
                return Err(AppError::Message(
                    "源视频在缓存期间发生变化，请重新打开录制".into(),
                ));
            }
            let mut verify = File::open(&local_path)?;
            let mut readback = blake3::Hasher::new();
            loop {
                cancelled(flag)?;
                let count = verify.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                readback.update(&buffer[..count]);
                done += count as u64;
                progress("校验本机视频", done, total * 2, path);
            }
            if readback.finalize() != hash.finalize() || verify.metadata()?.len() != stamp.bytes {
                return Err(AppError::Message("本机视频校验失败，缓存未启用".into()));
            }
            files.insert(
                path.clone(),
                CachedFile {
                    path: local_path.clone(),
                    source: stamp.clone(),
                    local: Stamp::read(&local_path)?,
                },
            );
        }
        cancelled(flag)?;
        for (path, stamp) in &plan {
            if Stamp::read(path)? != *stamp {
                return Err(AppError::Message("源视频已变化，缓存未启用".into()));
            }
        }
        let published = cache_root.join(format!("episode-{id}"));
        // Windows cannot rename a directory while its child lease is open.
        // The maintenance lock still excludes other preparers/cleaners throughout
        // publication and lease reacquisition, so the cache is never unprotected.
        directory.lock.take();
        crate::storage::publish_noreplace(&partial, &published)?;
        directory.path = published.clone();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(published.join(".lease"))?;
        FileExt::try_lock_exclusive(&lock)?;
        directory.lock = Some(lock);
        for entry in files.values_mut() {
            entry.path = published.join(entry.path.file_name().unwrap());
        }
        *self
            .0
            .lock()
            .map_err(|_| AppError::Message("本地播放状态不可用".into()))? = Some(Prepared {
            root,
            files,
            _directory: directory,
        });
        Ok(CacheResult {
            files: plan.len(),
            bytes: total,
        })
    }

    pub fn resolve(&self, root: &Path, paths: &mut Vec<String>) -> AppResult<bool> {
        let active = self
            .0
            .lock()
            .map_err(|_| AppError::Message("本地播放状态不可用".into()))?;
        let Some(prepared) = active.as_ref() else {
            return Ok(false);
        };
        if root.canonicalize()? != prepared.root {
            return Ok(false);
        }
        let mut resolved = Vec::with_capacity(paths.len());
        for path in paths.iter() {
            let Some(entry) = prepared.files.get(Path::new(path)) else {
                return Ok(false);
            };
            if Stamp::read(Path::new(path)).ok().as_ref() != Some(&entry.source)
                || Stamp::read(&entry.path).ok().as_ref() != Some(&entry.local)
            {
                return Ok(false);
            }
            resolved.push(entry.path.display().to_string());
        }
        *paths = resolved;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (TestDirectory, PathBuf, PathBuf, PathBuf) {
        let temp = TestDirectory(
            std::env::temp_dir().join(format!("d1-playback-test-{}", new_id().unwrap())),
        );
        fs::create_dir(temp.path()).unwrap();
        let source = temp.path().join("nas-source");
        fs::create_dir(&source).unwrap();
        let file = source.join("cam0.mp4");
        fs::write(&file, vec![7; 3 * 1024 * 1024 + 11]).unwrap();
        let file = file.canonicalize().unwrap();
        let data = temp.path().join("application");
        (temp, source, file, data)
    }
    #[test]
    fn explicit_cache_preserves_source_and_replaces_only_media_paths() {
        let (_temp, root, file, data) = fixture();
        let cache = PlaybackCache::default();
        let flag = AtomicBool::new(false);
        let original = fs::read(&file).unwrap();
        let mut paths = vec![file.display().to_string()];
        assert!(!cache.resolve(&root, &mut paths).unwrap());
        let result = cache
            .prepare(
                &data,
                &root,
                vec![file.clone(), file.clone()],
                &flag,
                |_, _, _, _| {},
            )
            .unwrap();
        assert_eq!(result.files, 1);
        assert!(cache.resolve(&root, &mut paths).unwrap());
        assert!(Path::new(&paths[0]).starts_with(&data));
        assert_eq!(fs::read(&paths[0]).unwrap(), original);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(fs::read(&file).unwrap(), original);
        let local = PathBuf::from(&paths[0]);
        drop(cache);
        assert!(!local.exists());
        assert_eq!(fs::read(&file).unwrap(), original);
    }
    #[test]
    fn changed_source_or_local_cache_is_never_reused() {
        let (_temp, root, file, data) = fixture();
        let cache = PlaybackCache::default();
        let flag = AtomicBool::new(false);
        cache
            .prepare(&data, &root, vec![file.clone()], &flag, |_, _, _, _| {})
            .unwrap();
        let original = vec![file.display().to_string()];
        let mut paths = original.clone();
        assert!(cache.resolve(&root, &mut paths).unwrap());
        fs::write(&paths[0], b"truncated").unwrap();
        assert!(!cache.resolve(&root, &mut original.clone()).unwrap());
        fs::write(&file, b"new source").unwrap();
        assert!(!cache.resolve(&root, &mut original.clone()).unwrap());
    }
    #[test]
    fn cancellation_and_source_changes_leave_no_complete_cache() {
        let (_temp, root, file, data) = fixture();
        let cache = PlaybackCache::default();
        let flag = AtomicBool::new(false);
        assert!(cache
            .prepare(&data, &root, vec![file.clone()], &flag, |_, _, _, _| {
                flag.store(true, Ordering::Release)
            })
            .is_err());
        assert_eq!(
            fs::read_dir(data.join("playback-cache-v1"))
                .unwrap()
                .count(),
            1
        );
        flag.store(false, Ordering::Release);
        let mut changed = false;
        assert!(cache
            .prepare(&data, &root, vec![file.clone()], &flag, |_, _, _, _| {
                if !changed {
                    changed = true;
                    OpenOptions::new()
                        .append(true)
                        .open(&file)
                        .unwrap()
                        .write_all(b"changed")
                        .unwrap();
                }
            })
            .is_err());
        assert_eq!(
            fs::read_dir(data.join("playback-cache-v1"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn outside_files_and_unknown_cache_contents_are_preserved() {
        let (temp, root, _file, data) = fixture();
        let outside = temp.path().join("other.mp4");
        fs::write(&outside, b"private").unwrap();
        let cache = PlaybackCache::default();
        assert!(cache
            .prepare(
                &data,
                &root,
                vec![outside.clone()],
                &AtomicBool::new(false),
                |_, _, _, _| {}
            )
            .is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"private");
        let unknown = data
            .join("playback-cache-v1")
            .join(format!("episode-{}", new_id().unwrap()));
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join(".owner"), MARKER).unwrap();
        fs::write(unknown.join(".lease"), []).unwrap();
        fs::write(unknown.join("notes.txt"), b"keep").unwrap();
        cleanup_unused(unknown.parent().unwrap()).unwrap();
        assert!(unknown.join("notes.txt").exists());
    }

    #[test]
    fn another_windows_active_cache_is_not_evicted() {
        let (_temp, root, file, data) = fixture();
        let flag = AtomicBool::new(false);
        let first = PlaybackCache::default();
        let second = PlaybackCache::default();
        first
            .prepare(&data, &root, vec![file.clone()], &flag, |_, _, _, _| {})
            .unwrap();
        assert!(
            cleanup_unused(&data.join("playback-cache-v1")).unwrap()
                >= fs::metadata(&file).unwrap().len()
        );
        second
            .prepare(&data, &root, vec![file.clone()], &flag, |_, _, _, _| {})
            .unwrap();
        let mut paths = vec![file.display().to_string()];
        assert!(first.resolve(&root, &mut paths).unwrap());
        drop(second);
        assert!(Path::new(&paths[0]).is_file());
        assert!(first
            .resolve(&root, &mut vec![file.display().to_string()])
            .unwrap());
        first.clear();
        first.clear();
        assert!(!Path::new(&paths[0]).exists());
        assert!(!first
            .resolve(&root, &mut vec![file.display().to_string()])
            .unwrap());
    }

    #[test]
    fn oversized_recording_is_rejected_before_copying() {
        let (_temp, root, file, data) = fixture();
        let cache = PlaybackCache::default();
        // Exercise the actual rejection path without allocating a multi-GiB
        // file on Windows (set_len is not sparse there).
        assert!(cache
            .prepare_with_limit(
                &data,
                &root,
                vec![file],
                &AtomicBool::new(false),
                2 * 1024 * 1024,
                |_, _, _, _| panic!("must not read oversized source")
            )
            .is_err());
        assert!(!data.exists());
    }

    #[test]
    fn corrupt_readback_cannot_publish_a_complete_cache() {
        let (_temp, root, file, data) = fixture();
        let cache = PlaybackCache::default();
        let mut corrupted = false;
        let result = cache.prepare(
            &data,
            &root,
            vec![file.clone()],
            &AtomicBool::new(false),
            |phase, _, _, _| {
                if phase == "校验本机视频" && !corrupted {
                    corrupted = true;
                    let dir = fs::read_dir(data.join("playback-cache-v1"))
                        .unwrap()
                        .flatten()
                        .find(|entry| entry.file_type().unwrap().is_dir())
                        .unwrap()
                        .path();
                    OpenOptions::new()
                        .append(true)
                        .open(dir.join("0.mp4"))
                        .unwrap()
                        .write_all(b"bad")
                        .unwrap();
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_dir(data.join("playback-cache-v1"))
                .unwrap()
                .count(),
            1
        );
        assert!(!cache
            .resolve(&root, &mut vec![file.display().to_string()])
            .unwrap());
    }
}
