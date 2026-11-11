export type ManagerSection = "home" | "device" | "diagnostics" | "support" | "data";
export const deviceSections: {id: ManagerSection; label: string}[] = [
  {id:"home",label:"首页"},{id:"device",label:"设备信息"},{id:"diagnostics",label:"检测排障"},{id:"support",label:"日志与支持"},
];
export type DeviceConnectionMode = "type_c" | "ap" | "lan";
export interface DevicePage {address:string;html:string;observedAtMs:number;status?:Record<string,unknown>|null;statusError?:string|null}
export interface DevicePageRequest {interfaceId:string;apAddress?:string;connectionMode:"ap"|"lan"}
export interface DevicePageApiRequest {path:string;method:"GET"|"PUT"|"POST";body?:string;ifMatch?:string}
export interface DevicePageApiResponse {status:number;contentType:string;body:string}
export interface WifiNetwork {interfaceId:string;ssid:string;signal:number;connected:boolean;recommended:boolean;connectable:boolean}
export interface WifiSnapshot {supported:boolean;networks:WifiNetwork[];message:string|null;observedAtMs:number}
export type DeviceResultStatus = "normal" | "abnormal" | "indeterminate" | "unsupported" | "not_run";
export const deviceResultLabels: Record<DeviceResultStatus,string> = {normal:"正常",abnormal:"异常",indeterminate:"无法判断",unsupported:"不支持",not_run:"未执行"};
export interface DeviceCheck {
  id:string; name:string; status:DeviceResultStatus; evidence:string; observedAtMs:number|null;
  ruleVersion:string; applicableFirmware:string; suggestion:string; errorKind:string|null;
}
export interface DeviceIdentity {
  id:string; applicationVersion:string|null; releaseId:string|null; firmware:string|null;
  hardwareProfile:string|null; architecture:string|null; channel:string|null;
  source:"device_report"; identityVerified:false;
}
export interface HealthSnapshot {
  statusSummary?:Record<string,unknown>;
  connectionAddress:string|null;
  connectionMode:DeviceConnectionMode|"unknown";cameraPortLimited:boolean;connectionLimitedOnly:boolean;
  observedAtMs:number; httpStatus:number; device:DeviceIdentity; phase:string|null; health:string|null;
  heartbeatStale:boolean|null; voltage:number|null; temperature:number|null;
  cameras:{role:string;name:string|null;state:string|null;enabled:boolean|null;required:boolean|null;fresh:boolean|null;effectiveFps:number|null;reason:string|null}[];
  storage:{mounted:boolean|null;writable:boolean|null;filesystem:string|null;freeBytes:number|null;usageWarning:boolean|null;reason:string|null}|null;
  alerts:{code:string;severity:string|null;component:string|null;message:string|null;action:string|null}[];
  selfTest:{phase:string|null;result:string|null}|null; otaState:string|null;
}
export interface DeviceRun {
  id:string; source:"physical_device"; device:DeviceIdentity|null; observation:HealthSnapshot|null;
  startedAtMs:number; finishedAtMs:number; status:"completed"|"timed_out"|"disconnected"|"cancelled"|"unavailable"; checks:DeviceCheck[];
}
export const deviceTaskLabels: Record<DeviceRun["status"],string> = {completed:"检测完成",timed_out:"检测超时",disconnected:"连接已断开",cancelled:"检测已取消",unavailable:"无法读取设备报告"};
export interface DeviceLinkCandidate {
  interfaceId:string; name:string; description:string; usbId:string|null; wireless:boolean;
  state:"link_down"|"waiting_address"|"address_incomplete"|"identity_unverified";
  localIpv4:string[]; gatewayCandidates:string[]; identityVerified:false;
}
export interface DeviceLinkSnapshot {
  status:"unsupported"|"no_candidates"|"candidates_found"|"unavailable";
  platform:string; observedAtMs:number; candidates:DeviceLinkCandidate[]; error:string|null;
}
export interface DeviceAvailability {
  attemptedAddress:string|null;
  connection:"not_connected"|"connected"|"query_failed"; identity:DeviceIdentity|null; observation:HealthSnapshot|null;
  error:{code:string;message:string}|null; selectedInterfaceId:string|null; realDeviceEnabled:boolean; linkDiscovery:DeviceLinkSnapshot;
  configuration:{diagnosticUpload:{enabled:false;endpoint:null;status:"waiting_interface"};schemaVersion:number;deviceOta:{reservedAddress:string;scheme:null;enabled:false;status:"waiting_interface"};productionOperations:string[]};
}
export interface DeviceBundleRequest {runId:string; fromMs:number; toMs:number}
export interface DeviceBundlePreview extends DeviceBundleRequest {source:"physical_device";files:{name:string;bytes:number;sha256:string}[];planHash:string;filteredMessages:number;privacy:string}
