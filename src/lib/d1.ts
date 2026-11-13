export type ManagerSection = "home" | "device" | "diagnostics" | "support" | "data";
export const deviceSections: {id: ManagerSection; label: string}[] = [
  {id:"home",label:"首页"},{id:"device",label:"设备信息"},{id:"diagnostics",label:"检测排障"},{id:"support",label:"日志与支持"},
];
export type DeviceConnectionMode = "type_c" | "ap" | "lan";
export interface DevicePage {address:string;html:string;observedAtMs:number;status?:Record<string,unknown>|null;statusError?:string|null}
export interface DeviceUpgradeRequest {interfaceId:string;apAddress?:string;connectionMode:DeviceConnectionMode}
export interface DevicePageRequest extends DeviceUpgradeRequest {connectionMode:"ap"|"lan"}
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
  configuration:{diagnosticUpload:{enabled:boolean;endpoint:string|null;status:string;origin?:string|null};schemaVersion:number;deviceOta:{origin?:string|null;channel?:string|null;reservedAddress?:string;scheme:string|null;enabled:boolean;status:string;trustRoot?:{keyId:string|null;publicKeyPem:string|null}};productionOperations:string[]};
}

export type TrustStatus = "configured" | "digest_only";
export interface OtaServiceStatus {
  enabled:boolean; origin:string|null; channel:string|null; trust:TrustStatus;
  trustKeyId:string|null; detail:string;
}
export interface OtaFileDescriptor { name:string; path:string; size:number; sha256:string|null }
export interface OtaPreview {
  previewId:string; releaseId:string; version:string; channel:string; keyId:string|null; rollbackIndex:number|null;
  artifactBytes:number; totalBytes:number; files:OtaFileDescriptor[]; trust:TrustStatus;
}
export interface OtaSubmitResult {
  releaseId:string; version:string; operationId:string|null; deviceState:string|null; message:string;
}
export interface DeviceOtaStatus {
  available:boolean; state:string|null; result:string|null; operationId:string|null;
  releaseBefore:string|null; releaseTarget:string|null; targetVersion:string|null;
  active:boolean; finalState:boolean; guidance:string|null; detail:string;
  failureCodes:string[]; reason:string|null; previousResult:boolean;
  transport?:"ssh";deviceId?:string;cid?:string;logError?:string|null;currentVersion?:string|null;currentReleaseId?:string|null;
}
export interface OtaLogRecord {
  id:string;deviceId:string|null;cid:string|null;operationId:string|null;
  releaseBefore:string|null;releaseTarget:string|null;targetVersion:string|null;
  state:string;result:string|null;startedAtMs:number;updatedAtMs:number;
  events:{atMs:number;level:string;message:string}[];truncated:boolean;receipt:LogUploadReceipt|null;
}
export interface DiagnosticServiceStatus { enabled:boolean; origin:string|null; detail:string }
export interface LogLevelCounts { error:number; warning:number; info:number; debug:number }
export interface LogPreview {
  previewId:string; reportType:string; checkCount:number;
  source:string; deviceId:string|null; hasCid:boolean; workspaceVersion:string|null; releaseId:string|null;
  totalEntries:number; selectedEntries:number; levels:LogLevelCounts;
  startedAt:string|null; completedAt:string|null; truncated:boolean; fileCount:number;
}
export interface LogUploadReceipt { reportId:string; deviceId:string; entryCount:number; message:string }
export const otaStateLabels:Record<string,string> = {
  IDLE:"设备就绪", QUEUED:"排队中", PRECHECK:"预检中", FETCH_INDEX:"读取索引", DOWNLOAD:"下载中",
  VERIFY:"校验中", STAGE:"暂存中", PRE_ACTIVATION:"准备激活", ACTIVATE:"正在激活", HEALTH_WINDOW:"健康观察",
  CONVERGENCE:"收敛检查", ROLLBACK:"回滚中", SUCCESS:"升级成功", FAILED:"升级失败", ROLLBACK_FAILED:"回滚失败",
  UP_TO_DATE:"已是最新", UNKNOWN:"结果待确认", STAGING:"SSH 文件传输中",
};
export interface DeviceBundleRequest {runId:string; fromMs:number; toMs:number}
export interface DeviceBundlePreview extends DeviceBundleRequest {source:"physical_device";files:{name:string;bytes:number;sha256:string}[];planHash:string;filteredMessages:number;privacy:string}
