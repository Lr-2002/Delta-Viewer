import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FolderOpen, Scissors, Trash2, Undo2 } from "lucide-react";
import { cancelTask, chooseDirectory, openOutput } from "../lib/backend";
import { t, tr, useLanguage } from "../lib/i18n";
import { outboundError } from "../lib/outbound-review";

export interface OutboundClipSpan {
  part: number;
  offset: number;
  duration: number;
  segments: number[];
}

export interface ClipRange { start: number; end: number }

function clipTimeline(ranges: ClipRange[]) {
  let duration = 0;
  const clips = ranges.map(range => {
    const offset = duration;
    duration += range.end - range.start;
    return { ...range, offset, limit: duration };
  });
  return { clips, duration };
}

interface ClipResult { outputPath: string; videoCount: number }
interface Progress { operationId: number; current: number; total: number; camera: string; joining?: boolean }

interface Props {
  datasetId: string;
  recordingId: string;
  version: number;
  position: number;
  duration: number;
  shortened: boolean;
  ranges: ClipRange[];
  onEdit: (ranges: ClipRange[]) => void;
  spans: OutboundClipSpan[];
  pause: () => void;
  seek: (seconds: number) => void;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}

export function OutboundClipEditor(props: Props) {
  useLanguage();
  const { duration, position, spans, ranges, onEdit, pause, seek, onBusy } = props;
  const { clips, duration: editedDuration } = clipTimeline(ranges);
  const current = Math.round(position * 1000);
  const playhead = clips.reduce((time, clip) =>
    time + Math.max(0, Math.min(current, clip.end) - clip.start), 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [undo, setUndo] = useState<ClipRange[][]>([]);
  const [draft, setDraft] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>();
  const [result, setResult] = useState<ClipResult>();
  const [error, setError] = useState("");
  const operation = useRef(0);
  const active = useRef(true);
  const disabled = busy || props.disabled;

  useEffect(() => {
    active.current = true;
    let unlisten: (() => void) | undefined;
    void listen<Progress>("outbound-clip-progress", event => {
      if (active.current && event.payload.operationId === operation.current) setProgress(event.payload);
    }).then(stop => {
      if (active.current) unlisten = stop;
      else stop();
    }).catch(() => {});
    return () => {
      active.current = false;
      unlisten?.();
      if (operation.current) void cancelTask(operation.current).catch(() => {});
    };
  }, []);

  const valid = editedDuration > 0 && editedDuration < Math.round(duration * 1000);
  const splitIndex = ranges.findIndex(range => current > range.start && current < range.end);

  function locate(at: number) {
    const clip = clips.find(item => at < item.limit) ?? clips.at(-1);
    if (clip) seek(Math.min(clip.end, clip.start + Math.max(0, at - clip.offset)) / 1000);
  }

  function edit(next: ClipRange[]) {
    pause();
    setUndo([...undo, ranges]);
    setResult(undefined);
    setError("");
    onEdit(next);
  }

  function split() {
    const range = ranges[splitIndex];
    if (!range) return;
    edit([...ranges.slice(0, splitIndex), { ...range, end: current },
      { ...range, start: current }, ...ranges.slice(splitIndex + 1)]);
    setSelected(splitIndex + 1);
  }

  function remove() {
    if (selected === null || ranges.length < 2) return;
    const next = ranges.filter((_, index) => index !== selected);
    const replacement = next[selected] ?? next.at(-1)!;
    const target = next[selected] ? replacement.start : replacement.end;
    edit(next);
    setSelected(null);
    seek(target / 1000);
  }

  function undoEdit() {
    const previous = undo.at(-1);
    if (!previous) return;
    pause();
    onEdit(previous);
    setUndo(undo.slice(0, -1));
    setSelected(null);
    setResult(undefined);
    setError("");
  }

  async function save() {
    if (!valid || disabled || operation.current) return;
    pause();
    const operationId = Date.now();
    operation.current = operationId;
    onBusy(true);
    setBusy(true);
    setProgress(undefined);
    setResult(undefined);
    setError("");
    try {
      const destination = await chooseDirectory("选择剪切结果保存目录");
      if (!destination || !active.current) return;
      const kept: ClipRange[] = [];
      for (const range of ranges) {
        const previous = kept.at(-1);
        if (previous?.end === range.start) previous.end = range.end;
        else kept.push({ ...range });
      }
      const pieces = spans.flatMap(span => {
        const offset = Math.round(span.offset * 1000);
        const endOfPart = Math.round((span.offset + span.duration) * 1000);
        return kept.flatMap(range => {
          const left = Math.max(range.start, offset);
          const right = Math.min(range.end, endOfPart);
          return right > left ? [{
            part: span.part,
            interval: { startMs: left - offset, endMs: right - offset },
            segments: span.segments,
          }] : [];
        });
      });
      const written = await invoke<ClipResult>("outbound_clip_export", { operationId, request: {
        datasetId: props.datasetId, recordingId: props.recordingId, version: props.version, destination, description, pieces,
      } });
      if (active.current) setResult(written);
    } catch (cause) {
      if (active.current) setError(clipError(cause));
    } finally {
      operation.current = 0;
      if (active.current) { setBusy(false); onBusy(false); }
    }
  }

  function open() {
    if (result) void openOutput(result.outputPath).catch(() => setError("无法打开剪切结果目录。"));
  }

  return <div className="outbound-clip-editor" role="group" aria-label={t("视频剪切")}>
    <div className="outbound-clip-timeline" style={{"--clip-playhead":
      `${100 * (draft ?? playhead) / editedDuration}%`} as CSSProperties}>
      <div className="outbound-clip-ruler">
        <div className="outbound-clip-clock">
          <span>{formatClipTime(draft ?? playhead)} / {formatClipTime(editedDuration)}</span>
          {props.shortened&&<span>{t("剪切范围已按各路共有画面对齐")}</span>}
        </div>
        <input type="range" aria-label={t("剪切播放位置")} min={0} max={editedDuration} step={1}
          value={draft ?? playhead} disabled={disabled}
          onPointerDown={() => { scrubbing.current = true; pause(); }}
          onPointerUp={event => {
            scrubbing.current = false;
            locate(event.currentTarget.valueAsNumber);
            setDraft(null);
          }}
          onPointerCancel={() => { scrubbing.current = false; setDraft(null); }}
          onBlur={() => { scrubbing.current = false; setDraft(null); }}
          onChange={event => {
            const at = event.currentTarget.valueAsNumber;
            if (scrubbing.current) setDraft(at);
            else { pause(); locate(at); }
          }}/>
      </div>
      <div className="outbound-clip-track">
        {clips.map((clip, index) => <button type="button" className="outbound-clip-piece" key={clip.start}
          style={{width: `${100 * (clip.end - clip.start) / editedDuration}%`}}
          aria-label={t("剪切片段 {0}", [index + 1])} aria-pressed={selected === index}
          title={t("剪切片段 {0} · {1}", [index + 1, formatClipTime(clip.end - clip.start)])} disabled={disabled}
          onClick={event => {
            setSelected(index);
            pause();
            const bounds = event.currentTarget.getBoundingClientRect();
            const fraction = event.detail === 0 ? 0 : Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
            seek((clip.start + Math.round(fraction * (clip.end - clip.start))) / 1000);
          }}>{t("剪切片段 {0}", [index + 1])}</button>)}
      </div>
      <i className="outbound-clip-playhead" aria-hidden="true"/>
    </div>
    <div className="outbound-clip-controls">
      <button className="button button-secondary" type="button" disabled={disabled || splitIndex < 0}
        onClick={split}><Scissors size={15}/>{t("分割")}</button>
      <button className="button button-secondary" type="button" disabled={disabled || selected === null || ranges.length < 2}
        onClick={remove}><Trash2 size={15}/>{t("删除选中片段")}</button>
      <button className="button button-secondary" type="button" disabled={disabled || !undo.length}
        onClick={undoEdit}><Undo2 size={15}/>{t("撤销剪切")}</button>
      <input aria-label={t("片段描述")} placeholder={t("片段描述（选填）")} maxLength={1000} disabled={disabled} value={description}
        onChange={event=>setDescription(event.target.value)}/>
      <button className="button button-primary" type="button" disabled={disabled||!valid} onClick={()=>void save()}>{t("剪切并保存 MP4")}</button>
      {busy&&<button className="button button-secondary" type="button" onClick={()=>void cancelTask(operation.current).catch(()=>{})}>{t("取消剪切")}</button>}
    </div>
    {busy&&<span className="outbound-clip-progress" role="status">{progress ? t(progress.joining ? "正在拼接 {0}/{1} · {2}" : "正在读取并剪切 {0}/{1} · {2}", [progress.current, progress.total, progress.camera]) : t("正在准备剪切…")}</span>}
    {result&&<div className="outbound-clip-result" role="status">
      <span title={result.outputPath}>{t("已保存 {0} 个 MP4 文件",[result.videoCount])}</span>
      <button className="button button-secondary" type="button" onClick={open}><FolderOpen size={15}/>{t("打开结果目录")}</button>
    </div>}
    {error&&<p className="outbound-clip-error" role="alert">{tr(error)}</p>}
  </div>;
}

function formatClipTime(ms:number){
  const minutes = String(Math.floor(ms / 60000)).padStart(2, "0");
  const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

function clipError(cause: unknown) {
  const value = String(cause);
  const camera = value.match(/\[([a-zA-Z0-9_-]{1,32})\]$/)?.[1];
  if (value.includes("OUTBOUND_CLIP_RANGE_INVALID")) return "剪切范围无效，请重新分割。";
  if (value.includes("OUTBOUND_CLIP_SOURCE_CHANGED")) return "录制或审核状态已变化，请刷新批次后重试。";
  if (value.includes("OUTBOUND_CLIP_CAMERA_GAP")) return t("{0} 缺少保留片段中的视频，无法生成同步结果。", [camera ?? ""]);
  if (value.includes("OUTBOUND_CLIP_SOURCE_READ")) return "读取源视频失败，请重试。";
  if (value.includes("OUTBOUND_CLIP_INCOMPLETE") || value.includes("OUTBOUND_CLIP_ENCODE"))
    return camera ? t("{0} 剪切失败，结果未保存。请缩短范围或检查源视频。", [camera]) : "剪切失败，结果未保存。";
  if (value.includes("OUTBOUND_CLIP_FFMPEG_MISSING")) return "无法启动视频剪切组件。";
  if (value.includes("任务已取消")) return "已取消剪切。";
  if (value.includes("I/O 错误")) return "无法保存剪切结果，请检查目标目录和剩余空间。";
  return outboundError(cause);
}
