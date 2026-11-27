//! Temporary, ticket-scoped playback copies. Each process owns a leased directory.
use crate::{error::AppResult, playback_cache::DirectoryLease};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const LIMIT: u64 = 8 * 1024 * 1024 * 1024;
const RESERVE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
pub struct CacheVideo {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Default)]
pub struct OutboundCache {
    usage: Mutex<Usage>,
}

#[derive(Default)]
struct Usage {
    directory: Option<DirectoryLease>,
    reserved: u64,
    ready: u64,
    write_failed: bool,
    pending_removals: Vec<(PathBuf, u64, u64)>,
    cleanup_failed: bool,
    next: u64,
    limited: bool,
    last_cleanup: Option<Instant>,
    surviving_bytes: u64,
}

pub struct CacheFile {
    pub path: PathBuf,
    pub size: u64,
    downloaded: AtomicU64,
    retired: AtomicBool,
    cache: Arc<OutboundCache>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub bytes: u64,
    pub limited: bool,
    pub cleanup_failed: bool,
}

fn root(data: &Path) -> PathBuf {
    data.join("outbound-playback-cache-v1")
}

impl OutboundCache {
    pub fn reserve(self: &Arc<Self>, data: &Path, size: u64) -> Option<CacheFile> {
        let mut usage = self.usage.lock().ok()?;
        if size == 0 || size > LIMIT {
            usage.limited = true;
            return None;
        }
        let cache_root = root(data);
        if usage.directory.is_none() {
            let Ok(directory) = DirectoryLease::create(&cache_root) else {
                usage.write_failed = true;
                return None;
            };
            usage.directory = Some(directory);
        }
        if size > LIMIT.saturating_sub(usage.reserved.saturating_add(usage.surviving_bytes))
            || fs2::available_space(&cache_root).ok()? < RESERVE + size
        {
            usage.limited = true;
            return None;
        }
        let path = usage
            .directory
            .as_ref()?
            .path
            .join(format!("{}.mp4", usage.next));
        usage.next += 1;
        usage.reserved += size;
        Some(CacheFile {
            path,
            size,
            downloaded: AtomicU64::new(0),
            retired: AtomicBool::new(false),
            cache: Arc::clone(self),
        })
    }

    pub fn maintain(&self, data: &Path, force: bool) -> AppResult<CacheStatus> {
        let mut usage = self
            .usage
            .lock()
            .map_err(|_| std::io::Error::other("cache unavailable"))?;
        let cache_root = root(data);
        if force
            || usage
                .last_cleanup
                .is_none_or(|last| last.elapsed() >= Duration::from_secs(900))
        {
            for (path, size, ready) in std::mem::take(&mut usage.pending_removals) {
                usage.remove(&path, size, ready);
            }
            let (bytes, failed) = if cache_root.is_dir() {
                let current = usage.directory.as_ref().map(|lease| lease.path.as_path());
                crate::playback_cache::cleanup_unused_except(&cache_root, current)?
            } else {
                (0, false)
            };
            usage.last_cleanup = Some(Instant::now());
            usage.surviving_bytes = bytes;
            usage.cleanup_failed = failed;
        }
        Ok(CacheStatus {
            bytes: usage.ready.saturating_add(usage.surviving_bytes),
            limited: usage.limited || usage.reserved.saturating_add(usage.surviving_bytes) >= LIMIT,
            cleanup_failed: usage.write_failed
                || !usage.pending_removals.is_empty()
                || usage.cleanup_failed,
        })
    }

    pub fn reset_warning(&self) {
        if let Ok(mut usage) = self.usage.lock() {
            usage.limited = false;
            usage.write_failed = false;
        }
    }

    pub fn close(&self) {
        if let Ok(mut usage) = self.usage.lock() {
            // Do not wait for active I/O during Tauri's normal exit.
            usage.directory.take();
        }
    }
}

impl CacheFile {
    pub fn available(&self) -> u64 {
        if self.retired.load(Ordering::Acquire) {
            return 0;
        }
        self.downloaded.load(Ordering::Acquire)
    }

    pub fn retire(&self) {
        if let Ok(mut usage) = self.cache.usage.lock() {
            if !self.retired.swap(true, Ordering::AcqRel) {
                let bytes = self.downloaded.load(Ordering::Acquire);
                usage.remove(&self.path, self.size, bytes);
            }
        }
    }

    pub fn publish(&self, bytes: u64) {
        if let Ok(mut usage) = self.cache.usage.lock() {
            if self.retired.load(Ordering::Acquire) {
                return;
            }
            let previous = self.downloaded.swap(bytes, Ordering::Release);
            usage.ready += bytes - previous;
        }
    }
}

impl Usage {
    fn remove(&mut self, path: &Path, size: u64, ready: u64) {
        if let Err(error) = std::fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                self.pending_removals
                    .push((path.to_path_buf(), size, ready));
                return;
            }
        }
        self.reserved = self.reserved.saturating_sub(size);
        self.ready = self.ready.saturating_sub(ready);
    }
}

impl Drop for CacheFile {
    fn drop(&mut self) {
        // A cancelled Tokio write can finish after the first unlink attempt.
        if self.retired.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.path);
        } else {
            self.retire();
        }
    }
}
