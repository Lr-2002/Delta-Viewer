//! Explicitly selected device pages and fixed configuration routes on port 80.
use crate::d1_device::{self, ConnectionMode, DeviceRequest};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    net::Ipv4Addr,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use zeroize::Zeroize;

const MAX_BYTES: usize = 512 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePage {
    pub address: String,
    pub html: String,
    pub observed_at_ms: u64,
    pub status: Option<serde_json::Value>,
    pub status_error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageApiRequest {
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    pub if_match: Option<String>,
}
impl Drop for PageApiRequest {
    fn drop(&mut self) {
        if let Some(body) = &mut self.body {
            body.zeroize();
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageApiResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}
// Fields observed in the device's own GET /status (status-summary.v2).
// Excludes device_name/task, credentials, source paths and unrelated payloads.
pub(super) fn status_fields(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    const KEYS: &[&str] = &[
        "schema",
        "device",
        "device_id",
        "workspace_version",
        "release_id",
        "channel",
        "firmware_version",
        "phase",
        "health",
        "ready",
        "heartbeat_stale",
        "heartbeat_age_seconds",
        "can_start",
        "can_stop",
        "runtime",
        "timestamp",
        "uptime_seconds",
        "cameras",
        "configured",
        "fresh",
        "items",
        "role",
        "state",
        "required",
        "enabled",
        "healthy",
        "extension",
        "last_frame_age_seconds",
        "effective_fps",
        "reconnect_count",
        "reason",
        "storage",
        "emmc_storage",
        "writable",
        "mounted",
        "filesystem_type",
        "used_percent",
        "free_bytes",
        "total_bytes",
        "usage_warning",
        "data_export_required",
        "telemetry",
        "vcc_voltage",
        "chip_temp",
        "sampled_at",
        "recording",
        "session_active",
        "storage_mode",
        "quality",
        "dropped_batches",
        "queue_depth",
        "queue_capacity",
        "writer_alive",
        "writer_busy",
        "indicators",
        "status",
        "battery",
        "color_hex",
        "color_name",
        "mode",
        "pattern",
        "trigger",
        "write_state",
        "qc",
        "result",
        "progress_percent",
        "elapsed_seconds",
        "remaining_seconds",
        "failures",
        "updater",
        "release_after",
        "components",
        "name",
        "alerts",
        "total",
        "critical",
        "warning",
        "severity",
        "component",
        "code",
        "message",
        "action",
        "reasons",
        "stress_test",
        "sample_count",
        "stop_reason",
        "low_voltage_threshold",
        "start_voltage",
        "end_voltage",
        "minimum_voltage",
        "stream",
        "read",
        "write",
        "saved",
        "read_delta",
        "write_delta",
        "saved_delta",
    ];
    match value {
        Value::Object(items) => Value::Object(
            items
                .iter()
                .filter(|(key, _)| KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), status_fields(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().take(64).map(status_fields).collect()),
        Value::String(text) => d1_device::safe_text(text)
            .map(Value::String)
            .unwrap_or(Value::Null),
        value => value.clone(),
    }
}
async fn get(
    client: &reqwest::Client,
    address: Ipv4Addr,
    path: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(format!("http://{address}{path}"))
        .send()
        .await
        .map_err(|_| "无法访问设备页面。请检查 IP、网络连接及设备是否开机。")?;
    if response.status().as_u16() != 200 {
        return Err("设备未返回可展示的状态页面。".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err("设备页面超过大小限制。".into());
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        if cancelled.load(Ordering::Acquire) {
            return Err("页面读取已取消。".into());
        }
        let chunk = chunk.map_err(|_| "设备页面读取中断，请重试。")?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("设备页面超过大小限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn lan_address(address: &str) -> Result<Ipv4Addr, String> {
    let ip: Ipv4Addr = address
        .parse()
        .map_err(|_| "请输入设备的私有 IPv4 地址，不含端口或路径。")?;
    if !ip.is_private() || matches!(ip.octets()[3], 0 | 255) {
        return Err("请输入设备的私有 IPv4 地址。".into());
    }
    Ok(ip)
}
pub(crate) async fn resolve_target(
    request: &DeviceRequest,
    cancelled: &AtomicBool,
) -> Result<(ConnectionMode, Ipv4Addr, Option<Ipv4Addr>), String> {
    let mode = request.validated_mode().map_err(|e| e.message)?;
    #[cfg(windows)]
    if mode == ConnectionMode::Ap {
        let id = request.interface_id.clone();
        let connected = tauri::async_runtime::spawn_blocking(move || {
            crate::d1_wifi::inventory(false).map(|snapshot| {
                snapshot
                    .networks
                    .into_iter()
                    .filter(|network| {
                        network.recommended
                            && network.connected
                            && (id.is_empty() || network.interface_id == id)
                    })
                    .count()
                    == 1
            })
        })
        .await
        .map_err(|_| "无法核对设备热点连接。")??;
        if !connected {
            return Err("请先连接设备标签对应的 Delta-D1 热点，再打开设备页面。".into());
        }
    }
    let (address, local) = match mode {
        ConnectionMode::Lan => (
            lan_address(request.ap_address.as_deref().unwrap_or(""))?,
            None,
        ),
        ConnectionMode::Ap => {
            let mut selected = None;
            // A successful WLAN association may precede DHCP. Re-read OS only.
            for _ in 0..16 {
                if cancelled.load(Ordering::Acquire) {
                    return Err("页面读取已取消。".into());
                }
                let links = d1_device::inventory_for(true)
                    .await
                    .map_err(|e| e.message)?;
                let mut candidates = links.candidates.iter().filter(|link| {
                    d1_device::hotspot_address(link).is_some()
                        && (request.interface_id.is_empty()
                            || request.interface_id == link.interface_id)
                });
                if let Some(link) = candidates.next() {
                    if candidates.next().is_some() {
                        return Err("有多个 Wi-Fi 连接，请先选择设备热点。".into());
                    }
                    let (local, peer) = d1_device::hotspot_endpoint(link).unwrap();
                    selected = Some((peer, Some(local)));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            selected.ok_or("未找到设备热点连接，请先连接 Delta-D1 热点并等待获得地址。")?
        }
        ConnectionMode::TypeC => return Err("请选择设备热点或局域网 IP。".into()),
    };
    if cancelled.load(Ordering::Acquire) {
        return Err("页面读取已取消。".into());
    }
    Ok((mode, address, local))
}
fn client(local: Option<Ipv4Addr>) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5));
    if let Some(local) = local {
        builder = builder.local_address(std::net::IpAddr::V4(local));
    }
    builder.build().map_err(|_| "无法建立设备页面查询。".into())
}
pub(crate) async fn verify_ap_target(
    request: &DeviceRequest,
    mode: ConnectionMode,
    local: Option<Ipv4Addr>,
    address: Ipv4Addr,
) -> Result<(), String> {
    if let Some(local) = local.filter(|_| mode == ConnectionMode::Ap) {
        let links = d1_device::inventory_for(true)
            .await
            .map_err(|e| e.message)?;
        if !links.candidates.iter().any(|link| {
            (request.interface_id.is_empty() || request.interface_id == link.interface_id)
                && d1_device::hotspot_endpoint(link) == Some((local, address))
        }) {
            return Err("热点连接已变化，请重新连接。".into());
        }
    }
    Ok(())
}
pub async fn read(request: DeviceRequest, cancelled: &AtomicBool) -> Result<DevicePage, String> {
    let (mode, address, local) = resolve_target(&request, cancelled).await?;
    // LAN uses the OS route: private enterprise networks may cross subnets.
    let client = client(local)?;
    let bytes = get(&client, address, "/", cancelled).await?;
    let html = String::from_utf8(bytes).map_err(|_| "设备页面编码暂不支持。")?;
    if !html.to_ascii_lowercase().contains("<html") {
        return Err("设备未返回可展示的状态页面。".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("页面读取已取消。".into());
    }
    let mut status = None;
    let mut status_error = None;
    if html.contains("id=\"cameraRows\"") && html.contains("DOHC 设备状态") {
        match get(&client, address, "/status", cancelled)
            .await
            .and_then(|bytes| {
                serde_json::from_slice::<serde_json::Value>(&bytes)
                    .map_err(|_| "设备状态暂不可用，请刷新页面。".into())
            }) {
            Ok(value) if value["schema"] == "dohc.device.status-summary.v2" => {
                status = Some(status_fields(&value))
            }
            _ => status_error = Some("设备状态暂不可用，请刷新页面。".into()),
        }
    }
    verify_ap_target(&request, mode, local, address).await?;
    if cancelled.load(Ordering::Acquire) {
        return Err("页面读取已取消。".into());
    }
    Ok(DevicePage {
        address: address.to_string(),
        html,
        observed_at_ms: crate::d1::millis(),
        status,
        status_error,
    })
}
fn endpoint_method_allowed(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        (
            "GET",
            "/" | "/status"
                | "/config"
                | "/api/v1/runtime-config"
                | "/api/v1/camera-config"
                | "/api/v1/device-name"
                | "/api/v1/device-task",
        ) | (
            "PUT",
            "/api/v1/device-name"
                | "/api/v1/device-task"
                | "/api/v1/camera-config"
                | "/api/v1/runtime-config"
        ) | (
            "POST",
            "/api/v1/device-name" | "/api/v1/device-task" | "/configure"
        )
    )
}
fn object_has_only(value: &serde_json::Value, fields: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| fields.contains(&key.as_str())))
}
fn valid_text(value: &serde_json::Value, maximum: usize) -> bool {
    value.as_str().is_some_and(|text| {
        !text.trim().is_empty() && text.len() <= maximum && !text.chars().any(char::is_control)
    })
}
fn validate_api_request(api: &PageApiRequest) -> Result<serde_json::Value, String> {
    if !api.path.starts_with('/')
        || api.path.contains(['?', '#', '\\', '%'])
        || !endpoint_method_allowed(&api.method, &api.path)
    {
        return Err("设备页面请求不在允许范围内。".into());
    }
    let body = match api.body.as_deref() {
        Some(body) if body.len() <= MAX_REQUEST_BYTES => {
            serde_json::from_str(body).map_err(|_| "设备配置内容无效。")?
        }
        Some(_) => return Err("设备配置内容超过大小限制。".into()),
        None => serde_json::Value::Null,
    };
    match (api.method.as_str(), api.path.as_str()) {
        ("GET", _) if api.body.is_none() && api.if_match.is_none() => Ok(body),
        ("POST", "/configure") => {
            let ssid = body.get("ssid").and_then(serde_json::Value::as_str);
            let password = body.get("password").and_then(serde_json::Value::as_str);
            if api.if_match.is_some()
                || !object_has_only(&body, &["ssid", "password"])
                || !ssid.is_some_and(|text| {
                    !text.is_empty() && text.len() <= 32 && !text.chars().any(char::is_control)
                })
                || !password.is_some_and(|text| {
                    (8..=63).contains(&text.len()) && !text.chars().any(char::is_control)
                })
            {
                return Err("Wi-Fi 名称或密码格式无效。".into());
            }
            Ok(body)
        }
        ("PUT", "/api/v1/camera-config") => {
            let hash_ok = api.if_match.as_deref().is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
            let Some(version) = body.get("version") else {
                return Err("相机配置版本无效。".into());
            };
            let Some(cameras) = body.get("cameras").and_then(serde_json::Value::as_object) else {
                return Err("相机配置内容无效。".into());
            };
            if !hash_ok
                || !object_has_only(&body, &["version", "cameras"])
                || !(version.is_number() || version.as_str().is_some_and(|value| value.len() <= 32))
                || cameras.is_empty()
                || cameras.len() > 32
                || cameras.iter().any(|(role, spec)| {
                    role.is_empty()
                        || role.len() > 48
                        || !role
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                        || !object_has_only(
                            spec,
                            &[
                                "enabled",
                                "required",
                                "source",
                                "profile",
                                "recording_fps",
                                "minimum_recording_fps",
                                "extension",
                                "driver",
                                "name",
                                "fps",
                                "raw_mjpeg",
                                "stereo_order",
                                "calibration",
                            ],
                        )
                        || spec.as_object().is_none_or(|fields| fields.is_empty())
                        || ["enabled", "required", "extension"]
                            .iter()
                            .any(|key| spec.get(key).is_some_and(|value| !value.is_boolean()))
                        || spec
                            .get("source")
                            .is_some_and(|value| !valid_text(value, 160))
                        || spec.get("profile").is_some_and(|value| {
                            !matches!(value.as_str(), Some("USB" | "DECXIN" | "STEREO_USB"))
                        })
                        || ["recording_fps", "minimum_recording_fps"]
                            .iter()
                            .any(|key| {
                                spec.get(key).is_some_and(|value| {
                                    value.as_u64().is_none_or(|fps| !(1..=120).contains(&fps))
                                })
                            })
                })
            {
                return Err("相机配置字段或校验值无效。".into());
            }
            Ok(body)
        }
        ("PUT", "/api/v1/runtime-config") => {
            let hash_ok = api.if_match.as_deref().is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
            let valid = body
                .get("values")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|values| {
                    !values.is_empty()
                        && values.len() <= 4
                        && values.iter().all(|(key, value)| {
                            let value = value
                                .as_str()
                                .map(str::to_owned)
                                .or_else(|| value.as_i64().map(|n| n.to_string()));
                            let Some(value) = value else {
                                return false;
                            };
                            match key.as_str() {
                                "DOHC_T265_CAPTURE_MODE" => {
                                    matches!(value.as_str(), "images-and-pose" | "pose-only")
                                }
                                "DOHC_RECORDING_STORAGE_MODE" => matches!(
                                    value.as_str(),
                                    "h264-split-mp4"
                                        | "main-h264-t265-side-bin"
                                        | "hybrid-h264-jpeg-segment"
                                        | "jpeg-shard"
                                        | "jpeg-stream"
                                        | "jpeg-segment"
                                        | "jpeg"
                                        | "video"
                                        | "h5"
                                ),
                                "DOHC_RECORDING_QUEUE_SIZE" => {
                                    value.parse::<u32>().is_ok_and(|v| (16..=4096).contains(&v))
                                }
                                "DOHC_ENCODED_QUEUE_SIZE" => {
                                    value.parse::<u32>().is_ok_and(|v| (64..=4096).contains(&v))
                                }
                                _ => false,
                            }
                        })
                });
            if !hash_ok || !object_has_only(&body, &["values"]) || !valid {
                return Err("运行配置字段、范围或校验值无效。".into());
            }
            Ok(body)
        }
        ("PUT", "/api/v1/device-name") | ("POST", "/api/v1/device-name") => {
            if api.if_match.is_some()
                || !object_has_only(&body, &["name"])
                || !body.get("name").is_some_and(|value| valid_text(value, 100))
            {
                return Err("用户名字配置无效。".into());
            }
            Ok(body)
        }
        ("PUT", "/api/v1/device-task") => {
            if api.if_match.is_some()
                || !object_has_only(&body, &["task"])
                || !body.get("task").is_some_and(|value| valid_text(value, 100))
            {
                return Err("用户任务配置无效。".into());
            }
            Ok(body)
        }
        ("POST", "/api/v1/device-task") => {
            if api.if_match.is_some()
                || !object_has_only(&body, &["label"])
                || !body
                    .get("label")
                    .is_some_and(|value| valid_text(value, 100))
            {
                return Err("用户任务配置无效。".into());
            }
            Ok(body)
        }
        _ => Err("设备页面请求参数无效。".into()),
    }
}
fn camera_baseline_matches(body: &serde_json::Value, current: &serde_json::Value) -> bool {
    const EDITABLE: &[&str] = &[
        "enabled",
        "required",
        "source",
        "profile",
        "recording_fps",
        "minimum_recording_fps",
    ];
    let Some(incoming) = body["cameras"].as_object() else {
        return false;
    };
    let Some(original) = current["manifest"]["cameras"].as_object() else {
        return false;
    };
    if body["version"] != current["manifest"]["version"] || incoming.len() != original.len() {
        return false;
    }
    incoming.iter().all(|(role, spec)| {
        let Some(previous) = original.get(role).and_then(serde_json::Value::as_object) else {
            return false;
        };
        let Some(fields) = spec.as_object() else {
            return false;
        };
        previous
            .iter()
            .filter(|(key, _)| !EDITABLE.contains(&key.as_str()))
            .all(|(key, value)| fields.get(key) == Some(value))
            && fields
                .iter()
                .filter(|(key, _)| !EDITABLE.contains(&key.as_str()))
                .all(|(key, value)| previous.get(key) == Some(value))
    })
}
pub async fn api_request(
    request: DeviceRequest,
    api: PageApiRequest,
    cancelled: &AtomicBool,
) -> Result<PageApiResponse, String> {
    let body = validate_api_request(&api)?;
    if cancelled.load(Ordering::Acquire) {
        return Err("设备页面操作已取消。".into());
    }
    let (mode, address, local) = resolve_target(&request, cancelled).await?;
    let client = client(local)?;
    if api.method == "PUT" && api.path == "/api/v1/camera-config" {
        let bytes = get(&client, address, "/api/v1/camera-config", cancelled).await?;
        let current: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "相机配置无法核对，请重新读取。")?;
        if current["sha256"].as_str() != api.if_match.as_deref()
            || !camera_baseline_matches(&body, &current)
        {
            return Err("相机配置已变化或包含不可修改的标定字段，请重新读取。".into());
        }
    }
    let method =
        reqwest::Method::from_bytes(api.method.as_bytes()).map_err(|_| "设备页面请求方法无效。")?;
    let mut builder = client.request(method, format!("http://{address}{}", api.path));
    // A confirmed configuration save may restart the capture service. Never
    // retry a write automatically: a timeout leaves its outcome unknown.
    if api.method != "GET" {
        builder = builder.timeout(Duration::from_secs(60));
    }
    if api.path == "/configure" {
        // Url uses the standard application/x-www-form-urlencoded serializer;
        // this is local encoding and does not request this placeholder origin.
        let mut encoded =
            reqwest::Url::parse("http://d1.invalid/").map_err(|_| "设备配网请求编码失败。")?;
        encoded
            .query_pairs_mut()
            .append_pair("ssid", body["ssid"].as_str().unwrap_or_default())
            .append_pair("password", body["password"].as_str().unwrap_or_default());
        builder = builder
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(encoded.query().unwrap_or_default().to_owned());
    } else if api.method != "GET" {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    if let Some(if_match) = &api.if_match {
        builder = builder.header(reqwest::header::IF_MATCH, if_match);
    }
    let response = builder.send().await.map_err(|_| {
        if api.method == "GET" {
            "无法读取设备接口，请检查连接。"
        } else {
            "尚未确认设备是否保存成功，请先重新读取配置核对，勿重复提交。"
        }
    })?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err("设备配置接口返回了不允许的跳转。".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_ascii_lowercase();
    if matches!(api.path.as_str(), "/" | "/config" | "/configure")
        && !content_type.starts_with("text/html")
    {
        return Err("设备未返回配置页面。".into());
    }
    if (api.path.starts_with("/api/") || api.path == "/status")
        && !content_type.starts_with("application/json")
    {
        return Err("设备配置接口返回格式暂不支持。".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err("设备页面响应超过大小限制。".into());
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        if cancelled.load(Ordering::Acquire) {
            return Err("设备页面操作已取消。".into());
        }
        let chunk = chunk.map_err(|_| "设备页面读取中断，请重试。")?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("设备页面响应超过大小限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut body = String::from_utf8(bytes).map_err(|_| "设备页面编码暂不支持。")?;
    if api.path == "/status" {
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "设备状态暂不可用，请刷新页面。")?;
        if value["schema"] != "dohc.device.status-summary.v2" {
            return Err("设备状态接口版本暂不支持。".into());
        }
        body = serde_json::to_string(&status_fields(&value))
            .map_err(|_| "设备状态暂不可用，请刷新页面。")?;
    }
    if api.path == "/api/v1/runtime-config" && api.method == "GET" && status == 200 {
        let mut value: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "运行配置格式暂不支持。")?;
        // The device also exposes its OTA channel here. OTA remains a separate,
        // disabled integration; do not offer or submit that field.
        if let Some(fields) = value
            .get_mut("fields")
            .and_then(serde_json::Value::as_array_mut)
        {
            fields.retain(|field| {
                matches!(
                    field["key"].as_str(),
                    Some(
                        "DOHC_T265_CAPTURE_MODE"
                            | "DOHC_RECORDING_STORAGE_MODE"
                            | "DOHC_RECORDING_QUEUE_SIZE"
                            | "DOHC_ENCODED_QUEUE_SIZE"
                    )
                )
            });
        }
        if let Some(categories) = value
            .get_mut("categories")
            .and_then(serde_json::Value::as_array_mut)
        {
            categories.retain(|category| category["id"] != "ota");
        }
        if let Some(values) = value
            .get_mut("values")
            .and_then(serde_json::Value::as_object_mut)
        {
            values.remove("DOHC_OTA_CHANNEL");
        }
        body = value.to_string();
    }
    // A successful AP provisioning submission intentionally turns the hotspot off.
    if api.path != "/configure" || status != 202 {
        verify_ap_target(&request, mode, local, address).await?;
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("设备页面操作已取消。".into());
    }
    Ok(PageApiResponse {
        status,
        content_type,
        body,
    })
}

pub async fn read_batch(
    request: DeviceRequest,
    apis: Vec<PageApiRequest>,
    cancelled: &AtomicBool,
) -> Result<Vec<PageApiResponse>, String> {
    if apis.is_empty()
        || apis.len() > 5
        || apis
            .iter()
            .any(|api| api.method != "GET" || validate_api_request(api).is_err())
    {
        return Err("设备只读查询批次无效。".into());
    }
    let replies = futures_util::future::join_all(apis.into_iter().map(|api| {
        let request = request.clone();
        async move {
            api_request(request, api, cancelled)
                .await
                .unwrap_or_else(|message| PageApiResponse {
                    status: 502,
                    content_type: "application/json".into(),
                    body: serde_json::json!({"message":message}).to_string(),
                })
        }
    }))
    .await;
    Ok(replies)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn api(method: &str, path: &str, body: Option<serde_json::Value>) -> PageApiRequest {
        PageApiRequest {
            path: path.into(),
            method: method.into(),
            body: body.map(|value| value.to_string()),
            if_match: None,
        }
    }
    #[test]
    fn configuration_routes_reject_ota_external_paths_and_unvalidated_fields() {
        for path in [
            "/ota/status",
            "/ota/upload",
            "/reboot",
            "//10.1.1.2/status",
            "http://10.1.1.2/status",
            "/status?x=1",
            "/%73tatus",
        ] {
            assert!(validate_api_request(&api("GET", path, None)).is_err());
        }
        for path in [
            "/",
            "/status",
            "/config",
            "/api/v1/camera-config",
            "/api/v1/device-name",
            "/api/v1/device-task",
        ] {
            assert!(validate_api_request(&api("GET", path, None)).is_ok());
        }
        assert!(validate_api_request(&api(
            "POST",
            "/configure",
            Some(serde_json::json!({"ssid":"Test Wi-Fi","password":"fixture-password"}))
        ))
        .is_ok());
        for body in [
            serde_json::json!({"ssid":"Test","password":"short"}),
            serde_json::json!({"ssid":"Test","password":"fixture-password","command":"reboot"}),
            serde_json::json!({"ssid":"a".repeat(33),"password":"fixture-password"}),
        ] {
            assert!(validate_api_request(&api("POST", "/configure", Some(body))).is_err());
        }
        assert!(validate_api_request(&api(
            "PUT",
            "/api/v1/device-name",
            Some(serde_json::json!({"name":"D1 Lab"}))
        ))
        .is_ok());
        assert!(validate_api_request(&api(
            "PUT",
            "/api/v1/device-name",
            Some(serde_json::json!({"name":"D1 Lab","host":"10.1.1.2"}))
        ))
        .is_err());
    }
    #[test]
    fn camera_configuration_requires_a_valid_baseline_hash_and_bounded_fps() {
        let mut request = api(
            "PUT",
            "/api/v1/camera-config",
            Some(
                serde_json::json!({"version":1,"cameras":{"main":{"enabled":true,"recording_fps":30}}}),
            ),
        );
        assert!(validate_api_request(&request).is_err());
        request.if_match = Some("a".repeat(64));
        assert!(validate_api_request(&request).is_ok());
        request.body = Some(
            serde_json::json!({"version":1,"cameras":{"main":{"recording_fps":121}}}).to_string(),
        );
        assert!(validate_api_request(&request).is_err());
    }
    #[test]
    fn runtime_config_allows_only_evidenced_fields_and_rejects_ota_and_shell() {
        let mut request = api(
            "PUT",
            "/api/v1/runtime-config",
            Some(
                serde_json::json!({"values":{"DOHC_RECORDING_QUEUE_SIZE":"256","DOHC_T265_CAPTURE_MODE":"pose-only"}}),
            ),
        );
        assert!(validate_api_request(&request).is_err());
        request.if_match = Some("a".repeat(64));
        assert!(validate_api_request(&request).is_ok());
        for values in [
            serde_json::json!({"DOHC_OTA_CHANNEL":"stable"}),
            serde_json::json!({"DOHC_RECORDING_QUEUE_SIZE":"4097"}),
            serde_json::json!({"COMMAND":"reboot"}),
            serde_json::json!({"DOHC_RECORDING_QUEUE_SIZE":true}),
        ] {
            request.body = Some(serde_json::json!({"values":values}).to_string());
            assert!(validate_api_request(&request).is_err());
        }
        assert!(validate_api_request(&api("GET", "/api/v1/runtime-config", None)).is_ok());
    }
    #[test]
    fn camera_write_preserves_calibration_and_other_immutable_device_fields() {
        let current = serde_json::json!({"manifest":{"version":1,"cameras":{"main":{"driver":"v4l2","enabled":true,"recording_fps":30,"calibration":{"revision":2}},"t265":{"enabled":true}}}});
        let mut body = current["manifest"].clone();
        body["cameras"]["main"]["recording_fps"] = serde_json::json!(25);
        assert!(camera_baseline_matches(&body, &current));
        body["cameras"]["main"]["calibration"]["revision"] = serde_json::json!(3);
        assert!(!camera_baseline_matches(&body, &current));
        body = current["manifest"].clone();
        body["cameras"].as_object_mut().unwrap().remove("t265");
        assert!(!camera_baseline_matches(&body, &current));
    }
    #[test]
    fn status_snapshot_keeps_observed_fields_and_excludes_credentials_and_personal_data() {
        let raw = serde_json::json!({"schema":"dohc.device.status-summary.v2","device":{"device_id":"fixture","device_name":"PRIVATE_PERSON","password":"PRIVATE_PASSWORD"},"telemetry":{"vcc_voltage":7.2},"storage":{"path":"PRIVATE_PATH"},"alerts":{"items":[{"message":"token=PRIVATE_TOKEN"}]}});
        let filtered = status_fields(&raw);
        let text = serde_json::to_string(&filtered).unwrap();
        assert!(!text.contains("PRIVATE_"));
        assert_eq!(filtered["telemetry"]["vcc_voltage"], 7.2);
    }
    #[test]
    fn lan_page_accepts_routed_private_ip_without_opening_arbitrary_urls() {
        assert_eq!(
            lan_address("10.1.30.114").unwrap(),
            Ipv4Addr::new(10, 1, 30, 114)
        );
        for value in [
            "8.8.8.8",
            "127.0.0.1",
            "169.254.1.2",
            "device.local",
            "10.1.30.114:80",
            "http://10.1.30.114",
            "10.1.30.114/ota/status",
            "10.1.30.114;sh",
            "10.1.30.0",
            "192.168.4.255",
        ] {
            assert!(lan_address(value).is_err());
        }
    }
}
