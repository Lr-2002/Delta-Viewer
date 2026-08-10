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
    pub fn clear(&self) -> AppResult<()> {
        self.lock()?.clear();
        Ok(())
    }

    pub fn store(&self, mut index: EpisodeIndex) -> AppResult<()> {
        let root = fs::canonicalize(&index.summary.root)?;
        let mut entries = self.lock()?;
        if entries.len() >= SOURCE_INDEX_MAX_EPISODES && !entries.contains_key(&root) {
            entries.clear();
        }
        let retained_frame_paths = entries
            .iter()
            .filter(|(path, _)| *path != &root)
            .map(|(_, cached)| cached.frame_path_count())
            .sum::<usize>();
        if retained_frame_paths.saturating_add(index.frame_path_count())
            > SOURCE_INDEX_MAX_FRAME_PATHS
        {
            index.stream_files.clear();
        }
        entries.insert(root, index);
        Ok(())
    }

    pub fn index_for(&self, root: &Path) -> AppResult<Option<EpisodeIndex>> {
        let root = fs::canonicalize(root)?;
        Ok(self.lock()?.get(&root).cloned())
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
    use crate::source::scan_episode_index;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stores_and_clears_an_episode_index() {
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
        cache.store(index).unwrap();

        assert_eq!(
            cache.index_for(&root).unwrap().unwrap().fingerprint,
            fingerprint
        );
        cache.clear().unwrap();
        assert!(cache.index_for(&root).unwrap().is_none());

        fs::remove_dir_all(root).unwrap();
    }
}
