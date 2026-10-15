use crate::error::{AppError, AppResult};
use crate::model::{AppUpdateInfo, ProgressPayload};
use crate::{source, storage};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::{Client, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const RELEASE_API: &str = "https://api.github.com/repos/Lr-2002/Delta-Viewer/releases/latest";
const REPOSITORY: &str = "https://github.com/Lr-2002/Delta-Viewer";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MIN_UPDATE_BYTES: u64 = 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 64 * 1024 * 1024;
const TARGETS: [&str; 3] = [
    "windows-x86_64-nsis",
    "darwin-aarch64-app",
    "linux-x86_64-deb",
];

#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn platform_target() -> AppResult<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok(TARGETS[0]),
        ("macos", "aarch64") => Ok(TARGETS[1]),
        ("linux", "x86_64") => Ok(TARGETS[2]),
        _ => Err(update_manifest_error("当前平台没有正式更新包")),
    }
}
fn asset_name(version: &str, target: &str) -> AppResult<String> {
    let suffix = match target {
        "windows-x86_64-nsis" => "windows-x64-updater.exe",
        "darwin-aarch64-app" => "macos-arm64.app.tar.gz",
        "linux-x86_64-deb" => "ubuntu-22.04+-x64.deb",
        _ => return Err(update_manifest_error("不支持的更新平台")),
    };
    Ok(format!("Delta-Viewer_{version}_UNSIGNED_{suffix}"))
}
fn asset_url(version: &str, name: &str) -> AppResult<Url> {
    // Generated names are ASCII; GitHub/assemble-release encode the literal + in
    // the Ubuntu filename as %2B. Keep exact URL equality for all three targets.
    Url::parse(&format!(
        "{REPOSITORY}/releases/download/v{version}/{}",
        name.replace('+', "%2B")
    ))
    .map_err(update_check_error)
}
fn canonical_version(tag: &str) -> AppResult<String> {
    let value = tag
        .strip_prefix('v')
        .ok_or_else(|| update_manifest_error("Release 必须使用 vX.Y.Z 标签"))?;
    let parsed = semver::Version::parse(value).map_err(update_check_error)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != value {
        return Err(update_manifest_error("不接受预发布或非标准版本号"));
    }
    Ok(value.to_owned())
}
fn validate_release(release: &Release) -> AppResult<(String, Url)> {
    if release.draft || release.prerelease || release.published_at.is_none() {
        return Err(update_manifest_error("只接受已公开的正式 Release"));
    }
    let version = canonical_version(&release.tag_name)?;
    let manifest = release
        .assets
        .iter()
        .filter(|asset| asset.name == "latest.json")
        .collect::<Vec<_>>();
    if manifest.len() != 1 || manifest[0].size == 0 || manifest[0].size > MAX_METADATA_BYTES {
        return Err(update_manifest_error("正式 Release 缺少有界的 latest.json"));
    }
    let url = asset_url(&version, "latest.json")?;
    if Url::parse(&manifest[0].browser_download_url).ok().as_ref() != Some(&url) {
        return Err(update_manifest_error("更新清单不属于官方仓库的精确版本"));
    }
    Ok((version, url))
}
fn allowed_redirect(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("github.com") => url
                .path()
                .starts_with("/Lr-2002/Delta-Viewer/releases/download/"),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}
fn redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() < 5 && allowed_redirect(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("更新下载重定向不属于官方 HTTPS 资产域名")
        }
    })
}
fn client(timeout: Duration) -> AppResult<Client> {
    #[cfg(not(target_os = "windows"))]
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .redirect(redirects())
        .user_agent(concat!("Delta-Viewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(update_check_error)
}
async fn bounded_get(client: &Client, url: Url, limit: u64) -> AppResult<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(update_check_error)?
        .error_for_status()
        .map_err(update_check_error)?;
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(update_manifest_error("更新元数据超过大小限制"));
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(update_check_error)?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(update_manifest_error("更新元数据超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn validate_manifest(
    json: &serde_json::Value,
    version: &str,
    release: Option<&Release>,
) -> AppResult<()> {
    if json.get("version").and_then(|v| v.as_str()) != Some(version) {
        return Err(update_manifest_error("清单版本与最新 Release 不一致"));
    }
    let platforms = json
        .get("platforms")
        .and_then(|v| v.as_object())
        .ok_or_else(|| update_manifest_error("缺少 platforms"))?;
    if platforms.len() != TARGETS.len() {
        return Err(update_manifest_error("三平台更新集合不完整"));
    }
    for target in TARGETS {
        let entry = platforms
            .get(target)
            .ok_or_else(|| update_manifest_error("三平台更新集合不完整"))?;
        let name = asset_name(version, target)?;
        let expected_url = asset_url(version, &name)?;
        let url = entry
            .get("url")
            .and_then(|v| v.as_str())
            .and_then(|v| Url::parse(v).ok());
        let size = entry.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let hash = entry.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
        let signature = entry
            .get("signature")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if url.as_ref() != Some(&expected_url)
            || !(MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(&size)
            || hash.len() != 64
            || !hash.bytes().all(|v| v.is_ascii_hexdigit())
            || signature.is_empty()
            || release.is_some_and(|release| {
                release
                    .assets
                    .iter()
                    .filter(|a| {
                        a.name == name
                            && a.size == size
                            && Url::parse(&a.browser_download_url).ok().as_ref()
                                == Some(&expected_url)
                    })
                    .count()
                    != 1
            })
        {
            return Err(update_manifest_error(
                "更新资产的来源、平台、大小、哈希或签名字段无效",
            ));
        }
    }
    Ok(())
}

fn version_from_latest_redirect(location: &str) -> AppResult<String> {
    let url = Url::parse(location).map_err(update_check_error)?;
    let prefix = "/Lr-2002/Delta-Viewer/releases/tag/";
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(update_manifest_error("最新 Release 跳转不属于官方仓库"));
    }
    canonical_version(
        url.path()
            .strip_prefix(prefix)
            .ok_or_else(|| update_manifest_error("最新 Release 跳转不是正式版本标签"))?,
    )
}
async fn discover_release(client: &Client) -> AppResult<(String, Url, Option<Release>)> {
    let api_result = async {
        let release: Release = serde_json::from_slice(
            &bounded_get(
                client,
                Url::parse(RELEASE_API).map_err(update_check_error)?,
                MAX_METADATA_BYTES,
            )
            .await?,
        )
        .map_err(update_check_error)?;
        let (version, url) = validate_release(&release)?;
        Ok::<_, AppError>((version, url, Some(release)))
    }
    .await;
    match api_result {
        Ok(result) => Ok(result),
        Err(api_error) => {
            // The public latest redirect also selects a published stable Release.
            // No token or HTML scrape is needed when anonymous API quotas run out.
            let fallback = async {
                let client = Client::builder()
                    .timeout(CHECK_TIMEOUT)
                    .redirect(reqwest::redirect::Policy::none())
                    .user_agent(concat!("Delta-Viewer/", env!("CARGO_PKG_VERSION")))
                    .build()
                    .map_err(update_check_error)?;
                let response = client
                    .head(format!("{REPOSITORY}/releases/latest"))
                    .send()
                    .await
                    .map_err(update_check_error)?;
                if !response.status().is_redirection() {
                    return Err(update_check_error(format!(
                        "官方最新 Release 查询返回 {}",
                        response.status()
                    )));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| update_manifest_error("最新 Release 没有版本跳转"))?;
                let version = version_from_latest_redirect(location)?;
                let url = asset_url(&version, "latest.json")?;
                Ok((version, url, None))
            }
            .await;
            fallback.map_err(|error: AppError| {
                update_check_error(format!(
                    "GitHub API: {api_error}; 官方 Release 备用查询: {error}"
                ))
            })
        }
    }
}

pub async fn check(app: &AppHandle, state: &UpdateState) -> AppResult<AppUpdateInfo> {
    let current_version = app.package_info().version.to_string();
    let client = client(CHECK_TIMEOUT)?;
    let (version, manifest_url, release) = discover_release(&client).await?;
    let remote_version = semver::Version::parse(&version).map_err(update_check_error)?;
    let current = semver::Version::parse(&current_version).map_err(update_check_error)?;
    if remote_version <= current {
        return Ok(AppUpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version,
            available: false,
            notes: None,
            published_at: release.as_ref().and_then(|r| r.published_at.clone()),
            ready: false,
        });
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &bounded_get(&client, manifest_url.clone(), MAX_METADATA_BYTES).await?,
    )
    .map_err(update_check_error)?;
    validate_manifest(&manifest, &version, release.as_ref())?;
    // The plugin owns platform installation; its vendored metadata read also
    // has a 1 MiB bound. Pin this second read to the exact validated tag and
    // require identical metadata before exposing an update to the UI.
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest_url])
        .map_err(update_check_error)?
        .target(platform_target()?)
        .timeout(CHECK_TIMEOUT)
        .configure_client(|builder| builder.redirect(redirects()))
        .build()
        .map_err(update_check_error)?;
    let update = updater
        .check()
        .await
        .map_err(update_check_error)?
        .ok_or_else(|| update_manifest_error("所选 Release 已不可用"))?;
    if update.raw_json != manifest || update.version != version {
        return Err(update_manifest_error("检查期间更新清单发生变化"));
    }
    let cached_update = update.clone();
    let cached_app = app.clone();
    let ready = tauri::async_runtime::spawn_blocking(move || {
        read_cached(&cached_app, &cached_update).is_ok()
    })
    .await
    .map_err(update_check_error)?;
    let info = AppUpdateInfo {
        current_version,
        latest_version: version,
        available: true,
        notes: update.body.clone(),
        published_at: release.as_ref().and_then(|r| r.published_at.clone()),
        ready,
    };
    *state.0.lock().map_err(update_check_error)? = Some(update);
    Ok(info)
}

fn selected(state: &UpdateState) -> AppResult<Update> {
    state
        .0
        .lock()
        .map_err(update_check_error)?
        .clone()
        .ok_or_else(|| update_manifest_error("请先检查并选择最新正式版本"))
}
fn update_entry(update: &Update) -> AppResult<&serde_json::Value> {
    update
        .raw_json
        .get("platforms")
        .and_then(|v| v.get(platform_target().ok()?))
        .ok_or_else(|| update_manifest_error("缺少当前平台更新资产"))
}
fn expected_download_bytes(update: &Update) -> AppResult<u64> {
    update_entry(update)?
        .get("size")
        .and_then(|v| v.as_u64())
        .filter(|n| (MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(n))
        .ok_or_else(|| update_manifest_error("当前平台 size 无效"))
}
fn verify_bytes(app: &AppHandle, update: &Update, bytes: &[u8]) -> AppResult<()> {
    let expected = expected_download_bytes(update)?;
    if bytes.len() as u64 != expected {
        return Err(update_size_error(expected, bytes.len() as u64));
    }
    let hash = update_entry(update)?
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| update_manifest_error("缺少 SHA-256"))?;
    if !format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(hash) {
        return Err(update_manifest_error("更新包 SHA-256 不匹配"));
    }
    verify_signature(app, update, bytes)
}
fn cache_path(app: &AppHandle, update: &Update) -> AppResult<PathBuf> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(update_check_error)?
        .join("updates")
        .join(&update.version);
    Ok(root.join(asset_name(&update.version, platform_target()?)?))
}
fn read_cache_file(path: &Path, expected: u64) -> AppResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() != expected {
        return Err(update_manifest_error("本机更新缓存不完整，请重新下载"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_UPDATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != expected {
        return Err(update_size_error(expected, bytes.len() as u64));
    }
    Ok(bytes)
}
fn read_cached(app: &AppHandle, update: &Update) -> AppResult<Vec<u8>> {
    let bytes = read_cache_file(&cache_path(app, update)?, expected_download_bytes(update)?)?;
    verify_bytes(app, update, &bytes)?;
    Ok(bytes)
}
fn write_cache(app: &AppHandle, update: &Update, bytes: &[u8]) -> AppResult<()> {
    let path = cache_path(app, update)?;
    let parent = path
        .parent()
        .ok_or_else(|| update_manifest_error("缓存目录无效"))?;
    fs::create_dir_all(parent)?;
    if path.exists() {
        // Only an app-owned exact version filename can be replaced after failure.
        if read_cached(app, update).is_ok() {
            return Ok(());
        }
        fs::remove_file(&path)?;
    }
    let partial = path.with_extension(format!(
        "partial-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(update_download_error)?
            .as_nanos()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        verify_bytes(
            app,
            update,
            &read_cache_file(&partial, expected_download_bytes(update)?)?,
        )?;
        storage::publish_noreplace(&partial, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

pub async fn download(
    app: &AppHandle,
    state: &UpdateState,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> AppResult<()> {
    let update = selected(state)?;
    check_cancelled(cancelled)?;
    let expected = expected_download_bytes(&update)?;
    let started = Instant::now();
    let response = client(DOWNLOAD_TIMEOUT)?
        .get(update.download_url.clone())
        .send()
        .await
        .map_err(update_download_error)?
        .error_for_status()
        .map_err(update_download_error)?;
    if response
        .content_length()
        .is_some_and(|size| size != expected)
    {
        return Err(update_manifest_error("下载响应大小不匹配"));
    }
    let mut bytes = Vec::with_capacity(expected as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        check_cancelled(cancelled)?;
        let chunk = chunk.map_err(update_download_error)?;
        if bytes.len() as u64 + chunk.len() as u64 > expected {
            return Err(update_manifest_error("更新下载超过清单大小"));
        }
        bytes.extend_from_slice(&chunk);
        source::emit_progress_for_operation(
            Some(app),
            operation_id,
            ProgressPayload {
                task: "update".into(),
                phase: format!("正在下载 v{}，完成后由您决定安装时间", update.version),
                current: bytes.len() as u64,
                total: expected,
                bytes_done: bytes.len() as u64,
                total_bytes: expected,
                current_path: update.download_url.to_string(),
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
    }
    check_cancelled(cancelled)?;
    verify_bytes(app, &update, &bytes)?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || write_cache(&app, &update, &bytes))
        .await
        .map_err(update_download_error)??;
    Ok(())
}

pub async fn install(
    app: &AppHandle,
    state: &UpdateState,
    cancelled: &AtomicBool,
) -> AppResult<()> {
    check_cancelled(cancelled)?;
    let update = selected(state)?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Re-read, rehash and reverify the staged file immediately before install.
        let bytes = read_cached(&app, &update)?;
        update
            .install(bytes)
            .map_err(|e| AppError::Message(format!("UPDATE_INSTALL_FAILED: 无法安装更新: {e}")))
    })
    .await
    .map_err(update_download_error)??;
    Ok(())
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
    use super::*;
    fn fixture() -> (Release, serde_json::Value) {
        let version = "1.2.3";
        let mut assets = vec![Asset {
            name: "latest.json".into(),
            size: 8000,
            browser_download_url: asset_url(version, "latest.json").unwrap().to_string(),
        }];
        let mut platforms = serde_json::Map::new();
        for target in TARGETS {
            let name = asset_name(version, target).unwrap();
            let url = asset_url(version, &name).unwrap().to_string();
            assets.push(Asset {
                name,
                size: MIN_UPDATE_BYTES,
                browser_download_url: url.clone(),
            });
            platforms.insert(target.into(), serde_json::json!({"url":url,"size":MIN_UPDATE_BYTES,"sha256":"a".repeat(64),"signature":"signed"}));
        }
        (
            Release {
                tag_name: "v1.2.3".into(),
                draft: false,
                prerelease: false,
                published_at: Some("2026-10-15T00:00:00Z".into()),
                assets,
            },
            serde_json::json!({"version":version,"platforms":platforms}),
        )
    }
    #[test]
    fn official_release_requires_published_stable_tag_and_exact_repository_asset() {
        let (mut release, _) = fixture();
        assert_eq!(validate_release(&release).unwrap().0, "1.2.3");
        for tag in [
            "1.2.3",
            "v1.2.3-dev.1",
            "v1.2.3+build",
            "v01.2.3",
            "v../../evil",
        ] {
            release.tag_name = tag.into();
            assert!(validate_release(&release).is_err());
        }
        release.tag_name = "v1.2.3".into();
        release.draft = true;
        assert!(validate_release(&release).is_err());
        release.draft = false;
        release.prerelease = true;
        assert!(validate_release(&release).is_err());
        release.prerelease = false;
        release.published_at = None;
        assert!(validate_release(&release).is_err());
        release.published_at = Some("now".into());
        release.assets[0].browser_download_url =
            "https://github.com/other/Delta-Viewer/releases/download/v1.2.3/latest.json".into();
        assert!(validate_release(&release).is_err());
    }
    #[test]
    fn manifest_rejects_missing_platform_size_hash_signature_and_cross_version_urls() {
        let (release, json) = fixture();
        validate_manifest(&json, "1.2.3", Some(&release)).unwrap();
        for (field, value) in [
            (
                "url",
                serde_json::json!("http://39.155.172.162:17879/releases/v1.2.3/update.exe"),
            ),
            (
                "url",
                serde_json::json!(
                    asset_url("1.2.2", &asset_name("1.2.3", TARGETS[0]).unwrap()).unwrap()
                ),
            ),
            ("size", serde_json::json!(MAX_UPDATE_BYTES + 1)),
            ("size", serde_json::json!(0)),
            ("sha256", serde_json::json!("not-a-hash")),
            ("signature", serde_json::json!("")),
        ] {
            let mut invalid = json.clone();
            invalid["platforms"][TARGETS[0]][field] = value;
            assert!(
                validate_manifest(&invalid, "1.2.3", Some(&release)).is_err(),
                "{field}"
            );
        }
        let mut invalid = json.clone();
        invalid["platforms"]
            .as_object_mut()
            .unwrap()
            .remove(TARGETS[1]);
        assert!(validate_manifest(&invalid, "1.2.3", Some(&release)).is_err());
        let mut invalid = json;
        invalid["version"] = serde_json::json!("1.2.4");
        assert!(validate_manifest(&invalid, "1.2.3", Some(&release)).is_err());
    }
    #[test]
    fn latest_redirect_fallback_accepts_only_official_stable_tag() {
        assert_eq!(
            version_from_latest_redirect(
                "https://github.com/Lr-2002/Delta-Viewer/releases/tag/v1.2.3"
            )
            .unwrap(),
            "1.2.3"
        );
        for url in [
            "http://github.com/Lr-2002/Delta-Viewer/releases/tag/v1.2.3",
            "https://github.com/other/repo/releases/tag/v1.2.3",
            "https://github.com/Lr-2002/Delta-Viewer/releases/tag/v1.2.3-beta.1",
            "https://github.com/Lr-2002/Delta-Viewer/releases/tag/v1.2.3?redirect=other",
        ] {
            assert!(version_from_latest_redirect(url).is_err());
        }
        let (_, json) = fixture();
        validate_manifest(&json, "1.2.3", None).unwrap();
        let mut invalid = json;
        invalid["platforms"][TARGETS[0]]["url"] = serde_json::json!("https://evil.test/a");
        assert!(validate_manifest(&invalid, "1.2.3", None).is_err());
    }
    #[test]
    fn ubuntu_asset_url_matches_github_percent_encoding() {
        assert_eq!(asset_url("1.0.63", &asset_name("1.0.63", TARGETS[2]).unwrap()).unwrap().as_str(),
            "https://github.com/Lr-2002/Delta-Viewer/releases/download/v1.0.63/Delta-Viewer_1.0.63_UNSIGNED_ubuntu-22.04%2B-x64.deb");
    }
    #[test]
    fn redirects_only_allow_official_https_asset_hosts() {
        for url in [
            "https://github.com/Lr-2002/Delta-Viewer/releases/download/v1.2.3/latest.json",
            "https://release-assets.githubusercontent.com/a?signature=test",
        ] {
            assert!(allowed_redirect(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://github.com/Lr-2002/Delta-Viewer/releases/download/v1.2.3/a",
            "https://github.com/other/repo/releases/download/a",
            "https://github.com.evil.test/a",
            "https://release-assets.githubusercontent.com:444/a",
            "https://name@release-assets.githubusercontent.com/a",
        ] {
            assert!(!allowed_redirect(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn metadata_read_is_bounded_for_fixed_length_and_chunked_responses() {
        #[cfg(not(target_os = "windows"))]
        let _ = rustls::crypto::ring::default_provider().install_default();
        use std::net::TcpListener;
        for response in ["HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n123456789",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let port=listener.local_addr().unwrap().port();
            let worker=std::thread::spawn(move || { let (mut stream,_)=listener.accept().unwrap(); let mut buf=[0;4096]; let _=stream.read(&mut buf); stream.write_all(response.as_bytes()).unwrap(); });
            let result=tauri::async_runtime::block_on(async { bounded_get(&Client::new(),Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(),8).await });
            assert!(result.is_err()); worker.join().unwrap();
        }
    }
    #[test]
    fn cached_file_read_rejects_incomplete_and_symlinked_packages() {
        let root = std::env::temp_dir().join(format!("delta-update-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("only-test-cache.deb");
        fs::write(&file, b"123456789").unwrap();
        assert!(read_cache_file(&file, 8).is_err());
        assert_eq!(read_cache_file(&file, 9).unwrap(), b"123456789");
        #[cfg(unix)]
        {
            let link = root.join("only-test-link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(read_cache_file(&link, 9).is_err());
            fs::remove_file(link).unwrap();
        }
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "explicit public GitHub connectivity check; not an offline regression gate"]
    fn live_official_release_discovery() {
        tauri::async_runtime::block_on(async {
            let client = client(CHECK_TIMEOUT).unwrap();
            let (version, url, release) = discover_release(&client).await.unwrap();
            let bytes = bounded_get(&client, url, MAX_METADATA_BYTES).await.unwrap();
            let json = serde_json::from_slice(&bytes).unwrap();
            validate_manifest(&json, &version, release.as_ref()).unwrap();
            println!(
                "Official published stable release v{version}; metadata/platform checks passed"
            );
        });
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
