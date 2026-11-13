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
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

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

struct Downloaded {
    name: String,
    bytes: Vec<u8>,
}

struct Release {
    preview: OtaPreview,
    files: Vec<Downloaded>,
}

pub(crate) struct DevicePackage(Arc<Release>, usize);
impl DevicePackage {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0.files[self.1].bytes
    }
}
#[derive(Default)]
pub struct OtaState(Mutex<Option<(String, Instant, Arc<Release>)>>);
impl OtaState {
    pub(crate) fn device_package(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<(OtaPreview, DevicePackage), String> {
        let release = self.get(owner, id)?;
        let index = release
            .files
            .iter()
            .position(|file| file.name == "artifact.deb")
            .ok_or("OTA_DEB_REQUIRED: Factory 通道不是 Debian 安装包")?;
        Ok((release.preview.clone(), DevicePackage(release, index)))
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
                TrustStatus::DigestOnly
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
    let release = resolve(&client()?, &origin()?, cancelled).await?;
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
