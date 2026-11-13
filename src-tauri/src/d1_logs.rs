//! Device diagnostic log collection and upload to the D1 Dashboard API.
//!
//! The person selects one session folder that already exists on disk; this module
//! reads the recorded `session.json` (for the real eMMC CID and identity), the
//! `.session_meta/recording.log.jsonl` event stream and any bounded `.gst.log`
//! text, reduces them to at most 200 accepted log entries and uploads one
//! `runtime-diagnostic` report. A matching backend-owned diagnostic run may be
//! included; unavailable checks stay unknown rather than becoming fabricated passes.
use crate::d1_device::safe_text;
use crate::d1_services;
use crate::error::{AppError, AppResult};
use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION_SCHEMA: &str = "dohc.recording.session-metadata.v1";
const SESSION_LOG_SCHEMA: &str = "dohc.recording.session-log.v1";
const MAX_SESSION_JSON_BYTES: u64 = 1024 * 1024;
const MAX_SESSION_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GST_LOG_BYTES: u64 = 512 * 1024;
const MAX_LOG_ENTRIES: usize = 200;
const MAX_MESSAGE_CHARS: usize = 2000;
const MAX_COMPONENT_CHARS: usize = 120;
const MAX_BODY_BYTES: u64 = 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPreview {
    pub preview_id: String,
    pub report_type: String,
    pub check_count: usize,
    pub source: String,
    pub device_id: Option<String>,
    pub has_cid: bool,
    pub workspace_version: Option<String>,
    pub release_id: Option<String>,
    pub total_entries: usize,
    pub selected_entries: usize,
    pub levels: LevelCounts,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub truncated: bool,
    pub file_count: usize,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelCounts {
    pub error: usize,
    pub warning: usize,
    pub info: usize,
    pub debug: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReceipt {
    pub report_id: String,
    pub device_id: String,
    pub entry_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    pub preview_id: String,
}

struct FrozenReport {
    owner: String,
    preview_id: String,
    report_id: String,
    idempotency_key: String,
    body: Vec<u8>,
    entry_count: usize,
    created: Instant,
    ota_source: Option<(String, String)>,
}
#[derive(Clone, Default)]
pub struct ReportState(Arc<Mutex<Vec<Arc<FrozenReport>>>>);
impl ReportState {
    fn get(&self, owner: &str, id: &str) -> Result<Arc<FrozenReport>, String> {
        self.0
            .lock()
            .map_err(|_| "DIAGNOSTIC_STATE_UNAVAILABLE")?
            .iter()
            .find(|v| {
                v.owner == owner
                    && v.preview_id == id
                    && v.created.elapsed() < Duration::from_secs(86400)
            })
            .cloned()
            .ok_or_else(|| "DIAGNOSTIC_PREVIEW_EXPIRED: 请重新预览检测日志".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    occurred_at: String,
    level: String,
    component: String,
    message: String,
}

#[derive(Debug, Clone)]
struct Collected {
    cid: String,
    device_id: String,
    workspace_version: Option<String>,
    release_id: Option<String>,
    firmware_version: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    entries: Vec<LogEntry>,
    total: usize,
    truncated: bool,
    file_count: usize,
}

fn timestamp_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format_rfc3339(ms as u64)
}

fn format_rfc3339(ms: u64) -> String {
    // Minimal UTC formatter: enough for the API's RFC3339 requirement without
    // pulling a date library into this module.
    let seconds = ms / 1000;
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        ms % 1000
    )
}

/// Howard Hinnant's civil-from-days algorithm (proleptic Gregorian, UTC).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "缺失".to_string(),
        _ => format!("无法读取: {error}"),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("不是普通文件".into());
    }
    if metadata.len() > limit {
        return Err(format!("超过 {} 字节限制", limit));
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("无法读取: {error}"))
}

fn session_file(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn metadata_dir(root: &Path) -> PathBuf {
    root.join(".session_meta")
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty() && item.len() <= 160 && !item.chars().any(char::is_control))
        .map(str::to_string)
}

fn normalize_cid(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (normalized.len() == 32 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(normalized)
}

/// Parsed identity from a recorded session.
type SessionIdentity = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Parsed identity from a recorded session, using the fields that are actually
/// written by the capture program (`device.emmc_cid`, `device.device_id`).
fn read_session(root: &Path) -> Result<SessionIdentity, String> {
    let path = session_file(root, "session.json");
    let bytes = match read_bounded(&path, MAX_SESSION_JSON_BYTES)? {
        Some(bytes) => bytes,
        None => {
            return Err("SESSION_METADATA_MISSING: 当前目录不是含 session.json 的采集会话".into())
        }
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "SESSION_METADATA_INVALID: session.json 不是有效 JSON".to_string())?;
    if text_field(&value, "schema").as_deref() != Some(SESSION_SCHEMA) {
        return Err("SESSION_METADATA_INVALID: session.json schema 不受支持".into());
    }
    let device = value.get("device").cloned().unwrap_or(Value::Null);
    let cid = text_field(&device, "emmc_cid")
        .and_then(|value| normalize_cid(&value))
        .ok_or_else(|| {
            "SESSION_CID_MISSING: session.json 未记录设备 eMMC CID，无法关联已登记设备".to_string()
        })?;
    let device_id = text_field(&device, "device_id")
        .ok_or_else(|| "SESSION_DEVICE_ID_MISSING: session.json 未记录设备标识".to_string())?;
    let software = value.get("software").cloned().unwrap_or(Value::Null);
    Ok((
        cid,
        device_id,
        text_field(&software, "workspace_version")
            .or_else(|| text_field(&value, "workspace_version")),
        text_field(&software, "release_id").or_else(|| text_field(&value, "release_id")),
        text_field(&software, "firmware_version")
            .or_else(|| text_field(&value, "firmware_version")),
        text_field(&value, "started_at"),
        text_field(&value, "completed_at"),
    ))
}

fn default_level(event: &str, detail: &Value) -> &'static str {
    let upper = event.to_ascii_uppercase();
    if upper.contains("FAIL")
        || upper.contains("ERROR")
        || upper.contains("TIMEOUT")
        || upper.contains("FAULT")
    {
        if detail.get("recovered").and_then(|value| value.as_bool()) == Some(true) {
            return "warning";
        }
        return "error";
    }
    if upper.contains("WARN")
        || upper.contains("DEGRAD")
        || upper.contains("RETRY")
        || upper.contains("GAP")
        || upper.contains("DROPPED")
    {
        return "warning";
    }
    if upper.contains("DEBUG") || upper.contains("TRACE") {
        return "debug";
    }
    "info"
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.encode_utf16().count() <= max {
        return trimmed.to_string();
    }
    let mut used = 0;
    trimmed
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used < max
        })
        .chain(std::iter::once('…'))
        .collect()
}

fn component(value: &str) -> String {
    let clipped = clip(value, MAX_COMPONENT_CHARS);
    if clipped.is_empty() {
        "capture".into()
    } else {
        clipped
    }
}

pub(crate) fn safe_message(value: &str) -> Option<String> {
    // Reuse the health-report redactor so credentials never reach an upload.
    safe_text(value).map(|text| clip(&text, MAX_MESSAGE_CHARS))
}

fn jsonl_entries(root: &Path, out: &mut Vec<LogEntry>) -> (usize, usize) {
    let path = metadata_dir(root).join("recording.log.jsonl");
    let Ok(Some(bytes)) = read_bounded(&path, MAX_SESSION_LOG_BYTES) else {
        return (0, 0);
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut count = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if text_field(&value, "schema").as_deref() != Some(SESSION_LOG_SCHEMA) {
            continue;
        }
        let Some(event) = text_field(&value, "event") else {
            continue;
        };
        let Some(occurred_at) = text_field(&value, "timestamp") else {
            continue;
        };
        if !occurred_at.ends_with('Z') || !occurred_at.contains('T') {
            continue;
        }
        let details = value.get("details").cloned().unwrap_or(Value::Null);
        let message = serde_json::to_string(&details).unwrap_or_default();
        let message =
            safe_message(&format!("{event} {}", message)).unwrap_or_else(|| event.clone());
        out.push(LogEntry {
            occurred_at,
            level: default_level(&event, &details).into(),
            component: component(&event),
            message,
        });
        count += 1;
    }
    (count, out.len())
}

fn gst_entries(root: &Path, out: &mut Vec<LogEntry>) -> (usize, usize) {
    let dir = metadata_dir(root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return (0, 0);
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".gst.log"))
        })
        .collect();
    files.sort();
    files.truncate(16);
    let mut count = 0;
    for file in files {
        let Ok(Some(bytes)) = read_bounded(&file, MAX_GST_LOG_BYTES) else {
            continue;
        };
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.trim_end_matches(".gst.log").to_string())
            .unwrap_or_else(|| "gst".into());
        for line in String::from_utf8_lossy(&bytes).lines() {
            let trimmed = line.trim();
            if !trimmed.contains(": ") {
                continue;
            }
            let level = if trimmed.contains("error")
                || trimmed.contains("ERROR")
                || trimmed.contains("fail")
            {
                "error"
            } else if trimmed.contains("warn") || trimmed.contains("WARN") {
                "warning"
            } else {
                "info"
            };
            let Some(message) = safe_message(trimmed) else {
                continue;
            };
            out.push(LogEntry {
                // `.gst.log` has no timestamp of its own; anchor it to the
                // session completion so ordering stays deterministic and honest.
                occurred_at: String::new(),
                level: level.into(),
                component: component(&name),
                message,
            });
            count += 1;
            if out.len() > MAX_LOG_ENTRIES * 8 {
                break;
            }
        }
    }
    (count, out.len())
}

fn collect(root: &Path) -> Result<Collected, String> {
    let canonical = fs::canonicalize(root)
        .map_err(|_| "SESSION_SOURCE_INVALID: 选择的目录不可用".to_string())?;
    if !canonical.is_dir() {
        return Err("SESSION_SOURCE_INVALID: 请选择一条采集会话目录".into());
    }
    let (cid, device_id, workspace_version, release_id, firmware_version, started_at, completed_at) =
        read_session(&canonical)?;
    let mut entries = Vec::new();
    let (jsonl_count, mut total) = jsonl_entries(&canonical, &mut entries);
    let (gst_count, gst_total) = gst_entries(&canonical, &mut entries);
    total = total.max(jsonl_count + gst_count);
    // Anchor untimestamped text logs to the session end time (or now).
    let anchor = completed_at.clone().unwrap_or_else(timestamp_now);
    for entry in entries.iter_mut() {
        if entry.occurred_at.is_empty() {
            entry.occurred_at = anchor.clone();
        }
    }
    entries.sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    let seen = entries.len();
    let keep = entries.split_off(seen.saturating_sub(MAX_LOG_ENTRIES));
    Ok(Collected {
        cid,
        device_id,
        workspace_version,
        release_id,
        firmware_version,
        started_at,
        completed_at,
        truncated: gst_total > MAX_LOG_ENTRIES || total > MAX_LOG_ENTRIES,
        entries: keep,
        total,
        file_count: 1 + usize::from(
            metadata_dir(&canonical)
                .join("recording.log.jsonl")
                .is_file(),
        ),
    })
}

fn level_counts(entries: &[LogEntry]) -> LevelCounts {
    let mut counts = LevelCounts::default();
    for entry in entries {
        match entry.level.as_str() {
            "error" => counts.error += 1,
            "warning" => counts.warning += 1,
            "debug" => counts.debug += 1,
            _ => counts.info += 1,
        }
    }
    counts
}

#[cfg(test)]
fn preview(source: &str) -> Result<LogPreview, String> {
    let collected = collect(Path::new(source))?;
    Ok(preview_collected(source, &collected))
}

fn preview_collected(source: &str, collected: &Collected) -> LogPreview {
    LogPreview {
        preview_id: String::new(),
        report_type: "runtime-diagnostic".into(),
        check_count: 0,
        source: source.into(),
        has_cid: true,
        device_id: Some(collected.device_id.clone()),
        workspace_version: collected.workspace_version.clone(),
        release_id: collected.release_id.clone(),
        total_entries: collected.total,
        selected_entries: collected.entries.len(),
        levels: level_counts(&collected.entries),
        started_at: collected.started_at.clone(),
        completed_at: collected.completed_at.clone(),
        truncated: collected.truncated,
        file_count: collected.file_count,
    }
}

pub async fn service_status() -> AppResult<d1_services::DiagnosticServiceStatus> {
    let config = d1_services::load()?;
    let upload = config.diagnostic_upload;
    let origin = upload
        .origin
        .as_deref()
        .and_then(|value| d1_services::origin(value).ok());
    Ok(d1_services::DiagnosticServiceStatus {
        enabled: upload.enabled && origin.is_some(),
        origin: origin.map(|value| value.base),
        detail: if upload.enabled && upload.origin.is_some() {
            "诊断日志将上传至已配置的 Dashboard 服务，需设备已登记。".into()
        } else {
            "日志上传服务尚未配置".into()
        },
    })
}

pub fn preview_source(
    state: &ReportState,
    owner: &str,
    source: &str,
    run: Option<&crate::d1::DiagnosticRun>,
) -> AppResult<LogPreview> {
    let collected = collect(Path::new(source)).map_err(AppError::Message)?;
    let mut preview = preview_collected(source, &collected);
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|_| AppError::Message("DIAGNOSTIC_RANDOM_UNAVAILABLE".into()))?;
    let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let report_id = format!("host-log-{token}");
    let bytes = build_body(&collected, &report_id).map_err(AppError::Message)?;
    let mut body: Value = serde_json::from_slice(&bytes)?;
    if let Some(run) = run {
        append_run(&mut body, &collected, run).map_err(AppError::Message)?;
        preview.check_count = run.checks.len().min(64);
        preview.report_type = "runtime-diagnostic".into();
        preview.started_at = Some(format_rfc3339(run.started_at_ms));
        preview.completed_at = Some(format_rfc3339(run.finished_at_ms.max(run.started_at_ms)));
        // Report the versions observed now, not the versions in an old recording.
        preview.workspace_version = run
            .device
            .as_ref()
            .and_then(|d| d.application_version.clone());
        preview.release_id = run.device.as_ref().and_then(|d| d.release_id.clone());
    }
    let bytes = bounded_body(&mut body).map_err(AppError::Message)?;
    preview.selected_entries = body["logs"].as_array().map_or(0, Vec::len);
    preview.truncated |= preview.selected_entries < collected.entries.len();
    preview.preview_id = token.clone();
    let frozen = Arc::new(FrozenReport {
        owner: owner.into(),
        preview_id: token,
        report_id: report_id.clone(),
        idempotency_key: format!("diag-{report_id}"),
        body: bytes,
        entry_count: preview.selected_entries,
        created: Instant::now(),
        ota_source: None,
    });
    let mut reports = state
        .0
        .lock()
        .map_err(|_| AppError::Message("DIAGNOSTIC_STATE_UNAVAILABLE".into()))?;
    reports.retain(|v| v.created.elapsed() < Duration::from_secs(86400));
    if reports.len() >= 8 {
        reports.remove(0);
    }
    reports.push(frozen);
    Ok(preview)
}

/// Freeze a backend-owned OTA observation. Prefer its SSH hardware CID; old
/// records can use a same-device recording. IPC never accepts a report body.
pub fn ota_revision(record: &crate::d1_ota_log::OtaLogRecord) -> String {
    use sha2::{Digest, Sha256};
    let value = json!([
        record.id,
        record.device_id,
        record.cid,
        record.operation_id,
        record.state,
        record.result,
        record.release_before,
        record.release_target,
        record.target_version,
        record.started_at_ms,
        record.updated_at_ms,
        record.events,
        record.truncated
    ]);
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
pub fn preview_ota_source(
    state: &ReportState,
    owner: &str,
    source: &str,
    record: &crate::d1_ota_log::OtaLogRecord,
) -> AppResult<LogPreview> {
    use sha2::{Digest, Sha256};
    let (cid, device_id) = if let (Some(cid), Some(id)) = (&record.cid, &record.device_id) {
        (cid.clone(), id.clone())
    } else {
        let (cid, id, _, _, _, _, _) =
            read_session(Path::new(source)).map_err(AppError::Message)?;
        (cid, id)
    };
    if cid.len() != 32 || !cid.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(AppError::Message(
            "DIAGNOSTIC_CID_INVALID: 升级记录缺少完整硬件 CID，不能关联售后档案".into(),
        ));
    }
    let observed_device = record.device_id.as_deref().ok_or_else(|| AppError::Message("OTA_LOG_DEVICE_UNKNOWN: 此升级记录未取得设备标识，不能自动关联售后档案。请连接可读取状态的设备后刷新升级记录。".into()))?;
    if observed_device != device_id {
        return Err(AppError::Message(
            "DIAGNOSTIC_DEVICE_MISMATCH: 采集目录与升级记录属于不同设备".into(),
        ));
    }
    let revision = ota_revision(record);
    let token = format!(
        "{:x}",
        Sha256::digest(format!("{cid}/{revision}").as_bytes())
    );
    let report_id = format!("host-ota-{token}");
    let entries: Vec<LogEntry> = record
        .events
        .iter()
        .map(|event| LogEntry {
            occurred_at: format_rfc3339(event.at_ms),
            level: event.level.clone(),
            component: "device-ota".into(),
            message: event.message.clone(),
        })
        .collect();
    let failed = record.result.as_deref() == Some("FAIL")
        || matches!(record.state.as_str(), "FAILED" | "ROLLBACK_FAILED");
    let passed = (record.state == "SUCCESS" && record.result.as_deref() == Some("PASS"))
        || record.state == "UP_TO_DATE";
    let mut body = json!({"cid":cid,"reportId":report_id,"reportType":"runtime-diagnostic",
        "outcome":if failed {"failed"} else if passed {"passed"} else {"degraded"},
        "observedStartedAt":format_rfc3339(record.started_at_ms),"observedCompletedAt":format_rfc3339(record.updated_at_ms.max(record.started_at_ms)),
        "summary":format!("DOHC 应用升级观测：操作 {}；目标 {}；状态 {}。仅记录上位机实际接收的状态，发送成功不表示安装成功。",record.operation_id.as_deref().unwrap_or("回执未确认"),record.release_target.as_deref().unwrap_or("未提供"),record.state),
        "stages":[{"name":"device-ota-observation","outcome":if failed {"failed"} else if passed {"passed"} else {"skipped"},
            "summary":"来自本机持久升级记录；未知或中断保持未知，不生成硬件自检结论。","checks":[]}],
        "alerts":[],"logs":entries});
    let bytes = bounded_body(&mut body).map_err(AppError::Message)?;
    let count = body["logs"].as_array().map_or(0, Vec::len);
    let frozen = Arc::new(FrozenReport {
        owner: owner.into(),
        preview_id: token.clone(),
        report_id: report_id.clone(),
        idempotency_key: format!("diag-{report_id}"),
        body: bytes,
        entry_count: count,
        created: Instant::now(),
        ota_source: Some((record.id.clone(), revision)),
    });
    let mut reports = state
        .0
        .lock()
        .map_err(|_| AppError::Message("DIAGNOSTIC_STATE_UNAVAILABLE".into()))?;
    reports.retain(|v| v.created.elapsed() < Duration::from_secs(86400));
    if !reports
        .iter()
        .any(|r| r.owner == owner && r.preview_id == token)
    {
        if reports.len() >= 8 {
            reports.remove(0);
        }
        reports.push(frozen);
    }
    Ok(LogPreview {
        preview_id: token,
        report_type: "runtime-diagnostic".into(),
        check_count: 0,
        source: source.into(),
        device_id: Some(device_id),
        has_cid: true,
        workspace_version: None,
        release_id: record.release_target.clone(),
        total_entries: entries.len(),
        selected_entries: count,
        levels: level_counts(&entries),
        started_at: Some(format_rfc3339(record.started_at_ms)),
        completed_at: Some(format_rfc3339(record.updated_at_ms)),
        truncated: record.truncated || count < entries.len(),
        file_count: 0,
    })
}
pub fn ota_source(state: &ReportState, owner: &str, preview_id: &str) -> Option<(String, String)> {
    state.get(owner, preview_id).ok()?.ota_source.clone()
}

fn append_run(
    body: &mut Value,
    collected: &Collected,
    run: &crate::d1::DiagnosticRun,
) -> Result<(), String> {
    use crate::d1::{ResultStatus, TaskStatus};
    let device = run
        .device
        .as_ref()
        // This flag describes cryptographic authentication, which the current
        // device-report protocol does not provide. It is not an identity-read
        // success flag. Match the actual report identity to the session instead.
        .filter(|d| !d.id.is_empty() && d.id != "unknown")
        .ok_or("DIAGNOSTIC_DEVICE_UNKNOWN: 检测未读取真实设备身份，请重新检测")?;
    if device.id != collected.device_id {
        return Err(
            "DIAGNOSTIC_DEVICE_MISMATCH: 此采集目录属于另一台设备，请选择当前 D1 的采集目录".into(),
        );
    }
    let failed = run
        .checks
        .iter()
        .any(|c| c.status == ResultStatus::Abnormal);
    let incomplete = run.status != TaskStatus::Completed
        || run.checks.is_empty()
        || run.checks.len() > 64
        || run.checks.iter().any(|c| {
            matches!(
                c.status,
                ResultStatus::Indeterminate | ResultStatus::Unsupported | ResultStatus::NotRun
            )
        });
    body["reportType"] = json!("runtime-diagnostic");
    body["outcome"] = json!(if failed {
        "failed"
    } else if incomplete {
        "degraded"
    } else {
        "passed"
    });
    body["observedStartedAt"] = json!(format_rfc3339(run.started_at_ms));
    body["observedCompletedAt"] = json!(format_rfc3339(run.finished_at_ms.max(run.started_at_ms)));
    body["summary"] = json!(format!(
        "D1 Manager 只读检测：{} 项；未执行或无法判断的项目保留为未知。附采集会话最近日志。",
        run.checks.len()
    ));
    body["stages"] = json!([{
        "name":"device-health-observation", "outcome":if failed {"failed"} else if incomplete {"skipped"} else {"passed"},
        "summary":"仅包含设备实际返回的观测与检测证据，未启动设备自检或压力测试。",
        "checks":run.checks.iter().take(64).enumerate().map(|(i,c)|json!({"name":clip(&format!("{} {}",i+1,c.name),120),
            "outcome": match c.status {ResultStatus::Normal=>"passed",ResultStatus::Abnormal=>"failed",_=>"warning"},
            "summary":clip(&safe_message(&format!("{:?}：{}",c.status,c.evidence)).unwrap_or_else(||"证据已脱敏".into()),1000)
        })).collect::<Vec<_>>()
    },{"name":"host-log-collection","outcome":"passed","checks":[],"summary":"采集日志来自已核对同一设备标识的本地会话目录"}]);
    if let Some(snapshot) = &run.observation {
        body["alerts"] = json!(snapshot.alerts.iter().take(64).map(|a|json!({"code":clip(&a.code,120),
            "severity":match a.severity.as_deref(){Some("critical")=>"critical",Some("info")=>"info",_=>"warning"},
            "summary":clip(&safe_message(a.message.as_deref().unwrap_or(&a.code)).unwrap_or_else(||"告警内容已脱敏".into()),2000)
        })).collect::<Vec<_>>());
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("workspaceVersion");
        object.remove("firmwareVersion");
    }
    if let Some(v) = &device.application_version {
        body["workspaceVersion"] = json!(clip(v, 80));
    }
    if let Some(v) = &device.firmware {
        body["firmwareVersion"] = json!(clip(v, 80));
    }
    Ok(())
}

fn bounded_body(body: &mut Value) -> Result<Vec<u8>, String> {
    loop {
        let text = json!({"summary":body["summary"],"stages":body["stages"],"alerts":body["alerts"],"logs":body["logs"]});
        let bytes = serde_json::to_vec(body).map_err(|_| "UPLOAD_BODY_INVALID")?;
        if bytes.len() <= MAX_BODY_BYTES as usize
            && serde_json::to_vec(&text)
                .map_err(|_| "UPLOAD_BODY_INVALID")?
                .len()
                <= 512 * 1024
        {
            return Ok(bytes);
        }
        let logs = body["logs"].as_array_mut().ok_or("UPLOAD_BODY_INVALID")?;
        if logs.is_empty() {
            return Err("UPLOAD_BODY_TOO_LARGE: 检测报告超过接口大小限制".into());
        }
        logs.remove(0);
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = (8..=160).contains(&value.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-')
        });
    if !valid {
        return Err(format!("UPLOAD_IDENTIFIER_INVALID: {label} 格式无效"));
    }
    Ok(())
}

fn build_body(collected: &Collected, report_id: &str) -> Result<Vec<u8>, String> {
    let now = timestamp_now();
    let started = collected
        .started_at
        .clone()
        .or_else(|| {
            collected
                .entries
                .first()
                .map(|entry| entry.occurred_at.clone())
        })
        .unwrap_or_else(|| now.clone());
    let completed = collected
        .completed_at
        .clone()
        .or_else(|| {
            collected
                .entries
                .last()
                .map(|entry| entry.occurred_at.clone())
        })
        .unwrap_or_else(|| now.clone());
    let outcome = if collected.entries.is_empty()
        || collected.entries.iter().any(|entry| entry.level == "error")
    {
        "degraded"
    } else {
        "passed"
    };
    let alerts: Vec<Value> = collected
        .entries
        .iter()
        .filter(|entry| entry.level == "error")
        .take(64)
        .map(|entry| {
            json!({
                "code": format!("HOST_LOG_{}", clip(&entry.component, 100)),
                "severity": "warning",
                "summary": entry.message,
            })
        })
        .collect();
    let logs: Vec<Value> = collected
        .entries
        .iter()
        .map(|entry| {
            json!({
                "occurredAt": entry.occurred_at,
                "level": entry.level,
                "component": entry.component,
                "message": entry.message,
            })
        })
        .collect();
    let mut body = json!({
        "cid": collected.cid,
        "reportId": report_id,
        "reportType": "runtime-diagnostic",
        "outcome": outcome,
        "observedStartedAt": started,
        "observedCompletedAt": if completed < started { started } else { completed },
        "summary": format!(
            "上位机收集采集会话日志：共 {} 条事件，上传最近 {} 条{}。",
            collected.total,
            collected.entries.len(),
            if collected.truncated { "（已裁剪较早内容）" } else { "" }
        ),
        "stages": [{
            "name": "host-log-collection",
            "outcome": "passed",
            "summary": format!(
                "读取 session.json 与 {} 个日志文件",
                collected.file_count.saturating_sub(1)
            ),
            "checks": [],
        }],
        "alerts": alerts,
        "logs": logs,
    });
    if let Some(version) = &collected.workspace_version {
        body["workspaceVersion"] = Value::String(clip(version, 80));
    }
    if let Some(version) = &collected.firmware_version {
        body["firmwareVersion"] = Value::String(clip(version, 80));
    }
    bounded_body(&mut body)
}

fn upload_url(origin: &d1_services::Origin) -> String {
    format!(
        "{}/api/v1/device-enrollment/diagnostic-reports",
        origin.base
    )
}

async fn post_report(
    client: &reqwest::Client,
    url: &str,
    body: Vec<u8>,
    idempotency_key: &str,
) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", idempotency_key)
        .body(body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "UPLOAD_TIMEOUT: 日志上传超时，可用相同内容重试".to_string()
            } else {
                "UPLOAD_NETWORK_FAILED: 无法连接日志服务，请检查内网".to_string()
            }
        })?;
    let status = response.status().as_u16();
    use futures_util::StreamExt;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "UPLOAD_RESPONSE_INVALID: 日志服务响应读取失败")?;
        if bytes.len() + part.len() > 1024 * 1024 {
            return Err("UPLOAD_RESPONSE_INVALID: 日志服务响应过大".into());
        }
        bytes.extend_from_slice(&part);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status == 201 {
        return Ok(value);
    }
    let code = text_field(&value["error"], "code").unwrap_or_else(|| status.to_string());
    let message =
        text_field(&value["error"], "message").unwrap_or_else(|| "日志服务拒绝上传".into());
    Err(format!("UPLOAD_FAILED_{status}_{code}: {message}"))
}

pub async fn upload(
    state: &ReportState,
    owner: &str,
    request: UploadRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<UploadReceipt, String> {
    let frozen = state.get(owner, &request.preview_id)?;
    validate_identifier(&frozen.report_id, "reportId")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("DIAGNOSTIC_CANCELLED: 上传已取消，未发送".into());
    }
    let config = d1_services::load().map_err(|error| error.to_string())?;
    if !config.diagnostic_upload.enabled {
        return Err("DIAGNOSTIC_UPLOAD_DISABLED: 日志上传服务尚未启用".into());
    }
    let origin_value = config
        .diagnostic_upload
        .origin
        .as_deref()
        .ok_or_else(|| "DIAGNOSTIC_ORIGIN_UNCONFIGURED: 日志上传地址尚未配置".to_string())?;
    let origin = d1_services::origin(origin_value)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .map_err(|_| "UPLOAD_CLIENT_UNAVAILABLE: 无法建立上传连接".to_string())?;
    // The body and key are immutable across retries, including an uncertain receipt.
    let value = post_report(
        &client,
        &upload_url(&origin),
        frozen.body.clone(),
        &frozen.idempotency_key,
    )
    .await?;
    let report = &value["data"]["report"];
    let device_id = text_field(report, "deviceId")
        .ok_or("UPLOAD_RECEIPT_INVALID: 缺少设备档案关联，请用原报告重试确认")?;
    if text_field(report, "reportId").as_deref() != Some(frozen.report_id.as_str())
        || text_field(report, "kind").as_deref() != Some("device-diagnostic-report-v1")
        || text_field(report, "id").is_none()
    {
        return Err("UPLOAD_RECEIPT_INVALID: 上传回执不匹配，请用原报告重试确认".into());
    }
    Ok(UploadReceipt {
        report_id: frozen.report_id.clone(),
        device_id,
        entry_count: frozen.entry_count,
        message: "已上传至 Device 设备档案，可在详细诊断报告中查看。".into(),
    })
}

/// Save the last upload receipt under the app data root for troubleshooting.
pub fn remember(app_data: &Path, receipt: &UploadReceipt) -> AppResult<PathBuf> {
    let directory = app_data.join("reports").join("diagnostic-uploads");
    fs::create_dir_all(&directory)?;
    let name = format!(
        "{}.json",
        receipt
            .report_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            })
            .collect::<String>()
    );
    let destination = directory.join(name);
    if destination.exists() {
        return Ok(destination);
    }
    let partial = directory.join(format!(
        ".partial-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let payload = serde_json::to_vec_pretty(receipt)?;
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)?;
        file.write_all(&payload)?;
        file.sync_all()?;
    }
    let result = storage::publish_noreplace(&partial, &destination);
    let _ = fs::remove_file(&partial);
    result.map(|_| destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dohc-d1-logs-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".session_meta")).unwrap();
        root
    }

    #[test]
    fn frozen_report_survives_source_change_and_is_bound_to_owner() {
        let root = temp_root("frozen");
        fs::write(root.join("session.json"),br#"{"schema":"dohc.recording.session-metadata.v1","device":{"device_id":"fixture-device","emmc_cid":"f4012241524a313158155c1983481c00"}}"#).unwrap();
        let state = ReportState::default();
        let preview = preview_source(&state, "owner", root.to_str().unwrap(), None).unwrap();
        let before = state.get("owner", &preview.preview_id).unwrap();
        fs::write(root.join("session.json"), b"changed").unwrap();
        let retry = state.get("owner", &preview.preview_id).unwrap();
        assert_eq!(before.body, retry.body);
        assert_eq!(before.idempotency_key, retry.idempotency_key);
        assert!(state.get("other", &preview.preview_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn device_checks_keep_unknown_and_reject_other_device_identity() {
        use crate::d1::{CheckResult, DiagnosticRun, ResultStatus, TaskStatus};
        let collected = Collected {
            cid: "f4012241524a313158155c1983481c00".into(),
            device_id: "fixture-device".into(),
            workspace_version: None,
            release_id: None,
            firmware_version: None,
            started_at: None,
            completed_at: None,
            entries: vec![],
            total: 0,
            truncated: false,
            file_count: 1,
        };
        let device = crate::d1_device::DeviceIdentity {
            id: "fixture-device".into(),
            application_version: Some("1.1.1".into()),
            release_id: None,
            firmware: None,
            hardware_profile: None,
            architecture: None,
            channel: None,
            source: "fixture",
            identity_verified: false,
        };
        let mut run = DiagnosticRun {
            id: "fixture".into(),
            source: "fixture",
            device: Some(device),
            observation: None,
            started_at_ms: 1,
            finished_at_ms: 2,
            status: TaskStatus::Completed,
            checks: vec![CheckResult {
                id: "camera".into(),
                name: "相机".into(),
                status: ResultStatus::Indeterminate,
                evidence: "未提供".into(),
                observed_at_ms: None,
                rule_version: "fixture".into(),
                applicable_firmware: "fixture".into(),
                suggestion: String::new(),
                error_kind: None,
            }],
        };
        let mut body: Value =
            serde_json::from_slice(&build_body(&collected, "fixture-report-01").unwrap()).unwrap();
        append_run(&mut body, &collected, &run).unwrap();
        assert_eq!(body["outcome"], "degraded");
        assert_eq!(body["stages"][0]["checks"][0]["outcome"], "warning");
        run.device.as_mut().unwrap().id = "different-device".into();
        assert!(append_run(&mut body, &collected, &run)
            .unwrap_err()
            .contains("MISMATCH"));
    }

    #[test]
    fn http_upload_requires_created_and_preserves_body_and_key() {
        use crate::d1_service_test::{serve, Reply};
        let receipt = json!({"data":{"report":{"id":"entity","kind":"device-diagnostic-report-v1","deviceId":"device","reportId":"fixture-report"}}});
        let replies = [201, 200, 503]
            .into_iter()
            .map(|status| Reply {
                method: "POST",
                path: "/report".into(),
                status,
                headers: vec![],
                body: serde_json::to_vec(&receipt).unwrap(),
            })
            .collect();
        let (base, worker) = serve(replies);
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body = b"{\"reportId\":\"fixture-report\"}".to_vec();
        for status in [201, 200, 503] {
            let result = tauri::async_runtime::block_on(post_report(
                &client,
                &format!("{base}/report"),
                body.clone(),
                "stable-key",
            ));
            assert_eq!(result.is_ok(), status == 201);
        }
        let requests = worker.join().unwrap();
        for req in requests {
            assert!(req.ends_with(&body));
            assert!(String::from_utf8_lossy(&req)
                .to_ascii_lowercase()
                .contains("idempotency-key: stable-key"));
        }
        assert!(clip(&"😀".repeat(2000), 2000).encode_utf16().count() <= 2000);
    }

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339(1_760_000_000_000),
            "2025-10-09T08:53:20.000Z"
        );
    }

    #[test]
    fn cid_must_be_32_hex_characters() {
        assert_eq!(
            normalize_cid("F4012241524A313158155C1983481C00").as_deref(),
            Some("f4012241524a313158155c1983481c00")
        );
        assert!(normalize_cid("f401").is_none());
        assert!(normalize_cid("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_none());
    }

    #[test]
    fn session_without_cid_is_rejected() {
        let root = temp_root("no-cid");
        fs::write(
            root.join("session.json"),
            br#"{"schema":"dohc.recording.session-metadata.v1","device":{"device_id":"d"}}"#,
        )
        .unwrap();
        let error = preview(root.to_str().unwrap()).unwrap_err();
        assert!(error.contains("SESSION_CID_MISSING"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collects_event_stream_and_keeps_the_tail() {
        let root = temp_root("tail");
        fs::write(
            root.join("session.json"),
            br#"{"schema":"dohc.recording.session-metadata.v1",
                 "device":{"device_id":"2475873b-968d-5a6d-93b0-943c55b349c4","emmc_cid":"f4012241524a313158155c1983481c00"},
                 "software":{"workspace_version":"1.3.0","release_id":"1.3.0+g1"},
                 "started_at":"2026-09-02T05:47:41.000Z","completed_at":"2026-09-02T05:48:11.000Z"}"#,
        )
        .unwrap();
        let mut lines = String::new();
        for index in 0..260 {
            let minutes = 47 + index / 60;
            let seconds = index % 60;
            lines.push_str(&format!(
                "{{\"schema\":\"dohc.recording.session-log.v1\",\"session_id\":\"s\",\"timestamp\":\"2026-09-02T05:{:02}:{:02}Z\",\"event\":\"{}\",\"details\":{{\"index\":{index}}}}}\n",
                minutes,
                seconds,
                if index == 259 { "CAPTURE_FAILED" } else { "SAVE_PROGRESS" }
            ));
        }
        fs::write(root.join(".session_meta/recording.log.jsonl"), lines).unwrap();
        let collected = collect(&root).unwrap();
        assert_eq!(collected.cid, "f4012241524a313158155c1983481c00");
        assert_eq!(collected.entries.len(), MAX_LOG_ENTRIES);
        assert!(collected.truncated);
        assert_eq!(collected.entries.last().unwrap().level, "error");
        let body = build_body(&collected, "host-log-20260902T054811Z-test").unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["reportType"], "runtime-diagnostic");
        assert_eq!(value["outcome"], "degraded");
        assert_eq!(value["cid"], "f4012241524a313158155c1983481c00");
        assert_eq!(value["stages"][0]["name"], "host-log-collection");
        assert_eq!(value["logs"].as_array().unwrap().len(), MAX_LOG_ENTRIES);
        assert!(body.len() < MAX_BODY_BYTES as usize);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redacts_credential_like_messages() {
        assert!(safe_message("token=abc123").is_none());
        assert!(safe_message("开始采集").is_some());
    }

    #[test]
    fn identifiers_reject_path_and_space_characters() {
        assert!(validate_identifier("host-log-20261110T113000Z-01", "reportId").is_ok());
        for bad in ["short", "../evil-id-1234", "has space in id"] {
            assert!(validate_identifier(bad, "reportId").is_err(), "{bad}");
        }
    }
}
