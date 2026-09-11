import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Code, LoaderCircle, Plus, RefreshCw, Scissors, Tag, Trash2, Undo2, X } from "lucide-react";
import { loadMachineAnnotation, loadMachineReview, saveMachineReview, recordAnnotationAudit } from "../lib/backend";
import { addReviewSegment, adjustReviewBoundary, deleteReviewSegment, restoreReviewSegments, machineTimelineMapping, splitReviewSegment } from "../lib/machine-annotation";
import { ProofreadPlayer } from "./ProofreadPlayer";
import { ReviewTimeline } from "./ReviewTimeline";
import type { EpisodeData, ExportRange, MachineAnnotation, MachineReview, ReviewSegment } from "../types";

interface Props {
  data: EpisodeData;
  username: string;
  busy: boolean;
  onReviewSaved?: (review: MachineReview) => void;
  onComplete?: (status: "approved" | "rejected") => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  playback?: {
    frame: number;
    onSeek: (frame: number) => void;
    onPause: () => void;
    onPlay: (range: ExportRange) => void;
    onToggle: () => void;
    controls: ReactNode;
  };
}
type Status = "pending" | "approved" | "rejected";
type Snapshot = { segments: ReviewSegment[]; status: Status; rejectionReason?: string };
type LabelLibraryItem = { id: string; text: string; createdAt: number };
const REJECTION_REASONS = ["骨架抖动", "镜头污渍", "镜头遮挡", "动作错误", "画面过曝", "其他原因"];
const LABEL_LIBRARY_LIMIT = 80;
const saves = new Map<string, Promise<boolean>>();

function labelLibraryKey(username: string) {
  return `dohc-viewer.machine-label-library.v1:${encodeURIComponent(username || "offline")}`;
}

export function MachineAnnotationPanel(props: Props) {
  const [sourceName, setSourceName] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  return <div className={`quality-workspace${props.playback ? " quality-embedded" : ""}`}>
    <label className="machine-source-picker">机标来源<select aria-label="机标来源" value={sourceName} disabled={props.busy || sourceBusy}
      onChange={(event) => { props.playback?.onPause(); setSourceName(event.currentTarget.value); }}>
      <option value="">自动（优先 Flash）</option><option value="bailian_annotation.json">3.8 Max</option><option value="bailian_annotation.qwen3.8-flash.json">3.8 Flash</option>
    </select></label>
    <MachineAnnotationEditor {...props} key={`${props.username}:${props.data.summary.root}:${sourceName}`} sourceName={sourceName || undefined} onSourceBusy={setSourceBusy} />
  </div>;
}

function MachineAnnotationEditor({ data, username, busy, sourceName, onSourceBusy, onComplete, onReviewSaved, onUnsavedChange, playback }: Props & { sourceName?: string; onSourceBusy: (busy: boolean) => void }) {
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
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reasonChoice, setReasonChoice] = useState("");
  const [otherReason, setOtherReason] = useState("");
  const [labelLibraryOpen, setLabelLibraryOpen] = useState(false);
  const [labelLibrary, setLabelLibrary] = useState<LabelLibraryItem[]>([]);
  const [labelLibraryError, setLabelLibraryError] = useState("");
  const rejectButton = useRef<HTMLButtonElement>(null);
  const boundaryFocus = useRef<"startFrame" | "endFrame">("endFrame");
  const mounted = useRef(true);
  const stateRef = useRef<MachineReview | null>(null);
  const pending = useRef<Snapshot | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const loadedSource = useRef(sourceName);
  const finishLock = useRef(false);
  const legacyRecovery = useRef(false);
  const legacyRecoveryKey = () => `dohc.machine-review.pending:${root}${loadedSource.current === "bailian_annotation.qwen3.8-flash.json" ? ":qwen3.8-flash" : ""}`;
  const recoveryKey = () => `${legacyRecoveryKey()}:account:${encodeURIComponent(username)}`;
  const [recoveryError, setRecoveryError] = useState("");
  const labelLibraryStorageKey = labelLibraryKey(username);
  const unsaved = saving || Boolean(saveError) || finishing;
  const blocksNavigation = saving || finishing || Boolean(recoveryError);
  useEffect(() => {
    setLabelLibraryOpen(false);
    setLabelLibraryError("");
    try {
      const parsed = JSON.parse(localStorage.getItem(labelLibraryStorageKey) ?? "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("Invalid label library");
      const seen = new Set<string>();
      const normalized = parsed
        .map((item): LabelLibraryItem | null => {
          if (!item || typeof item !== "object") return null;
          const candidate = item as Partial<LabelLibraryItem>;
          const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
          if (!text || seen.has(text)) return null;
          seen.add(text);
          return {
            id: typeof candidate.id === "string" && candidate.id ? candidate.id : `${Date.now()}-${seen.size}`,
            text,
            createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
          };
        })
        .filter((item): item is LabelLibraryItem => Boolean(item))
        .slice(0, LABEL_LIBRARY_LIMIT);
      setLabelLibrary(normalized);
    } catch {
      setLabelLibrary([]);
    }
  }, [labelLibraryStorageKey]);
  useEffect(() => { onSourceBusy(loading || blocksNavigation); }, [loading, blocksNavigation, onSourceBusy]);
  useEffect(() => {
    onUnsavedChange?.(blocksNavigation);
    return () => onUnsavedChange?.(false);
  }, [blocksNavigation, onUnsavedChange]);
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unsaved]);

  function persist(snapshot: Snapshot): Promise<boolean> {
    pending.current = snapshot;
    onUnsavedChange?.(true);
    try {
      localStorage.setItem(recoveryKey(), JSON.stringify({ sourceHash: stateRef.current?.sourceHash, ...snapshot }));
      setRecoveryError("");
    } catch { setRecoveryError("本机应急草稿无法保存，请保持此页打开直到保存完成"); }
    if (running.current) return running.current;
    setSaving(true); setSaveError("");
    const job = (async () => {
      try {
        while (pending.current && stateRef.current) {
          const next = pending.current;
          pending.current = null;
          const state = stateRef.current;
          try {
            const saved = await saveMachineReview(root, state.sourceHash, state.revision, next.segments, loadedSource.current, next.status, next.rejectionReason);
            stateRef.current = saved;
            if (mounted.current) { setReview(saved); onReviewSaved?.(saved); }
            if (!pending.current) {
              try {
                localStorage.removeItem(recoveryKey());
                if (legacyRecovery.current) { localStorage.removeItem(legacyRecoveryKey()); legacyRecovery.current = false; }
              } catch { /* The committed review is already durable. */ }
              if (mounted.current) setRecoveryError("");
            }
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
      const ownRaw = localStorage.getItem(recoveryKey());
      const raw = ownRaw ?? localStorage.getItem(legacyRecoveryKey());
      if (raw) {
        const recovery = JSON.parse(raw) as Snapshot & { sourceHash: string };
        // Human recovery snapshots remain valid when the reference model is updated.
        setEdits(recovery.segments); editsRef.current = recovery.segments;
        const snapshot = { segments: recovery.segments, status: recovery.status ?? "pending", rejectionReason: recovery.rejectionReason };
        if (ownRaw) void persist(snapshot);
        else {
          legacyRecovery.current = true;
          pending.current = snapshot;
          setSaveError("发现旧版未署名草稿；确认内容后点击重试保存，将关联当前账号。");
        }
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
  const outputName = "description.json";
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
  function saveLabelLibrary(next: LabelLibraryItem[]) {
    setLabelLibrary(next);
    try {
      localStorage.setItem(labelLibraryStorageKey, JSON.stringify(next));
      setLabelLibraryError("");
    } catch {
      setLabelLibraryError("标签库保存失败");
    }
  }
  function addCurrentDescriptionToLibrary() {
    const text = (active?.description ?? "").trim();
    if (!text) return;
    const existing = labelLibrary.find((item) => item.text === text);
    if (existing) {
      setLabelLibraryOpen(true);
      return;
    }
    saveLabelLibrary([
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() },
      ...labelLibrary,
    ].slice(0, LABEL_LIBRARY_LIMIT));
    void recordAnnotationAudit({ action: "label_library_added", taskId: "", trajectoryCode: "", occurredAtMs: Date.now(), detail: text });
    setLabelLibraryOpen(true);
  }
  function applyLibraryLabel(text: string) {
    if (!canEdit || !active) return;
    change(editsRef.current.map((item) => item.sourceIndex === active.sourceIndex
      ? { ...item, description: text, decision: "pending" }
      : item));
    setLabelLibraryOpen(false);
  }
  function deleteLibraryLabel(id: string) {
    const removed = labelLibrary.find((item) => item.id === id);
    saveLabelLibrary(labelLibrary.filter((item) => item.id !== id));
    if (removed) void recordAnnotationAudit({ action: "label_library_deleted", taskId: "", trajectoryCode: "", occurredAtMs: Date.now(), detail: removed.text });
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
    if (playback && mapping && !mapping.error) playback.onPlay({ startFrame: mapping.offset + segment.startFrame * mapping.step, endFrame: mapping.offset + (segment.endFrame + 1) * mapping.step - 1 });
  }, [rows, seek, playback?.onPlay, mapping]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || document.querySelector("dialog[open], [role='dialog']")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("textarea, select, [contenteditable='true'], .sidebar, .view-tabs, .label-library") || target?.matches("input:not([type='range'])")) return;
      if (event.code === "Space") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) { if (playback) playback.onToggle(); else setPlaying((value) => !value); }
        return;
      }
      if (!canEdit || !rows.length) return;
      if (target?.closest("button") && !target.closest(".machine-segment-description, .review-span, .review-edge") && event.key === "Enter") return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault(); event.stopImmediatePropagation();
        const index = Math.max(0, rows.findIndex((item) => item.sourceIndex === active?.sourceIndex));
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        if (next) choose(next.sourceIndex);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (active) boundary(boundaryFocus.current, active[boundaryFocus.current] + (event.key === "ArrowLeft" ? -1 : 1));
      } else if (event.key === "Enter" && !event.repeat) {
        event.preventDefault(); event.stopImmediatePropagation(); void finish("approved");
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
  function addSegment() {
    if (!canEdit || !result) return;
    const next = addReviewSegment(editsRef.current, visibleFrame, result.frameCount);
    if (next === editsRef.current) return;
    change(next); setSelected(next[next.length - 1].sourceIndex); seek(next[next.length - 1].startFrame);
  }
  function splitSegment() {
    if (!canEdit || !active) return;
    const next = splitReviewSegment(editsRef.current, active.sourceIndex, visibleFrame);
    if (next === editsRef.current) return;
    change(next); setSelected(next[next.length - 1].sourceIndex); seek(visibleFrame);
  }
  function deleteSegment(sourceIndex: number) {
    if (!canEdit) return;
    const next = deleteReviewSegment(editsRef.current, sourceIndex);
    if (next === editsRef.current) return;
    const removed = editsRef.current.find((item) => item.sourceIndex === sourceIndex)!;
    const retained = next.filter((item) => !item.deleted).sort((a, b) => a.startFrame - b.startFrame);
    const target = retained.find((item) => item.endFrame > removed.endFrame) ?? retained[retained.length - 1];
    change(next);
    if (target) { setSelected(target.sourceIndex); seek(target.startFrame); }
  }
  async function finish(status: "approved" | "rejected", rejectionReason?: string) {
    if (!canEdit || finishLock.current) return;
    if (status === "rejected" && !rejectionReason?.trim()) return;
    finishLock.current = true; setFinishing(true); setPlaying(false);
    playback?.onPause();
    const saved = await persist({ segments: editsRef.current, status, rejectionReason });
    finishLock.current = false; setFinishing(false);
    if (saved) { setRejectOpen(false); onUnsavedChange?.(false); onComplete?.(status); }
  }

  function openRejection() {
    playback?.onPause(); setPlaying(false);
    const previous = review?.rejectionReason ?? "";
    setReasonChoice(previous.startsWith("其他原因：") ? "其他原因" : previous);
    setOtherReason(previous.startsWith("其他原因：") ? previous.slice(5) : "");
    setRejectOpen(true);
  }
  function closeRejection() {
    if (finishing) return;
    setRejectOpen(false);
    rejectButton.current?.focus();
  }

  return <div className="quality-review proofreading-view">
    {playback ? <section className="quality-timeline" aria-label="校对时间轴">
      <div className="proofreading-transport">{playback.controls}<button className="icon-button" aria-label="分帧" title="分帧：在当前帧分割片段" disabled={!canEdit || !active || visibleFrame <= active.startFrame || visibleFrame > active.endFrame} onClick={splitSegment}><Scissors size={17} /></button></div>
      {valid && <ReviewTimeline frame={visibleFrame} frameCount={result.frameCount} start={active?.startFrame ?? 0}
        end={active?.endFrame ?? result.frameCount - 1} editable={canEdit && Boolean(active)} segments={rows}
        selected={active?.sourceIndex} onSeek={seek} onBoundary={boundary} onChoose={choose} onBoundaryFocus={(kind) => { boundaryFocus.current = kind; }} />}
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
        <button className="icon-button" title="新增片段" aria-label="新增片段" disabled={!canEdit} onClick={addSegment}><Plus size={15} /></button>
        <button className="icon-button" title="查看原始 JSON" aria-label="查看 JSON" disabled={!result} onClick={() => setShowJson(true)}><Code size={15} /></button>
        <button className="icon-button" title="重新读取机标" aria-label="重新读取机标" disabled={loading || blocksNavigation || busy} onClick={() => setReload(reload + 1)}><RefreshCw size={15} /></button>
      </header>
      {loading && <p role="status" className="machine-message"><LoaderCircle size={15} />正在读取机标</p>}
      {error && <p role="alert" className="machine-message">{error}</p>}
      {mapping?.error && <p role="alert" className="machine-message">{mapping.error}</p>}
      {!loading && !error && !result && <p className="machine-message">未发现 {sourceName ?? "机标 JSON"}</p>}
      <SegmentList rows={rows} selected={active?.sourceIndex} disabled={!canEdit} onChoose={choose}
        onDelete={deleteSegment} />
      <div className="quality-editor" aria-label="人工复核">
        <header className="machine-heading"><strong>{active ? `片段 ${rows.indexOf(active) + 1}` : "动作描述"}</strong>
          <button className="icon-button" title="恢复删除的片段" aria-label="恢复删除的片段" disabled={!canEdit || !edits.some((item) => item.deleted)} onClick={() => change(restoreReviewSegments(editsRef.current))}><Undo2 size={15} /></button>
        </header>
        <div className="quality-description-shell">
          <textarea aria-label="复核动作描述" placeholder="中文动作描述" value={active?.description ?? ""} disabled={!canEdit || !active}
            onChange={(event) => change(editsRef.current.map((item) => item.sourceIndex === active?.sourceIndex ? { ...item, description: event.currentTarget.value, decision: "pending" } : item))} />
          <div className="quality-description-tools">
            <button type="button" className="label-library-trigger" aria-expanded={labelLibraryOpen} aria-haspopup="dialog"
              disabled={!canEdit || !active} onClick={() => setLabelLibraryOpen((open) => !open)}>
              <Tag size={14} />标签库{labelLibrary.length > 0 && <span>{labelLibrary.length}</span>}
            </button>
          </div>
          {labelLibraryOpen && <div className="label-library" role="dialog" aria-label="标签库">
            <header>
              <strong>标签库</strong>
              <button type="button" className="icon-button" aria-label="关闭标签库" title="关闭" onClick={() => setLabelLibraryOpen(false)}><X size={15} /></button>
            </header>
            <button type="button" className="label-library-save" disabled={!(active?.description ?? "").trim()} onClick={addCurrentDescriptionToLibrary}>
              <Plus size={14} />保存当前描述
            </button>
            {labelLibraryError && <p className="label-library-error" role="alert">{labelLibraryError}</p>}
            {labelLibrary.length ? <div className="label-library-list" role="list">
              {labelLibrary.map((item) => <div className="label-library-item" role="listitem" key={item.id}>
                <button type="button" className="label-library-use" title={`使用：${item.text}`} onClick={() => applyLibraryLabel(item.text)}>{item.text}</button>
                <button type="button" className="icon-button label-library-delete" aria-label={`删除标签：${item.text}`} title="删除" onClick={() => deleteLibraryLabel(item.id)}><Trash2 size={14} /></button>
              </div>)}
            </div> : <p className="label-library-empty">暂无常用描述</p>}
          </div>}
        </div>
      </div>
      <footer className="quality-footer">
        <div className="quality-save-state" role="status">{saving ? "正在保存…" : saveError ? "保存失败" : review?.published ? "review 已实时保存" : "尚无人工修改"}
          {review?.versionId && <span className="review-revision" title={review.revisionLabel ?? review.versionId}>{review.revisionLabel ?? `${review.versionId} · 历史审核记录`}</span>}
        </div>
        {recoveryError && <p role="alert" className="machine-message">{recoveryError}</p>}
        {saveError && <div role="alert" className="machine-message">{saveError}<button className="icon-button" aria-label="重试保存复核" title="重试保存复核" onClick={() => void persist(pending.current ?? { segments: editsRef.current, status: "pending" })}><RefreshCw size={15} /></button></div>}
        <div className="quality-output" title={`${root}/${outputName}`}>{outputName}<span>{review?.status === "approved" ? "已通过" : review?.status === "rejected" ? "未通过" : "待审核"}</span></div>
        {review?.status === "rejected" && review.rejectionReason && <p className="review-rejection-reason" title={review.rejectionReason}>不通过：{review.rejectionReason}</p>}
        <div className="quality-decisions">
          <button ref={rejectButton} className="button button-secondary" disabled={!canEdit} onClick={openRejection}><X size={16} />不通过</button>
          <button className="button button-primary" disabled={!canEdit || !rows.length} onClick={() => void finish("approved")}><Check size={16} />通过</button>
        </div>
      </footer>
    </section>
    {rejectOpen && <dialog className="rejection-dialog" aria-labelledby="rejection-title" ref={(node) => { if (node && !node.open) node.showModal(); }}
      onCancel={(event) => { event.preventDefault(); closeRejection(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (reasonChoice && (reasonChoice !== "其他原因" || otherReason.trim())) void finish("rejected", reasonChoice === "其他原因" ? `其他原因：${otherReason.trim()}` : reasonChoice); }}>
        <header><h2 id="rejection-title">不通过原因</h2><button type="button" className="icon-button" aria-label="关闭不通过原因" title="关闭" disabled={finishing} onClick={closeRejection}><X size={18} /></button></header>
        <div className="rejection-options" role="group" aria-label="原因选项">
          {REJECTION_REASONS.map((reason, index) => <button key={reason} autoFocus={index === 0} type="button" className="button button-secondary" aria-pressed={reasonChoice === reason} disabled={finishing} onClick={() => setReasonChoice(reason)}>{reason}</button>)}
        </div>
        {reasonChoice === "其他原因" && <label className="rejection-detail">其他原因<textarea autoFocus aria-label="其他原因内容" required maxLength={1000} value={otherReason} disabled={finishing} onChange={(event) => setOtherReason(event.currentTarget.value)} /></label>}
        {saveError && <p role="alert" className="machine-message">{saveError}</p>}
        <footer><button type="button" className="button button-secondary" disabled={finishing} onClick={closeRejection}>取消</button>
          <button type="submit" className="button button-primary" disabled={!canEdit || !reasonChoice || (reasonChoice === "其他原因" && !otherReason.trim())}>{finishing ? <LoaderCircle size={16} className="spin" /> : <X size={16} />}确认不通过</button></footer>
      </form>
    </dialog>}
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
