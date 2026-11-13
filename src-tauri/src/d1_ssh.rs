//! User-authorized fixed root SSH upgrade. No shell text/URL/password IPC.
use crate::{
    d1_device::{self, DeviceRequest},
    d1_ota::{DeviceOtaStatus, OtaState, OtaSubmitResult},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{client, ChannelMsg};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::net::TcpSocket;

const WORKER: &str = include_str!("d1_ssh_upgrade.py");
const MAX_RESPONSE: usize = 1024 * 1024;
#[derive(Default)]
pub struct SshState(Mutex<BTreeMap<String, (String, String, String)>>);

struct Handler {
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
}
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        if self
            .expected
            .as_ref()
            .is_some_and(|value| value != &fingerprint)
        {
            return Ok(false);
        }
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(fingerprint);
        }
        Ok(true)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    #[serde(flatten)]
    pub status: DeviceOtaStatus,
    pub transport: &'static str,
    pub device_id: String,
    pub cid: String,
    pub events: Vec<crate::d1_ota_log::OtaLogEvent>,
    pub current_version: Option<String>,
    pub current_release_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
    pub log_error: Option<String>,
}

fn key(owner: &str, request: &DeviceRequest) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(owner, request)).map_err(|e| e.to_string())?)
    ))
}

fn command(action: &str, payload: &Value) -> Result<String, String> {
    // Encoded input is data, never shell syntax. Action is a private enum here.
    let source = STANDARD.encode(WORKER.as_bytes());
    let body = STANDARD.encode(serde_json::to_vec(payload).map_err(|e| e.to_string())?);
    Ok(format!("python3 -c 'import base64,json;s=base64.b64decode(\"{source}\").decode();exec(compile(s,\"<manager-ssh>\",\"exec\"));entry(\"{action}\",json.loads(base64.b64decode(\"{body}\")),s)'"))
}

async fn call(
    request: &DeviceRequest,
    expected: Option<String>,
    action: &str,
    payload: &Value,
    cancelled: &AtomicBool,
    input: Option<&[u8]>,
) -> Result<(Value, String), String> {
    let (peer, local) = d1_device::ssh_target(request, cancelled).await?;
    exchange(
        (peer, 22).into(),
        local,
        expected,
        action,
        payload,
        cancelled,
        input,
    )
    .await
}
async fn exchange(
    peer: std::net::SocketAddr,
    local: Option<std::net::Ipv4Addr>,
    expected: Option<String>,
    action: &str,
    payload: &Value,
    cancelled: &AtomicBool,
    input: Option<&[u8]>,
) -> Result<(Value, String), String> {
    let operation = async {
        let socket = TcpSocket::new_v4().map_err(|_| "OTA_SSH_SOCKET: 无法创建 SSH 连接")?;
        if let Some(local) = local {
            socket
                .bind((local, 0).into())
                .map_err(|_| "OTA_SSH_BIND: 设备网卡地址已变化")?;
        }
        let stream = socket
            .connect(peer)
            .await
            .map_err(|_| "OTA_SSH_CONNECT: 无法连接设备 SSH（22），请检查设备 IP 和连接")?;
        let observed = Arc::new(Mutex::new(None));
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(
                if matches!(action, "receive" | "download") {
                    660
                } else if matches!(action, "check" | "stage") {
                    45
                } else {
                    25
                },
            )),
            ..Default::default()
        });
        let mut session = client::connect_stream(
            config,
            stream,
            Handler {
                expected,
                observed: observed.clone(),
            },
        )
        .await
        .map_err(|_| "OTA_SSH_HANDSHAKE: SSH 握手失败或主机密钥已变化，请重新连接设备")?;
        // Factory device credentials explicitly supplied by the user. Never logged.
        if !session
            .authenticate_password("root", "root")
            .await
            .map_err(|_| "OTA_SSH_AUTH: 设备 SSH 身份验证失败")?
            .success()
        {
            return Err("OTA_SSH_AUTH: 设备未接受默认 root 登录".into());
        }
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|_| "OTA_SSH_CHANNEL: 无法打开 SSH 会话")?;
        let executable = command(action, payload)?;
        channel
            .exec(true, executable)
            .await
            .map_err(|_| "OTA_SSH_EXEC: 设备未接受升级命令")?;
        if let Some(input) = input {
            for block in input.chunks(1024 * 1024) {
                if cancelled.load(Ordering::Acquire) {
                    return Err("OTA_CANCELLED: SSH 文件发送已取消，尚未启动安装".into());
                }
                channel
                    .data(block)
                    .await
                    .map_err(|_| "OTA_SSH_TRANSFER: SSH 文件传输中断，尚未启动安装")?;
            }
            channel.eof().await.map_err(|_| "OTA_SSH_TRANSFER")?;
        }
        let mut bytes = Vec::new();
        let mut stderr = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if bytes.len() + data.len() > MAX_RESPONSE {
                        return Err("OTA_SSH_RESPONSE_TOO_LARGE".into());
                    }
                    bytes.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if stderr.len() + data.len() <= 8192 {
                        stderr.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        if exit != Some(0) {
            let message = String::from_utf8_lossy(&stderr);
            let safe = crate::d1_logs::safe_message(message.trim())
                .unwrap_or_else(|| "设备命令未正常结束".into());
            return Err(format!("OTA_SSH_COMMAND: {safe}"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "OTA_SSH_PROTOCOL: 设备返回的升级状态无效")?;
        let fingerprint = observed
            .lock()
            .map_err(|_| "OTA_SSH_STATE")?
            .clone()
            .ok_or("OTA_SSH_HOST_KEY_MISSING")?;
        Ok((value, fingerprint))
    };
    tokio::pin!(operation);
    let deadline = tokio::time::sleep(Duration::from_secs(
        if matches!(action, "receive" | "download") {
            660
        } else if matches!(action, "check" | "stage") {
            45
        } else {
            25
        },
    ));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result=&mut operation=>return result,
            _=&mut deadline=>return Err(if action=="launch" {"OTA_SSH_UNCONFIRMED: 发送回执超时，请先刷新状态，不要重复升级"}else{"OTA_SSH_TIMEOUT: 读取 SSH 升级状态超时"}.into()),
            _=tokio::time::sleep(Duration::from_millis(100))=>if cancelled.load(Ordering::Acquire){return Err("OTA_CANCELLED: 已停止等待；已提交的设备安装仍会继续，请刷新状态".into())}
        }
    }
}

fn parse(value: Value) -> Result<SshStatus, String> {
    let text = |name: &str| {
        value[name]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let device_id = text("deviceId").ok_or("OTA_DEVICE_ID_MISSING")?;
    if device_id.len() != 36
        || !device_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err("OTA_DEVICE_ID_INVALID".into());
    }
    let cid = text("cid")
        .filter(|s| s.len() == 32 && s.bytes().all(|v| v.is_ascii_hexdigit()))
        .ok_or("OTA_CID_INVALID")?;
    let reason = text("reason");
    if text("operationId")
        .is_some_and(|id| id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("OTA_OPERATION_INVALID".into());
    }
    let events: Vec<crate::d1_ota_log::OtaLogEvent> =
        serde_json::from_value(value["events"].clone()).map_err(|_| "OTA_SSH_EVENTS_INVALID")?;
    if events.len() > 200
        || events.iter().any(|e| {
            !matches!(e.level.as_str(), "error" | "warning" | "info" | "debug")
                || e.message.len() > 8000
        })
    {
        return Err("OTA_SSH_EVENTS_INVALID".into());
    }
    Ok(SshStatus {
        status: DeviceOtaStatus {
            available: value["available"].as_bool().unwrap_or(false),
            state: text("state"),
            result: text("result"),
            operation_id: text("operationId"),
            release_before: text("releaseBefore").or_else(|| text("version")),
            release_target: text("releaseTarget"),
            target_version: text("targetVersion"),
            active: value["active"].as_bool().unwrap_or(false),
            final_state: value["finalState"].as_bool().unwrap_or(false),
            failure_codes: value["failureCodes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            reason: reason.clone(),
            previous_result: false,
            guidance: text("guidance").or(reason),
            detail: "通过设备 SSH 查询；以安装器及实际运行版本确认结果。".into(),
        },
        transport: "ssh",
        current_version: text("version"),
        current_release_id: text("releaseId"),
        device_id,
        cid,
        events,
        started_at_ms: value["startedAtMs"].as_u64(),
        updated_at_ms: value["updatedAtMs"].as_u64(),
        log_error: None,
    })
}

async fn pin(root: &Path, cid: &str, fingerprint: &str) -> Result<(), String> {
    let root = root.to_path_buf();
    let cid = cid.to_owned();
    let fingerprint = fingerprint.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let directory = root.join("device-ssh-hosts");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(format!("{cid}.pub"));
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("OTA_SSH_HOST_KEY_INVALID".into());
            }
            if std::fs::read_to_string(&path).map_err(|e| e.to_string())? != fingerprint {
                return Err("OTA_SSH_HOST_KEY_CHANGED: 同一硬件的 SSH 主机密钥已变化".into());
            }
            return Ok(());
        }
        use std::io::Write;
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let temporary = directory.join(format!("{cid}.{:x}.partial", u64::from_le_bytes(nonce)));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(fingerprint.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let published = crate::storage::publish_noreplace(&temporary, &path);
        let _ = std::fs::remove_file(&temporary);
        if published.is_err()
            && std::fs::read_to_string(&path).ok().as_deref() != Some(&fingerprint)
        {
            return Err("OTA_SSH_HOST_KEY_CHANGED: 同一硬件的 SSH 主机密钥已变化".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn status(
    state: &SshState,
    root: &Path,
    owner: &str,
    request: &DeviceRequest,
) -> Result<SshStatus, String> {
    let expected = state
        .0
        .lock()
        .map_err(|_| "OTA_SSH_STATE")?
        .get(&key(owner, request)?)
        .map(|v| v.0.clone());
    let (value, fingerprint) = call(
        request,
        expected,
        "read",
        &Value::Null,
        &AtomicBool::new(false),
        None,
    )
    .await?;
    let status = parse(value)?;
    pin(root, &status.cid, &fingerprint).await?;
    let entry_key = key(owner, request)?;
    let mut entries = state.0.lock().map_err(|_| "OTA_SSH_STATE")?;
    if entries.len() >= 256 && !entries.contains_key(&entry_key) {
        return Err("OTA_SSH_STATE_LIMIT: 请重新启动软件后连接更多设备".into());
    }
    entries.insert(
        entry_key,
        (fingerprint, status.device_id.clone(), status.cid.clone()),
    );
    Ok(status)
}

fn current_receipt(preview: &crate::d1_ota::OtaPreview, remote: SshStatus) -> OtaSubmitResult {
    OtaSubmitResult {
        release_id: preview.release_id.clone(),
        version: preview.version.clone(),
        operation_id: remote.status.operation_id,
        device_state: Some("UP_TO_DATE".into()),
        message: remote
            .status
            .guidance
            .unwrap_or_else(|| format!("当前已是最新版本 {}，无需升级。", preview.version)),
    }
}

/// Explicit version check: this action can only record/announce a matching build.
/// A newer target never stages a file, downloads bytes or launches the installer.
pub async fn check_release(
    state: &SshState,
    ota: &OtaState,
    root: &Path,
    owner: &str,
    preview_id: &str,
    request: &DeviceRequest,
    cancelled: &AtomicBool,
) -> Result<SshStatus, String> {
    let (preview, _) = ota.device_package(owner, preview_id)?;
    let current = status(state, root, owner, request).await?;
    if current.status.active || current.status.state.as_deref() == Some("UNKNOWN") {
        return Err("OTA_DEVICE_NOT_READY: 设备正在升级或前次结果待确认".into());
    }
    let (fingerprint, device_id, cid) = state
        .0
        .lock()
        .map_err(|_| "OTA_SSH_STATE")?
        .get(&key(owner, request)?)
        .cloned()
        .ok_or("OTA_SSH_STATE")?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let operation: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let artifact = preview
        .files
        .iter()
        .find(|file| file.name == "artifact.deb")
        .ok_or("OTA_DEB_REQUIRED: Factory 通道不是 Debian 安装包")?;
    let payload = json!({"operationId":operation,"releaseId":preview.release_id,"version":preview.version,
        "size":artifact.size,"sha256":artifact.sha256,"deviceId":device_id,"cid":cid});
    let (value, _) = call(
        request,
        Some(fingerprint),
        "check",
        &payload,
        cancelled,
        None,
    )
    .await?;
    parse(value)
}

pub struct UpgradeContext<'a> {
    pub root: &'a Path,
    pub owner: &'a str,
    pub history_owner: &'a str,
}
async fn journal<T: Send + 'static>(
    root: &Path,
    owner: &str,
    work: impl FnOnce(&Path, &str) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let root = root.to_path_buf();
    let owner = owner.to_owned();
    tauri::async_runtime::spawn_blocking(move || work(&root, &owner))
        .await
        .map_err(|e| e.to_string())?
}
pub async fn submit(
    state: &SshState,
    ota: &OtaState,
    context: UpgradeContext<'_>,
    preview_id: &str,
    request: &DeviceRequest,
    cancelled: &AtomicBool,
) -> Result<OtaSubmitResult, String> {
    let UpgradeContext {
        root,
        owner,
        history_owner,
    } = context;
    let (preview, package) = ota.device_package(owner, preview_id)?;
    let release = preview.release_id.clone();
    let version = preview.version.clone();
    let operation = journal(root, history_owner, move |root, owner| {
        crate::d1_ota_log::begin(root, owner, &release, &version)
    })
    .await?;
    let result=async {
        let current=status(state,root,owner,request).await?;
        let log_operation=operation.clone();let log_current=current.clone();
        journal(root,history_owner,move|root,owner|crate::d1_ota_log::identify(root,owner,&log_operation,&log_current)).await?;
        if !current.status.available || current.status.active || current.status.state.as_deref()==Some("UNKNOWN") {
            return Err("OTA_DEVICE_NOT_READY: 设备正在升级或前次结果待确认".into());
        }
        let (fingerprint,device_id,cid)=state.0.lock().map_err(|_|"OTA_SSH_STATE")?
            .get(&key(owner,request)?).cloned().ok_or("OTA_SSH_STATE")?;
        let artifact=preview.files.iter().find(|file|file.name=="artifact.deb")
            .ok_or("OTA_DEB_REQUIRED: SSH 升级仅支持正式 Debian 安装包")?;
        let sha256=artifact.sha256.as_deref().ok_or("OTA_ARTIFACT_DIGEST_MISSING")?;
        let origin=crate::d1_services::load().map_err(|e|e.to_string())?.device_ota.origin.ok_or("OTA_ORIGIN_UNCONFIGURED")?;
        let url=crate::d1_services::ota_url(&crate::d1_services::origin(&origin)?,&artifact.path)?;
        let payload=json!({"operationId":operation,"releaseId":preview.release_id,"version":preview.version,"url":url,
            "size":artifact.size,"sha256":sha256,"deviceId":device_id,"cid":cid});
        let (staged,_) = call(request,Some(fingerprint.clone()),"stage",&payload,cancelled,None).await?;
        if staged["state"].as_str() == Some("UP_TO_DATE") {
            return Ok(current_receipt(&preview, parse(staged)?));
        }
        // Prefer direct download; AP/USB without Internet can receive the same verified bytes over SSH.
        if let Err(error)=call(request,Some(fingerprint.clone()),"download",&payload,cancelled,None).await {
            if cancelled.load(Ordering::Acquire) { return Err("OTA_CANCELLED: 尚未启动安装".into()); }
            if error.contains("OTA_DIGEST_") || error.contains("OTA_REQUEST_CHANGED") || error.contains("OTA_ALREADY_SUBMITTED") {
                return Err(error);
            }
            let log_operation=operation.clone();
            journal(root,history_owner,move|root,owner|crate::d1_ota_log::note(root,owner,&log_operation,"warning",
                "设备无法完成源站下载，改为通过 SSH 发送管理端已核对的同一安装包。")).await?;
            call(request,Some(fingerprint.clone()),"receive",&payload,cancelled,Some(package.bytes())).await?;
        }
        let (value,_)=call(request,Some(fingerprint),"launch",&payload,cancelled,None).await?;
        let remote=parse(value)?;
        if remote.status.state.as_deref()==Some("UP_TO_DATE") {
            return Ok(current_receipt(&preview, remote));
        }
        if remote.status.state.as_deref()==Some("FAILED") {
            return Err(remote.status.reason.unwrap_or_else(||"OTA_LAUNCH_FAILED".into()));
        }
        Ok(OtaSubmitResult{release_id:preview.release_id,version:preview.version,operation_id:Some(operation.clone()),device_state:remote.status.state,
            message:"设备已启动独立 SSH 安装任务。连接中断不会终止安装，请保持供电并重新连接查看最终结果。".into()})
    }.await;
    let log_result = result.clone();
    let log_operation = operation.clone();
    let saved = journal(root, history_owner, move |root, owner| {
        crate::d1_ota_log::submitted(root, owner, &log_operation, &log_result)
    })
    .await;
    match (result, saved) {
        (Ok(mut receipt), Err(error)) => {
            receipt
                .message
                .push_str(&format!(" 本机日志保存失败：{error}"));
            Ok(receipt)
        }
        (Err(error), Err(log_error)) => Err(format!("{error}；本机日志保存失败：{log_error}")),
        (result, Ok(())) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoded_command_never_interpolates_shell_data() {
        let cmd = command("launch", &json!({"url":"$(touch /tmp/no);'`foo`\n"})).unwrap();
        assert!(!cmd.contains("touch /tmp"));
        assert!(!cmd.contains("`foo`"));
        assert!(!cmd.contains("\n"));
    }
    #[test]
    fn ssh_final_state_is_not_inferred_from_upload() {
        let status=parse(json!({"available":true,"state":"QUEUED","deviceId":"b18a915d-f012-4c96-8dcb-56391da07c92","cid":"0123456789abcdef0123456789abcdef","events":[]})).unwrap();
        assert!(!status.status.final_state);
        assert!(status.status.result.is_none());
    }
    #[test]
    fn up_to_date_keeps_current_version_separate_from_previous_install() {
        let status = parse(json!({"available":true,"state":"UP_TO_DATE","result":"UP_TO_DATE",
            "finalState":true,"active":false,"operationId":"abababababababababababababababab",
            "deviceId":"b18a915d-f012-4c96-8dcb-56391da07c92","cid":"0123456789abcdef0123456789abcdef",
            "version":"1.3.1","releaseId":"factory-build","releaseBefore":"1.1.1",
            "guidance":"当前已是最新版本 1.3.1，无需升级。","events":[]})).unwrap();
        assert_eq!(status.current_version.as_deref(), Some("1.3.1"));
        assert_eq!(status.current_release_id.as_deref(), Some("factory-build"));
        assert_eq!(status.status.release_before.as_deref(), Some("1.1.1"));
        assert_eq!(status.status.result.as_deref(), Some("UP_TO_DATE"));
        assert!(status.status.final_state);
        assert!(!status.status.active);
        assert!(status.status.guidance.unwrap().contains("无需升级"));
    }

    // Actual SSH handshake, password authentication, flow control and stdin;
    // the synthetic server never executes the received command.
    struct Fixture {
        bytes: Vec<u8>,
    }
    impl russh::server::Handler for Fixture {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            assert_eq!((user, password), ("root", "root"));
            Ok(russh::server::Auth::Accept)
        }
        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }
        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let command = std::str::from_utf8(data).unwrap();
            assert!(command.starts_with("python3 -c '"));
            assert!(!command.contains("$("));
            session.channel_success(channel)?;
            Ok(())
        }
        async fn data(
            &mut self,
            _channel: russh::ChannelId,
            data: &[u8],
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.bytes.extend_from_slice(data);
            Ok(())
        }
        async fn channel_eof(
            &mut self,
            channel: russh::ChannelId,
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let body = json!({"bytes":self.bytes.len(),"sha256":format!("{:x}",Sha256::digest(&self.bytes))});
            session.data(channel, serde_json::to_vec(&body).unwrap())?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }
    #[tokio::test]
    async fn isolated_ssh_transfers_multiple_windows_and_rejects_changed_host_key() {
        use russh::keys::{
            ssh_key::private::{Ed25519Keypair, KeypairData},
            PrivateKey,
        };
        let key = PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[42; 32])),
            "synthetic",
        )
        .unwrap();
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(session) =
                        russh::server::run_stream(config, stream, Fixture { bytes: vec![] }).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        let bytes = vec![123; 3 * 1024 * 1024 + 17];
        let cancel = AtomicBool::new(false);
        let (result, observed) = exchange(
            address,
            None,
            Some(fingerprint.clone()),
            "receive",
            &json!({"operationId":"test"}),
            &cancel,
            Some(&bytes),
        )
        .await
        .unwrap();
        assert_eq!(result["bytes"], bytes.len());
        assert_eq!(result["sha256"], format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(observed, fingerprint);
        let error = exchange(
            address,
            None,
            Some("different-host-key".into()),
            "read",
            &Value::Null,
            &cancel,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("OTA_SSH_HANDSHAKE"));
        server.await.unwrap();
    }
}
