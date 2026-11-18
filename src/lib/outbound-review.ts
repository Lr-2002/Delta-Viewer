import { invoke } from "@tauri-apps/api/core";

export interface OutboundVideo { segment: number; label: string; size: number; sha256: string | null }
export type OutboundDecisionValue = "valid" | "invalid" | "anomalous";
export interface OutboundDecision { value: OutboundDecisionValue; reason?: string; actor: string; at: string }
export interface OutboundRecording { id: string; name: string; videos: OutboundVideo[]; decision: OutboundDecision | null }
export interface OutboundBatch {
  reasonOptions?: string[];
  id: string; name: string; version: number; claim: string | null; total: number; reviewed: number;
  valid: number; invalid: number; anomalous?: number; decisionValues?: OutboundDecisionValue[]; rate: number | null; recordings: OutboundRecording[];
}
export const OUTBOUND_INVALID_REASONS = ["无实际意义动作", "测试数据", "设备没有正确佩戴"] as const;

export const OUTBOUND_CAMERAS = ["cam0", "cam1", "cam2", "t265_left", "t265_right", "extension_left", "extension_right"] as const;

export function outboundVideoParts(videos: OutboundVideo[]) {
  const cameras = new Map<string, OutboundVideo[]>();
  for (const video of videos) {
    const path = video.label.replaceAll("\\", "/");
    const parent = path.lastIndexOf("/");
    const name = parent > 0 ? path.slice(0, parent).split("/").at(-1)! : path.replace(/-\d+\.mp4$/i, "").replace(/\.mp4$/i, "");
    const aliases: Record<string,string> = {stereo_left:"extension_left",stereo_right:"extension_right"};
    const camera = aliases[name] ?? name;
    const files = cameras.get(camera) ?? [];
    files.push(video);
    cameras.set(camera, files);
  }
  for (const files of cameras.values()) files.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  const order: readonly string[] = OUTBOUND_CAMERAS;
  const cameraNames = [...new Set([...order,...cameras.keys()])].sort((a, b) => {
    const rank = (name: string) => { const i = order.indexOf(name.split("/").at(-1) ?? name); return i < 0 ? order.length : i; };
    return rank(a) - rank(b) || a.localeCompare(b, "en", { numeric: true });
  });
  // A missing file must leave a hole in its real part, not shift the next
  // camera segment into the wrong time interval.
  const partOf = (file: OutboundVideo, index: number) => Number(/-(\d+)\.mp4$/i.exec(file.label)?.[1] ?? index);
  const keyed = new Map(cameraNames.map(camera => [camera, new Map((cameras.get(camera)??[]).map((file, index) => [partOf(file, index), file]))]));
  const partNumbers = [...new Set([...keyed.values()].flatMap(files => [...files.keys()]))].sort((a, b) => a - b);
  return { cameraCount: cameraNames.length, sourceCameraCount: cameras.size, cameras: cameraNames, primaryCamera: "cam0", partNumbers,
    parts: partNumbers.map(part => cameraNames.flatMap(camera => {
      const file = keyed.get(camera)!.get(part);
      return file ? [{ ...file, camera }] : [];
    })) };
}

/** Only measured MP4 durations define the continuous timeline. Never assume a
 * five-minute segment or silently shift a missing camera file into its place. */
export function outboundTimeline(parts: ReturnType<typeof outboundVideoParts>["parts"], durations: Record<number,number>) {
  let offset=0,complete=true;
  const spans=parts.map(files=>{
    const known=files.length>0&&files.every(file=>Number.isFinite(durations[file.segment])&&durations[file.segment]>0);
    const duration=known?Math.max(...files.map(file=>durations[file.segment])):0;
    const span={offset,duration,known};offset+=duration;complete&&=known;return span;
  });
  return {spans,duration:offset,complete:complete&&parts.length>0};
}

export const fetchOutboundMetadata = (url:string) => outboundCall<{duration:number}>({action:"media-metadata",url});

const outboundCall = <T,>(input: Record<string, unknown>) => invoke<T>("outbound_review_call", { input });
type BatchList = { batches: OutboundBatch[]; reasonOptions: string[] };
export type OutboundProtocol = {legacyList?:boolean;legacyMutation?:boolean};
export async function listOutboundBatches(datasetId?: string, protocol?:OutboundProtocol): Promise<BatchList> {
  const legacy=async()=>{const result=await outboundCall<BatchList>({action:"list"});return datasetId?{...result,batches:result.batches.filter(batch=>batch.id===datasetId)}:result;};
  if(protocol?.legacyList)return legacy();
  try { return await outboundCall<BatchList>({action:"list",...(datasetId?{datasetId}:{summary:true})}); }
  catch (error) {
    // The old service only accepts action:list. Fall back on an explicit
    // validation rejection; never replay a mutation after an ambiguous error.
    if (!String(error).includes("OUTBOUND_REQUEST_INVALID")) throw error;
    if(protocol)protocol.legacyList=true;
    return legacy();
  }
}
export const saveOutboundReasonOption = (reason: string) =>
  outboundCall<{ reasonOptions: string[] }>({ action: "save-reason-option", reason });
export async function changeOutboundBatch(batch: OutboundBatch, action: "claim" | "release" | "decide", recordingId?: string, value?: OutboundDecisionValue, reason?: string, protocol?:OutboundProtocol) {
  const input={action,datasetId:batch.id,version:batch.version,
    ...(recordingId?{recordingId,value,...(reason?{reason}:{})}:{})};
  // Keep a full claim response so entering the workspace needs no second read.
  const compact=action!=="claim"&&!protocol?.legacyMutation;
  let result:{batch:OutboundBatch};
  try { result=await outboundCall({...input,...(compact?{compact:true}:{})}); }
  catch(error) {
    if(!compact||!String(error).includes("OUTBOUND_REQUEST_INVALID"))throw error;
    if(protocol)protocol.legacyMutation=true;
    result=await outboundCall(input);
  }
  const videos=new Map(batch.recordings.map(recording=>[recording.id,recording.videos]));
  return {...result,batch:{...result.batch,recordings:result.batch.recordings.map(recording=>
    ({...recording,videos:recording.videos??videos.get(recording.id)??[]}))}};
}
export async function fetchOutboundVideo(batch: OutboundBatch, recording: OutboundRecording, segment: number) {
  const result = await outboundCall<{ url: string }>({ action: "video-url", datasetId: batch.id, recordingId: recording.id, segment });
  const url = new URL(result.url);
  const native = url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)
    && /^\/outbound-media\/[a-f0-9]{64}$/.test(url.pathname);
  const remote = url.protocol === "https:" && /^\/api\/platform\/manager-outbound\/media\/[a-f0-9]{64}$/.test(url.pathname);
  if ((!native && !remote) || url.username || url.password || url.search || url.hash)
    throw new Error("OUTBOUND_VIDEO_URL_INVALID");
  return url.toString();
}

export function outboundError(reason: unknown) {
  const raw = String(reason);
  if(raw.includes("OUTBOUND_MEDIA_DURATION_INVALID"))return "源视频时长信息无效，不能建立连续时间轴，请联系管理员核对源文件。";
  if(raw.includes("OUTBOUND_MEDIA_INDEX_MISSING"))return "源视频缺少播放索引，可能未完成封装，请联系管理员核对源文件。";
  if(raw.includes("OUTBOUND_MEDIA_CONTAINER_INVALID"))return "源视频容器结构异常，请联系管理员核对源文件。";
  if(raw.includes("OUTBOUND_MEDIA_TIMEOUT"))return "读取视频超时，请稍后重试失败视频。";
  if(raw.includes("OUTBOUND_MEDIA_NETWORK"))return "视频网络读取中断，请稍后重试失败视频。";
  if (raw.includes("OUTBOUND_USER_CENTER_TIMEOUT")) return "等待外发审核服务响应超时。请稍后重试；若持续出现，请联系管理员检查用户中心和交付服务。";
  if (raw.includes("OUTBOUND_USER_CENTER_TLS")) return "用户中心安全连接校验失败，请联系管理员核对连接配置和证书。";
  if (raw.includes("OUTBOUND_USER_CENTER_UNREACHABLE")) return "无法连接用户中心。请检查公司网络；若网络正常，请联系管理员检查用户中心服务。";
  if (raw.includes("OUTBOUND_RESPONSE_INTERRUPTED")) return "用户中心响应传输中断，请稍后重试；提交结果需重新核对。";
  if (raw.includes("OUTBOUND_NETWORK_UNAVAILABLE") || /OUTBOUND_HTTP_50[234]/.test(raw)) return "用户中心暂未取得交付服务响应。请稍后重试；若持续出现，请联系管理员检查外发审核服务。";
  if (raw.includes("OUTBOUND_BRIDGE_BUSY")) return "外发审核服务繁忙，请稍后重试。";
  if (raw.includes("AUTH_REQUIRED") || raw.includes("OUTBOUND_HTTP_401")) return "登录会话已失效，请保存当前工作后重新登录。";
  if (raw.includes("OUTBOUND_ACCOUNT_CHANGED")) return "登录账号或权限已变化，请重新打开任务中心核对。";
  if (raw.includes("OUTBOUND_NOT_CONFIGURED")) return "外发审核服务尚未开通，请联系管理员。";
  if (raw.includes("OUTBOUND_ALREADY_CLAIMED")) return "此批次已被其他审核员领取。";
  if (raw.includes("OUTBOUND_VERSION_CONFLICT")) return "批次状态已更新，请刷新后重试。";
  if (raw.includes("OUTBOUND_NOT_OWNER")) return "请先领取此批次。";
  if (raw.includes("OUTBOUND_SOURCE_CHANGED")) return "原始视频来源发生变化，未用于审核。";
  if (raw.includes("OUTBOUND_REASON_INVALID")) return "请选择有效原因，或先保存自定义原因。";
  if (raw.includes("OUTBOUND_REASON_LIMIT")) return "常用原因数量已满，请联系管理员整理。";
  if (raw.includes("OUTBOUND_USER_CENTER_UNAVAILABLE")) return "用户中心请求未完成，请核对网络和服务状态后重试。";
  return `外发审核暂不可用：${raw}`;
}

export function outboundResultUncertain(reason: unknown) {
  return /OUTBOUND_(?:USER_CENTER_(?:TIMEOUT|UNAVAILABLE)|RESPONSE_(?:INTERRUPTED|INVALID|TOO_LARGE)|NETWORK_UNAVAILABLE|HTTP_50[0234]|REQUEST_FAILED(?::\s*OUTBOUND_HTTP_50[0234])?$)/.test(String(reason));
}

// Local resource cleanup only. The native side never forwards this action.
export async function releaseOutboundVideos(urls:string[]) {
  if(!urls.length)return;
  try {await outboundCall({action:"release-media",urls});} catch { /* Session change already invalidates its routes. */ }
}

export async function outboundMediaFailure(url:string):Promise<string|null> {
  try {
    const {code}=await outboundCall<{code:string|null}>({action:"media-status",url});
    const messages:Record<string,string>={
      OUTBOUND_MEDIA_INDEX_MISSING:"源视频缺少播放索引，文件未完整封装；重试无法修复，请联系数据提供方检查原录制。",
      OUTBOUND_MEDIA_CONTAINER_INVALID:"源视频容器结构不完整，请联系数据提供方检查原录制。",
      OUTBOUND_MEDIA_EXPIRED:"视频访问凭证已失效，请重试失败视频；若仍失败，请刷新批次核对领取状态。",
      OUTBOUND_MEDIA_TIMEOUT:"视频读取超时，请检查网络后重试失败视频。",
      OUTBOUND_MEDIA_NETWORK:"视频传输中断，请检查网络后重试失败视频。",
      OUTBOUND_MEDIA_BUSY:"视频读取服务繁忙，请稍后重试失败视频。",
      OUTBOUND_MEDIA_UPSTREAM:"视频源站暂时不可用，请稍后重试失败视频。",
      OUTBOUND_SOURCE_CHANGED:"原始视频来源发生变化，未用于审核。",
      OUTBOUND_VIDEO_NOT_FOUND:"源视频文件不可用，请联系管理员核对来源。",
      OUTBOUND_MEDIA_INTEGRITY:"视频响应与源文件信息不一致，已停止读取，请联系管理员检查。",
      OUTBOUND_MEDIA_RESPONSE_INVALID:"视频读取服务返回异常，请稍后重试失败视频。",
    };
    return code?messages[code]??null:null;
  } catch { return null; }
}
