//! One bounded, metadata-checked parse shared by preview, indexing and validation.
//! Source files remain read-only. Failed/cancelled/changing reads never enter the cache.
use crate::error::{AppError, AppResult};
use crate::model::{RawStateRecord, Severity, ValidationIssue};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const MAX_CACHED_STATES: usize = 250_000;
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}
pub struct Snapshot {
    pub states: Vec<RawStateRecord>,
    pub issues: Vec<ValidationIssue>,
    pub rows: u64,
    pub first_time: Option<String>,
    pub last_time: Option<String>,
}
type SnapshotCache = BTreeMap<PathBuf, (Stamp, Arc<Snapshot>)>;
static CACHE: OnceLock<Mutex<SnapshotCache>> = OnceLock::new();
fn stamp(path: &Path) -> AppResult<Stamp> {
    let path = path.canonicalize()?;
    let meta = fs::metadata(&path)?;
    Ok(Stamp {
        path,
        bytes: meta.len(),
        modified: meta.modified()?,
    })
}
pub fn read(path: &Path, cancelled: &AtomicBool) -> AppResult<Arc<Snapshot>> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    let before = stamp(path)?;
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((key, snapshot)) = guard.get(&before.path) {
            if key == &before {
                return Ok(snapshot.clone());
            }
        }
    }
    let mut snapshot = Snapshot {
        states: Vec::new(),
        issues: Vec::new(),
        rows: 0,
        first_time: None,
        last_time: None,
    };
    let mut reader = BufReader::with_capacity(1024 * 1024, File::open(path)?);
    let mut line = String::new();
    let mut number = 0;
    while {
        line.clear();
        reader.read_line(&mut line)? != 0
    } {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        number += 1;
        let mut issue = |severity, code: &str, message: String, frame_id| {
            snapshot.issues.push(ValidationIssue {
                severity,
                code: code.into(),
                scope: "states".into(),
                message,
                frame_id,
            })
        };
        if line.trim().is_empty() {
            issue(
                Severity::Warning,
                "EMPTY_STATE_LINE",
                format!("第 {number} 行为空"),
                None,
            );
            continue;
        }
        snapshot.rows += 1;
        match serde_json::from_str::<RawStateRecord>(&line) {
            Ok(state) => {
                let time = state.capture_time_ns.to_string();
                snapshot.first_time.get_or_insert_with(|| time.clone());
                snapshot.last_time = Some(time);
                if state.frame_id < 0 {
                    issue(
                        Severity::Error,
                        "INVALID_FRAME_ID",
                        format!("第 {number} 行的 frame_id 为负数"),
                        None,
                    );
                }
                if state.capture_time_ns < 0 {
                    issue(
                        Severity::Error,
                        "INVALID_TIMESTAMP",
                        format!("第 {number} 行的 capture_time_ns 为负数"),
                        Some(state.frame_id),
                    );
                }
                if !crate::validation::state_is_finite(&state) {
                    issue(
                        Severity::Error,
                        "NON_FINITE_STATE",
                        format!("第 {number} 行包含 NaN 或 Infinity"),
                        Some(state.frame_id),
                    );
                }
                snapshot.states.push(state);
            }
            Err(error) => {
                let code = if crate::validation::contains_non_finite_token(&line)
                    || error.to_string().contains("number out of range")
                {
                    "NON_FINITE_STATE"
                } else {
                    "INVALID_STATE_JSON"
                };
                issue(
                    Severity::Error,
                    code,
                    format!("第 {number} 行无法解析: {error}"),
                    None,
                );
                // Preserve the original index summary even for a non-state JSON object.
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(time) = value["capture_time_ns"].as_i64() {
                        snapshot.first_time.get_or_insert_with(|| time.to_string());
                        snapshot.last_time = Some(time.to_string());
                    }
                }
            }
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    if before != stamp(path)? {
        return Err(AppError::Message(
            "状态文件在读取期间发生变化，请重新加载".into(),
        ));
    }
    let snapshot = Arc::new(snapshot);
    if snapshot.states.len() <= MAX_CACHED_STATES && snapshot.issues.len() <= 10_000 {
        if let Ok(mut guard) = cache.lock() {
            guard.remove(&before.path);
            if guard.len() >= 4
                || guard
                    .values()
                    .map(|(_, value)| value.states.len())
                    .sum::<usize>()
                    + snapshot.states.len()
                    > MAX_CACHED_STATES
            {
                guard.clear();
            }
            guard.insert(before.path.clone(), (before, snapshot.clone()));
        }
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shares_parse_preserves_errors_invalidates_and_cancels() {
        let root = std::env::temp_dir().join(format!(
            "delta-state-snapshot-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("states.jsonl");
        fs::write(&path, "{\"frame_id\":0,\"capture_time_ns\":1}\n\nbad json\n{\"frame_id\":-1,\"capture_time_ns\":-1}\n").unwrap();
        let cancelled = AtomicBool::new(false);
        let first = read(&path, &cancelled).unwrap();
        let again = read(&path, &cancelled).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.rows, 3);
        assert_eq!(first.states.len(), 2);
        for code in [
            "EMPTY_STATE_LINE",
            "INVALID_STATE_JSON",
            "INVALID_FRAME_ID",
            "INVALID_TIMESTAMP",
        ] {
            assert!(first.issues.iter().any(|issue| issue.code == code));
        }
        fs::write(&path, "{\"frame_id\":5,\"capture_time_ns\":999}\n").unwrap();
        let changed = read(&path, &cancelled).unwrap();
        assert!(!Arc::ptr_eq(&first, &changed));
        assert_eq!(changed.states[0].frame_id, 5);
        assert!(read(&path, &AtomicBool::new(true)).is_err());
        fs::remove_file(&path).unwrap();
        assert!(read(&path, &cancelled).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
