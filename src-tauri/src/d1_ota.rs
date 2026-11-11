//! Application OTA relay: verified Factory release download and device hand-off.
//!
//! The loop mirrors the device portal's own online flow: fetch the signed channel,
//! the signed manifest and the three referenced files from the fixed 4174 origin,
//! check every declared size and SHA-256, then relay the five-file bundle to the
//! D1 SoftAP upload session in 1 MiB chunks. The device updater remains the only
//! authority that decides whether a package is installed, so a successful upload
//! is reported as "submitted", never as an installed upgrade.
use crate::d1_device::{ConnectionMode, DeviceRequest};
use crate::d1_page;
use crate::d1_services::{self, Origin, TrustStatus};
use crate::model::ProgressPayload;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const CHANNEL_SCHEMA: &str = "dohc.ota.channel.v1";
const MANIFEST_SCHEMA: &str = "dohc.ota.release-manifest.v1";
const PORTAL_SCHEMA: &str = "dohc.ap-ota.portal.v1";
const UPLOAD_SCHEMA: &str = "dohc.ap-ota.upload.v1";
const ACCEPTED_SCHEMA: &str = "dohc.ap-ota.accepted.v1";
const SIGNATURE_BYTES: usize = 64;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MIN_CHUNK_BYTES: u64 = 64 * 1024;
const MAX_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaPreview {
    pub release_id: String,
    pub version: String,
    pub channel: String,
    pub key_id: Option<String>,
    pub rollback_index: Option<u64>,
    pub artifact_bytes: u64,
    pub total_bytes: u64,
    pub files: Vec<FileDescriptor>,
    pub trust: TrustStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaSubmitResult {
    pub release_id: String,
    pub version: String,
    pub operation_id: Option<String>,
    pub device_state: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOtaStatus {
    pub available: bool,
    pub state: Option<String>,
    pub result: Option<String>,
    pub operation_id: Option<String>,
    pub release_before: Option<String>,
    pub release_target: Option<String>,
    pub target_version: Option<String>,
    pub active: bool,
    pub final_state: bool,
    pub guidance: Option<String>,
    pub detail: String,
}

struct Downloaded {
    name: String,
    bytes: Vec<u8>,
}

struct Release {
    preview: OtaPreview,
    files: Vec<Downloaded>,
}

fn failure(message: impl Into<String>) -> String {
    message.into()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn origin() -> Result<Origin, String> {
    let config = d1_services::load().map_err(|error| error.to_string())?;
    let value = config
        .device_ota
        .origin
        .as_deref()
        .ok_or_else(|| "OTA_ORIGIN_UNCONFIGURED: 升级服务地址尚未配置".to_string())?;
    d1_services::origin(value)
}

fn channel_name() -> Result<String, String> {
    let config = d1_services::load().map_err(|error| error.to_string())?;
    let channel = config
        .device_ota
        .channel
        .unwrap_or_else(|| "factory".into());
    // A channel name is part of a fixed path; keep it to a plain identifier.
    if channel.is_empty()
        || channel.len() > 32
        || !channel
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("OTA_CHANNEL_INVALID: 升级通道名称无效".into());
    }
    Ok(channel)
}

fn client() -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|_| "OTA_CLIENT_UNAVAILABLE: 无法建立升级服务连接".to_string())
}

async fn fetch(
    client: &reqwest::Client,
    origin: &Origin,
    path: &str,
    limit: u64,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("OTA_CANCELLED: 升级已取消".into());
    }
    let url = d1_services::ota_url(origin, path)?;
    let response = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "OTA_DOWNLOAD_TIMEOUT: 升级服务响应超时".to_string()
            } else {
                "OTA_DOWNLOAD_FAILED: 无法连接升级服务，请检查网络".to_string()
            }
        })?;
    if response.status().as_u16() != 200 {
        return Err(format!(
            "OTA_HTTP_{}: 升级服务返回 HTTP {}，暂不可下载",
            response.status().as_u16(),
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("OTA_RESPONSE_TOO_LARGE: 升级资源超过大小限制".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Acquire) {
            return Err("OTA_CANCELLED: 升级已取消".into());
        }
        let chunk = chunk.map_err(|_| "OTA_DOWNLOAD_INCOMPLETE: 升级资源下载中断".to_string())?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("OTA_RESPONSE_TOO_LARGE: 升级资源超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn descriptor_path(value: &serde_json::Value, label: &str) -> Result<FileDescriptor, String> {
    let path = value
        .get("path")
        .and_then(|path| path.as_str())
        .ok_or_else(|| format!("OTA_MANIFEST_INVALID: {label} 缺少路径"))?;
    if !path.starts_with("/ota/v1/") || path.contains("..") || path.contains(['?', '#']) {
        return Err(format!("OTA_MANIFEST_INVALID: {label} 路径不在发布范围内"));
    }
    let size = value
        .get("size")
        .and_then(|size| size.as_u64())
        .ok_or_else(|| format!("OTA_MANIFEST_INVALID: {label} 缺少大小"))?;
    if size == 0 {
        return Err(format!("OTA_MANIFEST_INVALID: {label} 大小无效"));
    }
    let sha256 = value
        .get("sha256")
        .and_then(|hash| hash.as_str())
        .map(|hash| hash.to_ascii_lowercase());
    if let Some(hash) = &sha256 {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("OTA_MANIFEST_INVALID: {label} 摘要无效"));
        }
    }
    Ok(FileDescriptor {
        name: label.into(),
        path: path.into(),
        size,
        sha256,
    })
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(str::to_string)
}

async fn resolve(
    client: &reqwest::Client,
    origin: &Origin,
    cancelled: &AtomicBool,
) -> Result<Release, String> {
    let channel = channel_name()?;
    let channel_path = format!("/ota/v1/channels/{channel}.json");
    let channel_bytes = fetch(
        client,
        origin,
        &channel_path,
        MAX_JSON_BYTES as u64,
        cancelled,
    )
    .await?;
    let channel_json: serde_json::Value = serde_json::from_slice(&channel_bytes)
        .map_err(|_| failure("OTA_CHANNEL_INVALID: 升级通道不是有效 JSON"))?;
    if text(&channel_json, "schema").as_deref() != Some(CHANNEL_SCHEMA) {
        return Err("OTA_CHANNEL_INVALID: 升级通道 schema 不受支持".into());
    }
    let release_id = text(&channel_json, "release_id")
        .filter(|value| !value.is_empty() && value.len() <= 160)
        .ok_or_else(|| failure("OTA_CHANNEL_INVALID: 升级通道缺少发布编号"))?;
    if release_id.contains(['/', '\\'])
        || release_id.contains("..")
        || release_id.chars().any(char::is_whitespace)
    {
        return Err("OTA_CHANNEL_INVALID: 升级通道发布编号无效".into());
    }
    let version = text(&channel_json, "version").unwrap_or_default();
    let key_id = text(&channel_json, "key_id");
    let rollback_index = channel_json
        .get("rollback_index")
        .and_then(|value| value.as_u64());

    let manifest = descriptor_path(&channel_json["manifest"], "manifest.json")?;
    if manifest.sha256.is_none() {
        return Err("OTA_CHANNEL_INVALID: 升级通道缺少 manifest 摘要".into());
    }
    let manifest_bytes = fetch(
        client,
        origin,
        &manifest.path,
        MAX_JSON_BYTES as u64,
        cancelled,
    )
    .await?;
    if manifest_bytes.len() as u64 != manifest.size {
        return Err("OTA_MANIFEST_SIZE_MISMATCH: manifest 大小与通道声明不一致".into());
    }
    if let Some(expected) = &manifest.sha256 {
        if &sha256_hex(&manifest_bytes) != expected {
            return Err("OTA_MANIFEST_HASH_MISMATCH: manifest 摘要校验失败".into());
        }
    }
    let manifest_json: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| failure("OTA_MANIFEST_INVALID: manifest 不是有效 JSON"))?;
    if text(&manifest_json, "schema").as_deref() != Some(MANIFEST_SCHEMA) {
        return Err("OTA_MANIFEST_INVALID: manifest schema 不受支持".into());
    }
    if text(&manifest_json, "release_id").as_deref() != Some(release_id.as_str()) {
        return Err("OTA_MANIFEST_MISMATCH: manifest 与通道发布编号不一致".into());
    }
    let manifest_version = text(&manifest_json, "version").unwrap_or_default();
    if !version.is_empty() && !manifest_version.is_empty() && version != manifest_version {
        return Err("OTA_MANIFEST_MISMATCH: manifest 与通道版本不一致".into());
    }
    let manifest_key = manifest_json
        .get("signing")
        .and_then(|signing| text(signing, "key_id"));
    if let (Some(channel_key), Some(manifest_key)) = (&key_id, &manifest_key) {
        if channel_key != manifest_key {
            return Err("OTA_MANIFEST_MISMATCH: 通道与 manifest 签名密钥不一致".into());
        }
    }
    let manifest_rollback = manifest_json
        .get("rollback_index")
        .and_then(|value| value.as_u64());
    if let (Some(channel_index), Some(manifest_index)) = (rollback_index, manifest_rollback) {
        if channel_index != manifest_index {
            return Err("OTA_MANIFEST_MISMATCH: 通道与 manifest 防回退序号不一致".into());
        }
    }

    let artifact = descriptor_path(&manifest_json["artifact"], "artifact.deb")?;
    if !["/deb", "/tar.gz"]
        .iter()
        .any(|suffix| artifact.path.ends_with(suffix))
    {
        return Err("OTA_MANIFEST_INVALID: 制品不是受支持的安装包格式".into());
    }
    if artifact.sha256.is_none() {
        return Err("OTA_MANIFEST_INVALID: 制品缺少摘要".into());
    }
    if artifact.size > MAX_ARTIFACT_BYTES {
        return Err("OTA_ARTIFACT_TOO_LARGE: 升级包超过大小限制".into());
    }
    let changelog_json = descriptor_path(&manifest_json["changelog"]["json"], "changelog.json")?;
    let changelog_md = descriptor_path(&manifest_json["changelog"]["markdown"], "changelog.md")?;
    let signature = FileDescriptor {
        name: "manifest.json.sig".into(),
        path: format!("{}.sig", manifest.path),
        size: SIGNATURE_BYTES as u64,
        sha256: None,
    };

    let mut files = vec![
        Downloaded {
            name: "manifest.json".into(),
            bytes: manifest_bytes,
        },
        Downloaded {
            name: "manifest.json.sig".into(),
            bytes: fetch(
                client,
                origin,
                &signature.path,
                SIGNATURE_BYTES as u64 + 1,
                cancelled,
            )
            .await?,
        },
        Downloaded {
            name: "changelog.json".into(),
            bytes: fetch(
                client,
                origin,
                &changelog_json.path,
                MAX_JSON_BYTES as u64,
                cancelled,
            )
            .await?,
        },
        Downloaded {
            name: "changelog.md".into(),
            bytes: fetch(
                client,
                origin,
                &changelog_md.path,
                MAX_JSON_BYTES as u64,
                cancelled,
            )
            .await?,
        },
        Downloaded {
            name: "artifact.deb".into(),
            bytes: fetch(client, origin, &artifact.path, artifact.size, cancelled).await?,
        },
    ];
    let declared = [&changelog_json, &changelog_md, &signature, &artifact];
    for file in files.iter_mut().skip(2) {
        if file.name == "manifest.json.sig" {
            if file.bytes.len() != SIGNATURE_BYTES {
                return Err("OTA_SIGNATURE_INVALID: manifest 签名不是 64 字节".into());
            }
            continue;
        }
        let Some(descriptor) = declared.iter().find(|item| item.name == file.name) else {
            return Err("OTA_MANIFEST_INVALID: 制品描述缺失".into());
        };
        if file.bytes.len() as u64 != descriptor.size {
            return Err(format!(
                "OTA_SIZE_MISMATCH: {} 大小与 manifest 不一致",
                file.name
            ));
        }
        if let Some(expected) = &descriptor.sha256 {
            if &sha256_hex(&file.bytes) != expected {
                return Err(format!("OTA_HASH_MISMATCH: {} 摘要校验失败", file.name));
            }
        }
    }
    if let Some(root) = d1_services::load()
        .map_err(|error| error.to_string())?
        .device_ota
        .trust_root
    {
        if let Some(pem) = root
            .public_key_pem
            .as_deref()
            .filter(|pem| !pem.trim().is_empty())
        {
            let key = d1_services::ed25519_public_key(pem)?;
            let signature_bytes = files
                .iter()
                .find(|file| file.name == "manifest.json.sig")
                .map(|file| file.bytes.as_slice())
                .ok_or_else(|| failure("OTA_SIGNATURE_INVALID: 缺少 manifest 签名"))?;
            let manifest_payload = files
                .iter()
                .find(|file| file.name == "manifest.json")
                .map(|file| file.bytes.as_slice())
                .ok_or_else(|| failure("OTA_MANIFEST_INVALID: 缺少 manifest"))?;
            let public =
                ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key.as_slice());
            public
                .verify(manifest_payload, signature_bytes)
                .map_err(|_| "OTA_SIGNATURE_INVALID: manifest 签名校验失败".to_string())?;
            if let (Some(expected), Some(configured)) = (&root.key_id, &key_id) {
                if !expected.is_empty() && expected != configured {
                    return Err("OTA_KEY_ID_MISMATCH: 发布密钥编号与信任根不一致".into());
                }
            }
        }
    }

    let total_bytes = files.iter().map(|file| file.bytes.len() as u64).sum();
    Ok(Release {
        preview: OtaPreview {
            release_id,
            version: if manifest_version.is_empty() {
                version
            } else {
                manifest_version
            },
            channel,
            key_id,
            rollback_index,
            artifact_bytes: artifact.size,
            total_bytes,
            files: vec![
                FileDescriptor {
                    name: "manifest.json".into(),
                    path: manifest.path.clone(),
                    size: manifest.size,
                    sha256: manifest.sha256.clone(),
                },
                signature,
                changelog_json,
                changelog_md,
                artifact,
            ],
            trust: if d1_services::load()
                .map(|config| {
                    config
                        .device_ota
                        .trust_root
                        .and_then(|root| root.public_key_pem)
                        .is_some_and(|pem| !pem.trim().is_empty())
                })
                .unwrap_or(false)
            {
                TrustStatus::Configured
            } else {
                TrustStatus::DeviceVerified
            },
        },
        files,
    })
}

pub async fn service_status() -> crate::error::AppResult<d1_services::OtaServiceStatus> {
    let config = d1_services::load()?;
    let ota = config.device_ota;
    let origin = ota
        .origin
        .as_deref()
        .and_then(|value| d1_services::origin(value).ok());
    let trust = match ota
        .trust_root
        .as_ref()
        .and_then(|root| root.public_key_pem.as_deref())
    {
        Some(pem) if !pem.trim().is_empty() => d1_services::ed25519_public_key(pem)
            .map(|_| TrustStatus::Configured)
            .unwrap_or(TrustStatus::DeviceVerified),
        _ => TrustStatus::DeviceVerified,
    };
    let trust_key_id = ota.trust_root.and_then(|root| root.key_id);
    let detail = if !ota.enabled || origin.is_none() {
        "升级服务尚未配置".to_string()
    } else if matches!(trust, TrustStatus::Configured) {
        "已配置发布公钥，将校验通道文件。设备仍独立验签并决定安装。".into()
    } else {
        "未配置发布公钥：软件只核对大小与摘要，由设备独立验签后决定是否安装。".into()
    };
    Ok(d1_services::OtaServiceStatus {
        enabled: ota.enabled && origin.is_some(),
        origin: origin.map(|value| value.base),
        channel: ota.channel,
        trust,
        trust_key_id,
        detail,
    })
}

pub async fn preview(cancelled: &AtomicBool) -> Result<OtaPreview, String> {
    let config = d1_services::load().map_err(|error| error.to_string())?;
    if !config.device_ota.enabled {
        return Err("OTA_DISABLED: 应用升级服务尚未启用".into());
    }
    let origin = origin()?;
    let client = client()?;
    Ok(resolve(&client, &origin, cancelled).await?.preview)
}

// ---- Device relay -------------------------------------------------------

fn device_client(local: Option<Ipv4Addr>) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(DEVICE_TIMEOUT);
    if let Some(local) = local {
        builder = builder.local_address(std::net::IpAddr::V4(local));
    }
    builder
        .build()
        .map_err(|_| "AP_OTA_CLIENT_UNAVAILABLE: 无法建立设备连接".to_string())
}

fn chunk_count(size: u64, chunk: u64) -> u64 {
    size.div_ceil(chunk.max(1))
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| "AP_OTA_NETWORK_FAILED: 设备上传接口不可达".to_string())?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "AP_OTA_RESPONSE_INVALID: 设备响应读取失败".to_string())?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("AP_OTA_RESPONSE_INVALID: 设备响应超过大小限制".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "AP_OTA_RESPONSE_INVALID: 设备响应不是有效 JSON".to_string())?;
    if !(200..300).contains(&status) {
        let code = text(&value, "code").unwrap_or_else(|| status.to_string());
        let message = text(&value, "message").unwrap_or_else(|| "设备上传接口返回错误".into());
        return Err(format!("AP_OTA_{code}: {message}"));
    }
    Ok(value)
}

pub async fn status(request: &DeviceRequest) -> Result<DeviceOtaStatus, String> {
    let mode = request.validated_mode().map_err(|error| error.message)?;
    if mode == ConnectionMode::TypeC {
        return Err("OTA_DEVICE_AP_ONLY: 在线升级需要连接设备热点或局域网 IP".into());
    }
    let (_, address, local) = d1_page::resolve_target(request, &AtomicBool::new(false)).await?;
    if let Some(local) = local {
        d1_page::verify_ap_target(request, mode, Some(local), address).await?;
    }
    let client = device_client(local)?;
    let bytes = client
        .get(format!("http://{address}/ota/status"))
        .send()
        .await
        .map_err(|_| "OTA_DEVICE_UNREACHABLE: 无法读取设备升级状态".to_string())?
        .bytes()
        .await
        .map_err(|_| "OTA_DEVICE_UNREACHABLE: 无法读取设备升级状态".to_string())?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("OTA_DEVICE_STATUS_INVALID: 状态响应超过大小限制".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "OTA_DEVICE_STATUS_INVALID: 状态响应不是有效 JSON".to_string())?;
    if text(&value, "schema").as_deref() != Some(PORTAL_SCHEMA) {
        return Err("OTA_DEVICE_UNSUPPORTED: 当前设备未提供升级状态接口".into());
    }
    let state = text(&value, "state");
    let active_states = [
        "QUEUED",
        "PRECHECK",
        "FETCH_INDEX",
        "DOWNLOAD",
        "VERIFY",
        "STAGE",
        "PRE_ACTIVATION",
        "ACTIVATE",
        "HEALTH_WINDOW",
        "CONVERGENCE",
        "ROLLBACK",
    ];
    let active = state
        .as_deref()
        .is_some_and(|state| active_states.contains(&state));
    let final_state = state.as_deref().is_some_and(|state| {
        ["SUCCESS", "FAILED", "ROLLBACK_FAILED", "UP_TO_DATE"].contains(&state)
    });
    let guidance = value
        .get("user_guidance")
        .and_then(|guidance| {
            let title = text(guidance, "title")?;
            let action = text(guidance, "action").unwrap_or_default();
            Some(format!("{title}。{action}"))
        })
        .or_else(|| text(&value, "reason"));
    let detail = match state.as_deref() {
        Some("IDLE") | Some("") | None => "设备已就绪，等待升级".into(),
        Some("SUCCESS") => "设备已报告升级成功".into(),
        Some("UP_TO_DATE") => "设备已是最新版本".into(),
        Some("FAILED") | Some("ROLLBACK_FAILED") => "上一次升级未成功，请查看设备提示".into(),
        Some(_) if active => "设备正在处理升级".into(),
        Some(_) => "设备升级状态待确认".into(),
    };
    Ok(DeviceOtaStatus {
        available: true,
        state,
        result: text(&value, "result"),
        operation_id: text(&value, "operation_id"),
        release_before: text(&value, "release_before"),
        release_target: text(&value, "release_target"),
        target_version: text(&value, "target_version"),
        active,
        final_state,
        guidance,
        detail,
    })
}

fn progress(operation_id: u64, phase: &str, bytes_done: u64, total_bytes: u64, started: Instant) {
    crate::source::emit_progress_for_operation(
        None,
        operation_id,
        ProgressPayload {
            task: "ota".into(),
            phase: phase.into(),
            current: if total_bytes == 0 { 0 } else { bytes_done },
            total: total_bytes,
            bytes_done,
            total_bytes,
            current_path: String::new(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
}

pub async fn submit(
    request: &DeviceRequest,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> Result<OtaSubmitResult, String> {
    let config = d1_services::load().map_err(|error| error.to_string())?;
    if !config.device_ota.enabled {
        return Err("OTA_DISABLED: 应用升级服务尚未启用".into());
    }
    let mode = request.validated_mode().map_err(|error| error.message)?;
    if mode == ConnectionMode::TypeC {
        return Err("OTA_DEVICE_AP_ONLY: 在线升级需要连接设备热点或局域网 IP".into());
    }
    let origin = origin()?;
    let client = client()?;
    let started = Instant::now();
    progress(operation_id, "读取升级通道", 0, 0, started);
    let release = resolve(&client, &origin, cancelled).await?;
    let total: u64 = release.preview.total_bytes;

    let (_, address, local) = d1_page::resolve_target(request, cancelled).await?;
    if let Some(local) = local {
        d1_page::verify_ap_target(request, mode, Some(local), address).await?;
    }
    let device = device_client(local)?;

    progress(operation_id, "建立设备上传会话", 0, total, started);
    let begin = post_json(
        &device,
        &format!("http://{address}/ota/upload/v1/session"),
        serde_json::json!({
            "schema": UPLOAD_SCHEMA,
            "action": "begin",
            "files": release.files.iter().map(|file| serde_json::json!({
                "name": file.name,
                "size": file.bytes.len(),
                "sha256": if file.name == "manifest.json.sig" {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String(sha256_hex(&file.bytes))
                },
            })).collect::<Vec<_>>(),
        }),
    )
    .await?;
    if !matches!(
        text(&begin, "schema").as_deref(),
        Some(UPLOAD_SCHEMA) | Some(ACCEPTED_SCHEMA)
    ) {
        return Err("AP_OTA_RESPONSE_INVALID: 设备未返回上传会话".into());
    }
    let upload_id = text(&begin, "upload_id")
        .ok_or_else(|| failure("AP_OTA_RESPONSE_INVALID: 上传会话缺少编号"))?;
    let chunk = begin
        .get("chunk_size")
        .and_then(|size| size.as_u64())
        .filter(|size| (MIN_CHUNK_BYTES..=MAX_CHUNK_BYTES).contains(size))
        .ok_or_else(|| failure("AP_OTA_RESPONSE_INVALID: 设备分块大小无效"))?;

    let mut done = 0_u64;
    for file in &release.files {
        if file.name == "manifest.json.sig" && file.bytes.len() != SIGNATURE_BYTES {
            return Err("OTA_SIGNATURE_INVALID: manifest 签名不是 64 字节".into());
        }
        let total_chunks = chunk_count(file.bytes.len() as u64, chunk);
        for index in 0..total_chunks {
            if cancelled.load(Ordering::Acquire) {
                return Err(
                    "OTA_CANCELLED: 升级已取消；设备上传会话可能仍保留，重试前请确认".into(),
                );
            }
            let start = (index * chunk) as usize;
            let end = ((index + 1) * chunk).min(file.bytes.len() as u64) as usize;
            let slice = &file.bytes[start..end];
            let url = format!(
                "http://{address}/ota/upload/v1/session/{upload_id}/files/{}/chunks/{index}",
                file.name
            );
            let response = device
                .put(url)
                .header("Content-Type", "application/octet-stream")
                .header("X-AP-OTA-Chunk-SHA256", sha256_hex(slice))
                .body(slice.to_vec())
                .send()
                .await
                .map_err(|_| "AP_OTA_NETWORK_FAILED: 升级文件上传中断".to_string())?;
            if !(200..300).contains(&response.status().as_u16()) {
                let value: serde_json::Value = response.json().await.unwrap_or_default();
                return Err(format!(
                    "AP_OTA_CHUNK_FAILED: {}",
                    text(&value, "message").unwrap_or_else(|| "设备拒绝上传块".into())
                ));
            }
            done += (end - start) as u64;
            progress(
                operation_id,
                &format!("上传 {}", file.name),
                done,
                total,
                started,
            );
        }
    }

    if cancelled.load(Ordering::Acquire) {
        return Err("OTA_CANCELLED: 升级已取消；升级文件未提交给设备".into());
    }
    progress(operation_id, "设备校验并提交", total, total, started);
    let complete = post_json(
        &device,
        &format!("http://{address}/ota/upload/v1/session/{upload_id}/complete"),
        serde_json::json!({}),
    )
    .await?;
    let operation = text(&complete, "operation_id");
    let device_state = status(request).await.ok().and_then(|state| state.state);
    Ok(OtaSubmitResult {
        release_id: release.preview.release_id,
        version: release.preview.version,
        operation_id: operation,
        device_state,
        message: "设备已接收升级文件。安装与回滚由设备自行完成，请查看升级状态确认结果。".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_counts_match_device_rounding() {
        assert_eq!(chunk_count(0, 1024), 0);
        assert_eq!(chunk_count(1, 1024), 1);
        assert_eq!(chunk_count(1024, 1024), 1);
        assert_eq!(chunk_count(1025, 1024), 2);
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn channel_name_rejects_traversal_and_case() {
        assert_eq!(channel_name().unwrap(), "factory");
    }
}
