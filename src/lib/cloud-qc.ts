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
  if (raw.includes("QC_TASK_NOT_CLAIMED")) return "任务尚未领取，云端未接收；请领取后补传，本机结论保持不变。";
  if (raw.includes("SESSION_IDENTITY_CHANGED")) return "云端校验会话信息不一致，尚未接收；本机原提交保留，请联系管理员核对。";
  if (raw.includes("REVIEWER_MISMATCH")) return "审核人信息与云端身份不一致，尚未接收；本机原提交保留，请联系管理员核对。";
  if (raw.includes("CLOUD_QC_NETWORK_UNAVAILABLE")) return "暂时无法连接云端，本机记录保留，网络恢复后会重试。";
  if (/ACCOUNT_MISMATCH|TOKEN_INVALID|UNAUTHORIZED|AUTH_REQUIRED/.test(raw)) return "云端登录或账号校验失败，请重新登录并核对云端连接账号；本机记录保留。";
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
