use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Default)]
pub struct OutboxState(AtomicBool);

pub struct FlushGuard<'a>(&'a AtomicBool);
impl Drop for FlushGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl OutboxState {
    pub fn start(&self) -> Option<FlushGuard<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| FlushGuard(&self.0))
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxStatus {
    pub pending: u64,
    pub blocked: u64,
    pub error: String,
}

fn database_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("REVIEW_OUTBOX_STORAGE: {error}"))
}

fn open(root: &Path) -> AppResult<Connection> {
    let directory = root.join("review-outbox");
    fs::create_dir_all(&directory)?;
    let metadata = fs::symlink_metadata(&directory)?;
    if !metadata.file_type().is_dir() {
        return Err(database_error("队列目录不是普通目录"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(database_error("队列目录不能是链接"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let path = directory.join("events.sqlite");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.file_type().is_file() {
        return Err(database_error("队列数据库不是普通文件"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(database_error("队列数据库不能是链接"));
        }
    }
    let db = Connection::open(&path).map_err(database_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(database_error)?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS pending (
            id INTEGER PRIMARY KEY, service TEXT NOT NULL, username TEXT NOT NULL,
            event_id TEXT NOT NULL, payload TEXT NOT NULL, blocked TEXT NOT NULL DEFAULT '',
            UNIQUE(service, username, event_id));
        CREATE INDEX IF NOT EXISTS pending_owner ON pending(service, username, blocked, id);",
    )
    .map_err(database_error)?;
    Ok(db)
}

pub fn enqueue(
    root: &Path,
    service: &str,
    username: &str,
    events: &[Value],
) -> AppResult<OutboxStatus> {
    if events.is_empty() || events.len() > 20 {
        return Err(database_error("每批记录需为 1 至 20 项"));
    }
    let mut db = open(root)?;
    let tx = db.transaction().map_err(database_error)?;
    for event in events {
        let id = event
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 64)
            .ok_or_else(|| database_error("事件标识无效"))?;
        let payload = serde_json::to_string(event)?;
        if payload.len() > 64 * 1024 {
            return Err(database_error("单条记录超过 64 KiB"));
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT payload FROM pending WHERE service=? AND username=? AND event_id=?",
                params![service, username, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if existing.as_ref().is_some_and(|value| value != &payload) {
            return Err(database_error("同一事件标识存在不同内容"));
        }
        tx.execute(
            "INSERT OR IGNORE INTO pending(service,username,event_id,payload) VALUES(?,?,?,?)",
            params![service, username, id, payload],
        )
        .map_err(database_error)?;
    }
    tx.commit().map_err(database_error)?;
    status_with(&db, service, username)
}

fn status_with(db: &Connection, service: &str, username: &str) -> AppResult<OutboxStatus> {
    db.query_row("SELECT COUNT(*), COALESCE(SUM(blocked != ''),0), COALESCE(MAX(blocked),'') FROM pending WHERE service=? AND username=?",
        params![service,username], |row| Ok(OutboxStatus { pending: row.get(0)?, blocked: row.get(1)?, error: row.get(2)? }))
        .map_err(database_error)
}

pub fn status(root: &Path, service: &str, username: &str) -> AppResult<OutboxStatus> {
    status_with(&open(root)?, service, username)
}

pub fn batch(
    root: &Path,
    service: &str,
    username: &str,
    retry_blocked: bool,
) -> AppResult<Vec<Value>> {
    let db = open(root)?;
    if retry_blocked {
        db.execute(
            "UPDATE pending SET blocked='' WHERE service=? AND username=?",
            params![service, username],
        )
        .map_err(database_error)?;
    }
    let mut statement = db.prepare("SELECT payload FROM pending WHERE service=? AND username=? AND blocked='' ORDER BY id LIMIT 8").map_err(database_error)?;
    let rows = statement
        .query_map(params![service, username], |row| row.get::<_, String>(0))
        .map_err(database_error)?;
    rows.map(|row| Ok(serde_json::from_str(&row.map_err(database_error)?)?))
        .collect()
}

pub fn acknowledge(root: &Path, service: &str, username: &str, ids: &[String]) -> AppResult<()> {
    let mut db = open(root)?;
    let tx = db.transaction().map_err(database_error)?;
    for id in ids {
        tx.execute(
            "DELETE FROM pending WHERE service=? AND username=? AND event_id=?",
            params![service, username, id],
        )
        .map_err(database_error)?;
    }
    tx.commit().map_err(database_error)
}

pub fn block(root: &Path, service: &str, username: &str, id: &str, error: &str) -> AppResult<()> {
    open(root)?
        .execute(
            "UPDATE pending SET blocked=? WHERE service=? AND username=? AND event_id=?",
            params![
                error.chars().take(1000).collect::<String>(),
                service,
                username,
                id
            ],
        )
        .map_err(database_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_isolated_queue_keeps_unacknowledged_and_blocked_records() {
        let root = std::env::temp_dir().join(format!(
            "delta-outbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let a = serde_json::json!({"eventId":"a", "action":"loaded"});
        let b = serde_json::json!({"eventId":"b", "action":"approved"});
        enqueue(&root, "service", "alice", &[a.clone(), b.clone()]).unwrap();
        enqueue(&root, "service", "alice", std::slice::from_ref(&a)).unwrap();
        enqueue(&root, "other", "alice", std::slice::from_ref(&a)).unwrap();
        enqueue(&root, "service", "bob", &[a]).unwrap();
        assert_eq!(status(&root, "service", "alice").unwrap().pending, 2);
        assert!(enqueue(
            &root,
            "service",
            "alice",
            &[serde_json::json!({"eventId":"a","action":"changed"})]
        )
        .is_err());
        block(&root, "service", "alice", "a", "REVIEW_EVENT_INVALID").unwrap();
        assert_eq!(batch(&root, "service", "alice", false).unwrap(), vec![b]);
        acknowledge(&root, "service", "alice", &["b".into()]).unwrap();
        let summary = status(&root, "service", "alice").unwrap();
        assert_eq!((summary.pending, summary.blocked), (1, 1));
        assert_eq!(batch(&root, "service", "alice", true).unwrap().len(), 1);
        acknowledge(&root, "service", "alice", &["a".into()]).unwrap();
        assert_eq!(status(&root, "service", "bob").unwrap().pending, 1);
        assert_eq!(status(&root, "other", "alice").unwrap().pending, 1);
        assert_eq!(status(&root, "service", "alice").unwrap().pending, 0);
        fs::remove_dir_all(root).unwrap();
    }
}
