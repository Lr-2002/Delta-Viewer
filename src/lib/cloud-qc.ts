import { cloudQcInvoke } from "./backend";
import { chooseCloudQcConfig } from "./backend";

export interface CloudTask {
  recording_id: string; path: string; kind: "sample" | "full"; assignee: string | null;
  qc: { decision: string; reason: string | null }; claim_version: number;
}
export interface CloudPlan {
  id: string; job_id: string; company_id: string; external_order_id: string; source_revision: string;
  batch_path: string; created_at?: string; version: number; state: string; sample_count: number; population_count: number;
  sample_approved: number; sample_rejected: number; full_review: boolean; tasks: CloudTask[];
  audit?: { actor: string; action: string; reason: string; occurred_at: string }[];
}
export interface CloudPolicy {
  enabled: boolean; sample_percent: number; batch_scope: "sealed_order" | "recording_parent";
  rounding: "ceil_min_one"; release_mode: "batch_on_sample_pass" | "sampled_only";
  failure_action: "hold" | "full_review";
}
export const cloudQcCall = <T,>(action: string, payload: unknown = {}) => cloudQcInvoke<T>("cloud_qc_call", { action, payload });
export async function configureCloudQc() {
  const configPath = await chooseCloudQcConfig();
  if (!configPath) return false;
  await cloudQcInvoke("cloud_qc_configure", { configPath });
  return true;
}
export const fetchCloudQc = (jobId: string, recordingId: string, operationId: number) => cloudQcInvoke<string>("cloud_qc_fetch", { jobId, recordingId, operationId });
export const cancelCloudQc = (operationId: number) => cloudQcInvoke("cancel_task", { operationId });
const syncing = new Map<string, Promise<{ synchronized: boolean }>>();
export function syncCloudQc(directory: string) {
  const existing = syncing.get(directory);
  if (existing) return existing;
  const operation = cloudQcInvoke<{ synchronized: boolean }>("cloud_qc_sync", { directory }).then(result => {
    if (result.synchronized) window.dispatchEvent(new CustomEvent("cloud-qc-synchronized", { detail: directory }));
    return result;
  });
  syncing.set(directory, operation);
  void operation.finally(() => { if (syncing.get(directory) === operation) syncing.delete(directory); }).catch(() => {});
  return operation;
}

export interface CloudAccess { cloud: boolean; canEdit: boolean; claimable: boolean; assignee?: string | null; reason?: string; }
export const cloudQcAccess = (directory: string, claim = false) => cloudQcInvoke<CloudAccess>("cloud_qc_access", { directory, claim });
export function cloudQcError(error: unknown): string {
  const raw = String(error);
  if (raw.includes("CLOUD_QC_DOWNLOAD_CLIENT_FAILED")) return "本机无法建立云端下载连接，请重试或联系支持；任务领取状态与本机记录保留。";
  if (raw.includes("CLOUD_QC_MANAGER_CONFIG_FAILED")) return `Manager 本机读取用户中心配置失败，尚未请求用户中心或交付端：${raw}`;
  if (raw.includes("CLOUD_QC_MANAGER_TLS_FAILED")) return `Manager 本机建立安全连接失败，尚未请求交付端：${raw}`;
  if (raw.includes("CLOUD_QC_MANAGER_ENDPOINT_FAILED")) return `Manager 本机解析用户中心地址失败：${raw}`;
  if (raw.includes("CLOUD_QC_USER_CENTER_UNREACHABLE")) return `Manager 无法连接用户中心；请求尚未到达交付端：${raw}`;
  if (raw.includes("CLOUD_QC_USER_CENTER_REJECTED: AUTH_REQUIRED")) return "用户中心登录会话已失效，请重新登录后再刷新云端 QC。";
  if (raw.includes("CLOUD_QC_USER_CENTER_REJECTED: CLOUD_QC_NOT_CONFIGURED")) return "用户中心服务尚未启用云端 QC 桥接，交付端没有收到请求。";
  if (raw.includes("CLOUD_QC_USER_CENTER_REJECTED")) return `用户中心的云端 QC 连接接口拒绝了请求：${raw}`;
  if (raw.includes("CLOUD_QC_USER_CENTER_RESPONSE_INVALID")) return "用户中心的云端 QC 连接响应格式无效，请检查用户中心服务版本。";
  if (raw.includes("CLOUD_QC_USER_CENTER_PROXY_UNREACHABLE")) return `Manager 无法连接用户中心的 QC 代理，请求尚未到达交付端：${raw}`;
  if (raw.includes("CLOUD_QC_PROXY_RESPONSE_INTERRUPTED")) return `用户中心 QC 代理响应中断：${raw}`;
  if (raw.includes("CLOUD_QC_PROXY_RESPONSE_INVALID")) return `用户中心 QC 代理返回了无效响应：${raw}`;
  if (/CLOUD_QC_PROXY_REJECTED:(AUTH_REQUIRED|UNAUTHENTICATED|UNAUTHORIZED)/.test(raw)) return "用户中心登录会话已失效，请重新登录后再刷新云端 QC。";
  if (raw.includes("CLOUD_QC_PROXY_REJECTED:CLOUD_QC_BRIDGE_BUSY")) return "用户中心 QC 代理正忙，请稍后重试。";
  if (raw.includes("CLOUD_QC_PROXY_REJECTED:CLOUD_QC_BRIDGE_CONFIGURATION_INVALID")) return "用户中心 QC 代理配置无效，交付端尚未收到请求，请联系管理员检查桥接配置。";
  if (raw.includes("CLOUD_QC_PROXY_REJECTED:CLOUD_QC_NETWORK_UNAVAILABLE")) return `用户中心代理已接收请求，但连接交付 QC 失败：${raw}`;
  if (raw.includes("CLOUD_QC_PROXY_REJECTED:CLOUD_QC_NOT_CONFIGURED")) return `用户中心没有配置交付 QC 桥接：${raw}`;
  if (raw.includes("CLOUD_QC_PROXY_REJECTED")) return `用户中心 QC 代理拒绝了交付请求：${raw}`;
  if (/CLOUD_QC_NOT_CONFIGURED|NOT_FOUND/.test(raw)) return "管理员尚未开通云端任务连接，请联系管理员；无需单独绑定审核账号。";
  if (raw.includes("QC_TASK_NOT_CLAIMED")) return "任务尚未领取，云端未接收；请领取后补传，本机结论保持不变。";
  if (raw.includes("SESSION_IDENTITY_CHANGED")) return "云端校验会话信息不一致，尚未接收；本机原提交保留，请联系管理员核对。";
  if (raw.includes("REVIEWER_MISMATCH")) return "审核人信息与云端身份不一致，尚未接收；本机原提交保留，请联系管理员核对。";
  if (raw.includes("CLOUD_QC_NETWORK_UNAVAILABLE")) return "暂时无法连接云端，本机记录保留，网络恢复后会重试。";
  if (/ACCOUNT_MISMATCH|ACCOUNT_CHANGED|TOKEN_INVALID|UNAUTHENTICATED|UNAUTHORIZED|AUTH_REQUIRED/.test(raw)) return "登录已失效或账号信息发生变化，请重新登录；本机记录保留。";
  return `云端尚未确认，原因：${raw}`;
}

export const pendingCloudQc = () => cloudQcInvoke<{ items: { directory: string }[] }>("cloud_qc_pending");

export interface CloudOperationHandle { id: number; finish: () => void; }

export function cloudBatchName(plan: CloudPlan): string {
  if (plan.batch_path?.trim()) return plan.batch_path;
  const paths = plan.tasks.map(task => task.path.split("/").slice(0, -1));
  // Only a continuous shared prefix describes a real parent directory.
  let length = 0;
  while (length < (paths[0]?.length ?? 0) && paths.every(path => path[length] === paths[0][length])) length++;
  return paths[0]?.slice(0, length).join("/") || "采集批次";
}
export const cloudBatchNumber = (plan: CloudPlan) => plan.job_id.slice(0, 8);
export function cloudWorkspaceNumber(root: string): string | null {
  return root.replaceAll("\\", "/").match(/\/cloud-qc\/data\/[^/]+\/[^/]+\/([a-f0-9]{32})\/[a-f0-9]{32}\/files\//)?.[1].slice(0, 8) ?? null;
}
