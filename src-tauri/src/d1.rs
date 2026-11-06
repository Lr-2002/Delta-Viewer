//! D1 domain skeleton. No transport, shell, host, credentials or production commands.
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RULE_VERSION: &str = "fixture-v1";
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 4 * MAX_FILE_BYTES;
const CONFIG: &str = include_str!("../../config/d1-manager.json");

#[derive(Clone, Default)]
pub struct DeviceState(Arc<Mutex<BTreeMap<String, (String, DiagnosticRun)>>>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scenario {
    Success,
    Partial,
    Failure,
    Offline,
    Timeout,
    Disconnect,
    ParseFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeviceTarget {
    Simulation { scenario: Scenario },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub target: DeviceTarget,
    pub timeout_ms: u64,
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub id: String,
    pub model: String,
    pub firmware: String,
    pub source: String,
    pub capabilities: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRun {
    pub id: String,
    pub source: String,
    pub device: DeviceIdentity,
    pub scenario: Scenario,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub status: TaskStatus,
    pub checks: Vec<CheckResult>,
}

pub fn availability() -> AppResult<serde_json::Value> {
    // Inert registration only: never parsed into an URL or passed to a network client.
    let configuration = serde_json::from_str::<serde_json::Value>(CONFIG)?;
    Ok(
        serde_json::json!({"connection":"not_connected", "identity":null,
        "realDeviceEnabled":false, "configuration":configuration}),
    )
}
fn millis() -> u64 {
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
fn identity(scenario: &Scenario) -> DeviceIdentity {
    DeviceIdentity {
        id: "simulated:local-fixture".into(),
        model: "D1 模拟设备".into(),
        firmware: if *scenario == Scenario::Partial {
            "fixture-legacy"
        } else {
            "fixture-current"
        }
        .into(),
        source: "simulated".into(),
        capabilities: if *scenario == Scenario::Partial {
            vec!["fixture-link".into(), "fixture-result".into()]
        } else {
            vec![
                "fixture-link".into(),
                "fixture-result".into(),
                "fixture-optional".into(),
            ]
        },
    }
}
fn checks() -> Vec<CheckResult> {
    [
        ("fixture-link", "连接观测"),
        ("fixture-result", "状态观测"),
        ("fixture-optional", "可选能力观测"),
    ]
    .into_iter()
    .map(|(id, name)| CheckResult {
        id: id.into(),
        name: name.into(),
        status: ResultStatus::NotRun,
        evidence: "尚未执行此项模拟检查".into(),
        observed_at_ms: None,
        rule_version: RULE_VERSION.into(),
        applicable_firmware: "仅 fixture-current / fixture-legacy；不适用于真实固件".into(),
        suggestion: "运行检测后查看观测证据。".into(),
        error_kind: None,
    })
    .collect()
}
fn unknown(check: &mut CheckResult, kind: &str, evidence: &str) {
    check.status = ResultStatus::Indeterminate;
    check.error_kind = Some(kind.into());
    check.observed_at_ms = Some(millis());
    check.evidence = evidence.into();
    check.suggestion = "恢复连接或补齐可解析的证据后复检；当前结果不能判断硬件损坏。".into();
}

pub fn run(request: RunRequest, cancelled: &AtomicBool) -> AppResult<DiagnosticRun> {
    if !(100..=10_000).contains(&request.timeout_ms) {
        return Err(AppError::Message(
            "D1_TIMEOUT_INVALID: 超时必须在 100–10000 ms 内".into(),
        ));
    }
    let DeviceTarget::Simulation { scenario } = request.target;
    let mut result = DiagnosticRun {
        id: format!("simulated:{}", nonce()?),
        source: "simulated".into(),
        device: identity(&scenario),
        scenario: scenario.clone(),
        started_at_ms: millis(),
        finished_at_ms: 0,
        status: TaskStatus::Completed,
        checks: checks(),
    };
    let start = Instant::now();
    for index in 0..result.checks.len() {
        let step = Instant::now();
        let delay = if scenario == Scenario::Timeout {
            Duration::from_secs(11)
        } else {
            Duration::from_millis(220)
        };
        loop {
            if cancelled.load(Ordering::Acquire) {
                result.status = TaskStatus::Cancelled;
                break;
            }
            if start.elapsed() >= Duration::from_millis(request.timeout_ms) {
                result.status = TaskStatus::TimedOut;
                unknown(
                    &mut result.checks[index],
                    "timeout",
                    "模拟响应未在本次时间预算内返回，没有取得硬件故障证据。",
                );
                break;
            }
            if step.elapsed() >= delay {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if result.status != TaskStatus::Completed {
            break;
        }
        let check = &mut result.checks[index];
        if scenario == Scenario::Offline || (scenario == Scenario::Disconnect && index == 1) {
            unknown(
                check,
                "disconnected",
                if scenario == Scenario::Offline {
                    "模拟设备离线，未收到观测数据。"
                } else {
                    "首项后模拟连接中断，后续未执行。"
                },
            );
            result.status = TaskStatus::Disconnected;
            break;
        }
        check.observed_at_ms = Some(millis());
        if scenario == Scenario::Partial && index == 2 {
            check.status = ResultStatus::Unsupported;
            check.evidence = "合成 fixture-legacy 能力列表未声明 fixture-optional。".into();
            check.suggestion = "此模拟固件不支持该项；不能算作通过。".into();
        } else if scenario == Scenario::ParseFailure && index == 1 {
            unknown(
                check,
                "parse_failure",
                "合成响应缺少 fixture-v1 必需字段，无法解析观测。",
            );
        } else if scenario == Scenario::Failure && index == 1 {
            check.status = ResultStatus::Abnormal;
            check.evidence =
                "合成响应 flag=fixture-failure，命中 fixture-v1 的显式失败分支。".into();
            check.suggestion = "这是合成异常，不代表实际硬件故障；真实建议需正式设备规则。".into();
        } else {
            check.status = ResultStatus::Normal;
            check.evidence = "合成响应 flag=fixture-ok，与 fixture-v1 的预期值一致。".into();
            check.suggestion = "本项模拟通过；真实设备仍未检测。".into();
        }
    }
    result.finished_at_ms = millis().max(result.started_at_ms + 1);
    Ok(result)
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
            .ok_or_else(|| AppError::Message("D1_RUN_MISSING: 请先运行本地模拟检测".into()))
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

// Conservative fixture filter, NOT a collector for unknown real log formats.
fn safe_message(message: &str) -> Option<&str> {
    let lower = message.to_lowercase();
    let denied = [
        "password",
        "passwd",
        "token",
        "authorization",
        "bearer",
        "secret",
        "private key",
        "connection_key",
        "ssh_key",
        "email",
        "phone",
        "密码",
        "密钥",
        "私钥",
    ];
    if message.len() > 4096
        || message.chars().any(|c| c.is_control())
        || denied.iter().any(|key| lower.contains(key))
    {
        None
    } else {
        Some(message)
    }
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
    let filtered_checks: Vec<_> = run
        .checks
        .iter()
        .filter(|check| {
            check
                .observed_at_ms
                .is_none_or(|ms| ms >= request.from_ms && ms <= request.to_ms)
        })
        .collect();
    let summary = serde_json::json!({"schemaVersion":1,"source":"simulated","runId":run.id,"device":run.device,
        "ruleVersion":RULE_VERSION,"taskStatus":run.status,"startedAtMs":run.started_at_ms,"finishedAtMs":run.finished_at_ms,
        "fromMs":request.from_ms,"toMs":request.to_ms,"checks":filtered_checks});
    let mut logs = Vec::new();
    let mut filtered = 0;
    for message in [
        "Local synthetic diagnostic fixture; no device connection",
        "password=fixture-secret",
        "Authorization: Bearer fixture-token",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "email=fixture@example.invalid",
    ] {
        if let Some(message) = safe_message(message) {
            if run.started_at_ms >= request.from_ms && run.started_at_ms <= request.to_ms {
                serde_json::to_writer(
                    &mut logs,
                    &serde_json::json!({"timestampMs":run.started_at_ms,"source":"synthetic_fixture","code":"FIXTURE_START","message":message}),
                )?;
                logs.push(b'\n');
            }
        } else {
            filtered += 1;
        }
    }
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (
            "diagnostics.json".into(),
            serde_json::to_vec_pretty(&summary)?,
        ),
        ("logs/simulation.jsonl".into(), logs),
    ];
    let entries: Vec<BundleFile> = files
        .iter()
        .map(|(name, bytes)| BundleFile {
            name: name.clone(),
            bytes: bytes.len(),
            sha256: sha(bytes),
        })
        .collect();
    let manifest = serde_json::json!({"schemaVersion":1,"format":"d1-manager.diagnostic-package.v1","application":"D1 Manager",
        "appVersion":env!("CARGO_PKG_VERSION"),"source":"simulated","device":run.device,"runId":run.id,"collectedAtMs":run.finished_at_ms,
        "fromMs":request.from_ms,"toMs":request.to_ms,"files":entries,"filteredMessages":filtered,"realLogsCollected":false,"uploaded":false});
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
    Ok(BundlePlan {preview:BundlePreview {source:"simulated".into(),run_id:run.id,from_ms:request.from_ms,to_ms:request.to_ms,
        files:entries,plan_hash,filtered_messages:filtered,privacy:"仅合成日志、模拟设备身份及检测摘要；不含真实日志、账号、审核队列或本地路径；不上传。".into()},files})
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
        "D1-Manager-simulated-{}",
        request
            .run_id
            .strip_prefix("simulated:")
            .unwrap_or("invalid")
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
        if !["manifest.json", "diagnostics.json", "logs/simulation.jsonl"].contains(&name.as_str())
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
    if manifest["source"] != "simulated"
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
        fs::create_dir(partial.join("logs"))?;
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
    fn request(scenario: Scenario) -> RunRequest {
        RunRequest {
            target: DeviceTarget::Simulation { scenario },
            timeout_ms: 2000,
        }
    }
    fn fixture() -> (DeviceState, BundleRequest) {
        let state = DeviceState::default();
        let run = run(request(Scenario::Success), &AtomicBool::new(false)).unwrap();
        let req = BundleRequest {
            run_id: run.id.clone(),
            from_ms: run.started_at_ms,
            to_ms: run.finished_at_ms,
        };
        state.remember("test-owner", run).unwrap();
        (state, req)
    }
    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("d1-test-{}", nonce().unwrap()));
        fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn rejects_real_targets_unknown_fields_and_invalid_budgets() {
        for value in [
            r#"{"target":{"kind":"ssh","host":"example.invalid"},"timeoutMs":1000}"#,
            r#"{"target":{"kind":"simulation","scenario":"success","command":"sh"},"timeoutMs":1000}"#,
            r#"{"target":{"kind":"simulation","scenario":"success"},"timeoutMs":1000,"host":"x"}"#,
        ] {
            assert!(serde_json::from_str::<RunRequest>(value).is_err());
        }
        let mut invalid = request(Scenario::Success);
        invalid.timeout_ms = 0;
        assert!(run(invalid, &AtomicBool::new(false)).is_err());
        let config = availability().unwrap();
        assert_eq!(
            config["configuration"]["productionOperations"],
            serde_json::json!([])
        );
        assert_eq!(config["configuration"]["deviceOta"]["enabled"], false);
        assert!(config["configuration"]["deviceOta"]["scheme"].is_null());
    }
    #[test]
    fn explicit_failure_and_version_capabilities_are_distinct() {
        for (scenario, index, status) in [
            (Scenario::Success, 1, ResultStatus::Normal),
            (Scenario::Failure, 1, ResultStatus::Abnormal),
            (Scenario::Partial, 2, ResultStatus::Unsupported),
            (Scenario::ParseFailure, 1, ResultStatus::Indeterminate),
        ] {
            let value = run(request(scenario), &AtomicBool::new(false)).unwrap();
            assert_eq!(value.checks[index].status, status);
            assert!(value.device.id.starts_with("simulated:"));
            assert!(value.checks[index].observed_at_ms.is_some());
            assert!(!value.checks[index].evidence.is_empty());
        }
    }
    #[test]
    fn disconnection_timeout_and_cancellation_never_claim_damage() {
        for scenario in [Scenario::Offline, Scenario::Disconnect, Scenario::Timeout] {
            let mut req = request(scenario);
            req.timeout_ms = 700;
            let value = run(req, &AtomicBool::new(false)).unwrap();
            assert!(value
                .checks
                .iter()
                .any(|r| r.status == ResultStatus::Indeterminate));
            assert!(!value
                .checks
                .iter()
                .any(|r| r.status == ResultStatus::Abnormal));
            assert_eq!(value.checks[2].status, ResultStatus::NotRun);
        }
        let value = run(request(Scenario::Success), &AtomicBool::new(true)).unwrap();
        assert_eq!(value.status, TaskStatus::Cancelled);
        assert!(value
            .checks
            .iter()
            .all(|r| r.status == ResultStatus::NotRun && r.observed_at_ms.is_none()));
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(270));
                cancel.store(true, Ordering::Release);
            });
            let value = run(request(Scenario::Success), &cancel).unwrap();
            assert_eq!(value.status, TaskStatus::Cancelled);
            assert_eq!(value.checks[0].status, ResultStatus::Normal);
            assert_eq!(value.checks[1].status, ResultStatus::NotRun);
        });
    }
    #[test]
    fn redacts_fixture_credentials_and_personal_fields() {
        for message in [
            "Password = x",
            "TOKEN=x",
            "authorization: x",
            "Bearer x",
            "ssh_key=x",
            "BEGIN PRIVATE KEY",
            "email=x",
            "phone=x",
            "密码=x",
            "a\nb",
        ] {
            assert!(safe_message(message).is_none());
        }
        assert!(safe_message("observed fixture-ok").is_some());
        let (state, req) = fixture();
        let plan = build_plan(&state, "test-owner", &req).unwrap();
        assert_eq!(plan.preview.filtered_messages, 4);
        let text = String::from_utf8(
            plan.files
                .iter()
                .find(|(n, _)| n == "logs/simulation.jsonl")
                .unwrap()
                .1
                .clone(),
        )
        .unwrap();
        assert!(!text.contains("fixture-secret"));
        assert!(!text.contains("fixture-token"));
        assert!(!text.contains("example.invalid"));
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
