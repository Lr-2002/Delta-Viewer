import type {DeviceCheck, DeviceResultStatus, HealthSnapshot} from "./d1";

const states: Record<string, string> = {
  OK: "正常", FAILED: "异常", FAULT: "异常", DEGRADED: "需要检查",
  STREAMING: "运行中", RECOVERING: "恢复中", IDLE: "待机", STARTING: "启动中",
  STOPPED: "已停止", DISABLED: "未启用", RECORDING: "采集中", RUNNING: "运行中",
  COMPLETED: "已完成", PASSED: "通过", CANCELLED: "已取消", UNKNOWN: "状态待确认",
  ONLINE:"在线", OFFLINE:"离线", PASS:"通过", FAIL:"未通过", SUCCESS:"成功", FLUSHING:"正在结束采集",
};
const cameras: Record<string, string> = {
  main: "主相机", left: "左相机", right: "右相机", t265: "T265 定位相机",
  stereo_extension: "扩展双目相机",
};
export const deviceStateLabel = (value: string | null) => value ? states[value.toUpperCase()] ?? "未识别状态" : "未提供";
export const cameraLabel = (role: string) => cameras[role] ?? "其他相机";
export const resultOrder: DeviceResultStatus[] = ["abnormal", "indeterminate", "normal", "unsupported", "not_run"];

// Presentation only: original device evidence and exported observations stay intact.
export function deviceText(text: string): string {
  const phrases: [string, string][] = [
    ["Connect approved power or finish the current session before starting another.","请接入设备规定的电源，或完成当前采集后再开始下一次。"],
    ["PHASE_IDLE","设备待机"],
    ["waiting for finite T265 pose data", "等待有效的 T265 位姿数据"],
    ["device could not be opened", "设备无法打开"],
    ["camera heartbeat has not been received", "尚未收到相机心跳"],
    ["camera runtime is starting", "相机服务正在启动"],
    ["no fresh frame", "尚无有效画面"], ["frames are fresh", "画面有效"],
    ["STEREO USB EXTENSION", "扩展双目相机"], ["CAMERA LEFT", "左相机"],
    ["CAMERA RIGHT", "右相机"], ["MAIN CAMERA", "主相机"],
    ["BATTERY_VOLTAGE_WARNING", "电池电压预警"], ["BATTERY_VOLTAGE_LOW", "电池电压偏低"],
    ["CAMERA_RECOVERING", "相机恢复中"], ["CAMERA_FAULT", "相机异常"],
    ["Type-C", "数据线"], ["health=", "健康状态："], ["phase=", "运行阶段："], ["state=", "状态："],
    ["result=", "结果："], ["bytes", "字节"],
  ];
  let translated = text;
  translated=translated.replace(/Device voltage is low at ([\d.]+) V\./g,"设备电压偏低（$1 V）");
  for (const [from, to] of phrases) translated = translated.split(from).join(to);
  translated = translated.replace(/\b[A-Z_]+\b/g, value => states[value] ?? value);
  // Unknown firmware prose must never be guessed or silently treated as normal.
  const prose = translated.replace(/\b(?:DOHC|HTTP|T265|SHA|USB|exfat|ext4|vfat)\b/gi, "");
  return /[a-zA-Z]{3,}/.test(prose) ? "设备返回了补充信息，请展开查看原始记录。" : translated;
}

export function checkLabel(check: DeviceCheck): string {
  return check.id.startsWith("camera:") ? cameraLabel(check.id.slice(7)) : deviceText(check.name);
}

export function checkObservation(check: DeviceCheck, snapshot: HealthSnapshot | null): string {
  if (!snapshot) return deviceText(check.evidence);
  if (check.id.startsWith("camera:")) {
    const camera = snapshot.cameras.find(value => value.role === check.id.slice(7));
    if (!camera) return deviceText(check.evidence);
    if (check.status==="not_run" && snapshot.cameraPortLimited && camera.role==="stereo_extension") return "接口用于连接电脑，本次未检查相机";
    return [camera.enabled === false ? "未启用" : deviceStateLabel(camera.state),
      camera.effectiveFps === null ? null : `${camera.effectiveFps.toFixed(1)} 帧/秒`,
      camera.reason ? deviceText(camera.reason) : null].filter(Boolean).join(" · ");
  }
  if (check.id === "health" && snapshot.connectionLimitedOnly) return "扩展相机受连接方式限制，其余项目见逐项结果";
  if (check.id === "health") return `设备报告${deviceStateLabel(snapshot.health)} · ${deviceStateLabel(snapshot.phase)}`;
  if (check.id === "heartbeat") return snapshot.heartbeatStale === false ? "已取得当前设备状态" : "设备状态时效待确认";
  if (check.id === "storage" && snapshot.storage) {
    const storage = snapshot.storage;
    return [storage.mounted === true ? "已挂载" : storage.mounted === false ? "未挂载" : "挂载状态未提供",
      storage.writable === true ? "可写" : storage.writable === false ? "不可写" : "可写性未提供",
      storage.usageWarning === true ? "容量告警" : null].filter(Boolean).join(" · ");
  }
  return deviceText(check.evidence);
}
