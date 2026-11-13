//! Fixed read-only health operation over USB or explicitly selected local-subnet IPv4.
//! No arbitrary URL, DNS, redirects, proxy, shell, credentials, scan or OTA operation.
use crate::d1_link::{LinkCandidate, LinkSnapshot};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const MAX_HEALTH_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    TypeC,
    Ap,
    Lan,
}
impl ConnectionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeC => "type_c",
            Self::Ap => "ap",
            Self::Lan => "lan",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRequest {
    pub interface_id: String,
    #[serde(default)]
    pub ap_address: Option<String>,
    #[serde(default)]
    pub connection_mode: Option<ConnectionMode>,
}
impl DeviceRequest {
    pub fn validated_mode(&self) -> Result<ConnectionMode, QueryError> {
        let mode = self
            .connection_mode
            .unwrap_or(if self.ap_address.is_some() {
                ConnectionMode::Lan
            } else {
                ConnectionMode::TypeC
            });
        match (mode, self.ap_address.as_deref()) {
            (ConnectionMode::TypeC | ConnectionMode::Ap, None) | (ConnectionMode::Lan, Some(_)) => {
                Ok(mode)
            }
            _ => Err(error(
                "D1_CONNECTION_INVALID",
                "连接方式与设备地址不匹配，请重新选择。",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub id: String,
    pub application_version: Option<String>,
    pub release_id: Option<String>,
    pub firmware: Option<String>,
    pub hardware_profile: Option<String>,
    pub architecture: Option<String>,
    pub channel: Option<String>,
    pub source: &'static str,
    pub identity_verified: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraObservation {
    pub role: String,
    pub name: Option<String>,
    pub state: Option<String>,
    pub enabled: Option<bool>,
    pub required: Option<bool>,
    pub fresh: Option<bool>,
    pub effective_fps: Option<f64>,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageObservation {
    pub mounted: Option<bool>,
    pub writable: Option<bool>,
    pub filesystem: Option<String>,
    pub free_bytes: Option<u64>,
    pub usage_warning: Option<bool>,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAlert {
    pub code: String,
    pub severity: Option<String>,
    pub component: Option<String>,
    pub message: Option<String>,
    pub action: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedTest {
    pub phase: Option<String>,
    pub result: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub status_summary: Value,
    pub observed_at_ms: u64,
    /// Validated peer that actually returned this report, never the host adapter IP.
    pub connection_address: Option<Ipv4Addr>,
    pub connection_mode: &'static str,
    pub camera_port_limited: bool,
    pub connection_limited_only: bool,
    pub http_status: u16,
    pub device: DeviceIdentity,
    pub phase: Option<String>,
    pub health: Option<String>,
    pub heartbeat_stale: Option<bool>,
    pub voltage: Option<f64>,
    pub temperature: Option<f64>,
    pub cameras: Vec<CameraObservation>,
    pub storage: Option<StorageObservation>,
    pub alerts: Vec<DeviceAlert>,
    pub self_test: Option<ReportedTest>,
    pub ota_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    pub code: &'static str,
    pub message: &'static str,
}
fn error(code: &'static str, message: &'static str) -> QueryError {
    QueryError { code, message }
}

// Drop free text that could expose credentials or unrelated personal fields.
pub(super) fn safe_text(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    if value.is_empty()
        || value.len() > 1024
        || value.chars().any(char::is_control)
        || [
            "password",
            "passwd",
            "token",
            "authorization",
            "bearer",
            "secret",
            "private key",
            "ssh_key",
            "connection_key",
            "email",
            "phone",
            "密码",
            "密钥",
            "私钥",
        ]
        .iter()
        .any(|word| lower.contains(word))
    {
        return None;
    }
    Some(value.chars().take(300).collect())
}
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().and_then(safe_text)
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64().filter(|number| number.is_finite())
}
pub(super) fn parse_health(bytes: &[u8], status: u16) -> Result<HealthSnapshot, QueryError> {
    if bytes.len() > MAX_HEALTH_BYTES {
        return Err(error("D1_RESPONSE_TOO_LARGE", "设备报告超过大小限制。"));
    }
    // A provisioning portal may return HTML with HTTP 200 for *every* GET.
    // Inspect bounded bytes only; never render the page or run its OTA scripts.
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let prefix = prefix
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    if prefix.starts_with("<!doctype html") || prefix.starts_with("<html") {
        return Err(error(
            "D1_HEALTH_PAGE_ONLY",
            "地址可达，但返回的是网页，暂不能读取设备报告。请在设备联网后使用其播报的局域网 IP，或通过 Type-C 连接。",
        ));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| error("D1_RESPONSE_INVALID", "设备报告无法解析，请复检。"))?;
    let device = &value["device"];
    if device["schema"] != "dohc.device.health.v1" {
        return Err(error(
            "D1_PROTOCOL_UNSUPPORTED",
            "当前设备尚未提供受支持的健康报告。",
        ));
    }
    let id = text(device, "device_id")
        .ok_or_else(|| error("D1_IDENTITY_MISSING", "设备报告未提供设备标识。"))?;
    let cameras = value["devices"]
        .as_object()
        .map(|items| {
            items
                .iter()
                .take(16)
                .filter_map(|(role, item)| {
                    Some(CameraObservation {
                        role: safe_text(role)?,
                        name: text(item, "name"),
                        state: text(item, "state"),
                        enabled: item["enabled"].as_bool(),
                        required: item["required"].as_bool(),
                        fresh: item["fresh"].as_bool(),
                        effective_fps: number(item, "effective_fps"),
                        reason: text(item, "reason"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let storage = value["storage"].as_object().map(|_| {
        let item = &value["storage"];
        StorageObservation {
            mounted: item["mounted"].as_bool(),
            writable: item["writable"].as_bool(),
            filesystem: text(item, "filesystem_type"),
            free_bytes: item["free_bytes"].as_u64(),
            usage_warning: item["usage_warning"].as_bool(),
            reason: text(item, "reason"),
        }
    });
    let alerts = value["alerts"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(32)
                .filter_map(|item| {
                    Some(DeviceAlert {
                        code: text(item, "code")?,
                        severity: text(item, "severity"),
                        component: text(item, "component"),
                        message: text(item, "message"),
                        action: text(item, "action"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let telemetry = &value["monitor"]["telemetry"];
    Ok(HealthSnapshot {
        status_summary: crate::d1_page::status_fields(&serde_json::json!({
            "schema":"dohc.device.status-summary.v2", "device":device,
            "health":value["overall_health"].as_str().or_else(||value["health"].as_str()),
            "phase":value["phase"],"heartbeat_stale":value["heartbeat_stale"],"heartbeat_age_seconds":value["heartbeat_age_seconds"],
            "runtime":{"timestamp":value["timestamp"],"uptime_seconds":value["uptime_seconds"]},
            "cameras":{"items":value["devices"].as_object().map(|items|items.iter().map(|(role,item)|{
                let mut item=item.clone();item["role"]=Value::String(role.clone());item
            }).collect::<Vec<_>>()).unwrap_or_default()},
            "storage":value["storage"],"emmc_storage":value["emmc_storage"],"telemetry":telemetry,
            "recording":{"session_active":value["recording_quality"]["session_active"],"quality":value["recording_quality"]["status"],
                "dropped_batches":value["recording_quality"]["dropped_batches_session"],"writer_alive":value["writer"]["thread_alive"],
                "queue_depth":value["writer"]["queue_depth"],"queue_capacity":value["writer"]["queue_capacity"]},
            "qc":value["self_test"],"stress_test":value["stress_test"],
            "indicators":{"status":value["indicators"]["status_led"],"battery":value["indicators"]["battery_led"]},
            "alerts":{"items":value["alerts"],"total":value["alerts"].as_array().map(Vec::len)}
        })),
        observed_at_ms: crate::d1::millis(),
        connection_address: None,
        connection_mode: "unknown",
        camera_port_limited: false,
        connection_limited_only: false,
        http_status: status,
        device: DeviceIdentity {
            id,
            application_version: text(device, "workspace_version"),
            release_id: text(device, "release_id"),
            firmware: text(device, "firmware_version"),
            hardware_profile: text(device, "hardware_profile"),
            architecture: text(device, "architecture"),
            channel: text(device, "channel"),
            source: "device_report",
            identity_verified: false,
        },
        phase: text(&value, "phase"),
        health: text(&value, "overall_health").or_else(|| text(&value, "health")),
        heartbeat_stale: value["heartbeat_stale"].as_bool(),
        voltage: number(telemetry, "vcc_voltage"),
        temperature: number(telemetry, "chip_temp"),
        cameras,
        storage,
        alerts,
        self_test: value["self_test"].as_object().map(|_| ReportedTest {
            phase: text(&value["self_test"], "phase"),
            result: text(&value["self_test"], "result"),
        }),
        ota_state: text(&value["ota_operation"], "state"),
    })
}

#[derive(Debug, PartialEq)]
struct Endpoint {
    local: Ipv4Addr,
    peer: Ipv4Addr,
}
fn request_endpoint(link: &LinkCandidate, request: &DeviceRequest) -> Result<Endpoint, QueryError> {
    if request.validated_mode()? == ConnectionMode::Ap && !link.wireless {
        return Err(error(
            "D1_AP_WIFI_REQUIRED",
            "请先在电脑 Wi-Fi 中连接设备标签对应的 Delta-D1 热点。",
        ));
    }
    endpoint(link, request.ap_address.as_deref())
}
/// OS-derived on-link Wi-Fi gateway only; never an address supplied by the UI.
pub(super) fn hotspot_address(link: &LinkCandidate) -> Option<Ipv4Addr> {
    hotspot_endpoint(link).map(|(_, peer)| peer)
}
pub(super) fn hotspot_endpoint(link: &LinkCandidate) -> Option<(Ipv4Addr, Ipv4Addr)> {
    if !link.wireless {
        return None;
    }
    endpoint(link, None)
        .ok()
        .map(|target| (target.local, target.peer))
}

pub(super) fn attempted_address(link: &LinkCandidate, request: &DeviceRequest) -> Option<Ipv4Addr> {
    request_endpoint(link, request)
        .ok()
        .map(|target| target.peer)
}

/// Reuse the selected OS link for SSH, including the USB/RNDIS gateway.
pub(crate) async fn ssh_target(
    request: &DeviceRequest,
    cancelled: &AtomicBool,
) -> Result<(Ipv4Addr, Option<Ipv4Addr>), String> {
    if request.validated_mode().map_err(|e| e.message)? != ConnectionMode::TypeC {
        let (_, peer, local) = crate::d1_page::resolve_target(request, cancelled).await?;
        return Ok((peer, local));
    }
    let links = inventory_for(false).await.map_err(|e| e.message)?;
    let link = links
        .candidates
        .iter()
        .find(|link| link.interface_id == request.interface_id)
        .ok_or("D1_DISCONNECTED: 未找到所选 Type-C 网络连接")?;
    let target = request_endpoint(link, request).map_err(|e| e.message)?;
    Ok((target.peer, Some(target.local)))
}
fn endpoint(link: &LinkCandidate, ap_address: Option<&str>) -> Result<Endpoint, QueryError> {
    if ["link_down", "waiting_address"].contains(&link.state)
        || (ap_address.is_none()
            && (link.state != "identity_unverified" || link.gateway_candidates.len() != 1))
    {
        return Err(error(
            "D1_ADDRESS_UNAVAILABLE",
            "设备连接尚未获得唯一地址。",
        ));
    }
    let peer: Ipv4Addr = ap_address
        .unwrap_or_else(|| &link.gateway_candidates[0])
        .parse()
        .map_err(|_| error("D1_ADDRESS_UNAVAILABLE", "设备连接地址无效。"))?;
    if !peer.is_private() {
        return Err(error(
            "D1_ADDRESS_UNAVAILABLE",
            "只允许所选本机网卡同网段的私有 IPv4 设备地址。",
        ));
    }
    let local = link
        .local_ipv4
        .iter()
        .find_map(|address| {
            let (ip, prefix) = address.split_once('/')?;
            let ip: Ipv4Addr = ip.parse().ok()?;
            let prefix: u32 = prefix.parse().ok()?;
            if !(1..=30).contains(&prefix) || ip == peer {
                return None;
            }
            let mask = u32::MAX << (32 - prefix);
            (ip.is_private()
                && u32::from(ip) & mask == u32::from(peer) & mask
                && u32::from(peer) & !mask != 0
                && u32::from(peer) & !mask != !mask)
                .then_some(ip)
        })
        .ok_or_else(|| {
            error(
                "D1_ADDRESS_UNAVAILABLE",
                "设备地址必须与所选本机网卡同网段，且不能是本机、网络或广播地址。",
            )
        })?;
    Ok(Endpoint { local, peer })
}

pub async fn inventory_for(lan: bool) -> Result<LinkSnapshot, QueryError> {
    tauri::async_runtime::spawn_blocking(move || crate::d1_link::snapshot_for(lan))
        .await
        .map_err(|_| error("D1_INVENTORY_UNAVAILABLE", "无法读取本机设备连接。"))
}
async fn fetch_health(url: &str, local: Ipv4Addr) -> Result<HealthSnapshot, QueryError> {
    // reqwest's configured TLS backend also needs a provider when constructing
    // an HTTP-only client outside the normal application setup (e.g. tests).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .local_address(std::net::IpAddr::V4(local))
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| error("D1_QUERY_UNAVAILABLE", "无法建立设备查询。"))?;
    let map_error = |value: reqwest::Error| {
        if value.is_timeout() {
            error("D1_QUERY_TIMEOUT", "设备响应超时，请检查连接后复检。")
        } else {
            error("D1_QUERY_FAILED", "未能读取设备报告，请检查连接后复检。")
        }
    };
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(map_error)?;
    let status = response.status().as_u16();
    // DOHC intentionally uses 503 for a valid, unhealthy device report.
    if ![200, 503].contains(&status) {
        return Err(error(
            "D1_PROTOCOL_UNSUPPORTED",
            "设备未返回受支持的健康报告。",
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_HEALTH_BYTES as u64)
    {
        return Err(error("D1_RESPONSE_TOO_LARGE", "设备报告超过大小限制。"));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_error)?;
        if body.len() + chunk.len() > MAX_HEALTH_BYTES {
            return Err(error("D1_RESPONSE_TOO_LARGE", "设备报告超过大小限制。"));
        }
        body.extend_from_slice(&chunk);
    }
    parse_health(&body, status)
}
async fn read_cancellable(
    url: &str,
    local: Ipv4Addr,
    cancelled: &AtomicBool,
) -> Result<HealthSnapshot, QueryError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(error("D1_CANCELLED", "检测已取消。"));
    }
    tokio::select! {
        result=fetch_health(url,local)=>result,
        _=async {while !cancelled.load(Ordering::Acquire) {tokio::time::sleep(Duration::from_millis(20)).await;}}=>{
            Err(error("D1_CANCELLED", "检测已取消。"))
        }
    }
}
pub async fn query(
    request: &DeviceRequest,
    cancelled: &AtomicBool,
) -> Result<HealthSnapshot, QueryError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(error("D1_CANCELLED", "检测已取消。"));
    }
    let mode = request.validated_mode()?;
    if mode == ConnectionMode::Lan {
        let peer = crate::d1_page::lan_address(request.ap_address.as_deref().unwrap_or_default())
            .map_err(|_| error("D1_ADDRESS_UNAVAILABLE", "请输入设备的私有 IPv4 地址。"))?;
        let mut observation = read_cancellable(
            &format!("http://{peer}/health"),
            Ipv4Addr::UNSPECIFIED,
            cancelled,
        )
        .await?;
        apply_connection_context(&mut observation, true);
        observation.connection_mode = mode.as_str();
        observation.connection_address = Some(peer);
        return Ok(observation);
    }
    let links = inventory_for(mode != ConnectionMode::TypeC).await?;
    let link = links
        .candidates
        .iter()
        .find(|link| link.interface_id == request.interface_id)
        .ok_or_else(|| error("D1_DISCONNECTED", "设备已断开，请重新连接。"))?;
    let target = request_endpoint(link, request)?;
    // Sole operation is GET /health:80, bound to the selected on-link address.
    let url = format!("http://{}/health", target.peer);
    let mut observation = read_cancellable(&url, target.local, cancelled).await?;
    let current = inventory_for(mode != ConnectionMode::TypeC).await?;
    if cancelled.load(Ordering::Acquire) {
        return Err(error("D1_CANCELLED", "检测已取消。"));
    }
    if current
        .candidates
        .iter()
        .find(|link| link.interface_id == request.interface_id)
        .and_then(|link| request_endpoint(link, request).ok())
        .as_ref()
        != Some(&target)
    {
        return Err(error("D1_DISCONNECTED", "设备连接已变化，请重新检测。"));
    }
    apply_connection_context(&mut observation, mode != ConnectionMode::TypeC);
    observation.connection_mode = mode.as_str();
    observation.connection_address = Some(target.peer);
    Ok(observation)
}

// The user confirmed D1's sole Type-C port normally hosts the extension pair.
// Never turn missing camera evidence into a pass; retain raw state/alerts.
pub(super) fn apply_connection_context(snapshot: &mut HealthSnapshot, ap: bool) {
    snapshot.connection_mode = if ap { "ap" } else { "type_c" };
    snapshot.camera_port_limited = !ap
        && snapshot.cameras.iter().any(|camera| {
            camera.role == "stereo_extension"
                && camera.enabled == Some(true)
                && !(camera.state.as_deref() == Some("STREAMING") && camera.fresh == Some(true))
        });
    snapshot.connection_limited_only = snapshot.camera_port_limited
        && snapshot.heartbeat_stale == Some(false)
        && snapshot.health.as_deref() == Some("DEGRADED")
        && snapshot
            .cameras
            .iter()
            .filter(|camera| camera.role != "stereo_extension" && camera.enabled != Some(false))
            .all(|camera| {
                camera.state.as_deref() == Some("STREAMING") && camera.fresh == Some(true)
            })
        && snapshot.storage.as_ref().is_some_and(|storage| {
            storage.mounted == Some(true)
                && storage.writable == Some(true)
                && storage.usage_warning == Some(false)
        })
        && snapshot
            .alerts
            .iter()
            .all(|alert| alert.component.as_deref() == Some("camera.stereo_extension"));
}

pub fn address_matches(link: &LinkCandidate, address: &str) -> bool {
    endpoint(link, Some(address)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server(response: Vec<u8>, delay: Duration) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 2048];
            let count = stream.read(&mut request).unwrap();
            assert!(request[..count].starts_with(b"GET /health HTTP/1.1"));
            std::thread::sleep(delay);
            let _ = stream.write_all(&response);
        });
        format!("http://127.0.0.1:{port}/health")
    }
    #[tokio::test]
    async fn transport_accepts_valid_503_and_rejects_redirects_and_size_limit() {
        let body=br#"{"device":{"schema":"dohc.device.health.v1","device_id":"test-device"},"health":"FAILED"}"#;
        let mut response = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        assert_eq!(
            fetch_health(&server(response, Duration::ZERO), Ipv4Addr::LOCALHOST)
                .await
                .unwrap()
                .http_status,
            503
        );
        let redirect=b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        assert_eq!(
            fetch_health(&server(redirect, Duration::ZERO), Ipv4Addr::LOCALHOST)
                .await
                .unwrap_err()
                .code,
            "D1_PROTOCOL_UNSUPPORTED"
        );
        let large =
            b"HTTP/1.1 200 OK\r\nContent-Length: 524289\r\nConnection: close\r\n\r\n".to_vec();
        assert_eq!(
            fetch_health(&server(large, Duration::ZERO), Ipv4Addr::LOCALHOST)
                .await
                .unwrap_err()
                .code,
            "D1_RESPONSE_TOO_LARGE"
        );
    }
    #[tokio::test]
    async fn reachable_html_portal_is_unsupported_not_network_failure_or_device_health() {
        let body = b"<!DOCTYPE html><html><title>Provisioning</title><script>fetch('/ota/status')</script></html>";
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(body);
        let result = fetch_health(&server(response, Duration::ZERO), Ipv4Addr::LOCALHOST)
            .await
            .unwrap_err();
        assert_eq!(result.code, "D1_HEALTH_PAGE_ONLY");
        assert!(!result.message.contains("Provisioning"));
        assert!(!result.message.contains("/ota/"));
        assert_eq!(
            parse_health(b"broken json", 200).unwrap_err().code,
            "D1_RESPONSE_INVALID"
        );
    }
    #[tokio::test]
    async fn transport_timeout_and_inflight_cancellation_stop_reading_without_hardware_verdict() {
        let url = server(Vec::new(), Duration::from_secs(6));
        assert_eq!(
            fetch_health(&url, Ipv4Addr::LOCALHOST)
                .await
                .unwrap_err()
                .code,
            "D1_QUERY_TIMEOUT"
        );
        let url = server(Vec::new(), Duration::from_millis(500));
        let cancelled = AtomicBool::new(false);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancelled.store(true, Ordering::Release);
        };
        let (result, ()) = tokio::join!(
            read_cancellable(&url, Ipv4Addr::LOCALHOST, &cancelled),
            cancel
        );
        assert_eq!(result.unwrap_err().code, "D1_CANCELLED");
    }
    #[test]
    fn accepts_real_health_schema_and_unhealthy_503_without_including_personal_fields() {
        let bytes=br#"{"device":{"schema":"dohc.device.health.v1","device_id":"test-device","workspace_version":"1.1.1","device_name":"PRIVATE_PERSON","password":"PRIVATE_CREDENTIAL"},"health":"FAILED","heartbeat_stale":false,"alerts":[{"code":"CAMERA_FAULT","message":"token=PRIVATE_CREDENTIAL"}],"devices":{"t265":{"state":"FAULT","fresh":false}}}"#;
        let snapshot = parse_health(bytes, 503).unwrap();
        assert_eq!(snapshot.http_status, 503);
        assert!(
            snapshot.connection_address.is_none(),
            "report parsing cannot infer a network peer or device primary IP"
        );
        assert_eq!(snapshot.health.as_deref(), Some("FAILED"));
        assert!(!snapshot.device.identity_verified);
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("PRIVATE_"));
        assert!(snapshot.alerts[0].message.is_none());
    }
    #[test]
    fn unknown_protocol_and_invalid_or_oversized_json_never_become_device_success() {
        for bytes in [
            &b"<html>not health</html>"[..],
            &b"{}"[..],
            &b"{\"device\":{\"schema\":\"future\"}}"[..],
        ] {
            assert!(parse_health(bytes, 200).is_err());
        }
        assert!(parse_health(&vec![b' '; MAX_HEALTH_BYTES + 1], 200).is_err());
        assert!(
            serde_json::from_str::<DeviceRequest>(r#"{"interfaceId":"usb","host":"other"}"#)
                .is_err()
        );
        assert!(
            serde_json::from_str::<DeviceRequest>(r#"{"interfaceId":"usb","command":"sh"}"#)
                .is_err()
        );
    }
    #[test]
    fn restricts_endpoint_to_one_private_gateway_on_same_active_usb_subnet() {
        let mut link = LinkCandidate {
            interface_id: "usb".into(),
            name: String::new(),
            description: String::new(),
            usb_id: None,
            wireless: false,
            state: "identity_unverified",
            local_ipv4: vec!["192.168.188.86/24".into()],
            gateway_candidates: vec!["192.168.188.1".into()],
            identity_verified: false,
        };
        assert!(endpoint(&link, None).is_ok());
        link.gateway_candidates = vec!["10.1.40.1".into()];
        assert!(endpoint(&link, None).is_err());
        link.gateway_candidates = vec!["8.8.8.8".into()];
        assert!(endpoint(&link, None).is_err());
        link.gateway_candidates = vec!["192.168.188.1".into(), "192.168.188.2".into()];
        assert!(endpoint(&link, None).is_err());
        link.state = "link_down";
        assert!(endpoint(&link, None).is_err());
    }
    #[test]
    fn ap_address_is_literal_private_on_link_unicast_and_never_a_url_or_command() {
        let link = LinkCandidate {
            interface_id: "wifi".into(),
            name: "Wi-Fi".into(),
            description: String::new(),
            usb_id: None,
            wireless: false,
            state: "address_incomplete",
            local_ipv4: vec!["192.168.4.20/24".into()],
            gateway_candidates: vec![],
            identity_verified: false,
        };
        assert_eq!(
            endpoint(&link, Some("192.168.4.1")).unwrap().local,
            Ipv4Addr::new(192, 168, 4, 20)
        );
        for address in [
            "8.8.8.8",
            "127.0.0.1",
            "169.254.1.2",
            "192.168.5.1",
            "192.168.4.20",
            "192.168.4.0",
            "192.168.4.255",
            "http://192.168.4.1",
            "192.168.4.1:80",
            "192.168.4.1/health",
            "device.local",
            "192.168.4.1;reboot",
        ] {
            assert!(endpoint(&link, Some(address)).is_err(), "{address}");
        }
        let mut down = link;
        down.state = "link_down";
        assert!(endpoint(&down, Some("192.168.4.1")).is_err());
    }
    #[tokio::test]
    async fn invalid_ap_address_returns_without_fetching_any_report() {
        for address in ["example.invalid", "8.8.8.8", "http://192.168.4.1"] {
            let value = query(
                &DeviceRequest {
                    interface_id: "missing".into(),
                    ap_address: Some(address.into()),
                    connection_mode: None,
                },
                &AtomicBool::new(false),
            )
            .await;
            assert_eq!(value.unwrap_err().code, "D1_ADDRESS_UNAVAILABLE");
        }
    }
    #[test]
    fn connection_modes_separate_os_hotspot_from_explicit_lan_and_usb() {
        let request = |mode, address: Option<&str>| DeviceRequest {
            interface_id: "fixture".into(),
            ap_address: address.map(String::from),
            connection_mode: mode,
        };
        assert_eq!(
            request(Some(ConnectionMode::Ap), None)
                .validated_mode()
                .unwrap(),
            ConnectionMode::Ap
        );
        assert_eq!(
            request(Some(ConnectionMode::Lan), Some("10.1.41.12"))
                .validated_mode()
                .unwrap(),
            ConnectionMode::Lan
        );
        assert_eq!(
            request(None, None).validated_mode().unwrap(),
            ConnectionMode::TypeC
        );
        assert_eq!(
            request(None, Some("192.168.188.1"))
                .validated_mode()
                .unwrap(),
            ConnectionMode::Lan
        );
        for value in [
            request(Some(ConnectionMode::Ap), Some("192.168.4.1")),
            request(Some(ConnectionMode::Ap), Some("192.168.188.1")),
            request(Some(ConnectionMode::TypeC), Some("192.168.188.1")),
            request(Some(ConnectionMode::Lan), None),
        ] {
            assert_eq!(
                value.validated_mode().unwrap_err().code,
                "D1_CONNECTION_INVALID"
            );
        }
        assert!(serde_json::from_str::<DeviceRequest>(
            r#"{"interfaceId":"wifi","connectionMode":"shell"}"#
        )
        .is_err());
    }
    #[test]
    fn hotspot_cannot_use_usb_even_when_usb_and_wifi_share_the_same_peer_address() {
        let mut link = LinkCandidate {
            interface_id: "fixture".into(),
            name: "fixture".into(),
            description: String::new(),
            usb_id: Some("2207:0003".into()),
            wireless: false,
            state: "identity_unverified",
            local_ipv4: vec!["192.168.188.64/24".into()],
            gateway_candidates: vec!["192.168.188.1".into()],
            identity_verified: false,
        };
        let request = DeviceRequest {
            interface_id: "fixture".into(),
            ap_address: None,
            connection_mode: Some(ConnectionMode::Ap),
        };
        assert_eq!(
            request_endpoint(&link, &request).unwrap_err().code,
            "D1_AP_WIFI_REQUIRED"
        );
        link.wireless = true;
        assert_eq!(
            request_endpoint(&link, &request).unwrap().peer.to_string(),
            "192.168.188.1"
        );
        link.state = "link_down";
        assert!(request_endpoint(&link, &request).is_err());
    }
    #[test]
    fn hotspot_uses_actual_wifi_gateway_and_rejects_missing_ambiguous_or_unsafe_peers() {
        let mut link = LinkCandidate {
            interface_id: "wifi".into(),
            name: "Wi-Fi".into(),
            description: String::new(),
            usb_id: None,
            wireless: true,
            state: "identity_unverified",
            local_ipv4: vec!["192.168.4.121/24".into()],
            gateway_candidates: vec!["192.168.4.1".into()],
            identity_verified: false,
        };
        let request = DeviceRequest {
            interface_id: "wifi".into(),
            ap_address: None,
            connection_mode: Some(ConnectionMode::Ap),
        };
        assert_eq!(hotspot_address(&link), Some(Ipv4Addr::new(192, 168, 4, 1)));
        assert_eq!(
            request_endpoint(&link, &request).unwrap(),
            Endpoint {
                local: Ipv4Addr::new(192, 168, 4, 121),
                peer: Ipv4Addr::new(192, 168, 4, 1)
            }
        );
        link.wireless = false;
        assert!(
            hotspot_address(&link).is_none(),
            "neither USB nor wired gateways may be AP candidates"
        );
        link.wireless = true;
        for gateways in [
            vec![],
            vec!["192.168.4.1", "192.168.4.2"],
            vec!["8.8.8.8"],
            vec!["192.168.188.1"],
            vec!["192.168.4.121"],
            vec!["192.168.4.0"],
            vec!["192.168.4.255"],
        ] {
            link.gateway_candidates = gateways.into_iter().map(String::from).collect();
            assert!(hotspot_address(&link).is_none());
        }
        link.gateway_candidates = vec!["192.168.4.1".into()];
        link.state = "link_down";
        assert!(hotspot_address(&link).is_none());
    }
    #[tokio::test]
    async fn mismatched_hotspot_address_is_rejected_before_inventory_or_transport() {
        let request = DeviceRequest {
            interface_id: "not-an-interface".into(),
            ap_address: Some("192.168.4.1".into()),
            connection_mode: Some(ConnectionMode::Ap),
        };
        assert_eq!(
            query(&request, &AtomicBool::new(false))
                .await
                .unwrap_err()
                .code,
            "D1_CONNECTION_INVALID"
        );
    }
    #[test]
    fn filters_sensitive_and_control_text() {
        for text in [
            "password=x",
            "TOKEN=x",
            "Bearer x",
            "private key",
            "email=x",
            "密码=x",
            "a\nb",
        ] {
            assert!(safe_text(text).is_none());
        }
        assert!(safe_text("waiting for finite T265 pose data").is_some());
    }
    #[tokio::test]
    async fn cancellation_before_query_performs_no_inventory_or_network_operation() {
        let result = query(
            &DeviceRequest {
                interface_id: "not-a-device".into(),
                ap_address: None,
                connection_mode: None,
            },
            &AtomicBool::new(true),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "D1_CANCELLED");
    }
}
