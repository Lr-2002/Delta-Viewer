use crate::error::{AppError, AppResult};
use crate::source::{EpisodeIndex, SOURCE_INDEX_MAX_EPISODES, SOURCE_INDEX_MAX_FRAME_PATHS};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct SourceIndexCache {
    entries: Arc<Mutex<HashMap<PathBuf, EpisodeIndex>>>,
}

impl SourceIndexCache {
    pub fn replace(&self, indexes: Vec<EpisodeIndex>) -> AppResult<()> {
        let mut replacement = HashMap::with_capacity(indexes.len().min(SOURCE_INDEX_MAX_EPISODES));
        let mut cached_frame_paths = 0_usize;
        for mut index in indexes.into_iter().take(SOURCE_INDEX_MAX_EPISODES) {
            let frame_paths = index.frame_path_count();
            if cached_frame_paths.saturating_add(frame_paths) <= SOURCE_INDEX_MAX_FRAME_PATHS {
                cached_frame_paths = cached_frame_paths.saturating_add(frame_paths);
            } else {
                index.stream_files.clear();
            }
            replacement.insert(fs::canonicalize(&index.summary.root)?, index);
        }
        *self.lock()? = replacement;
        Ok(())
    }

    pub fn index_for(&self, root: &Path) -> AppResult<Option<EpisodeIndex>> {
        let root = fs::canonicalize(root)?;
        Ok(self.lock()?.get(&root).cloned())
    }

    #[cfg(test)]
    pub fn index_for_fingerprint(
        &self,
        root: &Path,
        fingerprint: &str,
    ) -> AppResult<Option<EpisodeIndex>> {
        Ok(self
            .index_for(root)?
            .filter(|index| index.fingerprint == fingerprint))
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<PathBuf, EpisodeIndex>>> {
        self.entries
            .lock()
            .map_err(|_| AppError::Message("源索引缓存不可用".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::SourceIndexCache;
    use crate::source::{episode_fingerprint, scan_episode_index};
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn only_reuses_an_index_for_its_source_fingerprint() {
        let root = std::env::temp_dir().join(format!(
            "dohc-viewer-source-index-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("cam0")).unwrap();
        fs::write(root.join("cam0/0.jpg"), b"jpeg placeholder").unwrap();
        let cancelled = AtomicBool::new(false);
        let index = scan_episode_index(&root, None, &cancelled).unwrap();
        let fingerprint = index.fingerprint.clone();
        let cache = SourceIndexCache::default();
        cache.replace(vec![index]).unwrap();

        assert_eq!(episode_fingerprint(&root, &cancelled).unwrap(), fingerprint);
        assert!(cache
            .index_for_fingerprint(&root, &fingerprint)
            .unwrap()
            .is_some());
        fs::write(root.join("changed.txt"), b"changed").unwrap();
        let changed = episode_fingerprint(&root, &cancelled).unwrap();
        assert_ne!(fingerprint, changed);
        assert!(cache
            .index_for_fingerprint(&root, &changed)
            .unwrap()
            .is_none());

        fs::remove_dir_all(root).unwrap();
    }
}
