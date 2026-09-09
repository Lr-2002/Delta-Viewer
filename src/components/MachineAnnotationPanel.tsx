import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Code, LoaderCircle, Play, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { loadMachineAnnotation, loadMachineReview, saveMachineReview, videoSource } from "../lib/backend";
import { adjustReviewBoundary, machineTimelineMapping } from "../lib/machine-annotation";
import { FramePanel } from "./FramePanel";
import { ProofreadPlayer } from "./ProofreadPlayer";
import type { EpisodeAnnotation, EpisodeData, ExportRange, MachineAnnotation, MachineReview, MachineSegment, ReviewSegment } from "../types";

interface Props {
  data: EpisodeData;
  annotation: EpisodeAnnotation | null;
  currentFrame: number;
  previewing: boolean;
  busy: boolean;
  onPreview: (range: ExportRange, play: boolean) => void;
  onExitPreview: () => void;
}
const COLORS = ["#087e79", "#5489a3", "#b3914b", "#797895", "#628969"];
const BODY_PARTS: Record<string, string> = { whole_body: "全身", full_body: "全身", body: "全身", left_hand: "左手", right_hand: "右手", both_hands: "双手" };
const saves = new Map<string, Promise<void>>();

export function MachineAnnotationPanel(props: Props) {
  const [sourceName, setSourceName] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  return <>
    <label className="machine-source-picker">机标来源<select aria-label="机标来源" value={sourceName} disabled={props.busy || sourceBusy}
      onChange={(event) => setSourceName(event.currentTarget.value)}>
      <option value="">自动（优先 Flash）</option>
      <option value="bailian_annotation.json">原机标 / Max</option>
      <option value="bailian_annotation.qwen3.8-flash.json">3.8 Flash</option>
    </select></label>
    <MachineAnnotationEditor {...props} key={`${props.data.summary.root}:${sourceName}`} sourceName={sourceName || undefined} onSourceBusy={setSourceBusy} />
  </>;
}

function MachineAnnotationEditor({ data, annotation, busy, sourceName, onSourceBusy }: Props & { sourceName?: string; onSourceBusy: (busy: boolean) => void }) {
  const root = data.summary.root;
  const [result, setResult] = useState<MachineAnnotation | null>(null);
  const [review, setReview] = useState<MachineReview | null>(null);
  const [edits, setEdits] = useState<ReviewSegment[]>([]);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [frame, setFrame] = useState(0);
  const [fps, setFps] = useState(30);
  const [mediaFps, setMediaFps] = useState(30);
  const [playing, setPlaying] = useState(false);
  const [playRequest, setPlayRequest] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const stateRef = useRef<MachineReview | null>(null);
  const pending = useRef<ReviewSegment[] | null>(null);
  const running = useRef(false);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const loadedSource = useRef(sourceName);
  const recoveryKey = () => `dohc.machine-review.pending:${root}${loadedSource.current === "bailian_annotation.qwen3.8-flash.json" ? ":qwen3.8-flash" : ""}`;
  useEffect(() => { onSourceBusy(loading || saving || Boolean(saveError)); }, [loading, saving, saveError, onSourceBusy]);

  function persist(next: ReviewSegment[]) {
    pending.current = next;
    if (running.current || !stateRef.current) return;
    running.current = true;
    setSaving(true);
    setSaveError("");
    const job = (async () => {
      try {
        while (pending.current && stateRef.current) {
          const snapshot = pending.current;
          pending.current = null;
          const state = stateRef.current;
          const saved = await saveMachineReview(root, state.sourceHash, state.revision, snapshot, loadedSource.current);
          stateRef.current = saved;
          if (mounted.current) setReview(saved);
          if (!pending.current) localStorage.removeItem(recoveryKey());
        }
      } catch (reason) {
        if (mounted.current) setSaveError(String(reason));
      } finally {
        running.current = false;
        if (mounted.current) setSaving(false);
      }
    })();
    saves.set(root, job);
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
      setReview(state); setEdits(state.segments);
      setSelected(state.segments.find((item) => !item.deleted)?.sourceIndex ?? 0);
      setFrame(state.segments.find((item) => !item.deleted)?.startFrame ?? 0);
      const raw = localStorage.getItem(recoveryKey());
      if (raw) {
        const recovery = JSON.parse(raw) as { sourceHash: string; segments: ReviewSegment[] };
        if (recovery.sourceHash !== state.sourceHash) throw new Error("待保存草稿与原机标不匹配，请先处理草稿冲突");
        setEdits(recovery.segments); persist(recovery.segments);
      }
      const source = await videoSource(root, "cam0");
      if (active && source?.fps) { setFps(source.fps); setMediaFps(source.mediaFps || source.fps); }
    })().catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [root, revision]);

  const primary = data.summary.streams.find((stream) => stream.name === "cam0");
  const mapping = useMemo(() => result ? machineTimelineMapping(result, primary) : null, [result, primary]);
  const originals = useMemo(() => new Map(result?.segments.map((segment, index) => [segment.sourceIndex ?? index, segment])), [result]);
  const rows = useMemo(() => edits.filter((segment) => !segment.deleted).sort((a, b) => a.startFrame - b.startFrame || a.sourceIndex - b.sourceIndex), [edits]);
  const active = rows.find((segment) => segment.sourceIndex === selected) ?? rows[0];
  const current = rows.filter((segment) => frame >= segment.startFrame && frame <= segment.endFrame);
  const timelineFrame = (sourceFrame: number) => (mapping?.offset ?? 0) + sourceFrame * (mapping?.step ?? 1);
  const human = annotation?.segments.filter((segment) => timelineFrame(frame) >= segment.startFrame && timelineFrame(frame) <= segment.endFrame) ?? [];
  const valid = result && primary && mapping && !mapping.error && !error;
  const canEdit = Boolean(valid && review && !busy && !loading);
  const approved = rows.filter((segment) => segment.decision === "approved").length;
  const gaps: { start: number; end: number }[] = [];
  let covered = 0;
  for (const segment of rows) { if (segment.startFrame > covered) gaps.push({ start: covered, end: segment.startFrame }); covered = Math.max(covered, segment.endFrame + 1); }
  if (result && covered < result.frameCount) gaps.push({ start: covered, end: result.frameCount });

  function change(next: ReviewSegment[]) {
    setEdits(next); editsRef.current = next; setPlaying(false);
    try { localStorage.setItem(recoveryKey(), JSON.stringify({ sourceHash: stateRef.current?.sourceHash, segments: next })); }
    catch { setSaveError("本机应急草稿无法保存，请保持此页打开直到保存完成"); }
    persist(next);
  }
  function edit(patch: Partial<ReviewSegment>, invalidate = true) {
    if (!active || !canEdit) return;
    change(editsRef.current.map((segment) => segment.sourceIndex === active.sourceIndex
      ? { ...segment, ...patch, decision: invalidate ? "pending" : patch.decision ?? segment.decision } : segment));
  }
  function boundary(kind: "startFrame" | "endFrame", value: number) {
    if (!active || !result || !canEdit) return;
    const updated = adjustReviewBoundary(editsRef.current, active.sourceIndex, kind, value, result.frameCount);
    if (updated === editsRef.current) return;
    change(updated); setFrame(updated.find((item) => item.sourceIndex === active.sourceIndex)![kind]);
  }
  const choose = useCallback((sourceIndex: number, play = false) => {
    const segment = rows.find((item) => item.sourceIndex === sourceIndex);
    if (!segment) return;
    setSelected(sourceIndex); setFrame(segment.startFrame); setPlaying(false);
    setPlayRequest(play ? performance.now() : 0);
  }, [rows]);
  useEffect(() => {
    if (!playRequest) return;
    const id = requestAnimationFrame(() => setPlaying(true));
    return () => cancelAnimationFrame(id);
  }, [playRequest]);
  useEffect(() => {
    if (!playing || !current.length) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-source-index="${current[0].sourceIndex}"]`);
    const list = listRef.current;
    if (row && list && (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)) list.scrollTop = row.offsetTop;
  }, [current[0]?.sourceIndex, playing]);

  return <div className={`review-view proofreading-view${data.skeleton || data.skeletonError ? " has-skeleton" : ""}`}><section className="camera-section">
    <div className="section-heading compact-heading"><h2>机标校对</h2><span className="frame-counter">帧 {frame} / {result ? result.frameCount - 1 : "--"}</span></div>
    {valid && <ProofreadPlayer root={root} stream={primary} offset={mapping.offset} step={mapping.step} frameCount={result.frameCount}
      skeleton={data.skeleton} skeletonError={data.skeletonError}
      frame={frame} start={active?.startFrame ?? 0} end={active?.endFrame ?? result.frameCount - 1} playing={playing} onFrame={setFrame} onPlaying={setPlaying} />}
    <section className="machine-annotation" aria-label="机标结果">
      <header className="machine-heading"><strong>动作片段</strong><span className="machine-episode">{result?.episodeId ?? data.summary.name}</span><span className="machine-status">{rows.length} 段</span>
        <button className="icon-button" title="查看 JSON" aria-label="查看 JSON" disabled={!result} onClick={() => setShowJson(true)}><Code size={15} /></button>
        <button className="icon-button" title="重新读取机标" aria-label="重新读取机标" disabled={loading || saving || busy} onClick={() => setRevision(revision + 1)}><RefreshCw size={15} /></button>
      </header>
      {loading && <p role="status" className="machine-message"><LoaderCircle size={15} />正在读取机标</p>}
      {error && <p role="alert" className="machine-message">{error}</p>}
      {!loading && !error && !result && <p className="machine-message">未发现 {sourceName ?? "bailian_annotation.json / bailian_annotation.qwen3.8-flash.json"}</p>}
      {result && <>
        <div className="machine-metadata"><span>模型：{result.model ?? "未记录"}</span><span>人工合格 {approved} / {rows.length}</span></div>
        {mapping?.error && <p role="alert">{mapping.error}</p>}
        <div className="machine-action-strip" aria-label="动作分段条">
          {gaps.map((gap) => <span className="machine-gap" key={gap.start} title={`未标注 [${gap.start}, ${gap.end})`} style={{ left: `${gap.start / result.frameCount * 100}%`, width: `${(gap.end - gap.start) / result.frameCount * 100}%` }} />)}
          <StripSegments rows={rows} frameCount={result.frameCount} selected={active?.sourceIndex} disabled={!canEdit} onChoose={choose} />
          <i className="machine-playhead" style={{ left: `${frame / result.frameCount * 100}%` }} />
        </div>
        {gaps.length > 0 && <p className="machine-gap-label">未标注：{gaps.map((gap) => `[${gap.start}, ${gap.end})`).join("、")}</p>}
        <SegmentList rows={rows} selected={active?.sourceIndex} disabled={!canEdit} originals={originals} listRef={listRef} onChoose={choose} />
        <div className="machine-comparison"><div><span>当前帧机标</span><strong>{current.map((segment) => segment.description).join("；") || "无对应片段"}</strong></div><div><span>已保存人工标注</span><strong>{human.map((segment) => segment.note || segment.title).join("；") || "无对应片段"}</strong></div></div>
      </>}
    </section>
    {valid && <section className="machine-boundaries" aria-label="片段边界">
      {active && <div className="machine-boundary-grid">
        {[{ name: "起始", sourceFrame: active.startFrame }, { name: "结束", sourceFrame: Math.min(active.endFrame + 1, result.frameCount - 1) }].map((boundaryItem) => <div key={boundaryItem.name} data-boundary-frame={timelineFrame(boundaryItem.sourceFrame)}>
          <FramePanel root={root} stream={primary} frameId={timelineFrame(boundaryItem.sourceFrame)} playbackFps={fps * mapping.step} playbackEndFrame={timelineFrame(result.frameCount - 1)} playing={false} readAheadEnabled={false} exactFrameSeek className="machine-boundary-frame" />
          <p>{boundaryItem.name} · {((boundaryItem.name === "起始" ? active.startFrame : active.endFrame + 1) / mediaFps).toFixed(3)} s · 第 {boundaryItem.name === "起始" ? active.startFrame : active.endFrame + 1} 帧{boundaryItem.name === "结束" ? `（不含）${active.endFrame + 1 === result.frameCount ? ` · 显示末帧 ${active.endFrame}` : ""}` : ""}</p>
        </div>)}
      </div>}
      <div className="machine-review" aria-label="人工复核">
        <header className="machine-heading"><strong>人工复核</strong><span className="machine-status" role="status">{saving ? "正在保存…" : saveError ? "保存失败" : review?.published ? "复核 JSON 已保存" : "草稿已保存"}</span></header>
        {saveError && <div role="alert" className="machine-message">{saveError}<button className="icon-button" aria-label="重试保存复核" title="重试保存复核" onClick={() => persist(editsRef.current)}><RefreshCw size={15} /></button></div>}
        {active ? <>
          <label>动作描述<textarea aria-label="复核动作描述" value={active.description} disabled={!canEdit} onChange={(event) => edit({ description: event.currentTarget.value })} /></label>
          <div className="machine-review-bounds">
            <label>起始帧<input aria-label="复核起始帧" type="number" value={active.startFrame} min={0} max={active.endFrame} disabled={!canEdit} onChange={(event) => boundary("startFrame", event.currentTarget.valueAsNumber)} /></label>
            <label>结束帧（不含）<input aria-label="复核结束帧" type="number" value={active.endFrame + 1} min={active.startFrame + 1} max={result.frameCount} disabled={!canEdit} onChange={(event) => boundary("endFrame", event.currentTarget.valueAsNumber - 1)} /></label>
          </div>
          <input className="machine-boundary-slider" aria-label="微调起始帧" type="range" min={0} max={active.endFrame} step={1} value={active.startFrame} onChange={(event) => boundary("startFrame", event.currentTarget.valueAsNumber)} disabled={!canEdit} />
          <input className="machine-boundary-slider" aria-label="微调结束帧" type="range" min={active.startFrame + 1} max={result.frameCount} step={1} value={active.endFrame + 1} onChange={(event) => boundary("endFrame", event.currentTarget.valueAsNumber - 1)} disabled={!canEdit} />
          <footer className="machine-review-actions">
            <button className="button button-secondary" aria-pressed={active.decision === "approved"} disabled={!canEdit} onClick={() => edit({ decision: "approved" }, false)}><Check size={16} />合格</button>
            <button className="button button-secondary" aria-pressed={active.decision === "rejected"} disabled={!canEdit} onClick={() => edit({ decision: "rejected" }, false)}><X size={16} />不合格</button>
            <button className="icon-button" aria-label="删除当前片段" title="删除当前片段" disabled={!canEdit} onClick={() => { edit({ deleted: true }); setSelected(rows.find((segment) => segment.sourceIndex !== active.sourceIndex)?.sourceIndex ?? -1); }}><Trash2 size={16} /></button>
          </footer>
        </> : <p>没有保留的片段</p>}
        {edits.some((segment) => segment.deleted) && <button className="button button-secondary" disabled={!canEdit} onClick={() => change(edits.map((segment) => segment.deleted ? { ...segment, deleted: false, decision: "pending" } : segment))}><Undo2 size={15} />恢复删除的片段</button>}
      </div>
    </section>}
    {showJson && result && <dialog className="machine-json" aria-label="机标 JSON" ref={(node) => { if (node && !node.open) node.showModal(); }} onCancel={() => setShowJson(false)}><header className="machine-heading"><strong>{result.sourceName ?? "bailian_annotation.json"}</strong><button autoFocus className="icon-button" aria-label="关闭 JSON" title="关闭 JSON" onClick={() => setShowJson(false)}><X size={16} /></button></header><pre>{result.sourceJson ?? JSON.stringify(result, null, 2)}</pre></dialog>}
  </section></div>;
}

interface SegmentControlsProps {
  rows: ReviewSegment[];
  selected: number | undefined;
  disabled: boolean;
  onChoose: (sourceIndex: number, play?: boolean) => void;
}
const StripSegments = memo(function StripSegments({ rows, frameCount, selected, disabled, onChoose }: SegmentControlsProps & { frameCount: number }) {
  return rows.map((segment, index) => <button key={segment.sourceIndex} type="button" title={`${segment.description} [${segment.startFrame}, ${segment.endFrame + 1})`} aria-label={`选择机标片段 ${index + 1}`} aria-pressed={segment.sourceIndex === selected} disabled={disabled} onClick={() => onChoose(segment.sourceIndex)} style={{ left: `${segment.startFrame / frameCount * 100}%`, width: `${(segment.endFrame + 1 - segment.startFrame) / frameCount * 100}%`, background: COLORS[segment.sourceIndex % COLORS.length] }} />);
});
const SegmentList = memo(function SegmentList({ rows, selected, disabled, onChoose, originals, listRef }: SegmentControlsProps & { originals: Map<number, MachineSegment>; listRef: RefObject<HTMLDivElement | null> }) {
  return <div className="machine-segment-list" role="list" ref={listRef}>
    {rows.map((segment, index) => <div role="listitem" data-source-index={segment.sourceIndex} className={`machine-segment${segment.sourceIndex === selected ? " active" : ""}`} key={segment.sourceIndex}>
      <button className="machine-segment-description" aria-label={`定位机标片段 ${index + 1}`} disabled={disabled} onClick={() => onChoose(segment.sourceIndex)}>
        <strong>{index + 1}. {segment.description || originals.get(segment.sourceIndex)?.label}</strong>
        <span><em>{BODY_PARTS[String(originals.get(segment.sourceIndex)?.attributes.body_part)] ?? String(originals.get(segment.sourceIndex)?.attributes.body_part ?? "未记录")}</em> · {originals.get(segment.sourceIndex)?.label}</span>
        <small>帧 [{segment.startFrame}, {segment.endFrame + 1}) · {segment.decision === "approved" ? "合格" : segment.decision === "rejected" ? "不合格" : "待复核"}</small>
      </button>
      <button className="icon-button" title={`播放机标片段 ${index + 1}`} aria-label={`播放机标片段 ${index + 1}`} disabled={disabled} onClick={() => onChoose(segment.sourceIndex, true)}><Play size={15} /></button>
    </div>)}
  </div>;
});
