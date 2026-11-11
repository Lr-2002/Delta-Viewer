//! Real device health observations and local diagnostic snapshot packages.
use crate::d1_device::{self, DeviceIdentity, DeviceRequest, HealthSnapshot};
use crate::error::{AppError, AppResult};
use crate::storage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const RULE_VERSION: &str = "dohc-health-v2";
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 4 * MAX_FILE_BYTES;
const CONFIG: &str = include_str!("../../config/d1-manager.json");
#[derive(Clone, Default)]
pub struct DeviceState(Arc<Mutex<BTreeMap<String, (String, DiagnosticRun)>>>);
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
    Normal,
    Abnormal,
    Indeterminate,
    Unsupported,
    NotRun,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Completed,
    TimedOut,
    Disconnected,
    Cancelled,
    Unavailable,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub id: String,
    pub name: String,
    pub status: ResultStatus,
    pub evidence: String,
    pub observed_at_ms: Option<u64>,
    pub rule_version: String,
    pub applicable_firmware: String,
    pub suggestion: String,
    pub error_kind: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRun {
    pub id: String,
    pub source: &'static str,
    pub device: Option<DeviceIdentity>,
    pub observation: Option<HealthSnapshot>,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub status: TaskStatus,
    pub checks: Vec<CheckResult>,
}
pub async fn availability(
    interface_id: Option<String>,
    ap_address: Option<String>,
    connection_mode: Option<d1_device::ConnectionMode>,
) -> AppResult<serde_json::Value> {
    let mode = DeviceRequest {
        interface_id: String::new(),
        ap_address: ap_address.clone(),
        connection_mode,
    }
    .validated_mode()
    .map_err(|value| AppError::Message(value.message.into()))?;
    if mode == d1_device::ConnectionMode::Lan {
        let request = DeviceRequest {
            interface_id: "lan".into(),
            ap_address: ap_address.clone(),
            connection_mode: Some(mode),
        };
        let (observation, query_error) =
            match d1_device::query(&request, &AtomicBool::new(false)).await {
                Ok(value) => (Some(value), None),
                Err(value) => (None, Some(value)),
            };
        return Ok(
            serde_json::json!({"connection":if observation.is_some(){"connected"}else{"query_failed"},
            "identity":observation.as_ref().map(|value|&value.device),"realDeviceEnabled":observation.is_some(),
            "observation":observation,"error":query_error,"attemptedAddress":ap_address,"selectedInterfaceId":"lan",
            "configuration":serde_json::from_str::<serde_json::Value>(CONFIG)?,
            "linkDiscovery":{"status":"no_candidates","platform":std::env::consts::OS,"observedAtMs":millis(),"candidates":[],"error":null}}),
        );
    }
    let mut links = d1_device::inventory_for(mode != d1_device::ConnectionMode::TypeC)
        .await
        .map_err(|value| AppError::Message(value.message.into()))?;
    if mode == d1_device::ConnectionMode::Ap {
        links
            .candidates
            .retain(|link| d1_device::hotspot_address(link).is_some());
        if links.candidates.is_empty() {
            return Ok(
                serde_json::json!({"connection":"query_failed","identity":null,"observation":null,
                "attemptedAddress":null,"selectedInterfaceId":null,"realDeviceEnabled":false,
                "error":{"code":"D1_AP_GATEWAY_UNAVAILABLE","message":"未找到可用的热点连接。请在电脑 Wi-Fi 中连接设备标签对应的 Delta-D1 热点，等待获得地址后重试。"},
                "linkDiscovery":links,"configuration":serde_json::from_str::<serde_json::Value>(CONFIG)?}),
            );
        }
    }
    if let Some(address) = ap_address.as_deref() {
        links
            .candidates
            .retain(|link| d1_device::address_matches(link, address));
        if links.candidates.is_empty() {
            return Ok(
                serde_json::json!({"connection":"query_failed","identity":null,"observation":null,
                "attemptedAddress":null,"error":{"code":"D1_ADDRESS_UNAVAILABLE","message":"设备 IP 无效或不在电脑活动网卡的同一网段，请核对语音播报的地址与电脑网络。"},
                "selectedInterfaceId":null,"realDeviceEnabled":false,"linkDiscovery":links,
                "configuration":serde_json::from_str::<serde_json::Value>(CONFIG)?}),
            );
        }
    }
    let selected = match interface_id {
        Some(id) => links
            .candidates
            .iter()
            .find(|link| link.interface_id == id)
            .map(|link| link.interface_id.clone()),
        None if links.candidates.len() == 1 => Some(links.candidates[0].interface_id.clone()),
        _ => None,
    };
    let mut observation = None;
    let mut query_error = None;
    let mut attempted_address = None;
    if let Some(id) = selected.as_ref() {
        if let Some(link) = links.candidates.iter().find(|link| {
            link.interface_id == *id
                && (ap_address.is_some() || link.state == "identity_unverified")
        }) {
            attempted_address = d1_device::attempted_address(
                link,
                &DeviceRequest {
                    interface_id: id.clone(),
                    ap_address: ap_address.clone(),
                    connection_mode: Some(mode),
                },
            );
            match d1_device::query(
                &DeviceRequest {
                    interface_id: id.clone(),
                    ap_address: ap_address.clone(),
                    connection_mode: Some(mode),
                },
                &AtomicBool::new(false),
            )
            .await
            {
                Ok(value) => observation = Some(value),
                Err(value) => query_error = Some(value),
            }
        }
    }
    let configuration: serde_json::Value = serde_json::from_str(CONFIG)?;
    Ok(
        serde_json::json!({"connection":if observation.is_some(){"connected"}else if query_error.is_some(){"query_failed"}else{"not_connected"},
        "realDeviceEnabled":observation.is_some(),"selectedInterfaceId":selected,"attemptedAddress":attempted_address,
        "identity":observation.as_ref().map(|value|&value.device),"observation":observation,"error":query_error,
        "configuration":configuration,"linkDiscovery":links}),
    )
}
pub(super) fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn nonce() -> AppResult<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| AppError::Message("D1_RANDOM_UNAVAILABLE: 系统随机源不可用，请重试".into()))?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}
fn checks(snapshot: &HealthSnapshot) -> Vec<CheckResult> {
    let yes_no = |value: Option<bool>| match value {
        Some(true) => "是",
        Some(false) => "否",
        None => "未提供",
    };
    let mut result = Vec::new();
    let mut add =
        |id: &str, name: &str, status: ResultStatus, evidence: String, suggestion: &str| {
            result.push(CheckResult {
                id: id.into(),
                name: name.into(),
                status,
                evidence,
                observed_at_ms: Some(snapshot.observed_at_ms),
                rule_version: RULE_VERSION.into(),
                applicable_firmware: format!(
                    "dohc.device.health.v1 · DOHC {}",
                    snapshot
                        .device
                        .application_version
                        .as_deref()
                        .unwrap_or("未提供版本")
                ),
                suggestion: suggestion.into(),
                error_kind: None,
            });
        };
    let fresh = snapshot.heartbeat_stale == Some(false);
    add(
        "heartbeat",
        "采集状态时效",
        if fresh {
            ResultStatus::Normal
        } else {
            ResultStatus::Indeterminate
        },
        format!(
            "设备报告采集状态已过期：{}",
            yes_no(snapshot.heartbeat_stale)
        ),
        "状态过期时先恢复设备状态服务再复检，不能据此判断硬件损坏。",
    );
    add(
        "health",
        "设备总体状态",
        if !fresh || snapshot.connection_limited_only {
            ResultStatus::Indeterminate
        } else {
            match snapshot.health.as_deref() {
                Some("OK") => ResultStatus::Normal,
                Some("FAILED" | "DEGRADED") => ResultStatus::Abnormal,
                _ => ResultStatus::Indeterminate,
            }
        },
        format!(
            "{}设备报告 health={}，phase={}；健康查询 HTTP {}",
            if snapshot.connection_limited_only {
                "总体报告仅见 Type-C 占用造成的扩展相机限制，不判定硬件故障；"
            } else {
                ""
            },
            snapshot.health.as_deref().unwrap_or("未提供"),
            snapshot.phase.as_deref().unwrap_or("未提供"),
            snapshot.http_status
        ),
        "按下列设备报告逐项排查并复检；异常状态不等同硬件损坏。",
    );
    if snapshot.cameras.is_empty() {
        add(
            "cameras",
            "相机状态",
            ResultStatus::Unsupported,
            "设备报告未提供相机状态。".into(),
            "确认设备应用支持相机健康状态后复检。",
        );
    }
    for camera in &snapshot.cameras {
        let port_limited = snapshot.camera_port_limited && camera.role == "stereo_extension";
        let status = if port_limited || camera.enabled == Some(false) {
            ResultStatus::NotRun
        } else if !fresh || camera.enabled.is_none() {
            ResultStatus::Indeterminate
        } else {
            match (camera.state.as_deref(), camera.fresh) {
                (Some("STREAMING"), Some(true)) => ResultStatus::Normal,
                (Some("FAULT" | "FAILED"), Some(false)) => ResultStatus::Abnormal,
                _ => ResultStatus::Indeterminate,
            }
        };
        add(
            &format!("camera:{}", camera.role),
            &format!("相机 · {}", camera.name.as_deref().unwrap_or(&camera.role)),
            status,
            format!(
                "{}设备报告状态={}；画面有效：{}，已启用：{}，必需相机：{}；{}",
                if port_limited {
                    "Type-C 当前用于诊断连接，扩展双目相机未检查；此项不判故障。"
                } else {
                    ""
                },
                camera.state.as_deref().unwrap_or("未提供"),
                yes_no(camera.fresh),
                yes_no(camera.enabled),
                yes_no(camera.required),
                camera.reason.as_deref().unwrap_or("无补充原因")
            ),
            if port_limited {
                "改用设备热点按 IP 连接，并接回扩展双目相机后复检；本次未验证相机健康。"
            } else {
                "检查对应相机连接和配置后复检；恢复中或缺少证据时不能判定相机损坏。"
            },
        );
    }
    match &snapshot.storage {
        Some(storage) => add(
            "storage",
            "采集存储",
            if !fresh {
                ResultStatus::Indeterminate
            } else {
                match (storage.mounted, storage.writable, storage.usage_warning) {
                    (Some(false), _, _) | (_, Some(false), _) | (_, _, Some(true)) => {
                        ResultStatus::Abnormal
                    }
                    (Some(true), Some(true), Some(false)) => ResultStatus::Normal,
                    _ => ResultStatus::Indeterminate,
                }
            },
            format!(
                "设备报告已挂载：{}，可写：{}，容量告警：{}，格式={}，剩余字节={}；{}",
                yes_no(storage.mounted),
                yes_no(storage.writable),
                yes_no(storage.usage_warning),
                storage.filesystem.as_deref().unwrap_or("未提供"),
                storage
                    .free_bytes
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "未提供".into()),
                storage.reason.as_deref().unwrap_or("无补充原因")
            ),
            "按设备报告检查采集卡挂载、可写性和容量；不会格式化或修改存储。",
        ),
        None => add(
            "storage",
            "采集存储",
            ResultStatus::Unsupported,
            "设备未提供存储状态。".into(),
            "确认设备应用版本支持存储状态查询。",
        ),
    }
    for (index, alert) in snapshot.alerts.iter().enumerate().filter(|(_, alert)| {
        !alert
            .component
            .as_deref()
            .is_some_and(|component| component.starts_with("camera."))
    }) {
        let status = if !fresh {
            ResultStatus::Indeterminate
        } else {
            match alert.severity.as_deref() {
                Some("critical" | "warning") => ResultStatus::Abnormal,
                Some("info") => ResultStatus::Normal,
                _ => ResultStatus::Indeterminate,
            }
        };
        add(
            &format!("alert:{index}"),
            if alert.code.starts_with("BATTERY_") {
                "供电告警"
            } else {
                "设备告警"
            },
            status,
            format!(
                "{} · {}",
                alert.code,
                alert.message.as_deref().unwrap_or("设备未提供说明")
            ),
            alert.action.as_deref().unwrap_or("按设备告警排查后复检。"),
        );
    }
    let (status, evidence) = match &snapshot.self_test {
        Some(test) if test.phase.as_deref() == Some("IDLE") && test.result.is_none() => (
            ResultStatus::NotRun,
            "设备尚未执行长时自检；本次只读取当前健康状态。".into(),
        ),
        Some(test) => (
            // A previously persisted QC result cannot establish current health.
            ResultStatus::Indeterminate,
            format!(
                "设备已有自检 phase={}，result={}；属于设备已有结果，不是本次启动的自检。",
                test.phase.as_deref().unwrap_or("未提供"),
                test.result.as_deref().unwrap_or("未提供")
            ),
        ),
        None => (
            ResultStatus::Unsupported,
            "当前设备未提供长时自检结果。".into(),
        ),
    };
    add(
        "self-test",
        "设备已有长时自检",
        status,
        evidence,
        "本次检测不触发采集、长时自检、重启或配置修改。",
    );
    result
}
pub async fn run(request: DeviceRequest, cancelled: &AtomicBool) -> AppResult<DiagnosticRun> {
    let started = millis();
    let mut run = DiagnosticRun {
        id: format!("device:{}", nonce()?),
        source: "physical_device",
        device: None,
        observation: None,
        started_at_ms: started,
        finished_at_ms: 0,
        status: TaskStatus::Completed,
        checks: vec![],
    };
    match d1_device::query(&request, cancelled).await {
        Ok(snapshot) => {
            run.checks = checks(&snapshot);
            run.device = Some(snapshot.device.clone());
            run.observation = Some(snapshot);
        }
        Err(error) => {
            run.status = match error.code {
                "D1_CANCELLED" => TaskStatus::Cancelled,
                "D1_QUERY_TIMEOUT" => TaskStatus::TimedOut,
                "D1_DISCONNECTED" => TaskStatus::Disconnected,
                _ => TaskStatus::Unavailable,
            };
            run.checks.push(CheckResult {
                id: "health-query".into(),
                name: "设备健康查询".into(),
                status: if run.status == TaskStatus::Cancelled {
                    ResultStatus::NotRun
                } else if ["D1_PROTOCOL_UNSUPPORTED", "D1_HEALTH_PAGE_ONLY"].contains(&error.code) {
                    ResultStatus::Unsupported
                } else {
                    ResultStatus::Indeterminate
                },
                evidence: error.message.into(),
                observed_at_ms: if run.status == TaskStatus::Cancelled {
                    None
                } else {
                    Some(millis())
                },
                rule_version: RULE_VERSION.into(),
                applicable_firmware: "尚未取得设备版本".into(),
                suggestion: "检查连接并复检；当前没有硬件损坏证据。".into(),
                error_kind: Some(error.code.into()),
            });
        }
    }
    run.finished_at_ms = millis().max(started + 1);
    Ok(run)
}
impl DeviceState {
    pub fn remember(&self, owner: &str, run: DiagnosticRun) -> AppResult<()> {
        let mut runs = self
            .0
            .lock()
            .map_err(|_| AppError::Message("D1_STATE_UNAVAILABLE".into()))?;
        if runs.len() >= 16 {
            let oldest = runs
                .values()
                .min_by_key(|(_, r)| r.started_at_ms)
                .map(|(_, r)| r.id.clone());
            if let Some(id) = oldest {
                runs.remove(&id);
            }
        }
        runs.insert(run.id.clone(), (owner.into(), run));
        Ok(())
    }
    pub fn clear(&self) {
        if let Ok(mut runs) = self.0.lock() {
            runs.clear();
        }
    }
    fn get(&self, owner: &str, id: &str) -> AppResult<DiagnosticRun> {
        self.0
            .lock()
            .map_err(|_| AppError::Message("D1_STATE_UNAVAILABLE".into()))?
            .get(id)
            .filter(|(stored_owner, _)| stored_owner == owner)
            .map(|(_, run)| run.clone())
            .ok_or_else(|| AppError::Message("D1_RUN_MISSING: 请先运行设备检测".into()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleRequest {
    pub run_id: String,
    pub from_ms: u64,
    pub to_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub name: String,
    pub bytes: usize,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePreview {
    pub source: String,
    pub run_id: String,
    pub from_ms: u64,
    pub to_ms: u64,
    pub files: Vec<BundleFile>,
    pub plan_hash: String,
    pub filtered_messages: usize,
    pub privacy: String,
}
struct BundlePlan {
    preview: BundlePreview,
    files: Vec<(String, Vec<u8>)>,
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn build_plan(state: &DeviceState, owner: &str, request: &BundleRequest) -> AppResult<BundlePlan> {
    let run = state.get(owner, &request.run_id)?;
    if request.from_ms > request.to_ms
        || request.from_ms < run.started_at_ms
        || request.to_ms > run.finished_at_ms
    {
        return Err(AppError::Message(
            "D1_TIME_RANGE_INVALID: 范围必须位于本次运行起止时间内".into(),
        ));
    }
    let checks: Vec<_> = run
        .checks
        .iter()
        .filter(|check| {
            check
                .observed_at_ms
                .is_none_or(|ms| ms >= request.from_ms && ms <= request.to_ms)
        })
        .collect();
    let summary = serde_json::json!({"schemaVersion":2,"source":"physical_device","runId":run.id,"device":run.device,
        "ruleVersion":RULE_VERSION,"taskStatus":run.status,"startedAtMs":run.started_at_ms,"finishedAtMs":run.finished_at_ms,
        "fromMs":request.from_ms,"toMs":request.to_ms,"checks":checks});
    let mut files: Vec<(String, Vec<u8>)> = vec![(
        "diagnostics.json".into(),
        serde_json::to_vec_pretty(&summary)?,
    )];
    let included = run.observation.as_ref().filter(|snapshot| {
        snapshot.observed_at_ms >= request.from_ms && snapshot.observed_at_ms <= request.to_ms
    });
    if let Some(snapshot) = included {
        files.push(("health.json".into(), serde_json::to_vec_pretty(snapshot)?));
    }
    let entries: Vec<_> = files
        .iter()
        .map(|(name, bytes)| BundleFile {
            name: name.clone(),
            bytes: bytes.len(),
            sha256: sha(bytes),
        })
        .collect();
    let manifest = serde_json::json!({"schemaVersion":2,"format":"d1-manager.diagnostic-package.v2","application":"D1 Manager",
        "appVersion":env!("CARGO_PKG_VERSION"),"source":"physical_device","device":run.device,"runId":run.id,"collectedAtMs":run.finished_at_ms,
        "fromMs":request.from_ms,"toMs":request.to_ms,"files":entries,"healthSnapshotIncluded":included.is_some(),"realLogsCollected":false,"uploaded":false});
    files.push((
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest)?,
    ));
    let entries: Vec<_> = files
        .iter()
        .map(|(name, bytes)| BundleFile {
            name: name.clone(),
            bytes: bytes.len(),
            sha256: sha(bytes),
        })
        .collect();
    let plan_hash = sha(&serde_json::to_vec(&entries)?);
    Ok(BundlePlan{preview:BundlePreview{source:"physical_device".into(),run_id:run.id,from_ms:request.from_ms,to_ms:request.to_ms,
        files:entries,plan_hash,filtered_messages:0,privacy:"仅本次真实设备健康观测、应用/板端版本和检测摘要；不含人员名称、任务、账号、审核队列或原始日志；不自动上传。".into()},files})
}
pub fn preview(
    state: &DeviceState,
    owner: &str,
    request: &BundleRequest,
) -> AppResult<BundlePreview> {
    Ok(build_plan(state, owner, request)?.preview)
}

pub fn export(
    state: &DeviceState,
    owner: &str,
    request: &BundleRequest,
    parent: &Path,
    expected_hash: &str,
    cancelled: &AtomicBool,
) -> AppResult<String> {
    let plan = build_plan(state, owner, request)?;
    if plan.preview.plan_hash != expected_hash {
        return Err(AppError::Message("D1_PREVIEW_CHANGED: 请重新预览".into()));
    }
    let parent = fs::canonicalize(parent)?;
    if !parent.is_dir() {
        return Err(AppError::Message("D1_DESTINATION_INVALID".into()));
    }
    let name = format!(
        "D1-Manager-device-{}",
        request.run_id.strip_prefix("device:").unwrap_or("invalid")
    );
    let output = parent.join(&name);
    publish_plan(&plan, &output, cancelled)?;
    Ok(output.to_string_lossy().into_owned())
}
fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(AppError::Message("D1_CANCELLED: 诊断包导出已取消".into()))
    } else {
        Ok(())
    }
}
fn validate_plan(plan: &BundlePlan) -> AppResult<()> {
    let mut total = 0;
    for (name, bytes) in &plan.files {
        if !["manifest.json", "diagnostics.json", "health.json"].contains(&name.as_str())
            || bytes.len() > MAX_FILE_BYTES
        {
            return Err(AppError::Message(
                "D1_PACKAGE_FILE_INVALID: 不允许的文件或文件过大".into(),
            ));
        }
        total += bytes.len();
    }
    if total > MAX_PACKAGE_BYTES {
        return Err(AppError::Message("D1_PACKAGE_TOO_LARGE".into()));
    }
    Ok(())
}
fn verify_package(plan: &BundlePlan, partial: &Path) -> AppResult<()> {
    for entry in &plan.preview.files {
        let path = partial.join(&entry.name);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || metadata.len() != entry.bytes as u64
            || metadata.len() > MAX_FILE_BYTES as u64
        {
            return Err(AppError::Message("D1_PACKAGE_VERIFY_FAILED".into()));
        }
        if sha(&fs::read(path)?) != entry.sha256 {
            return Err(AppError::Message("D1_PACKAGE_HASH_FAILED".into()));
        }
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(partial.join("manifest.json"))?)?;
    if manifest["source"] != "physical_device"
        || manifest["realLogsCollected"] != false
        || manifest["uploaded"] != false
    {
        return Err(AppError::Message("D1_PACKAGE_MANIFEST_INVALID".into()));
    }
    Ok(())
}
fn publish_plan(plan: &BundlePlan, output: &Path, cancelled: &AtomicBool) -> AppResult<()> {
    validate_plan(plan)?;
    check_cancelled(cancelled)?;
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Message("D1_DESTINATION_INVALID".into()))?;
    let partial = parent.join(format!(".D1-Manager.partial-{}", nonce()?));
    fs::create_dir(&partial)?;
    let result = (|| {
        for (name, bytes) in &plan.files {
            check_cancelled(cancelled)?;
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(partial.join(name))?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        verify_package(plan, &partial)?;
        check_cancelled(cancelled)?;
        storage::publish_noreplace(&partial, output)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn health() -> HealthSnapshot {
        d1_device::parse_health(br#"{"device":{"schema":"dohc.device.health.v1","device_id":"test-device","workspace_version":"1.1.1"},"health":"FAILED","heartbeat_stale":false,"devices":{"main":{"state":"STREAMING","enabled":true,"fresh":true},"t265":{"state":"FAULT","enabled":true,"fresh":false},"optional":{"state":"RECOVERING","enabled":true,"fresh":false}},"storage":{"mounted":true,"writable":true,"usage_warning":false},"self_test":{"phase":"IDLE","result":null}}"#,503).unwrap()
    }
    fn fixture() -> (DeviceState, BundleRequest) {
        let state = DeviceState::default();
        let snapshot = health();
        let at = snapshot.observed_at_ms;
        let run = DiagnosticRun {
            id: format!("device:{}", nonce().unwrap()),
            source: "physical_device",
            device: Some(snapshot.device.clone()),
            checks: checks(&snapshot),
            observation: Some(snapshot),
            started_at_ms: at,
            finished_at_ms: at + 1,
            status: TaskStatus::Completed,
        };
        let request = BundleRequest {
            run_id: run.id.clone(),
            from_ms: at,
            to_ms: at + 1,
        };
        state.remember("test-owner", run).unwrap();
        (state, request)
    }
    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("d1-test-{}", nonce().unwrap()));
        fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn type_c_port_exemption_never_passes_an_unobserved_camera_or_hides_other_failures() {
        let mut snapshot=d1_device::parse_health(br#"{"device":{"schema":"dohc.device.health.v1","device_id":"test"},"health":"DEGRADED","heartbeat_stale":false,"devices":{"main":{"state":"STREAMING","enabled":true,"fresh":true},"stereo_extension":{"state":"RECOVERING","enabled":true,"fresh":false}},"storage":{"mounted":true,"writable":true,"usage_warning":false},"alerts":[{"code":"CAMERA_RECOVERING","component":"camera.stereo_extension"}]}"#,200).unwrap();
        d1_device::apply_connection_context(&mut snapshot, false);
        assert!(snapshot.camera_port_limited && snapshot.connection_limited_only);
        let result = checks(&snapshot);
        let camera = result
            .iter()
            .find(|check| check.id == "camera:stereo_extension")
            .unwrap();
        assert_eq!(camera.status, ResultStatus::NotRun);
        assert!(camera.evidence.contains("Type-C 当前用于诊断连接"));
        assert_eq!(
            result
                .iter()
                .find(|check| check.id == "health")
                .unwrap()
                .status,
            ResultStatus::Indeterminate
        );
        assert_eq!(snapshot.cameras[1].state.as_deref(), Some("RECOVERING"));
        assert_eq!(snapshot.alerts.len(), 1);
        d1_device::apply_connection_context(&mut snapshot, true);
        assert!(!snapshot.camera_port_limited && !snapshot.connection_limited_only);
        assert_eq!(
            checks(&snapshot)
                .iter()
                .find(|check| check.id == "camera:stereo_extension")
                .unwrap()
                .status,
            ResultStatus::Indeterminate
        );
        snapshot.health = Some("FAILED".into());
        snapshot.cameras[0].state = Some("FAULT".into());
        snapshot.cameras[0].fresh = Some(false);
        d1_device::apply_connection_context(&mut snapshot, false);
        assert!(snapshot.camera_port_limited && !snapshot.connection_limited_only);
        assert_eq!(
            checks(&snapshot)
                .iter()
                .find(|check| check.id == "camera:main")
                .unwrap()
                .status,
            ResultStatus::Abnormal
        );
        assert_eq!(
            checks(&snapshot)
                .iter()
                .find(|check| check.id == "health")
                .unwrap()
                .status,
            ResultStatus::Abnormal
        );
        snapshot.heartbeat_stale = Some(true);
        d1_device::apply_connection_context(&mut snapshot, false);
        assert!(!snapshot.connection_limited_only);
        assert!(checks(&snapshot)
            .iter()
            .all(|check| check.status != ResultStatus::Normal));
    }
    #[test]
    fn actual_report_states_distinguish_failure_recovery_staleness_and_not_run() {
        let mut snapshot = health();
        let result = checks(&snapshot);
        let status = |id: &str| {
            result
                .iter()
                .find(|check| check.id == id)
                .unwrap()
                .status
                .clone()
        };
        assert_eq!(status("camera:main"), ResultStatus::Normal);
        assert_eq!(status("camera:t265"), ResultStatus::Abnormal);
        assert_eq!(status("camera:optional"), ResultStatus::Indeterminate);
        assert_eq!(status("self-test"), ResultStatus::NotRun);
        snapshot.heartbeat_stale = Some(true);
        assert!(checks(&snapshot)
            .iter()
            .all(|check| check.status != ResultStatus::Normal
                && check.status != ResultStatus::Abnormal));
        snapshot.cameras.clear();
        snapshot.storage = None;
        snapshot.self_test = None;
        assert!(checks(&snapshot)
            .iter()
            .filter(|check| ["cameras", "storage", "self-test"].contains(&check.id.as_str()))
            .all(|check| check.status == ResultStatus::Unsupported));
    }
    #[test]
    fn package_contains_actual_whitelisted_snapshot_and_no_synthetic_logs() {
        let (state, request) = fixture();
        let plan = build_plan(&state, "test-owner", &request).unwrap();
        let names: Vec<_> = plan.files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec!["diagnostics.json", "health.json", "manifest.json"]
        );
        let manifest: serde_json::Value = serde_json::from_slice(&plan.files[2].1).unwrap();
        assert_eq!(manifest["source"], "physical_device");
        assert_eq!(manifest["uploaded"], false);
        assert_eq!(manifest["realLogsCollected"], false);
        let mut range = request;
        range.from_ms += 1;
        assert!(!build_plan(&state, "test-owner", &range)
            .unwrap()
            .files
            .iter()
            .any(|(name, _)| name == "health.json"));
    }
    #[test]
    fn verifies_range_preview_hash_and_atomic_no_replace() {
        let (state, mut req) = fixture();
        let preview = preview(&state, "test-owner", &req).unwrap();
        assert!(super::preview(&state, "another-owner", &req).is_err());
        let parent = temp();
        let cancelled = AtomicBool::new(false);
        assert!(export(&state, "test-owner", &req, &parent, "wrong", &cancelled).is_err());
        let output = export(
            &state,
            "test-owner",
            &req,
            &parent,
            &preview.plan_hash,
            &cancelled,
        )
        .unwrap();
        let before = fs::read(Path::new(&output).join("manifest.json")).unwrap();
        assert!(export(
            &state,
            "test-owner",
            &req,
            &parent,
            &preview.plan_hash,
            &cancelled
        )
        .is_err());
        assert_eq!(
            before,
            fs::read(Path::new(&output).join("manifest.json")).unwrap()
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        req.from_ms = 0;
        assert!(build_plan(&state, "test-owner", &req).is_err());
        state.clear();
        assert!(build_plan(&state, "test-owner", &req).is_err());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn refuses_oversize_missing_corrupt_files_and_cancellation() {
        let (state, req) = fixture();
        let mut plan = build_plan(&state, "test-owner", &req).unwrap();
        let parent = temp();
        let output = parent.join("package");
        assert!(publish_plan(&plan, &output, &AtomicBool::new(true)).is_err());
        assert!(!output.exists());
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        plan.files[0].1 = vec![0; MAX_FILE_BYTES + 1];
        assert!(publish_plan(&plan, &output, &AtomicBool::new(false)).is_err());
        assert!(!output.exists());
        let plan = build_plan(&state, "test-owner", &req).unwrap();
        publish_plan(&plan, &output, &AtomicBool::new(false)).unwrap();
        fs::write(output.join("diagnostics.json"), b"corrupt").unwrap();
        assert!(verify_package(&plan, &output).is_err());
        fs::write(output.join("diagnostics.json"), &plan.files[0].1).unwrap();
        fs::remove_file(output.join("manifest.json")).unwrap();
        assert!(verify_package(&plan, &output).is_err());
        fs::remove_dir_all(parent).unwrap();
    }
}
