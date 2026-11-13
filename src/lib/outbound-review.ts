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
  const order = ["cam0", "cam1", "cam2", "t265_left", "t265_right", "extension_left", "extension_right"];
  const cameraNames = [...cameras.keys()].sort((a, b) => {
    const rank = (name: string) => { const i = order.indexOf(name.split("/").at(-1) ?? name); return i < 0 ? order.length : i; };
    return rank(a) - rank(b) || a.localeCompare(b, "en", { numeric: true });
  });
  // A missing file must leave a hole in its real part, not shift the next
  // camera segment into the wrong time interval.
  const partOf = (file: OutboundVideo, index: number) => Number(/-(\d+)\.mp4$/i.exec(file.label)?.[1] ?? index);
  const keyed = new Map(cameraNames.map(camera => [camera, new Map(cameras.get(camera)!.map((file, index) => [partOf(file, index), file]))]));
  const partNumbers = [...new Set([...keyed.values()].flatMap(files => [...files.keys()]))].sort((a, b) => a - b);
  return { cameraCount: cameras.size, cameras: cameraNames, primaryCamera: cameraNames[0], partNumbers,
    parts: partNumbers.map(part => cameraNames.flatMap(camera => {
      const file = keyed.get(camera)!.get(part);
      return file ? [{ ...file, camera }] : [];
    })) };
}

const outboundCall = <T,>(input: Record<string, unknown>) => invoke<T>("outbound_review_call", { input });
type BatchList = { batches: OutboundBatch[]; reasonOptions: string[] };
export async function listOutboundBatches(datasetId?: string): Promise<BatchList> {
  try { return await outboundCall<BatchList>({action:"list",...(datasetId?{datasetId}:{summary:true})}); }
  catch (error) {
    // The old service only accepts action:list. Fall back on an explicit
    // validation rejection; never replay a mutation after an ambiguous error.
    if (!String(error).includes("OUTBOUND_REQUEST_INVALID")) throw error;
    const result = await outboundCall<BatchList>({action:"list"});
    return datasetId?{...result,batches:result.batches.filter(batch=>batch.id===datasetId)}:result;
  }
}
export const saveOutboundReasonOption = (reason: string) =>
  outboundCall<{ reasonOptions: string[] }>({ action: "save-reason-option", reason });
export async function changeOutboundBatch(batch: OutboundBatch, action: "claim" | "release" | "decide", recordingId?: string, value?: "valid" | "invalid", reason?: string) {
  const input={action,datasetId:batch.id,version:batch.version,
    ...(recordingId?{recordingId,value,...(reason?{reason}:{})}:{})};
  // Keep a full claim response so entering the workspace needs no second read.
  const compact=action!=="claim";
  let result:{batch:OutboundBatch};
  try { result=await outboundCall({...input,...(compact?{compact:true}:{})}); }
  catch(error) {
    if(!compact||!String(error).includes("OUTBOUND_REQUEST_INVALID"))throw error;
    result=await outboundCall(input);
  }
  const videos=new Map(batch.recordings.map(recording=>[recording.id,recording.videos]));
  return {...result,batch:{...result.batch,recordings:result.batch.recordings.map(recording=>
    ({...recording,videos:recording.videos??videos.get(recording.id)??[]}))}};
}
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
