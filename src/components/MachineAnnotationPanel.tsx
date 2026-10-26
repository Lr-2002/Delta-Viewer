import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Code, LoaderCircle, Plus, RefreshCw, Scissors, Tag, Trash2, Undo2, X } from "lucide-react";
import { deferMachineReview, isTauriRuntime, listMachineAnnotationSources, loadMachineAnnotation, loadMachineReview, saveMachineReview, videoSource } from "../lib/backend";
import { createDeferredReviewEvent, enqueueCommittedReviewEvent, reviewReceiptValue, persistPendingReviewAudit, requireReviewAuditSession, recordReviewInteraction, reviewAuditRecorder } from "../lib/review-audit";
import { createReviewBoundaryEditor, addReviewSegment, recoverReviewSegments, reviewVideoIntersection, deleteReviewSegment, restoreReviewSegments, machineTimelineMapping, splitReviewSegment } from "../lib/machine-annotation";
import { ProofreadPlayer } from "./ProofreadPlayer";
import { ReviewTimeline } from "./ReviewTimeline";
import { RejectionReasons } from "./RejectionReasons";
import { MachineIdentityNotice } from "./MachineIdentityNotice";
import type { EpisodeData, ExportRange, MachineAnnotation, MachineReview, ReviewSegment } from "../types";
import { defaultTextPolicy, inspectDescription } from "../lib/text-quality";
import "./text-quality.css";

interface Props {
  data: EpisodeData;
  username: string;
  busy: boolean;
  suspended?: boolean;
  onReviewSaved?: (review: MachineReview) => void;
  onComplete?: (status: "approved" | "rejected", local?: boolean) => void;
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
const LABEL_LIBRARY_LIMIT = 80;
const SKELETON_SOURCE = "skeleton.description.json";
const SKELETON_LABELS = ["往前走", "抬肘", "踢腿", "蹲下", "顶门", "关上洗碗机"];
const saves = new Map<string, Promise<boolean>>();
export async function flushMachineReviewSaves(root?: string) {
  if (!root) return;
  while (saves.has(root)) {
    const job = saves.get(root);
    if (!await job) throw new Error("当前修改保存失败，请重试保存后再更新");
    if (saves.get(root) === job) return;
  }
}

function labelLibraryKey(username: string) {
  return `dohc-viewer.machine-label-library.v1:${encodeURIComponent(username || "offline")}`;
}

export function MachineAnnotationPanel(props: Props) {
  const [sourceName, setSourceName] = useState("");
  const [channel, setChannel] = useState<"action" | "skeleton">("action");
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  useEffect(() => {
    let active = true;
    setSourceName(""); setSourceOptions([]); setSourceError("");
    void listMachineAnnotationSources(props.data.summary.root).then((options) => { if (active) setSourceOptions(options); }).catch((error) => { if (active) setSourceError(String(error)); });
    return () => { active = false; };
  }, [props.data.summary.root]);
  const label = (name: string) => /(^|\/)(description|desorption)\.json$/.test(name) ? `人工结果（${name}）` : name;
  return <div className={`quality-workspace${props.playback ? " quality-embedded" : ""}`}>
    {channel === "action" && <label className="machine-source-picker">机标来源<select aria-label="机标来源" value={sourceName} disabled={props.busy || sourceBusy}
      onChange={(event) => { props.playback?.onPause(); setSourceName(event.currentTarget.value); recordReviewInteraction("source", { sourceName: event.currentTarget.value || "auto" }); }}>
      <option value="">自动（优先 Flash）</option>{sourceOptions.map((name) => <option key={name} value={name}>{label(name)}</option>)}
    </select></label>}
    {channel === "action" && sourceError && <p role="alert">{sourceError}</p>}
    <MachineAnnotationEditor {...props} key={`${props.username}:${props.data.summary.root}:${channel}:${sourceName}`} sourceName={channel === "skeleton" ? SKELETON_SOURCE : sourceName || undefined} onSourceBusy={setSourceBusy} channel={channel} onChannelChange={setChannel} />
  </div>;
}

function MachineAnnotationEditor({ data, username, busy, suspended = false, sourceName, onSourceBusy, onComplete, onReviewSaved, onUnsavedChange, playback, channel, onChannelChange }: Props & { sourceName?: string; onSourceBusy: (busy: boolean) => void; channel: "action" | "skeleton"; onChannelChange: (channel: "action" | "skeleton") => void }) {
  const root = data.summary.root;
  const skeletonMode = channel === "skeleton";
  const [result, setResult] = useState<MachineAnnotation | null>(null);
  const [review, setReview] = useState<MachineReview | null>(null);
  const [edits, setEdits] = useState<ReviewSegment[]>([]);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSlow, setSaveSlow] = useState(false);
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
  const [boundariesConfirmed, setBoundariesConfirmed] = useState(false);
  const [timelineAdapted, setTimelineAdapted] = useState(false);
  const [rangeRepairOpen, setRangeRepairOpen] = useState(false);
  const [rangeRepairConfirmed, setRangeRepairConfirmed] = useState(false);
  const [labelLibraryOpen, setLabelLibraryOpen] = useState(false);
  const [labelLibrary, setLabelLibrary] = useState<LabelLibraryItem[]>([]);
  const [labelLibraryError, setLabelLibraryError] = useState("");
  const [draggedLabelId, setDraggedLabelId] = useState<string | null>(null);
  const [labelDropTarget, setLabelDropTarget] = useState<number | null>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const applyLabelRef = useRef<(text: string) => void>(() => {});
  const textPolicy = defaultTextPolicy;
  const [ignoredText, setIgnoredText] = useState<Set<string>>(new Set());
  const [textUndo, setTextUndo] = useState<{index: number; before: string; after: string} | null>(null);
  const [textCheckOpen, setTextCheckOpen] = useState(false);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const boundaryFocus = useRef<"startFrame" | "endFrame" | "playhead">("endFrame");
  const boundaryEditor = useRef(createReviewBoundaryEditor());
  const mounted = useRef(true);
  const stateRef = useRef<MachineReview | null>(null);
  const originalDurationMs = useRef<number | null>(null);
  const pending = useRef<Snapshot | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const loadedSource = useRef(sourceName);
  const finishLock = useRef(false);
  const legacyRecovery = useRef(false);
  const legacyRecoveryKey = () => `dohc.machine-review.pending:${root}${!loadedSource.current || loadedSource.current === "bailian_annotation.json" ? "" : loadedSource.current === "bailian_annotation.qwen3.8-flash.json" ? ":qwen3.8-flash" : `:source:${encodeURIComponent(loadedSource.current)}`}`;
  const recoveryKey = () => `${legacyRecoveryKey()}:account:${encodeURIComponent(username)}`;
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryMessages, setRecoveryMessages] = useState<string[]>([]);
  const [auditCompletionError, setAuditCompletionError] = useState("");
  const [auditPreparationError, setAuditPreparationError] = useState("");
  const completionAwaitingAudit = useRef<"approved" | "rejected" | null>(null);
  const labelLibraryStorageKey = skeletonMode ? `${labelLibraryKey(username)}:skeleton` : labelLibraryKey(username);
  const unsaved = saving || Boolean(saveError) || finishing || Boolean(auditCompletionError);
  const blocksNavigation = saving || finishing || Boolean(recoveryError) || Boolean(auditCompletionError);
  useEffect(() => {
    setLabelLibraryOpen(false);
    setLabelLibraryError("");
    try {
      const defaults = skeletonMode ? SKELETON_LABELS.map((text, i) => ({ id: `skeleton-default-${i}`, text, createdAt: 0 })) : [];
      const parsed = JSON.parse(localStorage.getItem(labelLibraryStorageKey) ?? JSON.stringify(defaults)) as unknown;
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
  }, [labelLibraryStorageKey, skeletonMode]);
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
  useEffect(() => {
    setSaveSlow(false);
    if (!saving) return;
    const timer = window.setTimeout(() => setSaveSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [saving]);

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
          const audit = reviewAuditRecorder(root);
          try {
            const deferredAudit = await createDeferredReviewEvent(root, data.summary.name, next.status === "pending" ? "saved" : next.status, next.rejectionReason ?? "");
            deferredAudit.details.sourceName = loadedSource.current ?? "auto";
            deferredAudit.details.revision = deferredAudit.eventId.replaceAll("-", "");
            deferredAudit.details.target = "审核结果";
            if (originalDurationMs.current !== null) deferredAudit.details.durationMs = originalDurationMs.current;
            let saved: MachineReview;
            try {
              saved = await saveMachineReview(root, state.sourceHash, state.revision, next.segments, loadedSource.current, next.status, next.rejectionReason, [deferredAudit.eventId, deferredAudit.occurredAtMs], { base: state, audit: deferredAudit });
            } catch (cause) {
              const message = String(cause);
              if (!skeletonMode || !/REVIEW_STORAGE_|SOURCE_UNAVAILABLE|SOURCE_REVIEW_DEFERRED|I\/O 错误/.test(message)) throw cause;
              saved = await deferMachineReview({ sourcePath: root, sourceName: loadedSource.current, sourceHash: state.sourceHash, expectedRevision: state.revision, segments: next.segments, status: next.status, rejectionReason: next.rejectionReason }, state, message, deferredAudit);
            }
            if (!saved.pendingSourceWrite && (skeletonMode || !isTauriRuntime())) {
              deferredAudit.details.revision = saved.revisionLabel ?? String(saved.revision);
              deferredAudit.details.value = await reviewReceiptValue(root, deferredAudit, "nas", loadedSource.current);
              enqueueCommittedReviewEvent(deferredAudit);
            }
            stateRef.current = saved;
            if (mounted.current) { setReview(saved); if (!skeletonMode) onReviewSaved?.(saved); }
            if (!pending.current) {
              try {
                localStorage.removeItem(recoveryKey());
                if (legacyRecovery.current) { localStorage.removeItem(legacyRecoveryKey()); legacyRecovery.current = false; }
              } catch { /* The committed review is already durable. */ }
              if (mounted.current) setRecoveryError("");
            }
          } catch (reason) { audit("save_failed", { reason: "审核写入失败，等待重试" }); pending.current ??= next; throw reason; }
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
    void videoSource(root, "cam0").then(video => {
      const camera = data.summary.streams.find(stream => stream.name === "cam0");
      if (active && camera?.frameCount && video?.mediaFps && video.mediaFps > 0) originalDurationMs.current = camera.frameCount / video.mediaFps * 1000;
    }).catch(() => { /* Unavailable source duration remains unknown. */ });
    setLoading(true); setReview(null); stateRef.current = null; setError(""); setRecoveryMessages([]); setPlaying(false); setBoundariesConfirmed(false); setTimelineAdapted(false); setRangeRepairOpen(false); setRangeRepairConfirmed(false);
    boundaryEditor.current.reset();
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
      const videoCount = data.summary.streams.find(stream => stream.name === "cam0")?.frameCount;
      if (videoCount && (!loaded.videoFrameCount || loaded.videoFrameCount === videoCount) && loaded.frameCount !== videoCount && (state.localDraft || state.published || state.pendingSourceWrite || state.revision > 0)
        && segments.every(item => item.deleted || item.endFrame < videoCount)) setTimelineAdapted(true);
      setReview(state); setEdits(segments); editsRef.current = segments;
      setSelected(segments.find((item) => !item.deleted)?.sourceIndex ?? 0);
      setFrame(segments.find((item) => !item.deleted)?.startFrame ?? 0);
      const ownRaw = localStorage.getItem(recoveryKey());
      const raw = ownRaw ?? localStorage.getItem(legacyRecoveryKey());
      if (raw) {
        let recovery: Snapshot & { sourceHash: string };
        try { recovery = JSON.parse(raw); } catch { recovery = {} as typeof recovery; }
        const restored = recoverReviewSegments(recovery?.segments, videoCount ?? loaded.frameCount, loaded.frameCount);
        const invalidStatus = !["pending", "approved", "rejected"].includes(recovery?.status ?? "pending");
        if (!restored.segments || restored.repaired || invalidStatus) {
          try {
            const backupKey = `${recoveryKey()}:preserved:${crypto.randomUUID()}`;
            localStorage.setItem(backupKey, raw);
          } catch {
            setRecoveryError("旧应急草稿需要兼容恢复，但本机备份失败；已保留原草稿，请保持此页打开后重试保存。");
            return;
          }
          setRecoveryMessages([restored.segments
            ? "旧应急草稿的重复索引或旧状态已兼容修复，动作文字与边界保留，原记录已在本机备份。"
            : "旧应急草稿的片段范围或格式不适用于当前视频，原记录已在本机备份，当前显示已加载的机标或人工结果。"]);
        }
        if (!restored.segments) return;
        if (videoCount && (!loaded.videoFrameCount || loaded.videoFrameCount === videoCount) && loaded.frameCount !== videoCount
          && restored.segments.every(item => item.deleted || item.endFrame < videoCount)) setTimelineAdapted(true);
        setEdits(restored.segments); editsRef.current = restored.segments;
        const snapshot = { segments: restored.segments, status: restored.repaired || invalidStatus ? "pending" as const : recovery.status ?? "pending", rejectionReason: recovery.rejectionReason };
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
  const editFrameCount = timelineAdapted && primary ? primary.frameCount : result?.frameCount ?? 0;
  const mapping = useMemo(() => result ? machineTimelineMapping({ ...result, frameCount: editFrameCount }, primary) : null, [result, editFrameCount, primary]);
  const rangeRepair = useMemo(() => result && primary && !skeletonMode && result.frameCount !== primary.frameCount
    && (!result.videoFrameCount || result.videoFrameCount === primary.frameCount)
    ? reviewVideoIntersection(edits, primary.frameCount) : null, [result, primary, edits, skeletonMode]);
  const sourceOverflow = Boolean(result && primary && result.segments.some(item => item.endFrame >= primary.frameCount));
  const requiresBoundaryCheck = Boolean(result?.inferredEndFrames?.length || (timelineAdapted && sourceOverflow));
  const rows = useMemo(() => edits.filter((segment) => !segment.deleted).sort((a, b) => a.startFrame - b.startFrame || a.sourceIndex - b.sourceIndex), [edits]);
  const active = rows.find((segment) => segment.sourceIndex === selected) ?? rows[0];
  const issueKey = (index: number, description: string, original: string) => JSON.stringify([index,description,original]);
  const descriptionIssues = active ? inspectDescription(active.description, textPolicy).filter(issue => !ignoredText.has(issueKey(active.sourceIndex, active.description, issue.original))) : [];
  const allTextIssues = rows.flatMap(row => inspectDescription(row.description, textPolicy).filter(issue => !ignoredText.has(issueKey(row.sourceIndex,row.description,issue.original))).map(issue=>({...issue,row})));
  const valid = result && primary && mapping && !mapping.error && !error;
  const canEdit = Boolean(valid && review && !busy && !loading && !finishing && !auditCompletionError);
  applyLabelRef.current = applyLibraryLabel;
  useEffect(() => {
    if (!canEdit || !active || !labelLibrary.length) return;
    let digits = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); digits = ""; };
    const available = (target: HTMLElement | null) => {
      if (document.querySelector("dialog[open], [role='dialog']:not(.label-library)") || draggedLabelId) return false;
      if (target?.closest("input, select, textarea, [contenteditable]:not([contenteditable='false'])")) {
        return labelLibraryOpen && target === descriptionInput.current;
      }
      return !target?.closest(".sidebar, .view-tabs");
    };
    const apply = () => {
      const item = labelLibrary[Number(digits) - 1];
      cancel();
      if (!item || !available(document.activeElement as HTMLElement | null)) return;
      recordReviewInteraction("shortcut", { value: `标签 ${labelLibrary.indexOf(item) + 1}`, labelId: item.id }, root);
      applyLabelRef.current(item.text);
    };
    const handler = (event: KeyboardEvent) => {
      if (suspended) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.keyCode === 229 || !/^[0-9]$/.test(event.key) || !available(event.target as HTMLElement | null)) { cancel(); return; }
      if (event.repeat) { event.preventDefault(); return; }
      const next = digits + event.key;
      const number = Number(next);
      if (!number || number > labelLibrary.length) { cancel(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      digits = next;
      clearTimeout(timer);
      // Wait only when the number can prefix a larger slot, e.g. 1 -> 10.
      if (number * 10 <= labelLibrary.length) timer = setTimeout(apply, 650);
      else apply();
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("focusin", cancel);
    return () => {
      cancel();
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("focusin", cancel);
    };
  }, [canEdit, suspended, active?.sourceIndex, labelLibrary, labelLibraryOpen, draggedLabelId, root]);
  const outputName = skeletonMode ? SKELETON_SOURCE : loadedSource.current?.endsWith("desorption.json") ? "desorption.json" : review?.outputName || "description.json";
  const seek = useCallback((next: number) => {
    setFrame(next); setPlaying(false);
    if (mapping && !mapping.error) playback?.onSeek(mapping.offset + next * mapping.step);
  }, [mapping, playback?.onSeek]);
  const visibleFrame = playback && result && mapping && !mapping.error
    ? Math.max(0, Math.min(editFrameCount - 1, Math.floor((playback.frame - mapping.offset) / mapping.step))) : frame;

  function change(next: ReviewSegment[], boundaryEdit = false) {
    if (!canEdit || finishLock.current) return;
    if (!boundaryEdit) boundaryEditor.current.reset();
    if (timelineAdapted && sourceOverflow) setBoundariesConfirmed(false);
    for (const item of next) {
      const old = editsRef.current.find((row) => row.sourceIndex === item.sourceIndex);
      if (!old || old.description !== item.description || old.startFrame !== item.startFrame || old.endFrame !== item.endFrame || old.deleted !== item.deleted) {
        recordReviewInteraction("segment_edit", { segmentIndex: item.sourceIndex, startFrame: item.startFrame, endFrame: item.endFrame, before: old?.description ?? "", after: item.description, value: !old ? "新增片段" : item.deleted ? "删除片段" : old.deleted ? "恢复片段" : "修改片段" }, root);
      }
    }
    setEdits(next); editsRef.current = next; setPlaying(false);
    playback?.onPause();
    void persist({ segments: next, status: "pending" });
  }
  function saveLabelLibrary(next: LabelLibraryItem[]) {
    try {
      localStorage.setItem(labelLibraryStorageKey, JSON.stringify(next));
      setLabelLibrary(next);
      setLabelLibraryError("");
      return true;
    } catch {
      setLabelLibraryError("标签库保存失败");
      return false;
    }
  }
  function addCurrentDescriptionToLibrary() {
    if (!canEdit) return;
    const text = (active?.description ?? "").trim();
    if (!text) return;
    const existing = labelLibrary.find((item) => item.text === text);
    if (existing) {
      setLabelLibraryOpen(true);
      return;
    }
    if (labelLibrary.length >= LABEL_LIBRARY_LIMIT) { setLabelLibraryError("标签库已满，请删除不需要的标签后再添加"); return; }
    const label = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    const saved = saveLabelLibrary([
      ...labelLibrary,
      label,
    ]);
    if (saved) {
      recordReviewInteraction("label_add", { value: text, labelId: label.id }, root);
    }
    setLabelLibraryOpen(true);
  }
  function applyLibraryLabel(text: string) {
    if (!canEdit || !active || finishLock.current) return;
    recordReviewInteraction("label_apply", { value: text, segmentIndex: active.sourceIndex }, root);
    change(editsRef.current.map((item) => item.sourceIndex === active.sourceIndex
      ? { ...item, description: text, decision: "pending" }
      : item));
    setLabelLibraryOpen(false);
  }
  function deleteLibraryLabel(id: string) {
    if (!canEdit) return;
    const removed = labelLibrary.find((item) => item.id === id);
    const saved = saveLabelLibrary(labelLibrary.filter((item) => item.id !== id));
    if (saved && removed) recordReviewInteraction("label_delete", { value: removed.text, labelId: id }, root);
  }
  function reorderLibraryLabel(targetId: string) {
    if (!canEdit || !draggedLabelId || draggedLabelId === targetId) return;
    const from = labelLibrary.findIndex((item) => item.id === draggedLabelId);
    const to = labelLibrary.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...labelLibrary];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    if (saveLabelLibrary(next)) recordReviewInteraction("control", { target: "label_library_order", labelId: moved.id, value: moved.text, before: String(from + 1), after: String(to + 1) }, root);
  }
  function boundary(kind: "startFrame" | "endFrame", value: number) {
    if (!active || !result || !canEdit || finishLock.current) return;
    const updated = boundaryEditor.current.commit(editsRef.current, active.sourceIndex, kind, value, editFrameCount);
    if (updated === editsRef.current) return;
    change(updated, true); seek(updated.find((item) => item.sourceIndex === active.sourceIndex)![kind]);
  }
  function previewBoundary(kind: "startFrame" | "endFrame", value: number) {
    return active ? boundaryEditor.current.preview(editsRef.current, active.sourceIndex, kind, value, editFrameCount) : editsRef.current;
  }
  const choose = useCallback((sourceIndex: number) => {
    const segment = rows.find((item) => item.sourceIndex === sourceIndex);
    if (!segment) return;
    recordReviewInteraction("segment_select", { segmentIndex: sourceIndex, startFrame: segment.startFrame, endFrame: segment.endFrame }, root);
    setSelected(sourceIndex); seek(segment.startFrame);
    if (playback && mapping && !mapping.error) playback.onPlay({ startFrame: mapping.offset + segment.startFrame * mapping.step, endFrame: mapping.offset + (segment.endFrame + 1) * mapping.step - 1 });
  }, [rows, seek, playback?.onPlay, mapping]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (suspended) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || document.querySelector("dialog[open], [role='dialog']")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("textarea, select, [contenteditable='true'], .sidebar, .view-tabs, .label-library") || target?.matches("input:not([type='range'])")) return;
      if (event.code === "Space") {
        if (!event.repeat) recordReviewInteraction("shortcut", { value: event.code }, root);
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) { if (playback) playback.onToggle(); else setPlaying((value) => !value); }
        return;
      }
      if (!canEdit || !rows.length) return;
      if (target?.closest("button") && !target.closest(".machine-segment-description, .review-span, .review-edge") && event.key === "Enter") return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        recordReviewInteraction("shortcut", { value: event.code }, root);
        event.preventDefault(); event.stopImmediatePropagation();
        const index = Math.max(0, rows.findIndex((item) => item.sourceIndex === active?.sourceIndex));
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        if (next) choose(next.sourceIndex);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        recordReviewInteraction("shortcut", { value: event.code }, root);
        event.preventDefault(); event.stopImmediatePropagation();
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        if (boundaryFocus.current === "playhead" && result) seek(Math.max(0, Math.min(editFrameCount - 1, visibleFrame + delta)));
        else if (active && boundaryFocus.current !== "playhead") boundary(boundaryFocus.current, active[boundaryFocus.current] + delta);
      } else if (event.code === "KeyX" || event.key.toLowerCase() === "x") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) {
          recordReviewInteraction("shortcut", { value: event.code }, root);
          splitSegment();
        }
      } else if (event.key === "Enter" && !event.repeat && !skeletonMode) {
        recordReviewInteraction("shortcut", { value: event.code }, root);
        event.preventDefault(); event.stopImmediatePropagation(); void finish("approved");
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
  function addSegment() {
    if (!canEdit || !result) return;
    const next = addReviewSegment(editsRef.current, visibleFrame, editFrameCount);
    if (next === editsRef.current) return;
    change(next); setSelected(next[next.length - 1].sourceIndex); seek(next[next.length - 1].startFrame);
  }
  function splitSegment() {
    if (!canEdit || !active) return;
    // Keep the command useful when the playhead is on an edge: split at the
    // nearest valid interior frame instead of silently doing nothing.
    const splitFrame = Math.max(active.startFrame + 1, Math.min(active.endFrame, visibleFrame));
    const next = splitReviewSegment(editsRef.current, active.sourceIndex, splitFrame);
    if (next === editsRef.current) return;
    change(next); setSelected(next[next.length - 1].sourceIndex); seek(splitFrame);
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
  function confirmVideoRange() {
    if (!rangeRepair || !rangeRepairConfirmed || !primary || !review || loading || error || saving || busy || finishLock.current || running.current) return;
    const next = rangeRepair.segments;
    boundaryEditor.current.reset();
    setTimelineAdapted(true); setBoundariesConfirmed(false); setRangeRepairOpen(false);
    setEdits(next); editsRef.current = next;
    const first = next.find(item => !item.deleted);
    setSelected(first?.sourceIndex ?? 0); setFrame(first?.startFrame ?? 0);
    playback?.onPause(); playback?.onSeek(primary.firstFrame ?? 0);
    recordReviewInteraction("control", { target: "video_range_repair", value: `人工确认当前视频范围，截去 ${rangeRepair.trimmed} 段越界部分，排除 ${rangeRepair.excluded} 段`, before: String(result?.frameCount), after: String(primary.frameCount) }, root);
    void persist({ segments: next, status: "pending" });
  }
  async function finish(status: "approved" | "rejected", rejectionReason?: string, textConfirmed = false) {
    if (!canEdit || finishLock.current || running.current) return;
    if (status === "approved" && requiresBoundaryCheck && !boundariesConfirmed) return;
    if (status === "rejected" && !rejectionReason?.trim()) return;
    if (status === "approved" && allTextIssues.length > 0 && !textConfirmed) {
      playback?.onPause(); setPlaying(false); setTextCheckOpen(true); return;
    }
    finishLock.current = true; setFinishing(true); setPlaying(false);
    setAuditPreparationError("");
    playback?.onPause();
    try {
      requireReviewAuditSession(root);
      // Persist loaded/operations before committing a conclusion. Network
      // availability is not required; the native outbox is sufficient.
      await persistPendingReviewAudit();
      const saved = await persist({ segments: editsRef.current, status, rejectionReason });
      if (saved) {
        completionAwaitingAudit.current = status;
        setRejectOpen(false);
        await finishAuditCompletion();
      }
    } catch (reason) {
      setRejectOpen(false);
      setAuditPreparationError(`尚未提交审核结论：${String(reason)}。恢复后请重新点击通过或不通过。`);
    } finally {
      finishLock.current = false; setFinishing(false);
    }
  }

  async function finishAuditCompletion() {
    const status = completionAwaitingAudit.current;
    if (!status) return;
    setFinishing(true);
    try {
      await persistPendingReviewAudit();
      completionAwaitingAudit.current = null;
      setAuditCompletionError(""); setRejectOpen(false);
      onUnsavedChange?.(false); onComplete?.(status, stateRef.current?.pendingSourceWrite);
    } catch (reason) {
      // The source conclusion is already committed. Retry ONLY persistence,
      // never repeat the save or invent another revision/submission time.
      setAuditCompletionError(`审核结论已保存，操作记录尚未落盘，请保持当前数据打开：${String(reason)}`);
      onUnsavedChange?.(true);
    } finally { setFinishing(false); }
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
      <div className="proofreading-transport">{playback.controls}<button className="icon-button" type="button" aria-label="剪切片段" aria-keyshortcuts="X" title="剪切片段：在当前帧分割 (X)" disabled={!canEdit || !active || active.endFrame <= active.startFrame} onClick={splitSegment}><Scissors size={17} /></button></div>
      {valid && <ReviewTimeline frame={visibleFrame} frameCount={editFrameCount} start={active?.startFrame ?? 0}
        end={active?.endFrame ?? editFrameCount - 1} editable={canEdit && Boolean(active)} segments={rows}
        selected={active?.sourceIndex} onSeek={seek} onBoundary={boundary} previewBoundary={previewBoundary} onChoose={choose} onBoundaryFocus={(kind) => { boundaryFocus.current = kind; }} />}
      {!valid && primary?.firstFrame !== null && primary?.lastFrame !== null && primary && <input
        className="machine-boundary-slider" type="range" aria-label="校对播放帧" min={primary.firstFrame} max={primary.lastFrame}
        value={playback.frame} onChange={(event) => playback.onSeek(event.currentTarget.valueAsNumber)} />}
    </section> : <section className="quality-media" aria-label="视频与骨架">
      <header className="quality-heading"><h2>机标校对</h2><span className="frame-counter">帧 {frame} / {result ? editFrameCount - 1 : "--"}</span></header>
      {valid && <ProofreadPlayer root={root} stream={primary} offset={mapping.offset} step={mapping.step} frameCount={editFrameCount}
        skeleton={data.skeleton} skeletonError={data.skeletonError} segments={rows} selected={active?.sourceIndex}
        editable={canEdit && Boolean(active)} onBoundary={boundary} previewBoundary={previewBoundary} onChoose={choose} onBoundaryFocus={(kind) => { boundaryFocus.current = kind; }}
        frame={frame} start={active?.startFrame ?? 0} end={active?.endFrame ?? editFrameCount - 1} playing={playing} onFrame={setFrame} onPlaying={setPlaying} />}
    </section>}
    <section className="quality-inspector" aria-label="机标结果">
      <header className="machine-heading"><div className="segment-channel-tabs" role="tablist" aria-label="片段类型">
        {(["action", "skeleton"] as const).map(value => <button type="button" role="tab" key={value} aria-selected={channel === value} className={channel === value ? "active" : ""} disabled={loading || blocksNavigation || Boolean(saveError) || busy} onClick={() => { playback?.onPause(); onChannelChange(value); }}>{value === "action" ? "动作片段" : "骨架片段"}</button>)}
      </div><span className="machine-status">{rows.length} 段</span>
        <button className="icon-button" title="新增片段" aria-label="新增片段" disabled={!canEdit} onClick={addSegment}><Plus size={15} /></button>
        <button className="icon-button" title="查看原始 JSON" aria-label="查看 JSON" disabled={!result} onClick={() => setShowJson(true)}><Code size={15} /></button>
        <button className="icon-button" title={skeletonMode ? "重新读取骨架描述" : "重新读取机标"} aria-label={skeletonMode ? "重新读取骨架描述" : "重新读取机标"} disabled={loading || blocksNavigation || busy} onClick={() => setReload(reload + 1)}><RefreshCw size={15} /></button>
      </header>
      {loading && <p role="status" className="machine-message"><LoaderCircle size={15} />{skeletonMode ? "正在读取骨架描述" : "正在读取机标"}</p>}
      {error && <p role="alert" className="machine-message">{error}</p>}
      {mapping?.error && <div role="alert" className="machine-message"><p>{mapping.error}</p>
        {rangeRepair && <><p>机标范围与当前视频不一致，原因尚未确定。可核对后处理越界范围，或从“机标来源”选择其他文件。</p><button type="button" className="button button-secondary" disabled={busy || loading || saving || !review || Boolean(error)} onClick={() => { playback?.onPause(); setRangeRepairConfirmed(false); setRangeRepairOpen(true); }}>查看越界片段并处理</button></>}
        {result?.videoFrameCount && primary && result.videoFrameCount !== primary.frameCount ? <p>载入后视频清单发生变化，请重新加载当前数据后再处理，避免使用过期帧数。</p> : null}
      </div>}
      {timelineAdapted && sourceOverflow && <div className="machine-boundary-warning" role="region" aria-label="越界片段待核对">
        <strong>已按人工确认保留当前视频范围，尚未证明整段时间对齐</strong>
        <p>机标声明 {result?.frameCount} 帧，当前视频 {primary?.frameCount} 帧。仅保留范围交集，未按比例缩放；完全越界片段已排除，原机标及本机恢复记录保留原文字和边界。请回放核对全部片段，必要时调整或判为不通过。</p>
        <label><input type="checkbox" checked={boundariesConfirmed} disabled={!canEdit || saving} onChange={event => setBoundariesConfirmed(event.currentTarget.checked)} />我已回放核对保留片段的动作与边界</label>
      </div>}
      {!loading && !error && !result && <p className="machine-message">未发现 {sourceName ?? "机标 JSON"}</p>}
      {result?.identityWarning && <MachineIdentityNotice key={JSON.stringify([username, root, result.sourceName, result.sourceHash, result.identityWarning, result.identityVerified])} username={username} root={root} result={result} />}
      {result?.timelineWarning && <div className="machine-boundary-warning" role="region" aria-label="机标帧数适配提示"><strong>已按当前视频帧数适配</strong><p>{result.timelineWarning}</p></div>}
      {!!result?.attributeWarnings?.length && <details className="machine-boundary-warning" aria-label="机标属性兼容提示">
        <summary>部分机标属性格式异常，已兼容加载，请核对动作描述</summary>
        {result.attributeWarnings.map((message, index) => <p key={index}>{message}</p>)}
      </details>}
      {Boolean(review?.recoveryWarnings?.length || recoveryMessages.length) && <div className="machine-boundary-warning" role="region" aria-label="人工记录兼容恢复提示">
        <strong>原人工记录已保留，请核对恢复内容</strong>
        {[...(review?.recoveryWarnings ?? []), ...recoveryMessages].map((message, index) => <p key={index}>{message}</p>)}
      </div>}
      {!!result?.inferredEndFrames?.length && <div className="machine-boundary-warning" role="region" aria-label="机标边界待核对">
        <strong>机标缺少结束帧，以下边界为临时推定</strong>
        {result.inferredEndFrames.map(index => { const row = rows.find(item => item.sourceIndex === index); const original = result.segments.find(item => item.sourceIndex === index); return <p key={index}>
          <button type="button" className="review-user-link" disabled={!row || !canEdit} onClick={() => { if (row) choose(row.sourceIndex); }}>定位原片段 {index + 1}</button>
          {original && `：暂按 [${original.startFrame}, ${original.endFrame + 1}) 展示。`}
        </p>; })}
        <p>请回放核对并按需调整。原机标保持不变，保存时将当前边界写入人工结果。</p>
        <label><input type="checkbox" checked={boundariesConfirmed} disabled={!canEdit} onChange={event => setBoundariesConfirmed(event.currentTarget.checked)} />我已人工核对上述片段边界</label>
      </div>}
      {skeletonMode && !loading && !error && !rows.length && <p className="machine-message">暂无骨架片段，点击加号新增，使用标签库或输入自定义描述。</p>}
      <SegmentList rows={rows} selected={active?.sourceIndex} disabled={!canEdit} onChoose={choose}
        onDelete={deleteSegment} />
      <div className="quality-editor" aria-label="人工复核">
        <header className="machine-heading"><strong>{active ? `片段 ${rows.indexOf(active) + 1}` : "动作描述"}</strong>
          <button className="icon-button" title="恢复视频范围内删除的片段" aria-label="恢复删除的片段" disabled={!canEdit || !edits.some((item) => item.deleted && item.endFrame < editFrameCount)} onClick={() => change([...restoreReviewSegments(editsRef.current.filter(item => item.endFrame < editFrameCount)), ...editsRef.current.filter(item => item.endFrame >= editFrameCount)])}><Undo2 size={15} /></button>
        </header>
        <div className="quality-description-shell">
          <textarea ref={descriptionInput} aria-label="复核动作描述" placeholder="中文动作描述" value={active?.description ?? ""} disabled={!canEdit || !active}
            onChange={(event) => change(editsRef.current.map((item) => item.sourceIndex === active?.sourceIndex ? { ...item, description: event.currentTarget.value, decision: "pending" } : item))} />
          {descriptionIssues.length > 0 && <div className="description-issues" role="status"><strong>疑似文字问题</strong>{descriptionIssues.map((issue) => <span key={`${issue.original}:${issue.suggestion}`}><button disabled={!canEdit} title={`${issue.reason}：替换为 ${issue.suggestion}`} type="button" onClick={() => { if (!active) return; const next = active.description.replaceAll(issue.original, issue.suggestion); setTextUndo({index:active.sourceIndex,before:active.description,after:next}); change(editsRef.current.map((item) => item.sourceIndex === active.sourceIndex ? { ...item, description: next, decision: "pending" } : item)); }}><Check size={13}/><mark>{issue.original}</mark> → {issue.suggestion}</button><button type="button" title="忽略本次提示" aria-label={`忽略 ${issue.original}`} disabled={!canEdit} onClick={()=>{if(active){setIgnoredText(current=>new Set([...current,issueKey(active.sourceIndex,active.description,issue.original)]));recordReviewInteraction("control",{value:`忽略文字提示：${issue.original}`,segmentIndex:active.sourceIndex},root);}}}><X size={13}/></button></span>)}</div>}
          {textUndo && <button type="button" className="icon-button" title="撤销文字修正" aria-label="撤销文字修正" disabled={!canEdit || edits.find(row=>row.sourceIndex===textUndo.index)?.description!==textUndo.after} onClick={()=>{change(editsRef.current.map(row=>row.sourceIndex===textUndo.index?{...row,description:textUndo.before,decision:"pending"}:row));setTextUndo(null);}}><Undo2 size={15}/></button>}
          <div className="quality-description-tools">
            <button type="button" className="label-library-trigger" aria-label="标签库" aria-expanded={labelLibraryOpen} aria-haspopup="dialog"
              disabled={!canEdit || !active} onClick={() => setLabelLibraryOpen((open) => !open)}>
              <Tag size={14} />标签库{labelLibrary.length > 0 && <span>{labelLibrary.length}</span>}
            </button>
          </div>
          {labelLibraryOpen && <div className="label-library" role="dialog" aria-label="标签库">
            <header>
              <strong>标签库</strong>
              <button type="button" className="icon-button" aria-label="关闭标签库" title="关闭" onClick={() => setLabelLibraryOpen(false)}><X size={15} /></button>
            </header>
            <button type="button" className="label-library-save" disabled={!canEdit || !(active?.description ?? "").trim()} onClick={addCurrentDescriptionToLibrary}>
              <Plus size={14} />保存当前描述
            </button>
            {labelLibraryError && <p className="label-library-error" role="alert">{labelLibraryError}</p>}
            {labelLibrary.length ? <div className="label-library-list" role="list" aria-label="标签库条目">
              {labelLibrary.map((item, index) => <div className={`label-library-item${labelDropTarget === index ? " label-library-drop" : ""}`} role="listitem" key={index}
                onDragOver={(event) => { if (canEdit && draggedLabelId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setLabelDropTarget(index); } }}
                onDrop={(event) => { event.preventDefault(); reorderLibraryLabel(item.id); setDraggedLabelId(null); setLabelDropTarget(null); }}>
                <button type="button" className="label-library-index" disabled={!canEdit} title={`使用第 ${index + 1} 个标签（数字 ${index + 1}）`} aria-label={`使用第 ${index + 1} 个标签`} onClick={() => applyLibraryLabel(item.text)}>{index + 1}</button>
                <button type="button" className="label-library-use" disabled={!canEdit} draggable={canEdit} title={`拖动排序或使用：${item.text}`} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDraggedLabelId(item.id); }} onDragEnd={() => { setDraggedLabelId(null); setLabelDropTarget(null); }} onClick={() => { if (!draggedLabelId) applyLibraryLabel(item.text); }}>{item.text}</button>
                <button type="button" className="icon-button label-library-delete" disabled={!canEdit} aria-label={`删除标签：${item.text}`} title="删除" onClick={() => deleteLibraryLabel(item.id)}><Trash2 size={14} /></button>
              </div>)}
            </div> : <p className="label-library-empty">暂无常用描述</p>}
          </div>}
        </div>
      </div>
      <footer className="quality-footer">
        <div className="quality-save-state" role="status">{saving ? (skeletonMode ? "正在保存骨架描述…" : "正在保存本机草稿或审核结论…") : saveError ? "保存失败" : review?.localDraft ? "本机草稿已保存 · 审核通过后写入 JSON" : review?.pendingSourceWrite ? "结果已保存本机 · 待写回数据目录" : review?.published ? "人工结果已保存" : review?.revision ? "仅有本机历史草稿" : "尚无人工修改"}
          {review?.versionId && <span className="review-revision" title={review.revisionLabel ?? review.versionId}>{`${review.versionId} · 历史修订（非当前结论）`}</span>}
        </div>
        {recoveryError && <p role="alert" className="machine-message">{recoveryError}</p>}
        {auditPreparationError && <p role="alert" className="machine-message">{auditPreparationError}</p>}
        {auditCompletionError && <div role="alert" className="machine-message audit-completion-error"><span>{auditCompletionError}</span><button type="button" className="button button-secondary" disabled={finishing} onClick={() => void finishAuditCompletion()}>重试保存操作记录</button></div>}
        {saveSlow && saving && <div role="status" className="machine-message">保存耗时较长，正在等待本机保存或审核结论写入确认，尚未确认提交成功。{!recoveryError && "本机应急草稿已保留。"}请保持应用打开，等待结果后再重试；用户中心的操作记录上传独立进行。</div>}
        {saveError && <div role="alert" className="machine-message review-save-error"><span>{saveError}{!recoveryError && " 本机应急草稿已保留，恢复后请重试保存。"}</span><button type="button" className="button button-secondary" aria-label="重试保存复核" onClick={() => void persist(pending.current ?? { segments: editsRef.current, status: "pending" })}><RefreshCw size={15} />重试保存</button></div>}
        <div className="quality-output" title={`${root}/${outputName}`}>{outputName}{!skeletonMode && <span>{review?.qcStatus === "approved" ? "已通过" : review?.qcStatus === "rejected" ? "未通过" : review?.qcStatus === "pending" ? "待审核" : "审核状态未知"}</span>}</div>
        {!skeletonMode && review?.qcStatusError && <p role="alert" className="machine-message">当前目录审核状态读取失败，请重新读取：{review.qcStatusError}</p>}
        {!skeletonMode && review?.qcStatus === "rejected" && review.qcRejectionReason && <p className="review-rejection-reason" title={review.qcRejectionReason}>不通过：{review.qcRejectionReason}</p>}
        {!skeletonMode && <div className="quality-decisions">
          <button ref={rejectButton} className="button button-secondary" disabled={!canEdit || saving} onClick={openRejection}><X size={16} />不通过</button>
          <button className="button button-primary" disabled={!canEdit || saving || !rows.length || (requiresBoundaryCheck && !boundariesConfirmed)} onClick={() => void finish("approved")}><Check size={16} />通过</button>
        </div>}
      </footer>
    </section>
    {textCheckOpen && <dialog className="text-quality-dialog" aria-label="通过前文字检查" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={()=>setTextCheckOpen(false)}><h2>通过前文字检查</h2><p>{allTextIssues.length} 个疑似问题</p><ul className="text-check-summary">{allTextIssues.map((issue,i)=><li key={i}><button className="review-user-link" onClick={()=>{setTextCheckOpen(false);setSelected(issue.row.sourceIndex);seek(issue.row.startFrame);}}>片段 {rows.indexOf(issue.row)+1}：{issue.row.description}</button><p>{issue.original} → {issue.suggestion}（{issue.reason}）</p></li>)}</ul><footer><button className="button button-secondary" autoFocus onClick={()=>setTextCheckOpen(false)}>返回检查</button><button className="button button-primary" disabled={finishing} onClick={()=>{recordReviewInteraction("control",{value:`已核对 ${allTextIssues.length} 项文字提示并继续通过`},root);setTextCheckOpen(false);void finish("approved",undefined,true);}}><Check size={16}/>已核对，继续通过</button></footer></dialog>}
    {rangeRepairOpen && rangeRepair && <dialog className="rejection-dialog video-range-dialog" aria-label="处理机标越界范围" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setRangeRepairOpen(false)}>
      <header><h2>处理机标越界范围</h2></header>
      <p>机标 {result?.frameCount} 帧，当前 Camera 0 {primary?.frameCount} 帧。帧数不同不能确定视频是否相同，请先核对内容。</p>
      <p>将截去 {rangeRepair.trimmed} 个片段的越界尾部，排除 {rangeRepair.excluded} 个完全越界片段。有效范围的帧号和描述保持原样，不按比例缩放。</p>
      <div className="video-range-affected" role="list" aria-label="受影响的机标片段">{rangeRepair.affected.map(item => <p role="listitem" key={item.sourceIndex}>片段 {item.sourceIndex + 1} · 原范围 [{item.startFrame}, {item.endFrame + 1}) · {item.description || "暂无中文描述"}</p>)}</div>
      <p>确认后保存为待审核草稿，已有通过／不通过会变为待审核。原机标保持不变，原人工结果和机标另存本机恢复备份；之后仍需逐段回放核对才能通过。若视频不对应，请取消并选择正确来源。</p>
      <label><input type="checkbox" checked={rangeRepairConfirmed} onChange={event => setRangeRepairConfirmed(event.currentTarget.checked)} />我已核对视频内容，确认按上述方式处理</label>
      <footer><button className="button button-secondary" autoFocus onClick={() => setRangeRepairOpen(false)}>取消</button><button className="button button-primary" disabled={!rangeRepairConfirmed || saving || busy} onClick={confirmVideoRange}>应用处理并保存待审核草稿</button></footer>
    </dialog>}
    {rejectOpen && <dialog className="rejection-dialog" aria-labelledby="rejection-title" ref={(node) => { if (node && !node.open) node.showModal(); }}
      onCancel={(event) => { event.preventDefault(); closeRejection(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (reasonChoice && (reasonChoice !== "其他原因" || otherReason.trim())) void finish("rejected", reasonChoice === "其他原因" ? `其他原因：${otherReason.trim()}` : reasonChoice); }}>
        <header><h2 id="rejection-title">不通过原因</h2><button type="button" className="icon-button" aria-label="关闭不通过原因" title="关闭" disabled={finishing} onClick={closeRejection}><X size={18} /></button></header>
        <RejectionReasons key={username} username={username} value={reasonChoice} onChange={setReasonChoice} disabled={finishing} />
        {reasonChoice === "其他原因" && <label className="rejection-detail">其他原因<textarea autoFocus aria-label="其他原因内容" required maxLength={1000} value={otherReason} disabled={finishing} onChange={(event) => setOtherReason(event.currentTarget.value)} /></label>}
        {saveError && <p role="alert" className="machine-message">{saveError}</p>}
        <footer><button type="button" className="button button-secondary" disabled={finishing} onClick={closeRejection}>取消</button>
          <button type="submit" className="button button-primary" disabled={!canEdit || saving || !reasonChoice || (reasonChoice === "其他原因" && !otherReason.trim())}>{finishing ? <LoaderCircle size={16} className="spin" /> : <X size={16} />}确认不通过</button></footer>
      </form>
    </dialog>}
    {showJson && result && <dialog className="machine-json" aria-label="机标 JSON" ref={(node) => { if (node && !node.open) node.showModal(); }} onCancel={() => setShowJson(false)}><header className="machine-heading"><strong>{result.sourceName ?? "bailian_annotation.json"}</strong><button autoFocus className="icon-button" aria-label="关闭 JSON" title="关闭 JSON" onClick={() => setShowJson(false)}><X size={16} /></button></header><pre>{skeletonMode ? JSON.stringify({ schema_version: 4, annotation_source: "skeleton-human", episode_results: [{ episode_id: result.episodeId, media: { frame_count: result.frameCount, frame_index_base: 0, interval_convention: "[start,end)" }, annotations: rows.map(row => ({ start_frame: row.startFrame, end_frame: row.endFrame + 1, attributes_zh: { "动作描述": row.description } })) }] }, null, 2) : result.sourceJson ?? JSON.stringify(result, null, 2)}</pre></dialog>}
  </div>;
}

const SegmentList = memo(function SegmentList({ rows, selected, disabled, onChoose, onDelete }: {
  rows: ReviewSegment[]; selected: number | undefined; disabled: boolean;
  onChoose: (sourceIndex: number) => void; onDelete: (sourceIndex: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(".machine-segment.active");
    if (!list || !active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    // Keep keyboard selection visible without scrolling the surrounding workspace.
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [selected, rows]);
  return <div ref={listRef} className="machine-segment-list" role="list">
    {rows.map((segment, index) => <div role="listitem" data-source-index={segment.sourceIndex} className={`machine-segment${segment.sourceIndex === selected ? " active" : ""}`} key={segment.sourceIndex}>
      <button className="machine-segment-description" aria-label={`定位机标片段 ${index + 1}`} disabled={disabled} onClick={() => onChoose(segment.sourceIndex)}>
        <strong>{index + 1}. {segment.description || "暂无中文描述"}</strong><small>帧 [{segment.startFrame}, {segment.endFrame + 1})</small>
      </button>
      <button className="icon-button segment-delete" title="删除片段" aria-label={`删除机标片段 ${index + 1}`} disabled={disabled} onClick={() => onDelete(segment.sourceIndex)}><Trash2 size={15} /></button>
    </div>)}
  </div>;
});
