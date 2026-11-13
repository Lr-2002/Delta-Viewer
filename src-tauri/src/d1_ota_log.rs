//! Durable, owner-scoped OTA observations. This journal never triggers an install.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaLogEvent {
    pub at_ms: u64,
    pub level: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaLogRecord {
    pub id: String,
    pub device_id: Option<String>,
    #[serde(default)]
    pub cid: Option<String>,
    pub operation_id: Option<String>,
    pub release_before: Option<String>,
    pub release_target: Option<String>,
    pub target_version: Option<String>,
    pub state: String,
    pub result: Option<String>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub events: Vec<OtaLogEvent>,
    pub truncated: bool,
    pub receipt: Option<crate::d1_logs::UploadReceipt>,
    // Internal status fingerprint; never uploaded as an API field.
    #[serde(default)]
    last_status: String,
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn database(root: &Path, owner: &str) -> Result<Connection, String> {
    let directory = root.join("reports").join("ota-history");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{}.sqlite", digest(owner.as_bytes())));
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("OTA_LOG_INVALID: 升级记录路径不是普通文件".into());
    }
    let db = Connection::open(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS ota_records(id TEXT PRIMARY KEY, updated INTEGER NOT NULL, body TEXT NOT NULL);").map_err(|e| e.to_string())?;
    Ok(db)
}
fn read_records(db: &Connection) -> Result<Vec<OtaLogRecord>, String> {
    let mut stmt = db
        .prepare("SELECT body FROM ota_records ORDER BY updated DESC, id DESC LIMIT 100")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        r.map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    })
    .collect()
}
fn save(db: &Connection, record: &OtaLogRecord) -> Result<(), String> {
    db.execute("INSERT INTO ota_records(id,updated,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,body=excluded.body",params![record.id,record.updated_at_ms,serde_json::to_string(record).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
fn event(record: &mut OtaLogRecord, level: &str, message: &str) {
    let safe = crate::d1_logs::safe_message(message).unwrap_or_else(|| "内容已脱敏".into());
    record.updated_at_ms = crate::d1::millis().max(record.updated_at_ms);
    record.events.push(OtaLogEvent {
        at_ms: record.updated_at_ms,
        level: level.into(),
        message: safe,
    });
    if record.events.len() > 200 {
        record.events.remove(0);
        record.truncated = true;
    }
    // A new observation is a new report snapshot; an old receipt belongs to the old snapshot.
    record.receipt = None;
}
fn new_record(device_id: Option<String>, id: String) -> OtaLogRecord {
    let now = crate::d1::millis();
    OtaLogRecord {
        id,
        device_id,
        cid: None,
        operation_id: None,
        release_before: None,
        release_target: None,
        target_version: None,
        state: "HOST_PREPARING".into(),
        result: None,
        started_at_ms: now,
        updated_at_ms: now,
        events: vec![],
        truncated: false,
        receipt: None,
        last_status: String::new(),
    }
}
pub fn list(root: &Path, owner: &str) -> Result<Vec<OtaLogRecord>, String> {
    read_records(&database(root, owner)?)
}
pub fn get(root: &Path, owner: &str, id: &str) -> Result<OtaLogRecord, String> {
    let db = database(root, owner)?;
    let body: String = db
        .query_row("SELECT body FROM ota_records WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "OTA_LOG_MISSING: 未找到该升级记录".to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}
pub fn begin(root: &Path, owner: &str, release: &str, version: &str) -> Result<String, String> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let operation: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let id = format!("ssh-{operation}");
    let mut record = new_record(None, id.clone());
    record.release_target = Some(release.into());
    record.target_version = Some(version.into());
    event(
        &mut record,
        "info",
        &format!("用户确认发送升级包：{release}（{version}）。上传回执不表示安装成功。"),
    );
    record.operation_id = Some(operation.clone());
    save(&database(root, owner)?, &record)?;
    Ok(operation)
}
pub fn identify(
    root: &Path,
    owner: &str,
    operation: &str,
    remote: &crate::d1_ssh::SshStatus,
) -> Result<(), String> {
    let id = format!("ssh-{operation}");
    let mut record = get(root, owner, &id)?;
    record.device_id = Some(remote.device_id.clone());
    record.cid = Some(remote.cid.clone());
    record.release_before = remote.status.release_before.clone();
    save(&database(root, owner)?, &record)
}
pub fn note(
    root: &Path,
    owner: &str,
    operation: &str,
    level: &str,
    message: &str,
) -> Result<(), String> {
    let mut record = get(root, owner, &format!("ssh-{operation}"))?;
    event(&mut record, level, message);
    save(&database(root, owner)?, &record)
}
pub fn submitted(
    root: &Path,
    owner: &str,
    operation: &str,
    result: &Result<crate::d1_ota::OtaSubmitResult, String>,
) -> Result<(), String> {
    let id = format!("ssh-{operation}");
    let mut db = database(root, owner)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let body: String = tx
        .query_row("SELECT body FROM ota_records WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let mut record: OtaLogRecord = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    match result {
        Ok(receipt) => {
            record.operation_id = receipt.operation_id.clone();
            if receipt.device_state.as_deref() == Some("UP_TO_DATE") {
                record.state = "UP_TO_DATE".into();
                record.result = Some("UP_TO_DATE".into());
                event(&mut record, "info", &receipt.message);
                save(&tx, &record)?;
                return tx.commit().map_err(|e| e.to_string());
            }
            if record.last_status.is_empty() {
                record.state = "HOST_SUBMITTED".into();
            }
            event(
                &mut record,
                "info",
                &format!(
                    "设备接收回执：{}。等待设备最终结果。",
                    receipt.operation_id.as_deref().unwrap_or("未提供操作编号")
                ),
            );
        }
        Err(error) => {
            if record.last_status.is_empty() {
                record.state = "HOST_UNCONFIRMED".into();
            }
            event(
                &mut record,
                "warning",
                &format!("发送未确认：{error}；设备安装结果未知，请查看设备状态。"),
            );
        }
    }
    save(&tx, &record)?;
    tx.commit().map_err(|e| e.to_string())
}
pub fn remember_receipt(
    root: &Path,
    owner: &str,
    id: &str,
    revision: &str,
    receipt: &crate::d1_logs::UploadReceipt,
) -> Result<(), String> {
    let mut db = database(root, owner)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let body: String = tx
        .query_row("SELECT body FROM ota_records WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let mut record: OtaLogRecord = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if crate::d1_logs::ota_revision(&record) == revision {
        record.receipt = Some(receipt.clone());
        save(&tx, &record)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn sync_ssh(root: &Path, owner: &str, remote: &crate::d1_ssh::SshStatus) -> Result<(), String> {
    let Some(operation) = remote.status.operation_id.as_deref() else {
        return Ok(());
    };
    let id = format!("ssh-{operation}");
    let mut db = database(root, owner)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let previous = tx
        .query_row("SELECT body FROM ota_records WHERE id=?1", [&id], |r| {
            r.get::<_, String>(0)
        })
        .ok();
    let mut record = previous
        .as_deref()
        .map(serde_json::from_str::<OtaLogRecord>)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| new_record(Some(remote.device_id.clone()), id));
    record.cid = Some(remote.cid.clone());
    record.device_id = Some(remote.device_id.clone());
    record.operation_id = Some(operation.into());
    let fingerprint = serde_json::to_string(&(
        &remote.status.state,
        &remote.status.result,
        &remote.status.reason,
        &remote.events,
    ))
    .map_err(|e| e.to_string())?;
    if record.last_status == fingerprint {
        return Ok(());
    }
    record.state = remote
        .status
        .state
        .clone()
        .unwrap_or_else(|| "UNKNOWN".into());
    record.result = remote.status.result.clone();
    record.release_before = remote.status.release_before.clone();
    record.release_target = remote.status.release_target.clone();
    record.target_version = remote.status.target_version.clone();
    let local_events: Vec<_> = record
        .events
        .iter()
        .filter(|entry| {
            entry.message.starts_with("用户确认") || entry.message.starts_with("设备无法完成")
        })
        .cloned()
        .collect();
    record.events = local_events
        .into_iter()
        .chain(remote.events.iter().map(|entry| OtaLogEvent {
            at_ms: entry.at_ms,
            level: entry.level.clone(),
            message:
                crate::d1_logs::safe_message(&entry.message).unwrap_or_else(|| "内容已脱敏".into()),
        }))
        .collect();
    record.events.sort_by_key(|entry| entry.at_ms);
    if record.events.len() > 200 {
        record.truncated = true;
        record.events.drain(..record.events.len() - 200);
    }
    if let Some(first) = record.events.first() {
        record.started_at_ms = first.at_ms;
    }
    if let Some(last) = record.events.last() {
        record.updated_at_ms = last.at_ms.max(record.started_at_ms);
    }
    if let Some(reason) = &remote.status.reason {
        event(&mut record, "warning", &format!("设备状态说明：{reason}"));
    }
    record.last_status = fingerprint;
    record.receipt = None;
    if record.events.is_empty() {
        let message = format!(
            "SSH 升级操作 {operation}：{}。安装结果以设备最终状态为准。",
            record.state
        );
        event(&mut record, "info", &message);
    }
    save(&tx, &record)?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_build_receipt_is_final_without_waiting_for_an_install() {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("d1-current-log-{:x}", u128::from_le_bytes(nonce)));
        let operation = begin(&root, "alice", "factory-build", "1.3.1").unwrap();
        let receipt = crate::d1_ota::OtaSubmitResult {
            release_id: "factory-build".into(),
            version: "1.3.1".into(),
            operation_id: Some(operation.clone()),
            device_state: Some("UP_TO_DATE".into()),
            message: "当前已是最新版本 1.3.1，无需升级。".into(),
        };
        submitted(&root, "alice", &operation, &Ok(receipt)).unwrap();
        let saved = get(&root, "alice", &format!("ssh-{operation}")).unwrap();
        assert_eq!(saved.state, "UP_TO_DATE");
        assert_eq!(saved.result.as_deref(), Some("UP_TO_DATE"));
        assert!(saved.events.last().unwrap().message.contains("无需升级"));
        assert!(!saved.events.last().unwrap().message.contains("等待"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_survives_reopen_isolates_owners_and_keeps_receipt_for_its_revision() {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("d1-ota-log-{:x}", u128::from_le_bytes(nonce)));
        let operation = begin(&root, "alice", "release-fixture", "1.3.1").unwrap();
        let id = format!("ssh-{operation}");
        assert_eq!(list(&root, "alice").unwrap().len(), 1);
        assert!(list(&root, "bob").unwrap().is_empty());
        assert!(get(&root, "bob", &id).is_err());
        let mut record = get(&root, "alice", &id).unwrap();
        let revision = crate::d1_logs::ota_revision(&record);
        let receipt = crate::d1_logs::UploadReceipt {
            report_id: "frozen-report".into(),
            device_id: "device-fixture".into(),
            entry_count: 1,
            message: "accepted".into(),
        };
        remember_receipt(&root, "alice", &id, &revision, &receipt).unwrap();
        assert!(get(&root, "alice", &id).unwrap().receipt.is_some());
        note(
            &root,
            "alice",
            &operation,
            "warning",
            "password=secret-fixture",
        )
        .unwrap();
        record = get(&root, "alice", &id).unwrap();
        assert!(record.receipt.is_none());
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains("secret-fixture"));
        remember_receipt(&root, "alice", &id, &revision, &receipt).unwrap();
        assert!(
            get(&root, "alice", &id).unwrap().receipt.is_none(),
            "late upload receipt cannot label changed logs as uploaded"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
