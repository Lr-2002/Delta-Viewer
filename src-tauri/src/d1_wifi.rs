//! Host Wi-Fi only. No shell, saved-profile reads, device commands or OTA.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub interface_id: String,
    pub ssid: String,
    pub signal: u32,
    pub connected: bool,
    pub recommended: bool,
    pub connectable: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub supported: bool,
    pub networks: Vec<Network>,
    pub message: Option<&'static str>,
    pub observed_at_ms: u64,
}
fn observed_at_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
// Intentionally neither Debug nor Serialize: never echo credentials.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRequest {
    pub interface_id: String,
    pub ssid: String,
    #[serde(default)]
    pub password: String,
}
impl Drop for ConnectRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
pub fn is_device_ssid(ssid: &str) -> bool {
    ssid.strip_prefix("Delta-D1-").is_some_and(|suffix| {
        !suffix.is_empty()
            && ssid.len() <= 32
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}
fn validate(request: &ConnectRequest) -> Result<(), String> {
    if !is_device_ssid(&request.ssid)
        || request
            .interface_id
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .is_none()
    {
        return Err("请选择列表中的 D1 设备热点。".into());
    }
    Ok(())
}
#[cfg(any(windows, test))]
fn profile(request: &ConnectRequest) -> Result<zeroize::Zeroizing<String>, String> {
    validate(request)?;
    // Factory default explicitly supplied by the user. Empty means use it;
    // a manual override stays in memory and is zeroized with the request.
    let password = if request.password.is_empty() {
        "delta-d1"
    } else {
        &request.password
    };
    if !(8..=63).contains(&password.len()) || !password.bytes().all(|b| (32..=126).contains(&b)) {
        return Err("请输入 8–63 位的热点密码。".into());
    }
    let mut key = zeroize::Zeroizing::new(String::new());
    for c in password.chars() {
        match c {
            '&' => key.push_str("&amp;"),
            '<' => key.push_str("&lt;"),
            '>' => key.push_str("&gt;"),
            '\"' => key.push_str("&quot;"),
            '\'' => key.push_str("&apos;"),
            _ => key.push(c),
        }
    }
    let hex: String = request.ssid.bytes().map(|b| format!("{b:02X}")).collect();
    Ok(zeroize::Zeroizing::new(format!(
        r#"<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>{}</name><SSIDConfig><SSID><hex>{hex}</hex></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{}</keyMaterial></sharedKey></security></MSM></WLANProfile>"#,
        request.ssid,
        key.as_str()
    )))
}
pub fn inventory(refresh: bool) -> Result<Snapshot, String> {
    #[cfg(windows)]
    {
        platform::inventory(refresh)
    }
    #[cfg(not(windows))]
    {
        let _ = refresh;
        Ok(Snapshot {
            supported: false,
            networks: vec![],
            message: Some("当前平台请先在系统 Wi-Fi 中连接设备热点。"),
            observed_at_ms: observed_at_ms(),
        })
    }
}
pub fn connect(request: ConnectRequest, cancelled: &AtomicBool) -> Result<Network, String> {
    validate(&request)?;
    if cancelled.load(Ordering::Acquire) {
        return Err("热点连接已取消。".into());
    }
    #[cfg(windows)]
    {
        platform::connect(&request, cancelled)
    }
    #[cfg(not(windows))]
    {
        Err("当前平台请通过系统 Wi-Fi 连接设备热点。".into())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ptr,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::HANDLE,
        NetworkManagement::{
            IpHelper::{ConvertInterfaceGuidToLuid, ConvertInterfaceLuidToIndex},
            Ndis::NET_LUID_LH,
            WiFi::*,
        },
    };
    struct Client(HANDLE);
    impl Drop for Client {
        fn drop(&mut self) {
            unsafe {
                WlanCloseHandle(self.0, ptr::null());
            }
        }
    }
    struct Memory<T>(*mut T);
    impl<T> Drop for Memory<T> {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    WlanFreeMemory(self.0.cast());
                }
            }
        }
    }
    fn checked(code: u32) -> Result<(), String> {
        match code {
            0 => Ok(()),
            5 => Err(
                "无法读取 Wi-Fi。请在 Windows 设置中开启定位权限，并允许桌面应用访问位置。".into(),
            ),
            1062 => Err("Windows WLAN 服务未运行，请先在系统中启用 Wi-Fi。".into()),
            _ => Err("Windows Wi-Fi 暂不可用，请检查无线网卡或在系统中连接。".into()),
        }
    }
    impl Client {
        fn open() -> Result<Self, String> {
            let mut version = 0;
            let mut handle = ptr::null_mut();
            checked(unsafe { WlanOpenHandle(2, ptr::null(), &mut version, &mut handle) })?;
            if handle.is_null() {
                return Err("Windows Wi-Fi 连接不可用。".into());
            }
            Ok(Self(handle))
        }
        fn interfaces(&self) -> Result<Vec<(String, WLAN_INTERFACE_INFO)>, String> {
            let mut raw = ptr::null_mut();
            checked(unsafe { WlanEnumInterfaces(self.0, ptr::null(), &mut raw) })?;
            let memory = Memory(raw);
            if memory.0.is_null() {
                return Ok(vec![]);
            }
            let count = unsafe { (*memory.0).dwNumberOfItems } as usize;
            if count > 32 {
                return Err("无线网卡列表超过限制。".into());
            }
            let entries = unsafe {
                std::slice::from_raw_parts(
                    ptr::addr_of!((*memory.0).InterfaceInfo).cast::<WLAN_INTERFACE_INFO>(),
                    count,
                )
            };
            let mut result = vec![];
            for entry in entries {
                let mut luid: NET_LUID_LH = unsafe { std::mem::zeroed() };
                let mut index = 0;
                if unsafe { ConvertInterfaceGuidToLuid(&entry.InterfaceGuid, &mut luid) } == 0
                    && unsafe { ConvertInterfaceLuidToIndex(&luid, &mut index) } == 0
                {
                    result.push((index.to_string(), *entry));
                }
            }
            Ok(result)
        }
        fn networks(
            &self,
            id: &str,
            interface: &WLAN_INTERFACE_INFO,
        ) -> Result<Vec<Network>, String> {
            let connected_ssid = self.current_ssid(interface);
            let mut raw = ptr::null_mut();
            checked(unsafe {
                WlanGetAvailableNetworkList(
                    self.0,
                    &interface.InterfaceGuid,
                    0,
                    ptr::null(),
                    &mut raw,
                )
            })?;
            let memory = Memory(raw);
            if memory.0.is_null() {
                return Ok(vec![]);
            }
            let count = unsafe { (*memory.0).dwNumberOfItems } as usize;
            if count > 256 {
                return Err("可用 Wi-Fi 数量超过限制。".into());
            }
            let entries = unsafe {
                std::slice::from_raw_parts(
                    ptr::addr_of!((*memory.0).Network).cast::<WLAN_AVAILABLE_NETWORK>(),
                    count,
                )
            };
            Ok(entries
                .iter()
                .filter_map(|entry| {
                    let length = entry.dot11Ssid.uSSIDLength as usize;
                    if !(1..=32).contains(&length) {
                        return None;
                    }
                    let ssid = std::str::from_utf8(&entry.dot11Ssid.ucSSID[..length]).ok()?;
                    if ssid.chars().any(char::is_control) {
                        return None;
                    }
                    let recommended = is_device_ssid(ssid);
                    Some(Network {
                        interface_id: id.into(),
                        ssid: ssid.into(),
                        signal: entry.wlanSignalQuality.min(100),
                        connected: connected_ssid.as_deref() == Some(ssid),
                        recommended,
                        connectable: recommended
                            && entry.bNetworkConnectable != 0
                            && entry.dot11BssType == dot11_BSS_type_infrastructure
                            && entry.bSecurityEnabled != 0
                            && entry.dot11DefaultAuthAlgorithm == DOT11_AUTH_ALGO_RSNA_PSK
                            && entry.dot11DefaultCipherAlgorithm == DOT11_CIPHER_ALGO_CCMP,
                    })
                })
                .collect())
        }
        fn current_ssid(&self, interface: &WLAN_INTERFACE_INFO) -> Option<String> {
            let mut size = 0;
            let mut raw = ptr::null_mut();
            if unsafe {
                WlanQueryInterface(
                    self.0,
                    &interface.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    ptr::null(),
                    &mut size,
                    &mut raw,
                    ptr::null_mut(),
                )
            } != 0
            {
                return None;
            }
            let memory = Memory(raw);
            if memory.0.is_null() || size < std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>() as u32
            {
                return None;
            }
            let attributes = unsafe { &*memory.0.cast::<WLAN_CONNECTION_ATTRIBUTES>() };
            let reported = &attributes.wlanAssociationAttributes.dot11Ssid;
            if attributes.isState != wlan_interface_state_connected
                || !(1..=32).contains(&(reported.uSSIDLength as usize))
            {
                return None;
            }
            let bytes = reported.ucSSID.get(..reported.uSSIDLength as usize)?;
            let ssid = std::str::from_utf8(bytes).ok()?;
            if ssid.chars().any(char::is_control) {
                return None;
            }
            Some(ssid.to_string())
        }
        fn connected(&self, interface: &WLAN_INTERFACE_INFO, ssid: &str) -> bool {
            self.current_ssid(interface).as_deref() == Some(ssid)
        }
    }
    pub(super) fn inventory(refresh: bool) -> Result<Snapshot, String> {
        let client = Client::open()?;
        let interfaces = client.interfaces()?;
        if refresh {
            for (_, interface) in &interfaces {
                checked(unsafe {
                    WlanScan(
                        client.0,
                        &interface.InterfaceGuid,
                        ptr::null(),
                        ptr::null(),
                        ptr::null(),
                    )
                })?;
            }
            if !interfaces.is_empty() {
                std::thread::sleep(Duration::from_millis(1200));
            }
        }
        let mut networks = vec![];
        for (id, interface) in interfaces {
            networks.extend(client.networks(&id, &interface)?);
        }
        networks.sort_by(|a, b| {
            b.recommended
                .cmp(&a.recommended)
                .then(b.connected.cmp(&a.connected))
                .then(b.signal.cmp(&a.signal))
                .then(a.ssid.cmp(&b.ssid))
        });
        networks.dedup_by(|a, b| a.interface_id == b.interface_id && a.ssid == b.ssid);
        Ok(Snapshot {
            supported: true,
            networks,
            message: None,
            observed_at_ms: observed_at_ms(),
        })
    }
    pub(super) fn connect(
        request: &ConnectRequest,
        cancelled: &AtomicBool,
    ) -> Result<Network, String> {
        let client = Client::open()?;
        let (_, interface) = client
            .interfaces()?
            .into_iter()
            .find(|(id, _)| *id == request.interface_id)
            .ok_or("无线网卡已变化，请刷新列表。")?;
        let network = client
            .networks(&request.interface_id, &interface)?
            .into_iter()
            .find(|n| n.ssid == request.ssid && n.recommended && n.connectable)
            .ok_or("该 D1 热点已不可用或加密方式暂不支持，请刷新列表。")?;
        if client.connected(&interface, &request.ssid) {
            return Ok(network);
        }
        let xml = profile(request)?;
        let wide = zeroize::Zeroizing::new(xml.encode_utf16().chain(Some(0)).collect::<Vec<u16>>());
        let parameters = WLAN_CONNECTION_PARAMETERS {
            wlanConnectionMode: wlan_connection_mode_temporary_profile,
            strProfile: wide.as_ptr(),
            pDot11Ssid: ptr::null_mut(),
            pDesiredBssidList: ptr::null_mut(),
            dot11BssType: dot11_BSS_type_infrastructure,
            dwFlags: 0,
        };
        if cancelled.load(Ordering::Acquire) {
            return Err("热点连接已取消。".into());
        }
        // Temporary profile only. Never WlanSetProfile, netsh, or disk XML.
        checked(unsafe {
            WlanConnect(client.0, &interface.InterfaceGuid, &parameters, ptr::null())
        })?;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(20) {
            if cancelled.load(Ordering::Acquire) {
                return Err(
                    "已停止等待连接；Windows 可能仍在完成连接，请查看系统 Wi-Fi 状态。".into(),
                );
            }
            if client.connected(&interface, &request.ssid) {
                return Ok(Network {
                    connected: true,
                    ..network
                });
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err("热点连接未完成。请核对密码、设备 AP 状态及无线信号后重试。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_visible_device_ssids_and_valid_interfaces_can_be_connected() {
        for ssid in [
            "Corp WiFi",
            "Delta-D1-",
            "Delta-D1-x\n",
            "Delta-D1-<script>",
        ] {
            assert!(validate(&ConnectRequest {
                interface_id: "22".into(),
                ssid: ssid.into(),
                password: "fixture-only".into()
            })
            .is_err());
        }
        assert!(validate(&ConnectRequest {
            interface_id: "22;sh".into(),
            ssid: "Delta-D1-aabbccdd".into(),
            password: "fixture-only".into()
        })
        .is_err());
    }
    #[test]
    fn temporary_profile_escapes_credentials_and_rejects_invalid_passwords() {
        let mut request = ConnectRequest {
            interface_id: "22".into(),
            ssid: "Delta-D1-aabbccdd".into(),
            password: "fake<&password".into(),
        };
        let xml = profile(&request).unwrap();
        assert!(xml.contains("fake&lt;&amp;password"));
        assert!(!xml.contains("fake<&password"));
        request.password = "short".into();
        assert_eq!(profile(&request).unwrap_err(), "请输入 8–63 位的热点密码。");
    }
    #[test]
    fn omitted_password_uses_factory_default_but_keeps_manual_override() {
        let mut request: ConnectRequest = serde_json::from_value(serde_json::json!({
            "interfaceId":"22", "ssid":"Delta-D1-test001"
        }))
        .unwrap();
        assert!(profile(&request)
            .unwrap()
            .contains("<keyMaterial>delta-d1</keyMaterial>"));
        assert!(request.password.is_empty());
        request.password = "manual-fixture".into();
        let manual = profile(&request).unwrap();
        assert!(manual.contains("<keyMaterial>manual-fixture</keyMaterial>"));
        assert!(!manual.contains("<keyMaterial>delta-d1</keyMaterial>"));
    }
    #[test]
    fn cancelled_connect_has_no_os_side_effects_or_credential_echo() {
        let request = ConnectRequest {
            interface_id: "22".into(),
            ssid: "Delta-D1-aabbccdd".into(),
            password: "fixture-secret".into(),
        };
        assert_eq!(
            connect(request, &AtomicBool::new(true)).unwrap_err(),
            "热点连接已取消。"
        );
    }
}
