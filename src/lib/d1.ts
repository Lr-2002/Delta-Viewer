export type ManagerSection = "home" | "device" | "diagnostics" | "support" | "data";
export const managerSections: {id: ManagerSection; label: string}[] = [
  {id:"home",label:"首页"},{id:"device",label:"设备管理"},{id:"diagnostics",label:"检测排障"},{id:"support",label:"日志与支持"},{id:"data",label:"数据工作区"},
];
export type DeviceScenario = "success" | "partial" | "failure" | "offline" | "timeout" | "disconnect" | "parse_failure";
export const deviceScenarios: {id: DeviceScenario; label:string}[] = [
  {id:"success",label:"整体正常"},{id:"partial",label:"部分能力不支持"},{id:"failure",label:"单项异常"},{id:"offline",label:"设备离线"},
  {id:"timeout",label:"响应超时"},{id:"disconnect",label:"检测中断连"},{id:"parse_failure",label:"响应无法解析"},
];
export type DeviceResultStatus = "normal" | "abnormal" | "indeterminate" | "unsupported" | "not_run";
export const deviceResultLabels: Record<DeviceResultStatus,string> = {normal:"正常",abnormal:"异常",indeterminate:"无法判断",unsupported:"不支持",not_run:"未执行"};
export interface DeviceCheck {
  id:string; name:string; status:DeviceResultStatus; evidence:string; observedAtMs:number|null;
  ruleVersion:string; applicableFirmware:string; suggestion:string; errorKind:string|null;
}
export interface DeviceIdentity {id:string; model:string; firmware:string; source:"simulated"; capabilities:string[]}
export interface DeviceRun {
  id:string; source:"simulated"; device:DeviceIdentity; scenario:DeviceScenario; startedAtMs:number; finishedAtMs:number;
  status:"completed"|"timed_out"|"disconnected"|"cancelled"; checks:DeviceCheck[];
}
export const deviceTaskLabels: Record<DeviceRun["status"],string> = {completed:"检测完成",timed_out:"检测超时",disconnected:"连接已断开",cancelled:"检测已取消"};
export interface DeviceAvailability {connection:"not_connected"; identity:null; realDeviceEnabled:false; configuration:{schemaVersion:number; deviceOta:{reservedAddress:string; scheme:null; enabled:false; status:"waiting_interface"}; productionOperations:never[]}}
export interface DeviceBundleRequest {runId:string; fromMs:number; toMs:number}
export interface DeviceBundlePreview extends DeviceBundleRequest {source:"simulated"; files:{name:string;bytes:number;sha256:string}[]; planHash:string; filteredMessages:number; privacy:string}
