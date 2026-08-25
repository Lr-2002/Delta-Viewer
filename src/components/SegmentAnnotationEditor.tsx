import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RotateCcw, Save, Scissors, Trash2 } from "lucide-react";
import { confirmAction, isTauriRuntime, saveEpisodeAnnotation } from "../lib/backend";
import { descriptionMetadataPath } from "../lib/format";
import type { AnnotationAuditAction, EpisodeAnnotation, EpisodeData } from "../types";

interface Segment {
  id: string;
  startFrame: number;
  endFrame: number;
  title: string;
  note: string;
}

interface Props {
  data: EpisodeData;
  currentFrame: number;
  minFrame: number;
  maxFrame: number;
  clipStartFrame: number;
  clipEndFrame: number;
  busy: boolean;
  annotation: EpisodeAnnotation | null;
  templateTaskId: string | null;
  templateSegments: string[];
  playbackControls: ReactNode;
  onFrameChange: (frame: number) => void;
  onClipStartChange: (frame: number) => void;
  onClipEndChange: (frame: number) => void;
  onClipReset: () => void;
  onSaved: (annotation: EpisodeAnnotation) => void;
  onCompleted: (annotation: EpisodeAnnotation) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onActivity: (action: AnnotationAuditAction, taskId: string, trajectoryCode: string) => void;
}

export function SegmentAnnotationEditor({
  data, currentFrame, minFrame, maxFrame, clipStartFrame, clipEndFrame, busy,
  annotation, templateTaskId, templateSegments, playbackControls, onFrameChange, onClipStartChange, onClipEndChange, onClipReset,
  onSaved, onError, onNotice,
  onCompleted,
  onActivity,
}: Props) {
  const [segments, setSegments] = useState<Segment[]>(() => [createSegment(minFrame, maxFrame, 0)]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasMatchingAnnotation = annotation?.taskId === templateTaskId;
  const draftKey = `dohc-viewer.segment-draft.v1:${data.summary.root}:${templateTaskId ?? "none"}`;
  const skipNextDraftWrite = useRef(true);

  useEffect(() => {
    skipNextDraftWrite.current = true;
    let savedSegments = hasMatchingAnnotation && annotation.segments.length
      ? annotation.segments.map((segment, index) => ({ ...segment, id: `saved-${annotation.revision}-${index}` }))
      : [createSegment(minFrame, maxFrame, 0, `initial-${templateTaskId ?? "none"}`)];
    if (!hasMatchingAnnotation) {
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null") as { segments?: Segment[]; clipStartFrame?: number; clipEndFrame?: number } | null;
        if (draft?.segments?.length && draft.segments.every((segment) => Number.isSafeInteger(segment.startFrame) && Number.isSafeInteger(segment.endFrame) && segment.startFrame >= minFrame && segment.endFrame <= maxFrame && segment.startFrame <= segment.endFrame)) {
          savedSegments = draft.segments;
          if (Number.isSafeInteger(draft.clipStartFrame)) onClipStartChange(Math.max(minFrame, Math.min(maxFrame, draft.clipStartFrame!)));
          if (Number.isSafeInteger(draft.clipEndFrame)) onClipEndChange(Math.max(minFrame, Math.min(maxFrame, draft.clipEndFrame!)));
        }
      } catch { localStorage.removeItem(draftKey); }
    }
    setSegments(savedSegments);
    setSelectedId(null);
  }, [annotation?.revision, data.summary.root, draftKey, hasMatchingAnnotation, maxFrame, minFrame, templateTaskId]);

  useEffect(() => {
    setSegments((current) => extendSegmentsToRange(current, clipStartFrame, clipEndFrame));
  }, [clipEndFrame, clipStartFrame]);

  const selected = segments.find((segment) => segment.id === selectedId) ?? null;
  const span = Math.max(1, maxFrame - minFrame);
  const ordered = useMemo(() => {
    const available = segments.length ? segments : [createSegment(minFrame, maxFrame, 0, "initial-segment")];
    return [...available].sort((left, right) => left.startFrame - right.startFrame);
  }, [maxFrame, minFrame, segments]);
  const visibleSegments = useMemo(() => ordered.flatMap((segment) => {
    const startFrame = Math.max(segment.startFrame, clipStartFrame);
    const endFrame = Math.min(segment.endFrame, clipEndFrame);
    return startFrame <= endFrame ? [{ ...segment, startFrame, endFrame }] : [];
  }), [clipEndFrame, clipStartFrame, ordered]);
  const containingSegment = ordered.find((segment) => (
    currentFrame >= clipStartFrame
    && currentFrame <= clipEndFrame
    && currentFrame >= segment.startFrame
    && currentFrame <= segment.endFrame
  )) ?? null;
  const canSplit = containingSegment !== null && currentFrame < Math.min(containingSegment.endFrame, clipEndFrame);
  const persistedSignature = hasMatchingAnnotation && annotation?.segments.length
    ? segmentSignature(annotation.clipStartFrame, annotation.clipEndFrame, annotation.segments)
    : null;
  const currentSignature = segmentSignature(clipStartFrame, clipEndFrame, visibleSegments);
  const dirty = persistedSignature !== currentSignature;
  const saveStatus = !annotation || dirty
    ? "片段草稿已自动保存"
    : isTauriRuntime()
      ? `已保存到 description.json · r${annotation.revision}`
      : `浏览器演示已保存 · r${annotation.revision}`;

  async function saveSegments() {
    if (!annotation || !visibleSegments.length) return;
    const coveredFrames = visibleSegments.reduce((sum, segment) => sum + segment.endFrame - segment.startFrame + 1, 0);
    const confirmed = await confirmAction(
      `当前任务：${annotation.taskId}\n片段数：${visibleSegments.length}\n覆盖帧数：${coveredFrames}\n\n确认保存并完成当前任务？`,
      "确认完成任务",
    );
    if (!confirmed) return;
    setSaving(true);
    onError("");
    try {
      const saved = await saveEpisodeAnnotation({
        sourcePath: data.summary.root,
        taskId: annotation.taskId,
        taskDescription: annotation.taskDescription,
        editStartedAtMs: Date.now(),
        clipStartFrame,
        clipEndFrame,
        segments: visibleSegments.map(({ startFrame, endFrame, title, note }) => ({ startFrame, endFrame, title, note })),
      });
      onSaved(saved);
      localStorage.removeItem(draftKey);
      onActivity("annotation_saved", saved.taskId, saved.trajectoryCode);
      const persistenceNotice = isTauriRuntime()
        ? `片段已保存到 ${descriptionMetadataPath(saved.episodeRoot)}`
        : "浏览器演示已保存";
      onNotice(`${persistenceNotice} · ${saved.segments.length} 个片段 · r${saved.revision}`);
      onCompleted(saved);
    } catch (reason) {
      onActivity("annotation_save_failed", annotation.taskId, annotation.trajectoryCode);
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (skipNextDraftWrite.current) {
      skipNextDraftWrite.current = false;
      return;
    }
    if (!dirty) {
      localStorage.removeItem(draftKey);
      return;
    }
    try {
      localStorage.setItem(draftKey, JSON.stringify({ clipStartFrame, clipEndFrame, segments }));
    } catch { /* The unsaved badge remains visible if local persistence is unavailable. */ }
  }, [clipEndFrame, clipStartFrame, dirty, draftKey, segments]);

  function splitSegment() {
    if (!canSplit || !containingSegment) return;
    const rightId = `${Date.now()}-${ordered.length}`;
    setSegments((current) => {
      const available = current.length ? current : [createSegment(minFrame, maxFrame, 0, "initial-segment")];
      return renumberSegments(available.flatMap((segment) => (
      segment.id !== containingSegment.id
        ? [segment]
        : [
            { ...segment, endFrame: currentFrame },
            createSegment(currentFrame + 1, segment.endFrame, available.length, rightId),
          ]
      )));
    });
    setSelectedId(rightId);
    onActivity("segment_split", annotation?.taskId ?? "", annotation?.trajectoryCode ?? "");
  }

  function updateSelected(patch: Partial<Segment>) {
    setSegments((current) => current.map((segment) => (
      segment.id === selectedId ? { ...segment, ...patch } : segment
    )));
  }

  function selectSegment(segment: Segment) {
    setSelectedId(segment.id);
    onFrameChange(segment.startFrame);
  }

  function selectSegmentAtPointer(segment: Segment, clientX: number, track: HTMLElement) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setSelectedId(segment.id);
    onFrameChange(Math.round(minFrame + ratio * span));
  }

  function deleteSelected() {
    if (!selected || segments.length <= 1) return;
    const index = ordered.findIndex((segment) => segment.id === selected.id);
    const mergeTarget = index > 0 ? ordered[index - 1] : ordered[index + 1];
    const next = ordered
      .filter((segment) => segment.id !== selected.id)
      .map((segment) => segment.id === mergeTarget.id
        ? {
            ...segment,
            startFrame: Math.min(segment.startFrame, selected.startFrame),
            endFrame: Math.max(segment.endFrame, selected.endFrame),
          }
        : segment);
    setSegments(renumberSegments(next));
    setSelectedId(mergeTarget.id);
    onActivity("segment_deleted", annotation?.taskId ?? "", annotation?.trajectoryCode ?? "");
  }

  return (
    <section className="segment-editor-view segment-editor-embedded" aria-labelledby="segment-editor-title">
      <header className="section-heading segment-page-heading">
        <div>
          <span className="section-kicker">SEGMENT ANNOTATION</span>
          <h2 id="segment-editor-title">创建片段</h2>
        </div>
        <div className="segment-range-status">
          <span className="segment-draft-badge">保留范围 · 帧 {clipStartFrame}–{clipEndFrame} · {visibleSegments.length} 个片段</span>
          <span className={`segment-save-badge${!annotation || dirty ? " dirty" : ""}`}>{saveStatus}</span>
          <button className="button button-primary segment-save-action" type="button" disabled={busy || saving || !annotation} onClick={() => void saveSegments()} title={!annotation ? "请先保存上方的数据标注" : "保存片段到本机标注"}>
            <Save size={14} />{saving ? "保存中…" : dirty ? "保存片段" : "重新保存片段"}
          </button>
          <button className="icon-button" type="button" onClick={onClipReset} disabled={busy || (clipStartFrame === minFrame && clipEndFrame === maxFrame)} title="恢复完整轨迹" aria-label="恢复完整轨迹"><RotateCcw size={15} /></button>
        </div>
      </header>

      <section className="segment-timeline segment-timeline-embedded" aria-label="片段时间线">
          <header>
            <div className="segment-playback-controls">{playbackControls}</div>
            <button className="button button-primary segment-create-action" type="button" disabled={busy || !canSplit} onClick={splitSegment} title={!canSplit ? "请将播放头放在片段结束帧之前" : undefined}>
              <Scissors size={14} />{canSplit ? "在当前帧分割" : "片段结束处不可分割"}
            </button>
          </header>
          <div className="segment-ruler"><span>{minFrame}</span><span>{Math.round((minFrame + maxFrame) / 2)}</span><span>{maxFrame}</span></div>
          <div className="segment-track" onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            onFrameChange(Math.round(minFrame + ((event.clientX - rect.left) / rect.width) * span));
          }}>
            {visibleSegments.map((segment, index) => {
              const visualStartFrame = index > 0 && visibleSegments[index - 1].endFrame + 1 === segment.startFrame
                ? visibleSegments[index - 1].endFrame
                : segment.startFrame;
              const joinsPrevious = index > 0 && visibleSegments[index - 1].endFrame + 1 === segment.startFrame;
              const joinsNext = index < visibleSegments.length - 1 && segment.endFrame + 1 === visibleSegments[index + 1].startFrame;
              return (
                <button key={segment.id} type="button" className={`segment-block${segment.id === selectedId ? " selected" : ""}`} style={{ left: `${((visualStartFrame - minFrame) / span) * 100}%`, width: `${Math.max(1.5, ((segment.endFrame - visualStartFrame) / span) * 100)}%`, borderRadius: `${joinsPrevious ? 0 : 3}px ${joinsNext ? 0 : 3}px ${joinsNext ? 0 : 3}px ${joinsPrevious ? 0 : 3}px`, boxShadow: joinsPrevious ? "inset 1px 0 rgba(255, 255, 255, .8)" : undefined }} onClick={(event) => { event.stopPropagation(); selectSegmentAtPointer(segment, event.clientX, event.currentTarget.parentElement as HTMLElement); }} title={`${segment.title} · 帧 ${segment.startFrame}–${segment.endFrame}`}>
                  <b>{String(index + 1).padStart(2, "0")}</b><span>{segment.title}</span>
                </button>
              );
            })}
            <input
              id="trim-start-range"
              className="segment-trim-handle segment-trim-start"
              type="range"
              min={minFrame}
              max={maxFrame}
              value={clipStartFrame}
              disabled={busy}
              aria-label="裁剪起始帧"
              onChange={(event) => onClipStartChange(event.currentTarget.valueAsNumber)}
            />
            <input
              id="trim-end-range"
              className="segment-trim-handle segment-trim-end"
              type="range"
              min={minFrame}
              max={maxFrame}
              value={clipEndFrame}
              disabled={busy}
              aria-label="裁剪结束帧"
              onChange={(event) => onClipEndChange(event.currentTarget.valueAsNumber)}
            />
            <i className="segment-playhead" style={{ left: `${((currentFrame - minFrame) / span) * 100}%` }} />
          </div>
          {visibleSegments.length ? (
            <div className="segment-list">
              {visibleSegments.map((segment, index) => <button type="button" key={segment.id} className={segment.id === selectedId ? "selected" : ""} onClick={() => selectSegment(segment)}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{segment.title || "未命名片段"}</strong><small>帧 {segment.startFrame}–{segment.endFrame} · {segment.note || "尚未添加注解"}</small></span></button>)}
            </div>
          ) : null}
      </section>

      {selected && <div className="segment-workbench">
        <aside className="segment-inspector">
          <header><Scissors size={16} /><strong>注解</strong></header>
          <label className="segment-template">片段模板
            <select
              aria-label="片段模板"
              value={templateSegments.includes(selected.title) ? selected.title : ""}
              disabled={!templateSegments.length}
              onChange={(event) => {
                if (event.target.value) {
                  updateSelected({ title: event.target.value });
                  onActivity("segment_template_selected", annotation?.taskId ?? "", annotation?.trajectoryCode ?? "");
                }
              }}
            >
              <option value="">{templateSegments.length ? "选择片段模板" : "当前任务未配置片段模板"}</option>
              {templateSegments.map((title, index) => <option value={title} key={`${title}-${index}`}>{title}</option>)}
            </select>
          </label>
          <label className="segment-note"><textarea aria-label="片段注解" rows={2} maxLength={500} value={selected.note} placeholder="描述这个片段中的动作、事件或质量问题……" onChange={(event) => updateSelected({ note: event.target.value })} onBlur={() => onActivity("segment_note_changed", annotation?.taskId ?? "", annotation?.trajectoryCode ?? "")} /><small>{selected.note.length}/500</small></label>
          <div className="segment-edit-actions">
            <button className="button button-secondary segment-delete" type="button" disabled={segments.length <= 1} onClick={deleteSelected}><Trash2 size={15} />合并删除片段</button>
          </div>
        </aside>
      </div>}

    </section>
  );
}

function createSegment(startFrame: number, endFrame: number, index: number, id = `${Date.now()}-${index}`): Segment {
  return { id, startFrame, endFrame, title: `片段 ${index + 1}`, note: "" };
}

function renumberSegments(segments: Segment[]): Segment[] {
  return [...segments]
    .sort((left, right) => left.startFrame - right.startFrame)
    .map((segment, index) => ({
      ...segment,
      title: /^片段 \d+$/.test(segment.title) ? `片段 ${index + 1}` : segment.title,
    }));
}

function extendSegmentsToRange(segments: Segment[], startFrame: number, endFrame: number): Segment[] {
  if (!segments.length) return [createSegment(startFrame, endFrame, 0)];
  const next = [...segments].sort((left, right) => left.startFrame - right.startFrame);
  let changed = false;
  if (next[0].startFrame > startFrame) {
    next[0] = { ...next[0], startFrame };
    changed = true;
  }
  const lastIndex = next.length - 1;
  if (next[lastIndex].endFrame < endFrame) {
    next[lastIndex] = { ...next[lastIndex], endFrame };
    changed = true;
  }
  return changed ? next : segments;
}

function segmentSignature(startFrame: number | null, endFrame: number | null, segments: Array<Pick<Segment, "startFrame" | "endFrame" | "title" | "note">>): string {
  return JSON.stringify({ startFrame, endFrame, segments: segments.map(({ startFrame: start, endFrame: end, title, note }) => ({ startFrame: start, endFrame: end, title, note })) });
}
