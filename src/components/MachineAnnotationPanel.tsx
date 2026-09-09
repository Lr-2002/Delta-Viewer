import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Code, LoaderCircle, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { loadMachineAnnotation, loadMachineReview, saveMachineReview } from "../lib/backend";
import { adjustReviewBoundary, machineTimelineMapping } from "../lib/machine-annotation";
import { ProofreadPlayer } from "./ProofreadPlayer";
import { ReviewTimeline } from "./ReviewTimeline";
import type { EpisodeData, ExportRange, MachineAnnotation, MachineReview, ReviewSegment } from "../types";

interface Props {
  data: EpisodeData;
  busy: boolean;
  onComplete?: (status: "approved" | "rejected") => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  playback?: {
    frame: number;
    onSeek: (frame: number) => void;
    onPause: () => void;
    onRangeChange: (range: ExportRange | null) => void;
    controls: ReactNode;
  };
}
type Status = "pending" | "approved" | "rejected";
type Snapshot = { segments: ReviewSegment[]; status: Status };
const saves = new Map<string, Promise<boolean>>();

export function MachineAnnotationPanel(props: Props) {
  const [sourceName, setSourceName] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  return <div className={`quality-workspace${props.playback ? " quality-embedded" : ""}`}>
    <label className="machine-source-picker">机标来源<select aria-label="机标来源" value={sourceName} disabled={props.busy || sourceBusy}
      onChange={(event) => { props.playback?.onPause(); setSourceName(event.currentTarget.value); }}>
      <option value="">自动（优先 Flash）</option><option value="bailian_annotation.json">3.8 Max</option><option value="bailian_annotation.qwen3.8-flash.json">3.8 Flash</option>
    </select></label>
    <MachineAnnotationEditor {...props} key={`${props.data.summary.root}:${sourceName}`} sourceName={sourceName || undefined} onSourceBusy={setSourceBusy} />
  </div>;
}

function MachineAnnotationEditor({ data, busy, sourceName, onSourceBusy, onComplete, onUnsavedChange, playback }: Props & { sourceName?: string; onSourceBusy: (busy: boolean) => void }) {
  const root = data.summary.root;
  const [result, setResult] = useState<MachineAnnotation | null>(null);
  const [review, setReview] = useState<MachineReview | null>(null);
  const [edits, setEdits] = useState<ReviewSegment[]>([]);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const mounted = useRef(true);
  const stateRef = useRef<MachineReview | null>(null);
  const pending = useRef<Snapshot | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const loadedSource = useRef(sourceName);
  const finishLock = useRef(false);
  const recoveryKey = () => `dohc.machine-review.pending:${root}${loadedSource.current === "bailian_annotation.qwen3.8-flash.json" ? ":qwen3.8-flash" : ""}`;
  const unsaved = saving || Boolean(saveError) || finishing;
  useEffect(() => { onSourceBusy(loading || unsaved); }, [loading, unsaved, onSourceBusy]);
  useEffect(() => { onUnsavedChange?.(unsaved); }, [unsaved, onUnsavedChange]);
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unsaved]);

  function persist(snapshot: Snapshot): Promise<boolean> {
    pending.current = snapshot;
    onUnsavedChange?.(true);
    try { localStorage.setItem(recoveryKey(), JSON.stringify({ sourceHash: stateRef.current?.sourceHash, ...snapshot })); }
    catch { setSaveError("本机应急草稿无法保存，请保持此页打开直到保存完成"); }
    if (running.current) return running.current;
    setSaving(true); setSaveError("");
    const job = (async () => {
      try {
        while (pending.current && stateRef.current) {
          const next = pending.current;
          pending.current = null;
          const state = stateRef.current;
          try {
            const saved = await saveMachineReview(root, state.sourceHash, state.revision, next.segments, loadedSource.current, next.status);
            stateRef.current = saved;
            if (mounted.current) setReview(saved);
            if (!pending.current) localStorage.removeItem(recoveryKey());
          } catch (reason) { pending.current ??= next; throw reason; }
        }
        return true;
      } catch (reason) {
        if (mounted.current) setSaveError(String(reason));
        return false;
      } finally {
        running.current = null;
        if (mounted.current) setSaving(false);
      }
    })();
    running.current = job;
    saves.set(root, job);
    return job;
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoading(true); setError(""); setPlaying(false);
    void (async () => {
      await saves.get(root);
      const loaded = await loadMachineAnnotation(root, sourceName);
      if (!active) return;
      setResult(loaded);
      if (!loaded) return;
      loadedSource.current = loaded.sourceName ?? sourceName;
      const state = await loadMachineReview(root, loadedSource.current);
      if (!active) return;
      stateRef.current = state;
      const segments = state.segments;
      setReview(state); setEdits(segments); editsRef.current = segments;
      setSelected(segments.find((item) => !item.deleted)?.sourceIndex ?? 0);
      setFrame(segments.find((item) => !item.deleted)?.startFrame ?? 0);
      const raw = localStorage.getItem(recoveryKey());
      if (raw) {
        const recovery = JSON.parse(raw) as Snapshot & { sourceHash: string };
        if (recovery.sourceHash !== state.sourceHash) throw new Error("待保存草稿与原机标不匹配，请先处理草稿冲突");
        setEdits(recovery.segments); editsRef.current = recovery.segments;
        void persist({ segments: recovery.segments, status: recovery.status ?? "pending" });
      }
    })().catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [root, reload]);

  const primary = data.summary.streams.find((stream) => stream.name === "cam0");
  const mapping = useMemo(() => result ? machineTimelineMapping(result, primary) : null, [result, primary]);
  const rows = useMemo(() => edits.filter((segment) => !segment.deleted).sort((a, b) => a.startFrame - b.startFrame || a.sourceIndex - b.sourceIndex), [edits]);
  const active = rows.find((segment) => segment.sourceIndex === selected) ?? rows[0];
  const valid = result && primary && mapping && !mapping.error && !error;
  const canEdit = Boolean(valid && review && !busy && !loading && !finishing);
  const onRangeChange = playback?.onRangeChange;
  const rangeStart = valid && active && !loading ? mapping.offset + active.startFrame * mapping.step : null;
  const rangeEnd = valid && active && !loading ? mapping.offset + (active.endFrame + 1) * mapping.step - 1 : null;
  useEffect(() => {
    onRangeChange?.(rangeStart !== null && rangeEnd !== null ? { startFrame: rangeStart, endFrame: rangeEnd } : null);
    return () => onRangeChange?.(null);
  }, [onRangeChange, rangeStart, rangeEnd]);
  const outputName = loadedSource.current === "bailian_annotation.qwen3.8-flash.json" ? "review.3.8flash.json" : "review.3.8max.json";
  const seek = useCallback((next: number) => {
    setFrame(next); setPlaying(false);
    if (mapping && !mapping.error) playback?.onSeek(mapping.offset + next * mapping.step);
  }, [mapping, playback?.onSeek]);
  const visibleFrame = playback && result && mapping && !mapping.error
    ? Math.max(0, Math.min(result.frameCount - 1, Math.floor((playback.frame - mapping.offset) / mapping.step))) : frame;

  function change(next: ReviewSegment[]) {
    if (!canEdit || finishLock.current) return;
    setEdits(next); editsRef.current = next; setPlaying(false);
    playback?.onPause();
    void persist({ segments: next, status: "pending" });
  }
  function boundary(kind: "startFrame" | "endFrame", value: number) {
    if (!active || !result || !canEdit) return;
    const updated = adjustReviewBoundary(editsRef.current, active.sourceIndex, kind, value, result.frameCount);
    if (updated === editsRef.current) return;
    change(updated); seek(updated.find((item) => item.sourceIndex === active.sourceIndex)![kind]);
  }
  const choose = useCallback((sourceIndex: number) => {
    const segment = rows.find((item) => item.sourceIndex === sourceIndex);
    if (!segment) return;
    setSelected(sourceIndex); seek(segment.startFrame);
  }, [rows, seek]);
  async function finish(status: "approved" | "rejected") {
    if (!canEdit || finishLock.current) return;
    finishLock.current = true; setFinishing(true); setPlaying(false);
    playback?.onPause();
    const saved = await persist({ segments: editsRef.current, status });
    finishLock.current = false; setFinishing(false);
    if (saved) { onUnsavedChange?.(false); onComplete?.(status); }
  }

  return <div className="quality-review proofreading-view">
    {playback ? <section className="quality-timeline" aria-label="校对时间轴">
      <div className="proofreading-transport">{playback.controls}</div>
      {valid && <ReviewTimeline frame={visibleFrame} frameCount={result.frameCount} start={active?.startFrame ?? 0}
        end={active?.endFrame ?? result.frameCount - 1} editable={canEdit && Boolean(active)} segments={rows}
        selected={active?.sourceIndex} onSeek={seek} onBoundary={boundary} onChoose={choose} />}
      {!valid && primary?.firstFrame !== null && primary?.lastFrame !== null && primary && <input
        className="machine-boundary-slider" type="range" aria-label="校对播放帧" min={primary.firstFrame} max={primary.lastFrame}
        value={playback.frame} onChange={(event) => playback.onSeek(event.currentTarget.valueAsNumber)} />}
    </section> : <section className="quality-media" aria-label="视频与骨架">
      <header className="quality-heading"><h2>机标校对</h2><span className="frame-counter">帧 {frame} / {result ? result.frameCount - 1 : "--"}</span></header>
      {valid && <ProofreadPlayer root={root} stream={primary} offset={mapping.offset} step={mapping.step} frameCount={result.frameCount}
        skeleton={data.skeleton} skeletonError={data.skeletonError} segments={rows} selected={active?.sourceIndex}
        editable={canEdit && Boolean(active)} onBoundary={boundary} onChoose={choose}
        frame={frame} start={active?.startFrame ?? 0} end={active?.endFrame ?? result.frameCount - 1} playing={playing} onFrame={setFrame} onPlaying={setPlaying} />}
    </section>}
    <section className="quality-inspector" aria-label="机标结果">
      <header className="machine-heading"><h2>动作片段</h2><span className="machine-status">{rows.length} 段</span>
        <button className="icon-button" title="查看原始 JSON" aria-label="查看 JSON" disabled={!result} onClick={() => setShowJson(true)}><Code size={15} /></button>
        <button className="icon-button" title="重新读取机标" aria-label="重新读取机标" disabled={loading || unsaved || busy} onClick={() => setReload(reload + 1)}><RefreshCw size={15} /></button>
      </header>
      {loading && <p role="status" className="machine-message"><LoaderCircle size={15} />正在读取机标</p>}
      {error && <p role="alert" className="machine-message">{error}</p>}
      {mapping?.error && <p role="alert" className="machine-message">{mapping.error}</p>}
      {!loading && !error && !result && <p className="machine-message">未发现 {sourceName ?? "机标 JSON"}</p>}
      <SegmentList rows={rows} selected={active?.sourceIndex} disabled={!canEdit} onChoose={choose}
        onDelete={(sourceIndex) => change(editsRef.current.map((item) => item.sourceIndex === sourceIndex ? { ...item, deleted: true, decision: "pending" } : item))} />
      <div className="quality-editor" aria-label="人工复核">
        <header className="machine-heading"><strong>{active ? `片段 ${rows.indexOf(active) + 1}` : "动作描述"}</strong>
          <button className="icon-button" title="恢复删除的片段" aria-label="恢复删除的片段" disabled={!canEdit || !edits.some((item) => item.deleted)} onClick={() => change(edits.map((item) => ({ ...item, deleted: false })))}><Undo2 size={15} /></button>
        </header>
        <textarea aria-label="复核动作描述" placeholder="中文动作描述" value={active?.description ?? ""} disabled={!canEdit || !active}
          onChange={(event) => change(editsRef.current.map((item) => item.sourceIndex === active?.sourceIndex ? { ...item, description: event.currentTarget.value, decision: "pending" } : item))} />
      </div>
      <footer className="quality-footer">
        <div className="quality-save-state" role="status">{saving ? "正在保存…" : saveError ? "保存失败" : review?.published ? "review 已实时保存" : "尚无人工修改"}
          {review?.versionId && <span title={review.versionId}>版本 {review.revision} · {review.versionId.slice(0, 8)}</span>}
        </div>
        {saveError && <div role="alert" className="machine-message">{saveError}<button className="icon-button" aria-label="重试保存复核" title="重试保存复核" onClick={() => void persist(pending.current ?? { segments: editsRef.current, status: "pending" })}><RefreshCw size={15} /></button></div>}
        <div className="quality-output" title={`${root}/${outputName}`}>{outputName}<span>{review?.status === "approved" ? "已通过" : review?.status === "rejected" ? "未通过" : "待审核"}</span></div>
        <div className="quality-decisions">
          <button className="button button-secondary" disabled={!canEdit} onClick={() => void finish("rejected")}><X size={16} />不通过</button>
          <button className="button button-primary" disabled={!canEdit || !rows.length} onClick={() => void finish("approved")}><Check size={16} />通过</button>
        </div>
      </footer>
    </section>
    {showJson && result && <dialog className="machine-json" aria-label="机标 JSON" ref={(node) => { if (node && !node.open) node.showModal(); }} onCancel={() => setShowJson(false)}><header className="machine-heading"><strong>{result.sourceName ?? "bailian_annotation.json"}</strong><button autoFocus className="icon-button" aria-label="关闭 JSON" title="关闭 JSON" onClick={() => setShowJson(false)}><X size={16} /></button></header><pre>{result.sourceJson ?? JSON.stringify(result, null, 2)}</pre></dialog>}
  </div>;
}

const SegmentList = memo(function SegmentList({ rows, selected, disabled, onChoose, onDelete }: {
  rows: ReviewSegment[]; selected: number | undefined; disabled: boolean;
  onChoose: (sourceIndex: number) => void; onDelete: (sourceIndex: number) => void;
}) {
  return <div className="machine-segment-list" role="list">
    {rows.map((segment, index) => <div role="listitem" data-source-index={segment.sourceIndex} className={`machine-segment${segment.sourceIndex === selected ? " active" : ""}`} key={segment.sourceIndex}>
      <button className="machine-segment-description" aria-label={`定位机标片段 ${index + 1}`} disabled={disabled} onClick={() => onChoose(segment.sourceIndex)}>
        <strong>{index + 1}. {segment.description || "暂无中文描述"}</strong><small>帧 [{segment.startFrame}, {segment.endFrame + 1})</small>
      </button>
      <button className="icon-button segment-delete" title="删除片段" aria-label={`删除机标片段 ${index + 1}`} disabled={disabled} onClick={() => onDelete(segment.sourceIndex)}><Trash2 size={15} /></button>
    </div>)}
  </div>;
});
