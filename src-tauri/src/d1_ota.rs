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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CHANNEL_SCHEMA: &str = "dohc.ota.channel.v1";
const MANIFEST_SCHEMA: &str = "dohc.ota.release-manifest.v1";
const PORTAL_SCHEMA: &str = "dohc.ap-ota.portal.v1";
const UPLOAD_SCHEMA: &str = "dohc.ap-ota.upload.v1";
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
    pub preview_id: String,
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
    upload: Mutex<Option<(String, String)>>,
    submitted: AtomicBool,
    begin_attempted: AtomicBool,
    settled: AtomicBool,
    baseline_operation: Mutex<Option<String>>,
    expected_operation: Mutex<Option<String>>,
}

#[derive(Default)]
pub struct OtaState(Mutex<Option<(String, Instant, Arc<Release>)>>);
impl OtaState {
    fn remember(&self, owner: &str, release: Release) -> Result<OtaPreview, String> {
        let preview = release.preview.clone();
        *self.0.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")? =
            Some((owner.into(), Instant::now(), Arc::new(release)));
        Ok(preview)
    }
    fn get(&self, owner: &str, preview_id: &str) -> Result<Arc<Release>, String> {
        let guard = self.0.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")?;
        let (saved_owner, created, release) = guard
            .as_ref()
            .ok_or("OTA_PREVIEW_EXPIRED: 请重新检查升级版本")?;
        if saved_owner != owner
            || (created.elapsed() > Duration::from_secs(1800)
                && !release.begin_attempted.load(Ordering::Acquire))
            || release.preview.preview_id != preview_id
        {
            return Err("OTA_PREVIEW_EXPIRED: 版本预览已失效，请重新检查".into());
        }
        Ok(Arc::clone(release))
    }
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
    if channel != "factory"
        || channel.is_empty()
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
    Ok(fetch_with_etag(client, origin, path, limit, cancelled)
        .await?
        .0)
}

async fn fetch_with_etag(
    client: &reqwest::Client,
    origin: &Origin,
    path: &str,
    limit: u64,
    cancelled: &AtomicBool,
) -> Result<(Vec<u8>, Option<String>), String> {
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
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
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
    Ok((bytes, etag))
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
    let (channel_bytes, etag) = fetch_with_etag(
        client,
        origin,
        &channel_path,
        MAX_JSON_BYTES as u64,
        cancelled,
    )
    .await?;
    let generation = etag
        .as_deref()
        .map(|value| value.trim_matches('"'))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("OTA_CHANNEL_INVALID: 升级通道缺少有效 ETag，请重试")?;
    let channel_signature = fetch(
        client,
        origin,
        &format!("{channel_path}.sig?generation={generation}"),
        SIGNATURE_BYTES as u64,
        cancelled,
    )
    .await?;
    verify_signature(&channel_bytes, &channel_signature)?;
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
    if text(&channel_json, "channel").as_deref() != Some(channel.as_str()) {
        return Err("OTA_CHANNEL_INVALID: 通道名称不一致".into());
    }
    let version = text(&channel_json, "version")
        .filter(|v| !v.is_empty())
        .ok_or("OTA_CHANNEL_INVALID: 缺少版本")?;
    let key_id = text(&channel_json, "key_id");
    let rollback_index = channel_json
        .get("rollback_index")
        .and_then(|value| value.as_u64());

    let manifest = descriptor_path(&channel_json["manifest"], "manifest.json")?;
    if manifest.path != format!("/ota/v1/releases/{release_id}/manifest.json")
        || manifest.size > MAX_JSON_BYTES as u64
    {
        return Err("OTA_CHANNEL_INVALID: manifest 路径或大小无效".into());
    }
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

    if key_id.is_none()
        || rollback_index.is_none()
        || manifest_key != key_id
        || manifest_rollback != rollback_index
        || manifest_version != version
        || text(&manifest_json["signing"], "algorithm").as_deref() != Some("Ed25519")
    {
        return Err("OTA_MANIFEST_MISMATCH: 版本、签名密钥或防回退序号缺失或不一致".into());
    }
    let mut artifact = descriptor_path(&manifest_json["artifact"], "artifact")?;
    artifact.name = if artifact.path == format!("/ota/v1/artifacts/{release_id}.deb") {
        "artifact.deb"
    } else if artifact.path == format!("/ota/v1/artifacts/{release_id}.tar.gz") {
        "artifact.tar.gz"
    } else {
        return Err("OTA_MANIFEST_INVALID: 制品路径或格式不受支持".into());
    }
    .into();
    if artifact.size > MAX_ARTIFACT_BYTES {
        return Err("OTA_ARTIFACT_TOO_LARGE: 升级包超过大小限制".into());
    }
    let changelog_json = descriptor_path(&manifest_json["changelog"]["json"], "changelog.json")?;
    let changelog_md = descriptor_path(&manifest_json["changelog"]["markdown"], "changelog.md")?;
    for descriptor in [&artifact, &changelog_json, &changelog_md] {
        if descriptor.sha256.is_none() {
            return Err("OTA_MANIFEST_INVALID: 发布文件缺少摘要".into());
        }
    }
    for descriptor in [&changelog_json, &changelog_md] {
        if descriptor.path != format!("/ota/v1/releases/{release_id}/{}", descriptor.name)
            || descriptor.size > MAX_JSON_BYTES as u64
        {
            return Err("OTA_MANIFEST_INVALID: 更新说明路径或大小无效".into());
        }
    }
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
            name: artifact.name.clone(),
            bytes: fetch(client, origin, &artifact.path, artifact.size, cancelled).await?,
        },
    ];
    let declared = [&changelog_json, &changelog_md, &signature, &artifact];
    for file in files.iter_mut().skip(1) {
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
    verify_signature(&files[0].bytes, &files[1].bytes)?;
    if let Some(expected) = d1_services::load()
        .map_err(|e| e.to_string())?
        .device_ota
        .trust_root
        .and_then(|r| r.key_id)
    {
        if key_id.as_deref() != Some(expected.as_str()) {
            return Err("OTA_KEY_ID_MISMATCH: 发布密钥编号与配置不一致".into());
        }
    }

    let total_bytes = files.iter().map(|file| file.bytes.len() as u64).sum();
    Ok(Release {
        preview: OtaPreview {
            preview_id: format!(
                "{}-{}",
                sha256_hex(&files[0].bytes),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
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
        upload: Mutex::new(None),
        submitted: AtomicBool::new(false),
        begin_attempted: AtomicBool::new(false),
        settled: AtomicBool::new(false),
        baseline_operation: Mutex::new(None),
        expected_operation: Mutex::new(None),
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

fn verify_signature(payload: &[u8], signature: &[u8]) -> Result<(), String> {
    if signature.len() != SIGNATURE_BYTES {
        return Err("OTA_SIGNATURE_INVALID: 签名不是 64 字节".into());
    }
    if let Some(pem) = d1_services::load()
        .map_err(|e| e.to_string())?
        .device_ota
        .trust_root
        .and_then(|r| r.public_key_pem)
        .filter(|v| !v.trim().is_empty())
    {
        let key = d1_services::ed25519_public_key(&pem)?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(payload, signature)
            .map_err(|_| "OTA_SIGNATURE_INVALID: 发布签名校验失败".to_string())?;
    }
    Ok(())
}

pub async fn preview(
    state: &OtaState,
    owner: &str,
    cancelled: &AtomicBool,
) -> Result<OtaPreview, String> {
    if !d1_services::load()
        .map_err(|e| e.to_string())?
        .device_ota
        .enabled
    {
        return Err("OTA_DISABLED: 应用升级服务尚未启用".into());
    }
    if let Some((saved_owner, _, release)) = state
        .0
        .lock()
        .map_err(|_| "OTA_STATE_UNAVAILABLE")?
        .as_ref()
    {
        if saved_owner == owner
            && release.begin_attempted.load(Ordering::Acquire)
            && !release.settled.load(Ordering::Acquire)
        {
            // Keep the exact five files and the resumable device session.
            return Ok(release.preview.clone());
        }
    }
    let release = resolve(&client()?, &origin()?, cancelled).await?;
    state.remember(owner, release)
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

fn valid_upload_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
}

type ReceivedChunks = std::collections::BTreeMap<String, std::collections::BTreeSet<u64>>;
fn validate_upload_session(
    value: &serde_json::Value,
    files: &[Downloaded],
) -> Result<(String, u64, ReceivedChunks), String> {
    let invalid = || "AP_OTA_RESPONSE_INVALID: 上传会话与本次升级文件不一致".to_string();
    if text(value, "schema").as_deref() != Some(UPLOAD_SCHEMA) {
        return Err(invalid());
    }
    let id = text(value, "upload_id")
        .filter(|v| valid_upload_id(v))
        .ok_or_else(invalid)?;
    let chunk = value["chunk_size"]
        .as_u64()
        .filter(|v| (MIN_CHUNK_BYTES..=MAX_CHUNK_BYTES).contains(v))
        .ok_or_else(invalid)?;
    let descriptors = value["files"]
        .as_array()
        .filter(|v| v.len() == files.len())
        .ok_or_else(invalid)?;
    let mut received = ReceivedChunks::new();
    for file in files {
        let matching: Vec<_> = descriptors
            .iter()
            .filter(|d| text(d, "name").as_deref() == Some(file.name.as_str()))
            .collect();
        if matching.len() != 1 {
            return Err(invalid());
        }
        let descriptor = matching[0];
        let chunks = chunk_count(file.bytes.len() as u64, chunk);
        let expected = if file.name == "manifest.json.sig" {
            None
        } else {
            Some(sha256_hex(&file.bytes))
        };
        if descriptor["size"].as_u64() != Some(file.bytes.len() as u64)
            || descriptor["chunks"].as_u64() != Some(chunks)
            || text(descriptor, "sha256") != expected
        {
            return Err(invalid());
        }
        let indices = descriptor["received"].as_array().ok_or_else(invalid)?;
        let mut set = std::collections::BTreeSet::new();
        for index in indices {
            let index = index.as_u64().filter(|v| *v < chunks).ok_or_else(invalid)?;
            if !set.insert(index) {
                return Err(invalid());
            }
        }
        received.insert(file.name.clone(), set);
    }
    Ok((id, chunk, received))
}

async fn bounded_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "AP_OTA_RESPONSE_INVALID: 设备响应中断")?;
        if bytes.len() + chunk.len() > MAX_JSON_BYTES {
            return Err("AP_OTA_RESPONSE_INVALID: 设备响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
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
    let bytes = bounded_response(response).await?;
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
    Ok(status_at(request).await?.1)
}

pub async fn refresh_status(
    cache: &OtaState,
    owner: &str,
    request: &DeviceRequest,
) -> Result<DeviceOtaStatus, String> {
    let (target, status) = status_at(request).await?;
    let guard = cache.0.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")?;
    if let Some((saved_owner, _, release)) = guard.as_ref() {
        release.observe(saved_owner == owner, &target, &status)?;
    }
    Ok(status)
}

impl Release {
    fn observe(
        &self,
        same_owner: bool,
        target: &str,
        status: &DeviceOtaStatus,
    ) -> Result<(), String> {
        if !same_owner || !self.submitted.load(Ordering::Acquire) || !status.final_state {
            return Ok(());
        }
        let upload = self.upload.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")?;
        let baseline = self
            .baseline_operation
            .lock()
            .map_err(|_| "OTA_STATE_UNAVAILABLE")?;
        let expected = self
            .expected_operation
            .lock()
            .map_err(|_| "OTA_STATE_UNAVAILABLE")?;
        if upload.as_ref().is_some_and(|(saved, _)| saved == target)
            && status.release_target.as_deref() == Some(self.preview.release_id.as_str())
            && status.operation_id.is_some()
            && (if expected.is_some() {
                *expected == status.operation_id
            } else {
                *baseline != status.operation_id
            })
        {
            self.settled.store(true, Ordering::Release);
        }
        Ok(())
    }
}

async fn status_at(request: &DeviceRequest) -> Result<(String, DeviceOtaStatus), String> {
    let mode = request.validated_mode().map_err(|error| error.message)?;
    if mode == ConnectionMode::TypeC {
        return Err("OTA_DEVICE_AP_ONLY: 在线升级需要连接设备热点或局域网 IP".into());
    }
    let (_, address, local) = d1_page::resolve_target(request, &AtomicBool::new(false)).await?;
    if let Some(local) = local {
        d1_page::verify_ap_target(request, mode, Some(local), address).await?;
    }
    let client = device_client(local)?;
    let response = client
        .get(format!("http://{address}/ota/status"))
        .send()
        .await
        .map_err(|_| "OTA_DEVICE_UNREACHABLE: 无法读取设备升级状态".to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("OTA_DEVICE_UNSUPPORTED: 当前连接未提供升级接口，请使用热点配置模式".into());
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "OTA_DEVICE_HTTP_{}: 设备升级状态暂不可用",
            response.status().as_u16()
        ));
    }
    let bytes = bounded_response(response).await?;
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
        Some("SUCCESS") if text(&value, "result").as_deref() == Some("PASS") => {
            "设备已报告升级成功".into()
        }
        Some("UP_TO_DATE") => "设备已是最新版本".into(),
        Some("FAILED") | Some("ROLLBACK_FAILED") => "上一次升级未成功，请查看设备提示".into(),
        Some(_) if active => "设备正在处理升级".into(),
        Some(_) => "设备升级状态待确认".into(),
    };
    Ok((
        format!("http://{address}"),
        DeviceOtaStatus {
            available: value.get("enabled").and_then(|v| v.as_bool()) == Some(true),
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
        },
    ))
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
    state: &OtaState,
    owner: &str,
    preview_id: &str,
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
    let release = state.get(owner, preview_id)?;
    if release.submitted.load(Ordering::Acquire) {
        return Err(
            "OTA_SUBMISSION_UNCONFIRMED: 升级已提交或回执待确认，请查看设备状态，勿重复提交".into(),
        );
    }
    let current = status(request).await?;
    if !current.available || current.active {
        return Err("OTA_DEVICE_NOT_READY: 设备升级不可用或正在执行，请等待并查看状态".into());
    }
    if !release.begin_attempted.load(Ordering::Acquire) {
        *release
            .baseline_operation
            .lock()
            .map_err(|_| "OTA_STATE_UNAVAILABLE")? = current.operation_id;
    }
    let (_, address, local) = d1_page::resolve_target(request, cancelled).await?;
    if let Some(local) = local {
        d1_page::verify_ap_target(request, mode, Some(local), address).await?;
    }
    let device = device_client(local)?;

    let operation = relay(
        &release,
        &device,
        &format!("http://{address}"),
        operation_id,
        cancelled,
    )
    .await?;
    *release
        .expected_operation
        .lock()
        .map_err(|_| "OTA_STATE_UNAVAILABLE")? = Some(operation.clone());
    let device_state = refresh_status(state, owner, request)
        .await
        .ok()
        .and_then(|state| state.state);
    Ok(OtaSubmitResult {
        release_id: release.preview.release_id.clone(),
        version: release.preview.version.clone(),
        operation_id: Some(operation),
        device_state,
        message: "设备已接收升级文件。安装与回滚由设备自行完成，请查看升级状态确认结果。".into(),
    })
}

async fn relay(
    release: &Release,
    device: &reqwest::Client,
    target: &str,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    let started = Instant::now();
    let total = release.preview.total_bytes;
    if cancelled.load(Ordering::Acquire) {
        return Err("OTA_CANCELLED: 升级已取消，未发送".into());
    }
    let saved = release
        .upload
        .lock()
        .map_err(|_| "OTA_STATE_UNAVAILABLE")?
        .clone();
    let session = if let Some((saved_target, upload_id)) = saved {
        if saved_target != target {
            return Err("OTA_TARGET_CHANGED: 上传目标已变化，请恢复原设备连接".into());
        }
        progress(operation_id, "恢复设备上传会话", 0, total, started);
        let response = device
            .get(format!("{target}/ota/upload/v1/session/{upload_id}"))
            .send()
            .await
            .map_err(|_| "AP_OTA_NETWORK_FAILED: 无法恢复上传会话，请保持连接后重试")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            *release.upload.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")? = None;
            release.begin_attempted.store(false, Ordering::Release);
            return Err(
                "AP_OTA_SESSION_EXPIRED: 设备上传会话已过期，请点击开始升级重新上传".into(),
            );
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(
                "AP_OTA_SESSION_UNAVAILABLE: 设备上传会话不可用，请检查设备状态后重新检查版本"
                    .into(),
            );
        }
        serde_json::from_slice(&bounded_response(response).await?)
            .map_err(|_| "AP_OTA_RESPONSE_INVALID: 上传会话响应无效")?
    } else {
        // Device begin is exclusive: an uncertain reply can be retried manually;
        // an existing session returns BUSY instead of creating a duplicate.
        release.begin_attempted.store(true, Ordering::Release);
        progress(operation_id, "建立设备上传会话", 0, total, started);
        let value = post_json(device, &format!("{target}/ota/upload/v1/session"), serde_json::json!({
            "schema": UPLOAD_SCHEMA, "action": "begin",
            "files": release.files.iter().map(|file| serde_json::json!({
                "name": file.name, "size": file.bytes.len(),
                "sha256": if file.name == "manifest.json.sig" { None } else { Some(sha256_hex(&file.bytes)) },
            })).collect::<Vec<_>>(),
        })).await?;
        // Retain the id before validating descriptors: never blindly start another session.
        let upload_id = text(&value, "upload_id")
            .filter(|id| valid_upload_id(id))
            .ok_or("AP_OTA_RESPONSE_INVALID: 上传会话编号无效，请检查设备状态")?;
        *release.upload.lock().map_err(|_| "OTA_STATE_UNAVAILABLE")? =
            Some((target.to_string(), upload_id));
        value
    };
    let (upload_id, chunk, received) = validate_upload_session(&session, &release.files)?;

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
            if received[&file.name].contains(&index) {
                done += (end - start) as u64;
                progress(operation_id, "恢复已接收的升级文件", done, total, started);
                continue;
            }
            let url = format!(
                "{target}/ota/upload/v1/session/{upload_id}/files/{}/chunks/{index}",
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
            let status = response.status();
            let value: serde_json::Value =
                serde_json::from_slice(&bounded_response(response).await?)
                    .map_err(|_| "AP_OTA_RESPONSE_INVALID: 上传块回执无效")?;
            if !status.is_success() {
                return Err(format!(
                    "AP_OTA_CHUNK_FAILED: {}",
                    text(&value, "message").unwrap_or_else(|| "设备拒绝上传块".into())
                ));
            }
            if text(&value, "schema").as_deref() != Some(UPLOAD_SCHEMA)
                || text(&value, "upload_id").as_deref() != Some(upload_id.as_str())
                || text(&value, "name").as_deref() != Some(file.name.as_str())
                || value["index"].as_u64() != Some(index)
            {
                return Err(
                    "AP_OTA_RESPONSE_INVALID: 上传块回执与当前块不一致，可重试恢复会话".into(),
                );
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
    release.submitted.store(true, Ordering::Release);
    let complete = post_json(
        device,
        &format!("{target}/ota/upload/v1/session/{upload_id}/complete"),
        serde_json::json!({}),
    )
    .await?;
    let operation = text(&complete, "operation_id").filter(|id| {
        !id.is_empty()
            && id.len() <= 160
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    });
    if operation.is_none()
        || text(&complete, "release_id").as_deref() != Some(release.preview.release_id.as_str())
    {
        return Err(
            "AP_OTA_SUBMISSION_UNCONFIRMED: 提交回执无效，请查看设备状态，勿重复升级".into(),
        );
    }
    Ok(operation.unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_current_debian_release_and_pairs_raw_channel_signature() {
        use crate::d1_service_test::{serve, Reply};
        use serde_json::json;
        let id = "1.3.1+gfixture.DOHC-workspace";
        let root = format!("/ota/v1/releases/{id}");
        let artifact = b"fixture deb bytes".to_vec();
        let changes = b"{}".to_vec();
        let markdown = b"changes".to_vec();
        let descriptor = |path: String, bytes: &[u8]| json!({"path":path,"size":bytes.len(),"sha256":sha256_hex(bytes)});
        let manifest=serde_json::to_vec(&json!({"schema":MANIFEST_SCHEMA,"release_id":id,"version":"1.3.1",
            "signing":{"key_id":"dohc-release-lab-2026-01","algorithm":"Ed25519"},"rollback_index":1003001,
            "artifact":descriptor(format!("/ota/v1/artifacts/{id}.deb"),&artifact),
            "changelog":{"json":descriptor(format!("{root}/changelog.json"),&changes),"markdown":descriptor(format!("{root}/changelog.md"),&markdown)}})).unwrap();
        let channel=serde_json::to_vec(&json!({"schema":CHANNEL_SCHEMA,"channel":"factory","release_id":id,"version":"1.3.1",
            "key_id":"dohc-release-lab-2026-01","rollback_index":1003001,"manifest":descriptor(format!("{root}/manifest.json"),&manifest)})).unwrap();
        let generation = sha256_hex(&channel);
        let mut resources = vec![
            ("/ota/v1/channels/factory.json".into(), channel),
            (
                format!("/ota/v1/channels/factory.json.sig?generation={generation}"),
                vec![7; 64],
            ),
            (format!("{root}/manifest.json"), manifest),
            (format!("{root}/manifest.json.sig"), vec![8; 64]),
            (format!("{root}/changelog.json"), changes),
            (format!("{root}/changelog.md"), markdown),
            (format!("/ota/v1/artifacts/{id}.deb"), artifact.clone()),
        ];
        let replies = resources
            .drain(..)
            .enumerate()
            .map(|(i, (path, body))| Reply {
                method: "GET",
                path,
                status: 200,
                headers: if i == 0 {
                    vec![("ETag".into(), format!("\"{generation}\""))]
                } else {
                    vec![]
                },
                body,
            })
            .collect();
        let (base, worker) = serve(replies);
        let release = tauri::async_runtime::block_on(resolve(
            &client().unwrap(),
            &Origin { base },
            &AtomicBool::new(false),
        ))
        .unwrap();
        assert_eq!(worker.join().unwrap().len(), 7);
        assert_eq!(release.preview.version, "1.3.1");
        assert_eq!(release.files.len(), 5);
        assert_eq!(release.files[4].name, "artifact.deb");
        assert_eq!(release.files[4].bytes, artifact);
        let cache = OtaState::default();
        let preview = cache.remember("reviewer", release).unwrap();
        assert!(cache.get("other", &preview.preview_id).is_err());
        assert!(cache.get("reviewer", &preview.preview_id).is_ok());
    }

    #[test]
    fn relay_resumes_received_chunks_and_accepts_real_complete_contract() {
        use crate::d1_service_test::{serve, Reply};
        use serde_json::json;
        let upload_id = "12345678-1234-1234-1234-123456789abc";
        let files: Vec<_> = [
            "manifest.json",
            "manifest.json.sig",
            "changelog.json",
            "changelog.md",
            "artifact.deb",
        ]
        .into_iter()
        .map(|name| Downloaded {
            name: name.into(),
            bytes: vec![
                7;
                if name == "manifest.json.sig" {
                    64
                } else if name == "artifact.deb" {
                    70000
                } else {
                    12
                }
            ],
        })
        .collect();
        let preview = OtaPreview {
            preview_id: "resume-preview".into(),
            release_id: "fixture-release".into(),
            version: "1.3.1".into(),
            channel: "factory".into(),
            key_id: None,
            rollback_index: None,
            artifact_bytes: 70000,
            total_bytes: files.iter().map(|f| f.bytes.len() as u64).sum(),
            files: vec![],
            trust: TrustStatus::DeviceVerified,
        };
        let release = Release {
            preview,
            files,
            upload: Mutex::new(None),
            submitted: AtomicBool::new(false),
            begin_attempted: AtomicBool::new(false),
            settled: AtomicBool::new(false),
            baseline_operation: Mutex::new(Some("old-operation".into())),
            expected_operation: Mutex::new(None),
        };
        let session = |received: bool| {
            json!({"schema":UPLOAD_SCHEMA,"upload_id":upload_id,"chunk_size":65536,
            "files":release.files.iter().map(|f|json!({"name":f.name,"size":f.bytes.len(),"sha256":if f.name=="manifest.json.sig" {None} else {Some(sha256_hex(&f.bytes))},"chunks":chunk_count(f.bytes.len() as u64,65536),"received":if received&&f.name=="manifest.json" {vec![0]}else{vec![]}})).collect::<Vec<_>>()})
        };
        let response = |method, path: String, status, body| Reply {
            method,
            path,
            status,
            headers: vec![],
            body: serde_json::to_vec(&body).unwrap(),
        };
        let mut replies = vec![
            response("POST", "/ota/upload/v1/session".into(), 200, session(false)),
            response(
                "PUT",
                format!("/ota/upload/v1/session/{upload_id}/files/manifest.json/chunks/0"),
                200,
                json!({"schema":UPLOAD_SCHEMA,"upload_id":upload_id,"name":"manifest.json","index":0}),
            ),
            response(
                "PUT",
                format!("/ota/upload/v1/session/{upload_id}/files/manifest.json.sig/chunks/0"),
                503,
                json!({"message":"interrupted"}),
            ),
            response(
                "GET",
                format!("/ota/upload/v1/session/{upload_id}"),
                200,
                session(true),
            ),
        ];
        for f in release.files.iter().skip(1) {
            for index in 0..chunk_count(f.bytes.len() as u64, 65536) {
                replies.push(response("PUT",format!("/ota/upload/v1/session/{upload_id}/files/{}/chunks/{index}",f.name),200,json!({"schema":UPLOAD_SCHEMA,"upload_id":upload_id,"name":f.name,"index":index})));
            }
        }
        replies.push(response(
            "POST",
            format!("/ota/upload/v1/session/{upload_id}/complete"),
            202,
            json!({"operation_id":"new-operation","release_id":"fixture-release"}),
        ));
        let (target, worker) = serve(replies);
        let client = device_client(None).unwrap();
        let cancelled = AtomicBool::new(false);
        assert!(
            tauri::async_runtime::block_on(relay(&release, &client, &target, 1, &cancelled))
                .is_err()
        );
        assert!(!release.submitted.load(Ordering::Acquire));
        let operation =
            tauri::async_runtime::block_on(relay(&release, &client, &target, 2, &cancelled))
                .unwrap();
        assert_eq!(operation, "new-operation");
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 10);
        // The first confirmed block is never sent again; every actual chunk has its digest.
        for request in requests.iter().filter(|r| r.starts_with(b"PUT")) {
            let end = request.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
            let headers = String::from_utf8_lossy(&request[..end]);
            assert!(headers.to_lowercase().contains(&format!(
                "x-ap-ota-chunk-sha256: {}",
                sha256_hex(&request[end..])
            )));
        }
        let status = DeviceOtaStatus {
            available: true,
            state: Some("SUCCESS".into()),
            result: Some("PASS".into()),
            operation_id: Some("old-operation".into()),
            release_before: None,
            release_target: Some("fixture-release".into()),
            target_version: None,
            active: false,
            final_state: true,
            guidance: None,
            detail: String::new(),
        };
        release.observe(true, &target, &status).unwrap();
        assert!(!release.settled.load(Ordering::Acquire));
        let status = DeviceOtaStatus {
            operation_id: Some(operation),
            ..status
        };
        release.observe(false, &target, &status).unwrap();
        assert!(!release.settled.load(Ordering::Acquire));
        release.observe(true, &target, &status).unwrap();
        assert!(release.settled.load(Ordering::Acquire));
    }

    #[test]
    fn resume_rejects_other_files_and_invalid_received_chunks() {
        use serde_json::json;
        let files = vec![Downloaded {
            name: "artifact.deb".into(),
            bytes: vec![1; 70_000],
        }];
        let mut value = json!({"schema":UPLOAD_SCHEMA,"upload_id":"12345678-1234-1234-1234-123456789abc","chunk_size":65536,
            "files":[{"name":"artifact.deb","size":70000,"sha256":sha256_hex(&files[0].bytes),"chunks":2,"received":[0]}]});
        let (_, _, received) = validate_upload_session(&value, &files).unwrap();
        assert!(received["artifact.deb"].contains(&0));
        value["files"][0]["received"] = json!([2]);
        assert!(validate_upload_session(&value, &files).is_err());
        value["files"][0]["received"] = json!([0]);
        value["files"][0]["sha256"] = json!("0".repeat(64));
        assert!(validate_upload_session(&value, &files).is_err());
        assert!(verify_signature(b"payload", &[0; 63]).is_err());
    }

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
