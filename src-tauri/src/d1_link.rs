//! Passive host-side USB inventory and a constrained Windows USB DHCP renewal.
//! No shell, DNS, static address changes or device commands.
use serde::Serialize;
use std::net::Ipv4Addr;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSnapshot {
    pub status: &'static str,
    pub platform: &'static str,
    pub observed_at_ms: u64,
    pub candidates: Vec<LinkCandidate>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCandidate {
    pub interface_id: String,
    pub name: String,
    pub description: String,
    pub usb_id: Option<String>,
    // OS interface type only; not proof of SSID, pairing or D1 identity.
    pub wireless: bool,
    pub state: &'static str,
    pub local_ipv4: Vec<String>,
    pub gateway_candidates: Vec<String>,
    // USB IDs, interface descriptions and DHCP gateways never authenticate a D1.
    pub identity_verified: bool,
}

fn candidate(
    id: String,
    name: String,
    description: String,
    usb_id: Option<String>,
    up: bool,
    addresses: Vec<(Ipv4Addr, u8)>,
    gateways: Vec<Ipv4Addr>,
) -> LinkCandidate {
    let valid = |ip: &Ipv4Addr| {
        !ip.is_unspecified() && !ip.is_loopback() && !ip.is_multicast() && !ip.is_broadcast()
    };
    let mut addresses: Vec<_> = addresses
        .into_iter()
        .filter(|(ip, prefix)| valid(ip) && *prefix <= 32)
        .collect();
    addresses.sort();
    addresses.dedup();
    let usable: Vec<_> = addresses
        .iter()
        .filter(|(ip, _)| !ip.is_link_local())
        .collect();
    let mut peers: Vec<_> = gateways
        .into_iter()
        .filter(|ip| {
            valid(ip)
                && !ip.is_link_local()
                && usable.iter().any(|(local, prefix)| {
                    let mask = if *prefix == 0 {
                        0
                    } else {
                        u32::MAX << (32 - prefix)
                    };
                    // A /0 route is not evidence of a directly attached peer.
                    *prefix > 0 && local != ip && u32::from(*local) & mask == u32::from(*ip) & mask
                })
        })
        .collect();
    peers.sort();
    peers.dedup();
    LinkCandidate {
        interface_id: id,
        name,
        description,
        usb_id,
        wireless: false,
        state: if !up {
            "link_down"
        } else if usable.is_empty() {
            "waiting_address"
        } else if peers.is_empty() {
            "address_incomplete"
        } else {
            "identity_unverified"
        },
        local_ipv4: addresses
            .iter()
            .map(|(ip, prefix)| format!("{ip}/{prefix}"))
            .collect(),
        gateway_candidates: if up {
            peers.iter().map(ToString::to_string).collect()
        } else {
            vec![]
        },
        identity_verified: false,
    }
}

pub fn snapshot() -> LinkSnapshot {
    snapshot_for(false)
}

#[cfg(any(target_os = "windows", test))]
fn renewal_eligible(link: &LinkCandidate, dhcp_enabled: bool) -> bool {
    let description = link.description.to_ascii_lowercase();
    let name = link.name.to_ascii_lowercase();
    dhcp_enabled
        && !link.wireless
        && link.state == "waiting_address"
        && (description.contains("rndis")
            || description.contains("remote ndis")
            || name.contains("rndis")
            || name.contains("remote ndis"))
}

pub fn renew_usb_address(
    interface_id: &str,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err("USB 地址恢复已取消。".into());
    }
    #[cfg(target_os = "windows")]
    return platform::renew_usb_address(interface_id, cancelled);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = interface_id;
        Err("此系统暂不支持 USB 网络地址自动恢复。".into())
    }
}

pub fn snapshot_for(lan: bool) -> LinkSnapshot {
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = lan;
    let mut value = LinkSnapshot {
        status: "unsupported",
        platform: std::env::consts::OS,
        observed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        candidates: vec![],
        error: None,
    };
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    match platform::inventory(lan) {
        Ok(candidates) => {
            value.status = if candidates.is_empty() {
                "no_candidates"
            } else {
                "candidates_found"
            };
            value.candidates = candidates;
        }
        Err(error) => {
            value.status = "unavailable";
            value.error = Some(error);
        }
    }
    value
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::CStr;
    use std::fs::{self, File};
    use std::io::Read;
    use std::path::Path;

    fn read_small(path: &Path, limit: u64) -> Result<String, String> {
        let mut text = String::new();
        File::open(path)
            .and_then(|file| file.take(limit + 1).read_to_string(&mut text))
            .map_err(|error| format!("D1_LINK_READ_FAILED: {error}"))?;
        if text.len() as u64 > limit {
            return Err("D1_LINK_INVENTORY_LIMIT".into());
        }
        Ok(text)
    }

    fn addresses() -> Result<BTreeMap<String, Vec<(Ipv4Addr, u8)>>, String> {
        let mut head = std::ptr::null_mut();
        // getifaddrs reads OS interface configuration; it does not send packets.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Err(format!(
                "D1_LINK_ADDRESS_QUERY_FAILED: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut result = BTreeMap::<String, Vec<(Ipv4Addr, u8)>>::new();
        let mut cursor = head;
        while !cursor.is_null() {
            // The OS owns these linked entries until freeifaddrs(head).
            let entry = unsafe { &*cursor };
            if !entry.ifa_name.is_null()
                && !entry.ifa_addr.is_null()
                && !entry.ifa_netmask.is_null()
                && unsafe { (*entry.ifa_addr).sa_family as i32 == libc::AF_INET }
            {
                let name = unsafe { CStr::from_ptr(entry.ifa_name) }
                    .to_string_lossy()
                    .into_owned();
                let addr = unsafe { &*entry.ifa_addr.cast::<libc::sockaddr_in>() };
                let mask = unsafe { &*entry.ifa_netmask.cast::<libc::sockaddr_in>() };
                let ip = Ipv4Addr::from(addr.sin_addr.s_addr.to_ne_bytes());
                let prefix = mask.sin_addr.s_addr.count_ones() as u8;
                result.entry(name).or_default().push((ip, prefix));
            }
            cursor = entry.ifa_next;
        }
        unsafe { libc::freeifaddrs(head) };
        Ok(result)
    }

    pub(super) fn route_gateways(text: &str, name: &str) -> Vec<Ipv4Addr> {
        text.lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() < 4 || fields[0] != name || fields[1] != "00000000" {
                    return None;
                }
                let flags = u32::from_str_radix(fields[3], 16).ok()?;
                if flags & 3 != 3 {
                    return None;
                }
                let value = u32::from_str_radix(fields[2], 16).ok()?;
                Some(Ipv4Addr::from(value.to_ne_bytes()))
            })
            .collect()
    }

    pub fn inventory(lan: bool) -> Result<Vec<LinkCandidate>, String> {
        let entries = fs::read_dir("/sys/class/net")
            .map_err(|error| format!("D1_LINK_INVENTORY_UNAVAILABLE: {error}"))?;
        let addresses = addresses()?;
        let routes = read_small(Path::new("/proc/net/route"), 1024 * 1024)?;
        let mut result = vec![];
        for entry in entries.take(256) {
            let entry = entry.map_err(|error| format!("D1_LINK_READ_FAILED: {error}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(device) = fs::canonicalize(entry.path().join("device")) else {
                continue;
            };
            if lan {
                let up = read_small(&entry.path().join("carrier"), 128)
                    .is_ok_and(|text| text.trim() == "1");
                if up {
                    let mut link = candidate(
                        name.clone(),
                        name.clone(),
                        "本机局域网网卡".into(),
                        None,
                        up,
                        addresses.get(&name).cloned().unwrap_or_default(),
                        route_gateways(&routes, &name),
                    );
                    link.wireless = entry.path().join("wireless").is_dir();
                    result.push(link);
                }
                continue;
            }
            let Some(usb) = device
                .ancestors()
                .find(|path| path.join("idVendor").is_file() && path.join("idProduct").is_file())
            else {
                continue;
            };
            let vendor = read_small(&usb.join("idVendor"), 128)?;
            let product = read_small(&usb.join("idProduct"), 128)?;
            let driver = fs::read_link(device.join("driver")).ok().and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            });
            // Observed on the user's D1 on 2026-11-09. This recognizes a link,
            // never a device identity; the same USB IDs may be shared by other boards.
            if vendor.trim() != "2207"
                || product.trim() != "0003"
                || driver.as_deref() != Some("rndis_host")
            {
                continue;
            }
            let up =
                read_small(&entry.path().join("carrier"), 128).is_ok_and(|text| text.trim() == "1");
            result.push(candidate(
                name.clone(),
                name.clone(),
                "Rockchip USB / RNDIS".into(),
                Some("2207:0003".into()),
                up,
                addresses.get(&name).cloned().unwrap_or_default(),
                route_gateways(&routes, &name),
            ));
        }
        result.sort_by(|a, b| a.interface_id.cmp(&b.interface_id));
        Ok(result)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GetInterfaceInfo, IpRenewAddress, GAA_FLAG_INCLUDE_GATEWAYS,
        IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_DHCP_ENABLED, IP_ADAPTER_INDEX_MAP, IP_INTERFACE_INFO,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN, SOCKET_ADDRESS};

    // GetAdaptersAddresses allocates all strings/list nodes inside its caller buffer.
    // Bound every traversal and pointer read to that buffer before dereferencing.
    struct Buffer(Vec<u64>);
    impl Buffer {
        fn contains<T>(&self, ptr: *const T) -> bool {
            let start = self.0.as_ptr() as usize;
            let end = start + self.0.len() * 8;
            let address = ptr as usize;
            address >= start
                && address.is_multiple_of(std::mem::align_of::<T>())
                && address
                    .checked_add(std::mem::size_of::<T>())
                    .is_some_and(|last| last <= end)
        }
        fn get<T>(&self, ptr: *const T) -> Option<&T> {
            self.contains(ptr).then(|| unsafe { &*ptr })
        }
        fn text(&self, ptr: *const u16) -> String {
            let mut text = vec![];
            for index in 0..512 {
                let Some(value) = self.get(ptr.wrapping_add(index)) else {
                    break;
                };
                if *value == 0 {
                    break;
                }
                text.push(*value);
            }
            String::from_utf16_lossy(&text)
        }
        fn ipv4(&self, address: &SOCKET_ADDRESS) -> Option<Ipv4Addr> {
            if address.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN>() as i32 {
                return None;
            }
            let address = self.get(address.lpSockaddr.cast::<SOCKADDR_IN>())?;
            if address.sin_family != AF_INET {
                return None;
            }
            Some(Ipv4Addr::from(unsafe {
                address.sin_addr.S_un.S_addr.to_ne_bytes()
            }))
        }
    }

    pub fn inventory(lan: bool) -> Result<Vec<LinkCandidate>, String> {
        Ok(enumerate(lan)?.into_iter().map(|(link, _)| link).collect())
    }

    fn enumerate(lan: bool) -> Result<Vec<(LinkCandidate, bool)>, String> {
        let mut size = 16 * 1024;
        for _ in 0..3 {
            if size > 1024 * 1024 {
                return Err("D1_LINK_INVENTORY_LIMIT".into());
            }
            let mut buffer = Buffer(vec![0; (size as usize).div_ceil(8)]);
            let head = buffer.0.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
            // Native read-only inventory API. Do NOT use SendARP or open sockets.
            let status = unsafe {
                GetAdaptersAddresses(
                    AF_INET as u32,
                    GAA_FLAG_INCLUDE_GATEWAYS,
                    std::ptr::null(),
                    head,
                    &mut size,
                )
            };
            if status == 111 {
                continue; // ERROR_BUFFER_OVERFLOW: retry with OS-requested capacity.
            }
            if status == 232 {
                return Ok(vec![]); // ERROR_NO_DATA: no adapters configured.
            }
            if status != 0 {
                return Err(format!("D1_LINK_INVENTORY_UNAVAILABLE: Windows {status}"));
            }
            let mut result = vec![];
            let mut cursor = head;
            for _ in 0..256 {
                if cursor.is_null() {
                    break;
                }
                let adapter = buffer.get(cursor).ok_or("D1_LINK_INVENTORY_INVALID")?;
                let description = buffer.text(adapter.Description);
                let name = buffer.text(adapter.FriendlyName);
                let lower = format!("{description} {name}").to_ascii_lowercase();
                if (lan && [6, 71].contains(&adapter.IfType) && adapter.OperStatus == 1)
                    || (!lan && (lower.contains("rndis") || lower.contains("remote ndis")))
                {
                    let mut addresses = vec![];
                    let mut address = adapter.FirstUnicastAddress;
                    for _ in 0..64 {
                        let Some(value) = buffer.get(address) else {
                            break;
                        };
                        if let Some(ip) = buffer.ipv4(&value.Address) {
                            addresses.push((ip, value.OnLinkPrefixLength));
                        }
                        address = value.Next;
                    }
                    let mut gateways = vec![];
                    let mut gateway = adapter.FirstGatewayAddress;
                    for _ in 0..64 {
                        let Some(value) = buffer.get(gateway) else {
                            break;
                        };
                        if let Some(ip) = buffer.ipv4(&value.Address) {
                            gateways.push(ip);
                        }
                        gateway = value.Next;
                    }
                    let index = unsafe { adapter.Anonymous1.Anonymous.IfIndex };
                    let mut link = candidate(
                        index.to_string(),
                        name,
                        description,
                        None, // RNDIS description is not USB VID/PID or authenticated D1.
                        adapter.OperStatus == 1,
                        addresses,
                        gateways,
                    );
                    link.wireless = adapter.IfType == 71;
                    let dhcp_enabled =
                        unsafe { adapter.Anonymous2.Flags } & IP_ADAPTER_DHCP_ENABLED != 0;
                    result.push((link, dhcp_enabled));
                }
                cursor = adapter.Next;
            }
            return Ok(result);
        }
        Err("D1_LINK_INVENTORY_CHANGED: 请稍后重试".into())
    }

    pub fn renew_usb_address(
        interface_id: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        use std::sync::{Mutex, OnceLock};
        use std::time::{Duration, Instant};
        let index: u32 = interface_id.parse().map_err(|_| "USB 网卡标识无效。")?;
        let eligible = || -> Result<bool, String> {
            Ok(enumerate(false)?.iter().any(|(link, dhcp)| {
                link.interface_id == interface_id && renewal_eligible(link, *dhcp)
            }))
        };
        if index == 0 || !eligible()? {
            return Err("当前 USB 网卡不需要或不支持地址恢复。".into());
        }
        static ATTEMPTS: OnceLock<Mutex<std::collections::HashMap<u32, Instant>>> = OnceLock::new();
        {
            let mut attempts = ATTEMPTS
                .get_or_init(Default::default)
                .lock()
                .map_err(|_| "USB 地址恢复暂不可用。")?;
            attempts.retain(|_, at| at.elapsed() < Duration::from_secs(30));
            if attempts.contains_key(&index) {
                return Err("USB 地址恢复正在等待，请稍后重试。".into());
            }
            attempts.insert(index, Instant::now());
        }
        let mut size = 16 * 1024;
        for _ in 0..3 {
            if size > 1024 * 1024 {
                break;
            }
            let mut buffer = Buffer(vec![0; (size as usize).div_ceil(8)]);
            let head = buffer.0.as_mut_ptr().cast::<IP_INTERFACE_INFO>();
            let status = unsafe { GetInterfaceInfo(head, &mut size) };
            if status == 122 {
                continue;
            }
            if status != 0 {
                return Err("无法读取 USB 网络接口。".into());
            }
            let info = buffer.get(head).ok_or("USB 网络接口信息无效。")?;
            if !(0..=256).contains(&info.NumAdapters) {
                break;
            }
            for offset in 0..info.NumAdapters as usize {
                let address = unsafe {
                    std::ptr::addr_of!((*head).Adapter)
                        .cast::<IP_ADAPTER_INDEX_MAP>()
                        .add(offset)
                };
                let adapter = buffer.get(address).ok_or("USB 网络接口信息无效。")?;
                if adapter.Index != index {
                    continue;
                }
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return Err("USB 地址恢复已取消。".into());
                }
                // Revalidate immediately before the one allowed native operation.
                if !eligible()? {
                    return Ok(());
                }
                let status = unsafe { IpRenewAddress(adapter) };
                return match status {
                    0 => Ok(()),
                    5 => Err("电脑未允许 USB 网络地址恢复，请重新插拔数据线后重试。".into()),
                    _ => Err("USB 网络暂未取得地址，请确认设备开机并重新插拔数据线。".into()),
                };
            }
            break;
        }
        Err("USB 网卡已变化，请重新连接。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link(up: bool, addresses: &[&str], gateways: &[&str]) -> LinkCandidate {
        candidate(
            "usb-fixture".into(),
            "USB fixture".into(),
            "RNDIS fixture".into(),
            Some("2207:0003".into()),
            up,
            addresses
                .iter()
                .map(|ip| (ip.parse().unwrap(), 24))
                .collect(),
            gateways.iter().map(|ip| ip.parse().unwrap()).collect(),
        )
    }
    #[test]
    fn gateways_are_candidates_not_device_identity() {
        let value = link(true, &["192.168.188.92"], &["192.168.188.1", "10.1.40.1"]);
        assert_eq!(value.state, "identity_unverified");
        assert_eq!(value.gateway_candidates, ["192.168.188.1"]);
        assert!(!value.identity_verified);
    }
    #[test]
    fn missing_dhcp_link_down_and_multiple_links_are_not_connected_devices() {
        assert_eq!(link(true, &[], &[]).state, "waiting_address");
        assert_eq!(link(true, &["169.254.1.2"], &[]).state, "waiting_address");
        assert_eq!(
            link(true, &["192.168.1.3"], &[]).state,
            "address_incomplete"
        );
        let down = link(false, &["192.168.1.3"], &["192.168.1.1"]);
        assert_eq!(down.state, "link_down");
        assert!(down.gateway_candidates.is_empty());
        let links = [
            link(true, &["192.168.1.3"], &["192.168.1.1"]),
            link(true, &["192.168.2.3"], &["192.168.2.1"]),
        ];
        assert!(links.iter().all(|link| !link.identity_verified));
        assert_ne!(links[0].gateway_candidates, links[1].gateway_candidates);
    }
    #[test]
    fn renewal_is_only_for_unaddressed_dhcp_usb_not_static_wifi_or_ready_links() {
        let waiting = link(true, &["169.254.9.83"], &[]);
        assert!(renewal_eligible(&waiting, true));
        assert!(!renewal_eligible(&waiting, false));
        assert!(!renewal_eligible(&link(false, &[], &[]), true));
        assert!(!renewal_eligible(
            &link(true, &["192.168.188.98"], &["192.168.188.1"]),
            true
        ));
        let mut other = link(true, &[], &[]);
        other.wireless = true;
        assert!(!renewal_eligible(&other, true));
        other.wireless = false;
        other.description = "Ethernet".into();
        assert!(!renewal_eligible(&other, true));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn only_this_interfaces_active_default_gateway_is_used() {
        let hex = u32::from_ne_bytes([192, 168, 188, 1]);
        let routes = format!(
            "Iface Destination Gateway Flags\nusb0 00000000 {hex:08X} 0003\n\
             eth0 00000000 01010101 0003\nusb0 00000000 01010101 0001\n\
             usb0 0001A8C0 01010101 0003\nusb0 broken x y\n"
        );
        assert_eq!(
            platform::route_gateways(&routes, "usb0"),
            [Ipv4Addr::new(192, 168, 188, 1)]
        );
    }
}
