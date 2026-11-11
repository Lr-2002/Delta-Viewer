//! Fixed D1 service endpoints for application OTA relay and diagnostic log upload.
//!
//! Only the origins compiled into `config/d1-manager.json` may be contacted. The
//! frontend never supplies a host, port, path or query string; it only selects an
//! already-resolved device link. Both features stay disabled while their origin
//! is not configured, and a disabled origin performs no network traffic at all.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fmt;

const CONFIG: &str = include_str!("../../config/d1-manager.json");

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustRoot {
    #[serde(default)]
    pub key_id: Option<String>,
    /// PEM-encoded Ed25519 SubjectPublicKeyInfo. Public material only.
    #[serde(default)]
    pub public_key_pem: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceOtaConfig {
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trust_root: Option<TrustRoot>,
    #[serde(default)]
    pub reserved_address: Option<String>,
    #[serde(default)]
    pub scheme: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticUploadConfig {
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServicesConfig {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub device_ota: DeviceOtaConfig,
    #[serde(default)]
    pub diagnostic_upload: DiagnosticUploadConfig,
    #[serde(default)]
    pub production_operations: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Origin {
    /// Scheme, host and port exactly as configured, without a trailing slash.
    pub base: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustStatus {
    /// A public key is configured and the release must verify against it.
    Configured,
    /// No key is configured; the device performs the authoritative verification.
    DeviceVerified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaServiceStatus {
    pub enabled: bool,
    pub origin: Option<String>,
    pub channel: Option<String>,
    pub trust: TrustStatus,
    pub trust_key_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticServiceStatus {
    pub enabled: bool,
    pub origin: Option<String>,
    pub detail: String,
}

pub fn load() -> AppResult<ServicesConfig> {
    serde_json::from_str(CONFIG)
        .map_err(|error| AppError::Message(format!("D1_SERVICES_CONFIG_INVALID: {error}")))
}

/// Parse a configured origin into a strict `scheme://host[:port]` base.
///
/// Rejects user-info, paths, queries, fragments and unknown schemes so a config
/// typo cannot silently redirect traffic somewhere else.
pub fn origin(value: &str) -> Result<Origin, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("D1_ORIGIN_EMPTY: 服务地址未配置".into());
    }
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| "D1_ORIGIN_INVALID: 服务地址必须包含 http:// 或 https://".to_string())?;
    let scheme: &'static str = match scheme.to_ascii_lowercase().as_str() {
        "http" => "http",
        "https" => "https",
        _ => return Err("D1_ORIGIN_INVALID: 只支持 http 或 https 服务地址".into()),
    };
    let authority = rest.trim_end_matches('/');
    if authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('@')
    {
        return Err("D1_ORIGIN_INVALID: 服务地址只能是 scheme://主机[:端口]".into());
    }
    if authority
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("D1_ORIGIN_INVALID: 服务地址包含非法字符".into());
    }
    Ok(Origin {
        base: format!("{scheme}://{authority}"),
    })
}

/// Resolve one fixed OTA resource path against the configured origin.
///
/// Paths are produced internally from a verified channel/manifest, never from the
/// frontend, and must stay inside the documented `/ota/v1/` namespace.
pub fn ota_url(origin: &Origin, path: &str) -> Result<String, String> {
    if !path.starts_with("/ota/v1/") || path.starts_with("//") || path.contains("..") {
        return Err("OTA_PATH_INVALID: 升级资源路径不在允许范围内".into());
    }
    if path.contains(['?', '#']) {
        return Err("OTA_PATH_INVALID: 升级资源路径不接受查询参数".into());
    }
    Ok(format!("{}{path}", origin.base))
}

/// Decode a PEM SubjectPublicKeyInfo into the 32 raw Ed25519 bytes `ring` needs.
pub fn ed25519_public_key(pem: &str) -> Result<[u8; 32], String> {
    const BEGIN: &str = "-----BEGIN PUBLIC KEY-----";
    const END: &str = "-----END PUBLIC KEY-----";
    let body = pem
        .split_once(BEGIN)
        .and_then(|(_, rest)| rest.split_once(END))
        .map(|(body, _)| body)
        .ok_or_else(|| "OTA_TRUST_ROOT_INVALID: 公钥不是 PEM PUBLIC KEY".to_string())?;
    let normalized: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = decode_base64(&normalized)?;
    // Ed25519 SPKI is a fixed 12-byte prefix followed by the 32-byte key.
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if decoded.len() != 44 || decoded[..12] != PREFIX {
        return Err("OTA_TRUST_ROOT_INVALID: 公钥不是 Ed25519 公钥".into());
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&decoded[12..]);
    Ok(key)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut accumulator = 0_u32;
    let mut bits = 0_u32;
    for byte in bytes {
        if *byte == b'=' {
            break;
        }
        let digit = match *byte {
            b'A'..=b'Z' => (*byte - b'A') as u32,
            b'a'..=b'z' => (*byte - b'a') as u32 + 26,
            b'0'..=b'9' => (*byte - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("OTA_TRUST_ROOT_INVALID: 公钥 Base64 含非法字符".into()),
        };
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

impl fmt::Display for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_accept_only_scheme_host_port() {
        assert_eq!(
            origin("http://deltadevice.cn:4174/").unwrap().base,
            "http://deltadevice.cn:4174"
        );
        assert_eq!(
            origin("https://10.1.11.200:4174").unwrap().base,
            "https://10.1.11.200:4174"
        );
        for bad in [
            "",
            "deltadevice.cn:4174",
            "ftp://deltadevice.cn",
            "http://user:pass@host:4174",
            "http://host:4174/ota",
            "http://host:4174?x=1",
            "http://host:4174#fragment",
            "http://host :4174",
        ] {
            assert!(origin(bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn ota_paths_stay_inside_the_release_namespace() {
        let origin = origin("http://deltadevice.cn:4174").unwrap();
        assert_eq!(
            ota_url(&origin, "/ota/v1/channels/factory.json").unwrap(),
            "http://deltadevice.cn:4174/ota/v1/channels/factory.json"
        );
        for bad in [
            "/api/v1/devices",
            "/ota/v1/../../etc/passwd",
            "//evil.example/ota/v1/x",
            "/ota/v1/channels/factory.json?version=9",
        ] {
            assert!(ota_url(&origin, bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn public_key_decoding_requires_the_ed25519_spki_prefix() {
        // 32 zero bytes wrapped in the canonical Ed25519 SubjectPublicKeyInfo.
        let key = [7_u8; 32];
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(&key);
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            wrap(&encode_base64(&der))
        );
        assert_eq!(ed25519_public_key(&pem).unwrap(), key);
        assert!(
            ed25519_public_key("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")
                .is_err()
        );
        assert!(ed25519_public_key("not a pem").is_err());
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    fn wrap(value: &str) -> String {
        value
            .as_bytes()
            .chunks(64)
            .map(|line| String::from_utf8_lossy(line).to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
