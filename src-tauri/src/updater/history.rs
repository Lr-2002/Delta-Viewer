//! Explicit installer downloads from the existing company mirror. Never install
//! or mutate the selected/latest application update as a side effect.
use super::*;
use futures_util::StreamExt;
use serde::Serialize;

const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const PLATFORMS: [(&str, &str, &str); 3] = [
    ("windows-x64", "Windows x64", "windows-x64-setup.exe"),
    ("macos-arm64", "macOS arm64", "macos-arm64.dmg"),
    ("ubuntu-deb-x64", "Ubuntu x64", "ubuntu-22.04+-x64.deb"),
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installer {
    pub key: String,
    pub label: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
}

fn name(version: &str, key: &str) -> AppResult<String> {
    canonical_version(&format!("v{version}"))?;
    let suffix = PLATFORMS
        .iter()
        .find(|item| item.0 == key)
        .ok_or_else(|| update_manifest_error("没有此平台的安装包"))?
        .2;
    let brand = if semver::Version::parse(version).map_err(update_check_error)?
        < semver::Version::new(1, 0, 32)
    {
        "DOHC"
    } else {
        "Delta"
    };
    Ok(format!("{brand}-Viewer_{version}_UNSIGNED_{suffix}"))
}

fn url(version: &str, file: &str) -> AppResult<Url> {
    Url::parse(&format!(
        "{}/releases/v{version}/{}",
        lan::BASE_URL,
        file.replace('+', "%2B")
    ))
    .map_err(update_check_error)
}

fn parse(version: &str, value: serde_json::Value) -> AppResult<Vec<Installer>> {
    if value["schemaVersion"] != 1 || value["version"] != version {
        return Err(update_manifest_error("历史版本安装包清单不一致"));
    }
    let entries = value["installers"]
        .as_array()
        .ok_or_else(|| update_manifest_error("没有历史版本安装包清单"))?;
    if entries.len() != PLATFORMS.len() {
        return Err(update_manifest_error("历史版本三平台安装包不完整"));
    }
    PLATFORMS
        .iter()
        .map(|(key, label, _)| {
            let matched: Vec<_> = entries
                .iter()
                .filter(|entry| entry["key"] == *key)
                .collect();
            if matched.len() != 1 {
                return Err(update_manifest_error("历史版本平台清单不一致"));
            }
            let entry = matched[0];
            let expected = name(version, key)?;
            let size = entry["size"]
                .as_u64()
                .filter(|n| (MIN_UPDATE_BYTES..=MAX_INSTALLER_BYTES).contains(n))
                .ok_or_else(|| update_manifest_error("历史安装包大小未提供"))?;
            let hash = entry["sha256"]
                .as_str()
                .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
                .ok_or_else(|| update_manifest_error("历史安装包摘要未提供"))?;
            if entry["fileName"] != expected || entry["url"] != url(version, &expected)?.as_str() {
                return Err(update_manifest_error("历史安装包身份不一致"));
            }
            Ok(Installer {
                key: (*key).into(),
                label: (*label).into(),
                file_name: expected,
                size,
                sha256: hash.into(),
            })
        })
        .collect()
}

pub async fn list(version: &str) -> AppResult<Vec<Installer>> {
    canonical_version(&format!("v{version}"))?;
    let bytes = tokio::time::timeout(
        Duration::from_secs(45),
        bounded_get(
            &lan::DownloadRoute::Lan.client(CHECK_TIMEOUT)?,
            url(version, "release.json")?,
            MAX_METADATA_BYTES,
        ),
    )
    .await
    .map_err(|_| update_check_error("内网历史版本查询超时，请稍后重试"))?
    .map_err(|_| update_check_error("此版本尚未在内网缓存，或内网服务不可达"))?;
    parse(
        version,
        serde_json::from_slice(&bytes).map_err(update_check_error)?,
    )
}

struct Partial(PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub async fn download(
    app: &AppHandle,
    version: &str,
    key: &str,
    destination: &Path,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> AppResult<String> {
    check_cancelled(cancelled)?;
    let entry = list(version)
        .await?
        .into_iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| update_manifest_error("没有所选平台的安装包"))?;
    let directory = fs::canonicalize(destination)?;
    if !directory.is_dir() {
        return Err(update_download_error("请选择有效的保存目录"));
    }
    let output = directory.join(&entry.file_name);
    if output.exists() {
        return Err(update_download_error(
            "同名安装包已存在，请选择其他目录；不会覆盖原文件",
        ));
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| update_download_error("系统随机源不可用，请重试"))?;
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let partial = Partial(directory.join(format!(".{}.{}.partial", entry.file_name, nonce)));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial.0)?;
    let client = lan::DownloadRoute::Lan.client(DOWNLOAD_TIMEOUT)?;
    let download_url = url(version, &entry.file_name)?;
    let mut send = std::pin::pin!(client.get(download_url.clone()).send());
    let response = loop {
        tokio::select! {
            response=&mut send=>break response.map_err(update_download_error)?,
            _=tokio::time::sleep(Duration::from_millis(100))=>check_cancelled(cancelled)?,
        }
    };
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n != entry.size)
    {
        return Err(update_download_error("历史安装包不可用或大小与清单不符"));
    }
    let started = Instant::now();
    let mut last = Instant::now();
    let mut received = 0u64;
    let mut hash = Sha256::new();
    let mut chunks = response.bytes_stream();
    loop {
        check_cancelled(cancelled)?;
        let next = tokio::select! {
            next=chunks.next()=>next,
            _=tokio::time::sleep(Duration::from_millis(100))=>continue,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(update_download_error)?;
        received += chunk.len() as u64;
        if received > entry.size {
            return Err(update_download_error("历史安装包超出清单大小"));
        }
        file.write_all(&chunk)?;
        hash.update(&chunk);
        if last.elapsed() >= Duration::from_millis(200) || received == entry.size {
            source::emit_progress_for_operation(
                Some(app),
                operation_id,
                ProgressPayload {
                    task: "update-history".into(),
                    phase: format!("下载 v{version} · {}", entry.label),
                    current: received,
                    total: entry.size,
                    bytes_done: received,
                    total_bytes: entry.size,
                    current_path: entry.file_name.clone(),
                    elapsed_ms: started.elapsed().as_millis(),
                },
            );
            last = Instant::now();
        }
    }
    if received != entry.size
        || format!("{:x}", hash.finalize()) != entry.sha256.to_ascii_lowercase()
    {
        return Err(update_download_error("历史安装包未完整收到或摘要不符"));
    }
    file.sync_all()?;
    drop(file);
    let mut input = File::open(&partial.0)?;
    let mut readback = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        readback.update(&buffer[..count]);
    }
    drop(input);
    if format!("{:x}", readback.finalize()) != entry.sha256.to_ascii_lowercase() {
        return Err(update_download_error("安装包回读校验未通过"));
    }
    check_cancelled(cancelled)?;
    storage::publish_noreplace(&partial.0, &output)?;
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_installer_names_cover_brand_and_three_platforms() {
        assert_eq!(
            name("1.0.31", "windows-x64").unwrap(),
            "DOHC-Viewer_1.0.31_UNSIGNED_windows-x64-setup.exe"
        );
        for (key, _, suffix) in PLATFORMS {
            assert_eq!(
                name("1.9.4", key).unwrap(),
                format!("Delta-Viewer_1.9.4_UNSIGNED_{suffix}")
            );
        }
    }
    #[test]
    fn historical_manifest_keeps_exact_version_and_complete_platforms() {
        let entries:Vec<_>=PLATFORMS.iter().map(|(key,_,_)| {let file=name("1.9.4",key).unwrap();serde_json::json!({"key":key,"fileName":file,"url":url("1.9.4",&file).unwrap().as_str(),"size":MIN_UPDATE_BYTES,"sha256":"a".repeat(64)})}).collect();
        let value = serde_json::json!({"schemaVersion":1,"version":"1.9.4","installers":entries});
        assert_eq!(parse("1.9.4", value.clone()).unwrap().len(), 3);
        assert!(parse("1.9.3", value).is_err());
    }
}
