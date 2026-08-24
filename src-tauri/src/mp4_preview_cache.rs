use crate::error::{AppError, AppResult};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_PREVIEW_CACHE_BYTES: usize = 192 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreviewKey {
    root: PathBuf,
    stream: String,
    frame_id: u64,
}

#[derive(Default)]
struct PreviewCacheInner {
    entries: HashMap<PreviewKey, Arc<Vec<u8>>>,
    order: VecDeque<PreviewKey>,
    total_bytes: usize,
}

#[derive(Clone, Default)]
pub struct Mp4PreviewCache {
    inner: Arc<Mutex<PreviewCacheInner>>,
}

impl Mp4PreviewCache {
    pub fn get(&self, root: &Path, stream: &str, frame_id: u64) -> AppResult<Option<Arc<Vec<u8>>>> {
        let key = preview_key(root, stream, frame_id)?;
        Ok(self.lock()?.entries.get(&key).cloned())
    }

    pub fn insert_batch(
        &self,
        root: &Path,
        stream: &str,
        frames: Vec<(u64, Arc<Vec<u8>>)>,
    ) -> AppResult<()> {
        let canonical_root = root.canonicalize()?;
        let mut inner = self.lock()?;
        for (frame_id, bytes) in frames {
            let key = PreviewKey {
                root: canonical_root.clone(),
                stream: stream.to_string(),
                frame_id,
            };
            if inner.entries.contains_key(&key) {
                continue;
            }
            inner.total_bytes = inner.total_bytes.saturating_add(bytes.len());
            inner.order.push_back(key.clone());
            inner.entries.insert(key, bytes);
        }
        while inner.total_bytes > MAX_PREVIEW_CACHE_BYTES {
            let Some(oldest) = inner.order.pop_front() else {
                break;
            };
            if let Some(bytes) = inner.entries.remove(&oldest) {
                inner.total_bytes = inner.total_bytes.saturating_sub(bytes.len());
            }
        }
        Ok(())
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, PreviewCacheInner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::Message("MP4 预览缓存不可用，请重试".into()))
    }
}

fn preview_key(root: &Path, stream: &str, frame_id: u64) -> AppResult<PreviewKey> {
    Ok(PreviewKey {
        root: root.canonicalize()?,
        stream: stream.to_string(),
        frame_id,
    })
}

#[cfg(test)]
mod tests {
    use super::Mp4PreviewCache;
    use std::fs;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stores_sequential_preview_frames_without_writing_the_source() {
        let root = std::env::temp_dir().join(format!(
            "dohc-mp4-preview-cache-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let cache = Mp4PreviewCache::default();
        cache
            .insert_batch(
                &root,
                "cam0",
                vec![(10, Arc::new(vec![1, 2])), (11, Arc::new(vec![3, 4]))],
            )
            .unwrap();

        assert_eq!(
            cache.get(&root, "cam0", 10).unwrap().unwrap().as_slice(),
            &[1, 2]
        );
        assert_eq!(
            cache.get(&root, "cam0", 11).unwrap().unwrap().as_slice(),
            &[3, 4]
        );
        assert!(cache.get(&root, "cam0", 12).unwrap().is_none());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
