//! A fixed read-only LAN transport for official, signed Release bytes.
//! No user-center identity, proxy, configurable URL or redirected LAN requests.
use super::*;

pub(super) const BASE_URL: &str = "http://10.1.41.17:17879";

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateSource {
    #[default]
    Auto,
    Lan,
    Github,
}

#[derive(Clone, Copy)]
pub(super) enum DownloadRoute {
    Lan,
    Github,
}

impl DownloadRoute {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Github => "github",
        }
    }
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Lan => "公司内网",
            Self::Github => "GitHub",
        }
    }
    pub(super) fn asset_url(self, version: &str, target: &str) -> AppResult<Url> {
        canonical_version(&format!("v{version}"))?;
        let name = asset_name(version, target)?;
        match self {
            Self::Github => super::asset_url(version, &name),
            Self::Lan => Url::parse(&format!(
                "{BASE_URL}/releases/v{version}/{}",
                name.replace('+', "%2B")
            ))
            .map_err(update_check_error),
        }
    }
    pub(super) fn client(self, timeout: Duration) -> AppResult<Client> {
        if matches!(self, Self::Github) {
            return super::client(timeout);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = rustls::crypto::ring::default_provider().install_default();
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(timeout)
            .read_timeout(Duration::from_secs(30))
            .user_agent(concat!("Delta-Viewer/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(update_check_error)
    }
}

pub(super) struct Candidate {
    pub version: String,
    pub manifest: serde_json::Value,
    pub route: DownloadRoute,
    pub note: Option<String>,
    pub published_at: Option<String>,
}

fn from_lan_manifest(manifest: serde_json::Value) -> AppResult<Candidate> {
    let version = canonical_version(&format!("v{}", manifest["version"].as_str().unwrap_or("")))?;
    // URLs must still identify the immutable official Release. LAN transport
    // locations are derived above, never accepted from network metadata.
    validate_manifest(&manifest, &version, None)?;
    Ok(Candidate {
        published_at: manifest["pub_date"].as_str().map(str::to_owned),
        version, manifest, route: DownloadRoute::Lan,
        note: Some("公司内网已缓存的正式版本；以服务器最近同步结果为准。下载不经过 GitHub，安装前仍核验大小、哈希和签名。".into()),
    })
}

async fn lan() -> AppResult<Candidate> {
    let client = DownloadRoute::Lan.client(CHECK_TIMEOUT)?;
    let url = Url::parse(&format!("{BASE_URL}/client/latest.json")).map_err(update_check_error)?;
    let bytes = tokio::time::timeout(
        Duration::from_secs(3),
        bounded_get(&client, url, MAX_METADATA_BYTES),
    )
    .await
    .map_err(|_| update_check_error("公司内网更新服务连接或读取超时"))??;
    from_lan_manifest(serde_json::from_slice(&bytes).map_err(update_check_error)?)
}

async fn github(note: Option<String>) -> AppResult<Candidate> {
    let client = super::client(CHECK_TIMEOUT)?;
    let (version, url, release) = discover_release(&client).await?;
    let manifest = serde_json::from_slice(&bounded_get(&client, url, MAX_METADATA_BYTES).await?)
        .map_err(update_check_error)?;
    validate_manifest(&manifest, &version, release.as_ref())?;
    Ok(Candidate {
        version,
        manifest,
        route: DownloadRoute::Github,
        note,
        published_at: release.and_then(|r| r.published_at),
    })
}

pub(super) async fn resolve(source: UpdateSource) -> AppResult<Candidate> {
    match source {
        UpdateSource::Lan => lan().await,
        UpdateSource::Github => github(None).await,
        UpdateSource::Auto => match lan().await {
            Ok(candidate) => Ok(candidate),
            Err(error) => github(Some(format!(
                "公司内网未就绪，已改用 GitHub。内网原因：{error}"
            )))
            .await
            .map_err(|github| update_check_error(format!("公司内网：{error}；GitHub：{github}"))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "explicit company LAN download and signature check; no installation"]
    fn live_lan_release_download() {
        tauri::async_runtime::block_on(async {
            let candidate = lan().await.unwrap();
            let target = platform_target().unwrap();
            let entry = &candidate.manifest["platforms"][target];
            let size = entry["size"].as_u64().unwrap();
            let url = candidate
                .route
                .asset_url(&candidate.version, target)
                .unwrap();
            let bytes = network::bytes(
                &candidate.route.client(DOWNLOAD_TIMEOUT).unwrap(),
                network::Request {
                    url: &url,
                    limit: size,
                    expected: Some(size),
                    stage: "验证公司内网更新包",
                    cancelled: None,
                },
                |_, _| {},
            )
            .await
            .unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                entry["sha256"].as_str().unwrap()
            );
            let config: serde_json::Value =
                serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
            verify_minisign(
                config["plugins"]["updater"]["pubkey"].as_str().unwrap(),
                entry["signature"].as_str().unwrap(),
                &bytes,
            )
            .unwrap();
            println!(
                "LAN v{} {target}: {} bytes SHA-256/Minisign verified, no install",
                candidate.version,
                bytes.len()
            );
        });
    }

    #[test]
    fn lan_transport_never_follows_an_http_redirect() {
        #[cfg(not(target_os = "windows"))]
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") && headers.len() < 16384 {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://untrusted.invalid/payload\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let error = tauri::async_runtime::block_on(async {
            bounded_get(
                &DownloadRoute::Lan.client(CHECK_TIMEOUT).unwrap(),
                Url::parse(&format!("http://{address}/latest.json")).unwrap(),
                MAX_METADATA_BYTES,
            )
            .await
            .unwrap_err()
        });
        assert!(error.to_string().contains("302"), "{error}");
        worker.join().unwrap();
    }

    #[test]
    fn transport_urls_are_fixed_and_cannot_inject_paths() {
        for target in TARGETS {
            let url = DownloadRoute::Lan.asset_url("1.4.7", target).unwrap();
            assert_eq!(url.origin().ascii_serialization(), BASE_URL);
            assert!(url
                .path()
                .starts_with("/releases/v1.4.7/Delta-Viewer_1.4.7_UNSIGNED_"));
            assert_eq!(
                DownloadRoute::Github.asset_url("1.4.7", target).unwrap(),
                super::super::asset_url("1.4.7", &asset_name("1.4.7", target).unwrap()).unwrap()
            );
        }
        for bad in ["../1.4.7", "1.4.7-rc.1", "1.4.7?url=evil", "01.4.7"] {
            assert!(DownloadRoute::Lan.asset_url(bad, TARGETS[0]).is_err());
        }
    }
    #[test]
    fn lan_metadata_rejects_rewritten_urls_partial_targets_and_prereleases() {
        let platforms: serde_json::Map<String, serde_json::Value> = TARGETS.into_iter().map(|target| (target.into(), serde_json::json!({
            "url": super::super::asset_url("1.4.7", &asset_name("1.4.7", target).unwrap()).unwrap().as_str(),
            "size": MIN_UPDATE_BYTES, "sha256": "a".repeat(64), "signature": "signature verified before install"
        }))).collect();
        let good = serde_json::json!({"version":"1.4.7","platforms":platforms});
        assert_eq!(from_lan_manifest(good.clone()).unwrap().version, "1.4.7");
        let mut bad = good.clone();
        bad["platforms"][TARGETS[0]]["url"] =
            serde_json::json!("http://10.1.41.17:17879/untrusted.exe");
        assert!(from_lan_manifest(bad).is_err());
        let mut bad = serde_json::json!({"version":"1.4.7-rc.1","platforms":platforms});
        assert!(from_lan_manifest(bad.clone()).is_err());
        bad["version"] = serde_json::json!("1.4.7");
        bad["platforms"].as_object_mut().unwrap().remove(TARGETS[1]);
        assert!(from_lan_manifest(bad).is_err());
    }
}
