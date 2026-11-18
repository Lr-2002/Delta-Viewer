//! Public candidate updates are independently signed before their metadata is
//! interpreted. This channel never creates or impersonates a GitHub Release.
use super::*;

pub(super) const BASE_URL: &str = "https://114.111.19.219/api/manager-updates/candidate";

pub(super) fn asset_url(version: &str, target: &str) -> AppResult<Url> {
    canonical_version(&format!("v{version}"))?;
    Url::parse(&format!(
        "{BASE_URL}/releases/v{version}/{}",
        asset_name(version, target)?.replace('+', "%2B")
    ))
    .map_err(update_check_error)
}

pub(super) fn parse(bytes: &[u8], public_key: &str, target: &str) -> AppResult<lan::Candidate> {
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(update_manifest_error("候选更新清单超限"));
    }
    let envelope: serde_json::Value = serde_json::from_slice(bytes).map_err(update_check_error)?;
    let payload = envelope["payload"]
        .as_str()
        .ok_or_else(|| update_manifest_error("候选更新缺少签名内容"))?;
    let signature = envelope["signature"]
        .as_str()
        .ok_or_else(|| update_manifest_error("候选更新缺少清单签名"))?;
    let payload = BASE64.decode(payload).map_err(update_check_error)?;
    verify_minisign(public_key, signature, &payload)?;
    let json: serde_json::Value = serde_json::from_slice(&payload).map_err(update_check_error)?;
    let version = canonical_version(&format!("v{}", json["version"].as_str().unwrap_or("")))?;
    let commit = json["commit"].as_str().unwrap_or("");
    let published = json["pub_date"].as_str().unwrap_or("");
    if json["schemaVersion"] != 1
        || json["channel"] != "candidate"
        || commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_hexdigit())
        || time::OffsetDateTime::parse(published, &time::format_description::well_known::Rfc3339)
            .is_err()
        || json["notes"].as_str().is_none_or(|s| s.trim().is_empty())
    {
        return Err(update_manifest_error("候选更新身份、日期或摘要无效"));
    }
    let platforms = json["platforms"]
        .as_object()
        .ok_or_else(|| update_manifest_error("候选更新缺少平台"))?;
    if platforms.is_empty() || platforms.len() > TARGETS.len() || !platforms.contains_key(target) {
        return Err(update_manifest_error("当前平台尚无候选更新包"));
    }
    for (key, entry) in platforms {
        if !TARGETS.contains(&key.as_str()) {
            return Err(update_manifest_error("候选更新平台无效"));
        }
        let expected = asset_url(&version, key)?;
        let size = entry["size"].as_u64().unwrap_or(0);
        let hash = entry["sha256"].as_str().unwrap_or("");
        if entry["url"].as_str() != Some(expected.as_str())
            || !(MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(&size)
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            || entry["signature"].as_str().is_none_or(str::is_empty)
        {
            return Err(update_manifest_error(
                "候选更新资产来源、大小、哈希或签名无效",
            ));
        }
    }
    Ok(lan::Candidate {
        version,
        published_at: Some(published.into()),
        manifest: json,
        route: lan::DownloadRoute::Candidate,
        note: Some(
            "公开候选更新，尚未发布为 GitHub 正式版。安装由您确认；保留工作后再重启。".into(),
        ),
    })
}

pub(super) async fn resolve(app: &AppHandle) -> AppResult<lan::Candidate> {
    let key = signing_public_key(app)?;
    let client = lan::DownloadRoute::Candidate.client(Duration::from_secs(4))?;
    let url = Url::parse(&format!("{BASE_URL}/latest.json")).map_err(update_check_error)?;
    let bytes = tokio::time::timeout(
        Duration::from_secs(5),
        bounded_get(&client, url, MAX_METADATA_BYTES),
    )
    .await
    .map_err(|_| update_check_error("候选更新服务读取超时"))??;
    parse(&bytes, &key, platform_target()?)
}

pub(super) fn choose(
    stable: AppResult<lan::Candidate>,
    preview: AppResult<lan::Candidate>,
) -> AppResult<lan::Candidate> {
    match (stable, preview) {
        (Ok(stable), Ok(preview)) => {
            let a = semver::Version::parse(&stable.version).map_err(update_check_error)?;
            let b = semver::Version::parse(&preview.version).map_err(update_check_error)?;
            // Prefer the stable identity at equal version. Candidate failures do
            // not interrupt the existing stable update path or current work.
            Ok(if b > a { preview } else { stable })
        }
        (Ok(stable), Err(_)) => Ok(stable),
        (Err(_), Ok(preview)) => Ok(preview),
        (Err(stable), Err(preview)) => Err(update_check_error(format!(
            "正式更新：{stable}；候选更新：{preview}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../scripts/fixtures/candidate-update.json"
        ))
        .unwrap()
    }
    #[test]
    fn signed_candidate_accepts_one_available_platform_and_rejects_tampered_or_invalid_metadata() {
        let fixture = fixtures();
        let key = fixture["publicKey"].as_str().unwrap();
        let envelope = &fixture["envelopes"]["valid"];
        let bytes = serde_json::to_vec(envelope).unwrap();
        let result = parse(&bytes, key, TARGETS[0]).unwrap();
        assert_eq!(result.version, "9.1.0");
        assert!(parse(&bytes, key, TARGETS[1]).is_err());
        for name in [
            "bad_url",
            "oversize",
            "bad_target",
            "bad_channel",
            "bad_date",
            "no_reason",
        ] {
            assert!(
                parse(
                    &serde_json::to_vec(&fixture["envelopes"][name]).unwrap(),
                    key,
                    TARGETS[0]
                )
                .is_err(),
                "{name}"
            );
        }
        let mut tampered = envelope.clone();
        let raw = BASE64
            .decode(tampered["payload"].as_str().unwrap())
            .unwrap();
        let raw = String::from_utf8(raw)
            .unwrap()
            .replace("synthetic", "tampered");
        tampered["payload"] = BASE64.encode(raw).into();
        assert!(parse(&serde_json::to_vec(&tampered).unwrap(), key, TARGETS[0]).is_err());
        assert!(parse(&vec![0; MAX_METADATA_BYTES as usize + 1], key, TARGETS[0]).is_err());
    }
    fn row(version: &str, route: lan::DownloadRoute) -> lan::Candidate {
        lan::Candidate {
            version: version.into(),
            manifest: serde_json::json!({}),
            route,
            note: None,
            published_at: None,
        }
    }
    #[test]
    fn newer_candidate_is_available_to_all_and_stable_wins_at_equal_version_or_candidate_failure() {
        assert!(matches!(
            choose(
                Ok(row("1.0.0", lan::DownloadRoute::Github)),
                Ok(row("1.0.1", lan::DownloadRoute::Candidate))
            )
            .unwrap()
            .route,
            lan::DownloadRoute::Candidate
        ));
        assert!(matches!(
            choose(
                Ok(row("1.0.1", lan::DownloadRoute::Github)),
                Ok(row("1.0.1", lan::DownloadRoute::Candidate))
            )
            .unwrap()
            .route,
            lan::DownloadRoute::Github
        ));
        assert!(matches!(
            choose(
                Ok(row("1.0.1", lan::DownloadRoute::Lan)),
                Err(update_manifest_error("unavailable"))
            )
            .unwrap()
            .route,
            lan::DownloadRoute::Lan
        ));
        assert!(matches!(
            choose(
                Err(update_manifest_error("offline")),
                Ok(row("1.0.1", lan::DownloadRoute::Candidate))
            )
            .unwrap()
            .route,
            lan::DownloadRoute::Candidate
        ));
        assert!(choose(
            Err(update_manifest_error("offline")),
            Err(update_manifest_error("offline"))
        )
        .is_err());
    }
}
