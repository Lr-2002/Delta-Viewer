use crate::error::{AppError, AppResult};
use crate::model::{ValidationReport, VALIDATION_REPORT_FORMAT_VERSION};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct ValidationCache {
    entries: Arc<Mutex<HashMap<PathBuf, CachedValidation>>>,
}

#[derive(Clone)]
struct CachedValidation {
    fingerprint: String,
    report: ValidationReport,
}

impl ValidationCache {
    pub fn store(
        &self,
        root: &Path,
        fingerprint: String,
        report: ValidationReport,
    ) -> AppResult<()> {
        if report.format_version != VALIDATION_REPORT_FORMAT_VERSION {
            return Err(AppError::Message(
                "EXPORT_REVALIDATION_REQUIRED: 检查报告版本已过期，请重新检查".into(),
            ));
        }
        let root = fs::canonicalize(root)?;
        let mut entries = self.lock()?;
        if entries.len() >= 16 && !entries.contains_key(&root) {
            entries.clear();
        }
        entries.insert(
            root,
            CachedValidation {
                fingerprint,
                report,
            },
        );
        Ok(())
    }

    pub fn report_for(&self, root: &Path, fingerprint: &str) -> AppResult<ValidationReport> {
        let root = fs::canonicalize(root)?;
        let mut entries = self.lock()?;
        let Some(cached) = entries.get(&root) else {
            return Err(AppError::Message(
                "EXPORT_REVALIDATION_REQUIRED: 请先运行数据检查".into(),
            ));
        };
        if cached.fingerprint != fingerprint {
            entries.remove(&root);
            return Err(AppError::Message(
                "EXPORT_REVALIDATION_REQUIRED: 数据在检查后发生变化，请重新检查".into(),
            ));
        }
        Ok(cached.report.clone())
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<PathBuf, CachedValidation>>> {
        self.entries
            .lock()
            .map_err(|_| AppError::Message("校验缓存不可用".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::ValidationCache;
    use crate::model::{ImageValidationMode, ValidationReport, VALIDATION_REPORT_FORMAT_VERSION};
    use crate::validation::IMAGE_SAMPLE_PERCENTAGES;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_missing_or_stale_validation() {
        let root = std::env::temp_dir().join(format!(
            "dohc-viewer-cache-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let cache = ValidationCache::default();
        assert!(cache.report_for(&root, "one").is_err());

        let mut stale = report(&root);
        stale.format_version = VALIDATION_REPORT_FORMAT_VERSION - 1;
        assert!(cache.store(&root, "old".into(), stale).is_err());

        cache.store(&root, "one".into(), report(&root)).unwrap();
        assert_eq!(cache.report_for(&root, "one").unwrap().status, "ok");
        assert!(cache.report_for(&root, "two").is_err());
        assert!(cache.report_for(&root, "one").is_err());

        fs::remove_dir(root).unwrap();
    }

    fn report(root: &std::path::Path) -> ValidationReport {
        ValidationReport {
            format_version: VALIDATION_REPORT_FORMAT_VERSION,
            episode_root: root.display().to_string(),
            parsed_state_count: 0,
            image_validation_mode: ImageValidationMode::Sampled,
            image_sample_percentages: IMAGE_SAMPLE_PERCENTAGES.to_vec(),
            auto_report_path: None,
            status: "ok".into(),
            checked_files: 0,
            elapsed_ms: 0,
            issues: Vec::new(),
            streams: Vec::new(),
        }
    }
}
