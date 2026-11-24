//! Factory channel resolution and verified release downloads for the SSH installer.
use crate::d1_services::{self, Origin, TrustStatus};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CHANNEL_SCHEMA: &str = "dohc.ota.channel.v1";
const MANIFEST_SCHEMA: &str = "dohc.ota.release-manifest.v1";
const SIGNATURE_BYTES: usize = 64;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const METADATA_TIMEOUT: Duration = Duration::from_secs(7);
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(24);
const PACKAGE_TIMEOUT: Duration = Duration::from_secs(600);

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
    pub failure_codes: Vec<String>,
    pub reason: Option<String>,
    pub previous_result: bool,
    pub guidance: Option<String>,
    pub detail: String,
}

struct Release {
    preview: OtaPreview,
    origin: Origin,
}

pub(crate) struct DevicePackage(Vec<u8>);
impl DevicePackage {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }
}
#[derive(Default)]
pub struct OtaState(Mutex<Option<(String, Instant, Arc<Release>)>>);
impl OtaState {
    pub(crate) fn device_release(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<(OtaPreview, String), String> {
        let release = self.get(owner, id)?;
        let artifact = deb_descriptor(&release.preview)?;
        let url = d1_services::ota_url(&release.origin, &artifact.path)?;
        Ok((release.preview.clone(), url))
    }
    /// Only called after the user confirms an upgrade and device download fails.
    pub(crate) async fn device_package(
        &self,
        owner: &str,
        id: &str,
        cancelled: &AtomicBool,
    ) -> Result<DevicePackage, String> {
        let release = self.get(owner, id)?;
        let artifact = deb_descriptor(&release.preview)?;
        let bytes = fetch(
            &client()?,
            &release.origin,
            &artifact.path,
            artifact.size,
            cancelled,
        )
        .await?;
        verify_file(artifact, &bytes)?;
        Ok(DevicePackage(bytes))
    }
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
            || created.elapsed() > Duration::from_secs(1800)
            || release.preview.preview_id != preview_id
        {
            return Err("OTA_PREVIEW_EXPIRED: 版本预览已失效，请重新检查".into());
        }
        Ok(Arc::clone(release))
    }
}

fn deb_descriptor(preview: &OtaPreview) -> Result<&FileDescriptor, String> {
    preview
        .files
        .iter()
        .find(|file| file.name == "artifact.deb")
        .ok_or_else(|| "OTA_DEB_REQUIRED: Factory 通道不是 Debian 安装包".into())
}

fn verify_file(file: &FileDescriptor, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != file.size {
        return Err(format!(
            "OTA_SIZE_MISMATCH: {} 大小与发布清单不一致，请重新检查版本",
            file.name
        ));
    }
    if file
        .sha256
        .as_ref()
        .is_some_and(|expected| sha256_hex(bytes) != *expected)
    {
        return Err(format!(
            "OTA_HASH_MISMATCH: {} 摘要校验失败，已停止升级，请联系管理员核查发布文件",
            file.name
        ));
    }
    Ok(())
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
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(30))
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

fn source_resource(path: &str) -> &'static str {
    if path.ends_with(".sig") || path.contains(".sig?") {
        "发布签名"
    } else if path.contains("/channels/") {
        "版本通道"
    } else if path.ends_with("manifest.json") {
        "版本清单"
    } else if path.contains("/artifacts/") {
        "安装包"
    } else {
        "更新说明"
    }
}

fn source_error(error: reqwest::Error, path: &str, reading_body: bool) -> String {
    let resource = source_resource(path);
    if error.is_timeout() && error.is_connect() {
        format!("OTA_SOURCE_CONNECT_TIMEOUT: 电脑连接 OTA 源站超时（{resource}）。请检查电脑能否访问升级服务所在网络。")
    } else if error.is_timeout() && reading_body {
        format!("OTA_SOURCE_TIMEOUT: 读取 OTA 源站响应内容超时（{resource}）。请稍后重试；若持续出现，请联系管理员。")
    } else if error.is_timeout() {
        format!("OTA_SOURCE_TIMEOUT: 等待 OTA 源站响应超时（{resource}）。请稍后重试；若持续出现，请联系管理员。")
    } else if error.is_connect() {
        format!("OTA_SOURCE_UNREACHABLE: 无法连接 OTA 源站（{resource}）。请检查电脑网络；若网络正常，请联系管理员检查升级服务。")
    } else {
        format!("OTA_SOURCE_INTERRUPTED: OTA 源站传输中断（{resource}）。请稍后重试；若持续出现，请联系管理员检查升级服务。")
    }
}

async fn wait_cancelled(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn retryable(error: &str) -> bool {
    [
        "OTA_SOURCE_TIMEOUT:",
        "OTA_SOURCE_CONNECT_TIMEOUT:",
        "OTA_SOURCE_UNREACHABLE:",
        "OTA_SOURCE_INTERRUPTED:",
        "OTA_HTTP_502:",
        "OTA_HTTP_503:",
        "OTA_HTTP_504:",
    ]
    .iter()
    .any(|code| error.starts_with(code))
}

async fn fetch_with_etag(
    client: &reqwest::Client,
    origin: &Origin,
    path: &str,
    limit: u64,
    cancelled: &AtomicBool,
) -> Result<(Vec<u8>, Option<String>), String> {
    let package = path.contains("/artifacts/");
    let delays = if package { &[250][..] } else { &[250, 750][..] };
    let started = Instant::now();
    for attempt in 0..=delays.len() {
        match fetch_once(client, origin, path, limit, cancelled).await {
            Err(error) if retryable(&error) => {
                if let Some(delay) = delays.get(attempt) {
                    tokio::select! {
                        _ = wait_cancelled(cancelled) => return Err("OTA_CANCELLED: 升级已取消".into()),
                        _ = tokio::time::sleep(Duration::from_millis(*delay)) => {}
                    }
                } else {
                    return Err(format!(
                        "{error}\n{}{} · {} 次请求 · {} ms",
                        origin.base,
                        path.split('?').next().unwrap_or(path),
                        attempt + 1,
                        started.elapsed().as_millis()
                    ));
                }
            }
            result => return result,
        }
    }
    unreachable!()
}

async fn fetch_once(
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
    let timeout = if path.contains("/artifacts/") {
        PACKAGE_TIMEOUT
    } else {
        METADATA_TIMEOUT
    };
    let response = tokio::select! {
        _ = wait_cancelled(cancelled) => return Err("OTA_CANCELLED: 升级已取消".into()),
        response = client.get(url).timeout(timeout).header("Accept", "application/octet-stream").send() => response.map_err(|error| source_error(error, path, false))?,
    };
    let status = response.status().as_u16();
    if status != 200 {
        let reason = match status {
            404 => "当前发布资源不存在，请稍后重试；若持续出现，请联系管理员检查发布内容",
            401 | 403 => "OTA 源站拒绝访问，请联系管理员检查下载权限",
            502..=504 => "OTA 源站暂不可用，请稍后重试；若持续出现，请联系管理员检查升级服务",
            _ => "OTA 源站响应异常，请稍后重试或联系管理员",
        };
        return Err(format!(
            "OTA_HTTP_{status}: {reason}（HTTP {status}，{}）。",
            source_resource(path)
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("OTA_RESPONSE_TOO_LARGE: OTA 发布资源超过大小限制，已停止读取，请联系管理员检查发布内容".into());
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    loop {
        let next = tokio::select! {
            _ = wait_cancelled(cancelled) => return Err("OTA_CANCELLED: 升级已取消".into()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|error| source_error(error, path, true))?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("OTA_RESPONSE_TOO_LARGE: OTA 发布资源超过大小限制，已停止读取，请联系管理员检查发布内容".into());
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

    let manifest_signature = fetch(
        client,
        origin,
        &signature.path,
        SIGNATURE_BYTES as u64,
        cancelled,
    )
    .await?;
    verify_signature(&manifest_bytes, &manifest_signature)?;
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

    let total_bytes = [
        &manifest,
        &signature,
        &changelog_json,
        &changelog_md,
        &artifact,
    ]
    .iter()
    .map(|file| file.size)
    .sum();
    Ok(Release {
        preview: OtaPreview {
            preview_id: format!(
                "{}-{}",
                sha256_hex(&manifest_bytes),
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
                TrustStatus::DigestOnly
            },
        },
        origin: origin.clone(),
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
            .unwrap_or(TrustStatus::DigestOnly),
        _ => TrustStatus::DigestOnly,
    };
    let trust_key_id = ota.trust_root.and_then(|root| root.key_id);
    let detail = if !ota.enabled || origin.is_none() {
        "升级服务尚未配置".to_string()
    } else if matches!(trust, TrustStatus::Configured) {
        "SSH 直接升级：设备下载 Factory 安装包，由包内安装器完成安装与健康检查；软件已配置发布公钥。".into()
    } else {
        "SSH 直接升级：设备下载 Factory 安装包，核对大小与摘要后调用包内安装器。当前未配置发布公钥。".into()
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
    let source = origin()?;
    let client = client()?;
    let release = tokio::time::timeout(VERSION_CHECK_TIMEOUT, resolve(&client, &source, cancelled))
        .await
        .map_err(|_| {
            format!(
            "OTA_SOURCE_CHECK_TIMEOUT: 读取 OTA 发布信息超时。请检查电脑网络后重试。\n{} · {} s",
            source.base,
            VERSION_CHECK_TIMEOUT.as_secs()
        )
        })??;
    state.remember(owner, release)
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
        assert_eq!(worker.join().unwrap().len(), 4);
        assert_eq!(release.preview.version, "1.3.1");
        assert_eq!(release.preview.files.len(), 5);
        assert_eq!(release.preview.artifact_bytes, artifact.len() as u64);
        let cache = OtaState::default();
        let preview = cache.remember("reviewer", release).unwrap();
        assert!(cache.get("other", &preview.preview_id).is_err());
        assert!(cache.get("reviewer", &preview.preview_id).is_ok());
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

    #[test]
    fn source_gateway_retries_are_bounded_and_missing_release_is_not_retried() {
        use crate::d1_service_test::{serve, Reply};
        let path = "/ota/v1/channels/factory.json";
        for (codes, expected) in [
            (vec![503, 504, 200], None),
            (vec![504, 504, 504], Some("OTA_HTTP_504:")),
            (vec![404], Some("OTA_HTTP_404:")),
        ] {
            let (base, worker) = serve(
                codes
                    .iter()
                    .map(|status| Reply {
                        method: "GET",
                        path: path.into(),
                        status: *status,
                        headers: vec![],
                        body: b"fixture".to_vec(),
                    })
                    .collect(),
            );
            let result = tauri::async_runtime::block_on(fetch(
                &client().unwrap(),
                &Origin { base: base.clone() },
                path,
                100,
                &AtomicBool::new(false),
            ));
            if let Some(code) = expected {
                let error = result.unwrap_err();
                assert!(error.starts_with(code), "{error}");
                assert!(error.contains("管理员"));
                if codes.len() > 1 {
                    assert!(error.contains(&format!("{base}{path} · 3 次请求")));
                }
            } else {
                assert_eq!(result.unwrap(), b"fixture");
            }
            assert_eq!(worker.join().unwrap().len(), codes.len());
        }
    }

    #[test]
    fn stalled_source_reports_timeout_and_cancellation_interrupts_the_body() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = Origin {
                base: format!("http://{}", listener.local_addr().unwrap()),
            };
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() <= 4096);
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n")
                    .unwrap();
                std::thread::sleep(Duration::from_millis(350));
                let _ = stream.write_all(b"test");
            });
            let cancelled = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&cancelled);
            let error = tauri::async_runtime::block_on(async {
                let http = reqwest::Client::builder()
                    .no_proxy()
                    .read_timeout(Duration::from_millis(if cancel { 2000 } else { 40 }))
                    .build()
                    .unwrap();
                let signal = tokio::spawn(async move {
                    if cancel {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        flag.store(true, Ordering::Release);
                    }
                });
                let result = fetch_once(
                    &http,
                    &origin,
                    "/ota/v1/channels/factory.json",
                    100,
                    &cancelled,
                )
                .await;
                signal.await.unwrap();
                result.unwrap_err()
            });
            assert!(
                error.starts_with(if cancel {
                    "OTA_CANCELLED:"
                } else {
                    "OTA_SOURCE_TIMEOUT:"
                }),
                "{error}"
            );
            if !cancel {
                assert!(error.contains("版本通道"));
                assert!(error.contains("管理员"));
            }
            worker.join().unwrap();
        }
    }

    #[test]
    fn deferred_fallback_stays_on_frozen_artifact_and_rejects_digest_changes() {
        use crate::d1_service_test::{serve, Reply};
        for valid in [true, false] {
            let body = b"frozen package".to_vec();
            let path = "/ota/v1/artifacts/frozen-release.deb";
            let (base, worker) = serve(vec![Reply {
                method: "GET",
                path: path.into(),
                status: 200,
                headers: vec![],
                body: body.clone(),
            }]);
            let cache = OtaState::default();
            let preview = OtaPreview {
                preview_id: "frozen-preview".into(),
                release_id: "frozen-release".into(),
                version: "1.3.1".into(),
                channel: "factory".into(),
                key_id: None,
                rollback_index: None,
                artifact_bytes: body.len() as u64,
                total_bytes: body.len() as u64,
                trust: TrustStatus::DigestOnly,
                files: vec![FileDescriptor {
                    name: "artifact.deb".into(),
                    path: path.into(),
                    size: body.len() as u64,
                    sha256: Some(if valid {
                        sha256_hex(&body)
                    } else {
                        "0".repeat(64)
                    }),
                }],
            };
            let origin = Origin { base: base.clone() };
            cache
                .remember("owner", Release { preview, origin })
                .unwrap();
            assert!(cache
                .device_release("other-owner", "frozen-preview")
                .is_err());
            assert_eq!(
                cache.device_release("owner", "frozen-preview").unwrap().1,
                format!("{base}{path}")
            );
            let result = tauri::async_runtime::block_on(cache.device_package(
                "owner",
                "frozen-preview",
                &AtomicBool::new(false),
            ));
            if valid {
                assert_eq!(result.unwrap().bytes(), body);
            } else {
                assert!(result.err().unwrap().starts_with("OTA_HASH_MISMATCH:"));
            }
            assert_eq!(worker.join().unwrap().len(), 1);
        }
    }
}
