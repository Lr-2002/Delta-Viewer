import { invoke } from "@tauri-apps/api/core";

export interface OutboundVideo { segment: number; label: string; size: number; sha256: string | null }
export interface OutboundDecision { value: "valid" | "invalid"; reason?: string; actor: string; at: string }
export interface OutboundRecording { id: string; name: string; videos: OutboundVideo[]; decision: OutboundDecision | null }
export interface OutboundBatch {
  reasonOptions?: string[];
  id: string; name: string; version: number; claim: string | null; total: number; reviewed: number;
  valid: number; invalid: number; rate: number | null; recordings: OutboundRecording[];
}
export const OUTBOUND_INVALID_REASONS = ["无实际意义动作", "测试数据", "设备没有正确佩戴"] as const;

export function outboundVideoParts(videos: OutboundVideo[]) {
  const cameras = new Map<string, OutboundVideo[]>();
  for (const video of videos) {
    const path = video.label.replaceAll("\\", "/");
    const parent = path.lastIndexOf("/");
    const camera = parent > 0 ? path.slice(0, parent) : path.replace(/-\d+\.mp4$/i, "").replace(/\.mp4$/i, "");
    const files = cameras.get(camera) ?? [];
    files.push(video);
    cameras.set(camera, files);
  }
  for (const files of cameras.values()) files.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  const count = Math.max(0, ...[...cameras.values()].map(files => files.length));
  return { cameraCount: cameras.size, parts: Array.from({ length: count }, (_, index) =>
    [...cameras.entries()].flatMap(([camera, files]) => files[index] ? [{ ...files[index], camera }] : [])) };
}

const outboundCall = <T,>(input: Record<string, unknown>) => invoke<T>("outbound_review_call", { input });
export const listOutboundBatches = () => outboundCall<{ batches: OutboundBatch[]; reasonOptions: string[] }>({ action: "list" });
export const saveOutboundReasonOption = (reason: string) =>
  outboundCall<{ reasonOptions: string[] }>({ action: "save-reason-option", reason });
export const changeOutboundBatch = (batch: OutboundBatch, action: "claim" | "release" | "decide", recordingId?: string, value?: "valid" | "invalid", reason?: string) =>
  outboundCall<{ batch: OutboundBatch }>({ action, datasetId: batch.id, version: batch.version,
    ...(recordingId ? { recordingId, value, ...(reason ? { reason } : {}) } : {}) });
export async function fetchOutboundVideo(batch: OutboundBatch, recording: OutboundRecording, segment: number) {
  const result = await outboundCall<{ url: string }>({ action: "video-url", datasetId: batch.id, recordingId: recording.id, segment });
  const url = new URL(result.url);
  if (url.protocol !== "https:" || !/^\/api\/platform\/manager-outbound\/media\/[a-f0-9]{64}$/.test(url.pathname))
    throw new Error("OUTBOUND_VIDEO_URL_INVALID");
  return url.toString();
}

export function outboundError(reason: unknown) {
  const raw = String(reason);
  if (raw.includes("OUTBOUND_NOT_CONFIGURED")) return "外发审核服务尚未开通，请联系管理员。";
  if (raw.includes("OUTBOUND_ALREADY_CLAIMED")) return "此批次已被其他审核员领取。";
  if (raw.includes("OUTBOUND_VERSION_CONFLICT")) return "批次状态已更新，请刷新后重试。";
  if (raw.includes("OUTBOUND_NOT_OWNER")) return "请先领取此批次。";
  if (raw.includes("OUTBOUND_SOURCE_CHANGED")) return "原始视频来源发生变化，未用于审核。";
  if (raw.includes("OUTBOUND_REASON_INVALID")) return "请选择有效原因，或先保存自定义原因。";
  if (raw.includes("OUTBOUND_REASON_LIMIT")) return "常用原因数量已满，请联系管理员整理。";
  if (raw.includes("OUTBOUND_USER_CENTER_UNAVAILABLE")) return "无法连接用户中心，请检查网络后重试。";
  return `外发审核暂不可用：${raw}`;
}
