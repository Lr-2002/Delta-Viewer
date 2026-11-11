import type {DeviceLinkCandidate, DeviceLinkSnapshot} from "../lib/d1";

const states:Record<DeviceLinkCandidate["state"],string>={
  link_down:"连接已断开",waiting_address:"等待分配地址",
  address_incomplete:"已获取本机地址",identity_unverified:"USB 网络已连接",
};
export function linkSummary(snapshot:DeviceLinkSnapshot|null):string {
  if(!snapshot)return "正在读取连接状态";
  if(snapshot.status==="unavailable")return "无法读取连接状态";
  if(snapshot.status==="unsupported")return snapshot.platform==="browser"?"请在桌面客户端查看":"此系统暂不支持自动发现";
  if(snapshot.status==="no_candidates")return "未发现 USB 网络设备";
  return snapshot.candidates.length===1?states[snapshot.candidates[0].state]:`发现 ${snapshot.candidates.length} 条 USB 网络连接`;
}
