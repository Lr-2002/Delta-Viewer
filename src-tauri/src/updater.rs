use crate::error::{AppError, AppResult};
use crate::model::{AppUpdateInfo, ProgressPayload};
use crate::source;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::ACCEPT;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MIN_UPDATE_BYTES: u64 = 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 64 * 1024 * 1024;
const RELEASE_PATH_PREFIX: &str = "/releases/";

pub async fn check(app: &AppHandle) -> AppResult<AppUpdateInfo> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(update_check_error)?;
    let update = updater.check().await.map_err(update_check_error)?;
    Ok(match update {
        Some(update) => {
            require_mirror_release(app, &update)?;
            AppUpdateInfo {
                current_version,
                latest_version: update.version,
                available: true,
                notes: update.body,
                published_at: update.date.map(|date| date.to_string()),
            }
        }
        None => AppUpdateInfo {
            latest_version: current_version.clone(),
            current_version,
            available: false,
            notes: None,
            published_at: None,
        },
    })
}

pub async fn download_and_install(
    app: &AppHandle,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> AppResult<bool> {
    check_cancelled(cancelled)?;
    let updater = app
        .updater_builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(update_check_error)?;
    let Some(update) = updater.check().await.map_err(update_check_error)? else {
        return Ok(false);
    };
    require_mirror_release(app, &update)?;
    let expected_bytes = expected_download_bytes(&update)?;
    let latest_version = update.version.clone();
    let download_url = update.download_url.to_string();
    let started = Instant::now();
    let progress_app = app.clone();
    let mut bytes_done = 0_u64;

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(concat!("DOHC-Viewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(update_download_error)?;
    let response = client
        .get(update.download_url.clone())
        .header(ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(update_download_error)?
        .error_for_status()
        .map_err(update_download_error)?;
    if let Some(content_length) = response.content_length() {
        if content_length != expected_bytes {
            return Err(update_size_error(expected_bytes, content_length));
        }
    }

    let mut bytes = Vec::with_capacity(expected_bytes as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        check_cancelled(cancelled)?;
        let chunk = chunk.map_err(update_download_error)?;
        bytes_done = bytes_done
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| update_manifest_error("更新包大小溢出"))?;
        if bytes_done > expected_bytes || bytes_done > MAX_UPDATE_BYTES {
            return Err(update_size_error(expected_bytes, bytes_done));
        }
        bytes.extend_from_slice(&chunk);
        source::emit_progress_for_operation(
            Some(&progress_app),
            operation_id,
            ProgressPayload {
                task: "update".into(),
                phase: format!("下载 v{latest_version}"),
                current: bytes_done,
                total: expected_bytes,
                bytes_done,
                total_bytes: expected_bytes,
                current_path: download_url.clone(),
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
    }

    check_cancelled(cancelled)?;
    if bytes.len() as u64 != expected_bytes {
        return Err(update_size_error(expected_bytes, bytes.len() as u64));
    }
    verify_signature(app, &update, &bytes)?;
    source::emit_progress_for_operation(
        Some(app),
        operation_id,
        ProgressPayload {
            task: "update".into(),
            phase: "签名已验证，正在安装".into(),
            current: expected_bytes,
            total: expected_bytes,
            bytes_done: expected_bytes,
            total_bytes: expected_bytes,
            current_path: update.download_url.to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        },
    );

    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| {
            AppError::Message(format!("UPDATE_INSTALL_FAILED: 更新安装任务失败: {error}"))
        })?
        .map_err(|error| {
            AppError::Message(format!("UPDATE_INSTALL_FAILED: 无法安装更新: {error}"))
        })?;
    Ok(true)
}

fn require_mirror_release(app: &AppHandle, update: &Update) -> AppResult<()> {
    let endpoints = configured_update_endpoints(app)?;
    if !endpoints
        .iter()
        .any(|endpoint| is_allowed_mirror_url(endpoint, &update.download_url, &update.version))
    {
        return Err(AppError::Message(
            "UPDATE_SOURCE_REJECTED: 更新包不是已配置镜像的当前版本资产".into(),
        ));
    }
    expected_download_bytes(update).map(|_| ())
}

fn configured_update_endpoints(app: &AppHandle) -> AppResult<Vec<reqwest::Url>> {
    let values = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| update_manifest_error("应用未配置更新镜像地址"))?;
    if values.is_empty() {
        return Err(update_manifest_error("应用未配置更新镜像地址"));
    }
    let mut endpoints = Vec::with_capacity(values.len());
    for value in values {
        let endpoint = value
            .as_str()
            .ok_or_else(|| update_manifest_error("更新镜像地址必须是字符串"))?;
        let endpoint = reqwest::Url::parse(endpoint)
            .map_err(|error| update_manifest_error(&format!("更新镜像地址无效: {error}")))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.path() != "/latest.json"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoints
                .iter()
                .any(|existing: &reqwest::Url| existing == &endpoint)
        {
            return Err(update_manifest_error(
                "更新镜像地址必须是唯一的固定 HTTP(S) origin /latest.json",
            ));
        }
        endpoints.push(endpoint);
    }
    Ok(endpoints)
}

fn is_allowed_mirror_url(endpoint: &reqwest::Url, download: &reqwest::Url, version: &str) -> bool {
    let expected_prefix = format!("{RELEASE_PATH_PREFIX}v{version}/");
    let remainder = download.path().strip_prefix(&expected_prefix);
    matches!(download.scheme(), "http" | "https")
        && download.scheme() == endpoint.scheme()
        && download.host_str() == endpoint.host_str()
        && download.port_or_known_default() == endpoint.port_or_known_default()
        && download.query().is_none()
        && download.fragment().is_none()
        && download.username().is_empty()
        && download.password().is_none()
        && remainder.is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

fn expected_download_bytes(update: &Update) -> AppResult<u64> {
    let platforms = update
        .raw_json
        .get("platforms")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| update_manifest_error("缺少 platforms"))?;
    let expected_url = update.download_url.as_str();
    let size = platforms
        .values()
        .find(|platform| {
            platform.get("url").and_then(serde_json::Value::as_str) == Some(expected_url)
        })
        .and_then(|platform| platform.get("size"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| update_manifest_error("当前平台缺少可信 size"))?;
    if !(MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(&size) {
        return Err(update_manifest_error(&format!(
            "更新包大小 {size} 超出允许范围"
        )));
    }
    Ok(size)
}

fn update_check_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("UPDATE_CHECK_FAILED: 无法检查最新版本: {error}"))
}

fn update_download_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("UPDATE_DOWNLOAD_FAILED: 无法下载更新: {error}"))
}

fn update_size_error(expected: u64, actual: u64) -> AppError {
    AppError::Message(format!(
        "UPDATE_SIZE_MISMATCH: 更新包大小不匹配，预期 {expected} 字节，实际 {actual} 字节"
    ))
}

fn update_manifest_error(message: &str) -> AppError {
    AppError::Message(format!("UPDATE_MANIFEST_INVALID: {message}"))
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

fn verify_signature(app: &AppHandle, update: &Update, bytes: &[u8]) -> AppResult<()> {
    let wrapped_public_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| update_manifest_error("应用未配置更新公钥"))?;
    verify_minisign(wrapped_public_key, &update.signature, bytes)
}

fn verify_minisign(
    wrapped_public_key: &str,
    wrapped_signature: &str,
    bytes: &[u8],
) -> AppResult<()> {
    let public_key_envelope = decode_base64_utf8(wrapped_public_key, "更新公钥")?;
    let signature_envelope = decode_base64_utf8(wrapped_signature, "更新签名")?;
    let public_key = PublicKey::decode(&public_key_envelope)
        .map_err(|error| update_signature_error(format!("无法解析更新公钥: {error}")))?;
    let signature = Signature::decode(&signature_envelope)
        .map_err(|error| update_signature_error(format!("无法解析更新签名: {error}")))?;
    public_key
        .verify(bytes, &signature, false)
        .map_err(|error| update_signature_error(format!("更新签名无效: {error}")))
}

fn decode_base64_utf8(value: &str, label: &str) -> AppResult<String> {
    let decoded = BASE64
        .decode(value)
        .map_err(|error| update_signature_error(format!("{label}不是有效 Base64: {error}")))?;
    String::from_utf8(decoded)
        .map_err(|error| update_signature_error(format!("{label}不是有效 UTF-8: {error}")))
}

fn update_signature_error(message: String) -> AppError {
    AppError::Message(format!("UPDATE_SIGNATURE_INVALID: {message}"))
}

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_mirror_url, verify_minisign, MAX_UPDATE_BYTES, MIN_UPDATE_BYTES,
        RELEASE_PATH_PREFIX,
    };
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    #[test]
    fn updater_limits_keep_release_assets_bounded() {
        assert_eq!(MIN_UPDATE_BYTES, 1024 * 1024);
        assert_eq!(MAX_UPDATE_BYTES, 64 * 1024 * 1024);
        assert_eq!(RELEASE_PATH_PREFIX, "/releases/");
    }

    #[test]
    fn accepts_only_the_configured_mirror_origin_and_exact_version_directory() {
        let endpoint = reqwest::Url::parse("http://39.155.172.162:17879/latest.json").unwrap();
        let fallback = reqwest::Url::parse("http://10.1.11.36:17879/latest.json").unwrap();
        let allowed = reqwest::Url::parse(
            "http://39.155.172.162:17879/releases/v0.17.9/DOHC-Viewer_0.17.9.deb",
        )
        .unwrap();
        assert!(is_allowed_mirror_url(&endpoint, &allowed, "0.17.9"));
        let fallback_allowed =
            reqwest::Url::parse("http://10.1.11.36:17879/releases/v0.17.9/DOHC-Viewer_0.17.9.deb")
                .unwrap();
        assert!(is_allowed_mirror_url(
            &fallback,
            &fallback_allowed,
            "0.17.9"
        ));

        for rejected in [
            "https://39.155.172.162:17879/releases/v0.17.9/update.deb",
            "http://39.155.172.163:17879/releases/v0.17.9/update.deb",
            "http://39.155.172.162:17880/releases/v0.17.9/update.deb",
            "http://39.155.172.162:17879/releases/v0.17.8/update.deb",
            "http://39.155.172.162:17879/releases/v0.17.9/nested/update.deb",
        ] {
            let url = reqwest::Url::parse(rejected).unwrap();
            assert!(!is_allowed_mirror_url(&endpoint, &url, "0.17.9"));
        }
    }

    #[test]
    fn verifies_wrapped_prehashed_minisign_and_rejects_tampering() {
        let public_key = BASE64.encode(concat!(
            "untrusted comment: minisign public key E7620F1842B4E81F\n",
            "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
        ));
        let signature = BASE64.encode(concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
            "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
            "trusted comment: timestamp:1556193335\tfile:test\n",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n",
        ));

        verify_minisign(&public_key, &signature, b"test").unwrap();
        assert!(verify_minisign(&public_key, &signature, b"Test").is_err());
    }
}
