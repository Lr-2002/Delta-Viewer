import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Scissors, Trash2, Undo2 } from "lucide-react";
import { t, tr, useLanguage } from "../lib/i18n";
import { matchShortcut, shortcutBlocked } from "../lib/shortcuts";
import { useShortcuts } from "../lib/use-shortcuts";
import { outboundError, outboundResultUncertain, outboundTrimStatus, saveOutboundTrim, type OutboundBatch, type OutboundTrimRequest } from "../lib/outbound-review";

export interface OutboundClipSpan {
  part: number;
  offset: number;
  duration: number;
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


interface Props {
  datasetId: string;
  recordingId: string;
  version: number;
  sourceRevision: string;
  initialDescription?: string;
  canSave: boolean;
  onSaved: (batch:OutboundBatch)=>void;
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
  const shortcuts = useShortcuts();
  const { duration, position, spans, ranges, onEdit, pause, seek, onBusy } = props;
  const { clips, duration: editedDuration } = clipTimeline(ranges);
  const current = Math.round(position * 1000);
  const playhead = clips.reduce((time, clip) =>
    time + Math.max(0, Math.min(current, clip.end) - clip.start), 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [undo, setUndo] = useState<ClipRange[][]>([]);
  const [draft, setDraft] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const [description, setDescription] = useState(props.initialDescription??"");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<OutboundTrimRequest|undefined>(undefined);
  const active = useRef(true);
  const disabled = busy || props.disabled;

  useEffect(()=>{
    active.current=true;
    return ()=>{active.current=false;};
  },[]);

  const valid = editedDuration > 0 && editedDuration < Math.round(duration * 1000);
  const splitIndex = ranges.findIndex(range => current > range.start && current < range.end);

  function locate(at: number) {
    const clip = clips.find(item => at < item.limit) ?? clips.at(-1);
    if (clip) seek(Math.min(clip.end, clip.start + Math.max(0, at - clip.offset)) / 1000);
  }

  function edit(next: ClipRange[]) {
    pause();
    setUndo([...undo, ranges]);
    request.current=undefined;
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
    setError("");
  }

  async function save() {
    if ((!valid&&!request.current)||disabled||!props.canSave) return;
    pause();
    const target = {datasetId:props.datasetId,recordingId:props.recordingId,
      operationId:request.current?.operationId??crypto.randomUUID()};
    const kept: ClipRange[] = [];
    for (const range of ranges) {
      const previous = kept.at(-1);
      if (previous?.end === range.start) previous.end = range.end;
      else kept.push({...range});
    }
    const parts: OutboundTrimRequest["parts"] = spans.flatMap(span => {
      const start = Math.round(span.offset*1000);
      const end = Math.round((span.offset+span.duration)*1000);
      const intervals=kept.flatMap<[number,number]>(range=>{
        const left=Math.max(range.start,start),right=Math.min(range.end,end);
        return right>left?[[left-start,right-start]]:[];
      });
      return intervals.length===1&&intervals[0][0]===0&&intervals[0][1]===end-start ? [] : [[span.part,intervals]];
    });
    request.current??={...target,version:props.version,sourceRevision:props.sourceRevision,description,parts};
    const submitted=request.current;
    onBusy(true);
    setBusy(true);
    setError("");
    try {
      let outcome;
      try { outcome=await saveOutboundTrim(submitted); }
      catch (cause) { if(!outboundResultUncertain(cause))throw cause; }
      for(let attempt=0;active.current&&attempt<720;attempt++){
        if(outcome?.status==="saved"&&outcome.batch){props.onSaved(outcome.batch);return;}
        if(outcome?.status==="failed"||outcome?.status==="interrupted")throw new Error(outcome.error??"OUTBOUND_TRIM_INTERRUPTED");
        if(outcome?.status==="unknown"&&attempt>2)throw new Error("OUTBOUND_TRIM_INTERRUPTED");
        await new Promise(resolve=>setTimeout(resolve,2500));
        if(!active.current)return;
        try{outcome=await outboundTrimStatus(target);}
        catch(cause){if(!outboundResultUncertain(cause))throw cause;}
      }
      if(active.current)throw new Error("OUTBOUND_TRIM_INTERRUPTED");
    } catch (cause) {
      if(active.current)setError(outboundError(cause));
    } finally {
      if(active.current){setBusy(false);onBusy(false);}
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (disabled || event.repeat || shortcutBlocked(event, false, true)) return;
      const action = matchShortcut(event, shortcuts, "outbound", [
        "outboundClipSplit", "outboundClipDelete", "outboundClipUndo", "outboundClipSave",
      ]);
      if (!action) return;
      event.preventDefault();
      if (action === "outboundClipSplit") split();
      if (action === "outboundClipDelete") remove();
      if (action === "outboundClipUndo") undoEdit();
      if (action === "outboundClipSave") void save();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
      <button className="button button-primary" type="button" disabled={disabled||!props.canSave||(!valid&&!request.current)} onClick={()=>void save()}>{t("保存并替换原视频")}</button>
      {busy&&<p role="status">{t("正在剪切并更新原始归档…")}</p>}
      {!props.canSave&&<p role="status">{t("当前交付服务暂未启用原路径保存。")}</p>}
      {error&&<p className="outbound-clip-error" role="alert">{tr(error)}</p>}
    </div>

  </div>;
}

function formatClipTime(ms:number){
  const minutes = String(Math.floor(ms / 60000)).padStart(2, "0");
  const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}
