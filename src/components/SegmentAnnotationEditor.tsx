import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Plus, Scissors, Trash2 } from "lucide-react";
import type { EpisodeData } from "../types";
import { TrimControls } from "./TrimControls";

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
  busy: boolean;
  playbackControls: ReactNode;
  onFrameChange: (frame: number) => void;
}

export function SegmentAnnotationEditor({
  data, currentFrame, minFrame, maxFrame, busy, playbackControls, onFrameChange,
}: Props) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSegments([]);
    setSelectedId(null);
  }, [data.summary.root, maxFrame, minFrame]);

  const selected = segments.find((segment) => segment.id === selectedId) ?? null;
  const span = Math.max(1, maxFrame - minFrame);
  const ordered = useMemo(
    () => [...segments].sort((left, right) => left.startFrame - right.startFrame),
    [segments],
  );
  const lastEndFrame = ordered.length ? ordered[ordered.length - 1].endFrame : minFrame - 1;
  const nextStartFrame = lastEndFrame + 1;
  const canCreate = currentFrame >= nextStartFrame && nextStartFrame <= maxFrame;

  function addSegment() {
    if (!canCreate) return;
    const id = `${Date.now()}-${segments.length}`;
    const next: Segment = {
      id,
      startFrame: nextStartFrame,
      endFrame: currentFrame,
      title: `片段 ${segments.length + 1}`,
      note: "",
    };
    setSegments((current) => [...current, next]);
    setSelectedId(id);
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

  return (
    <section className="segment-editor-view segment-editor-embedded" aria-labelledby="segment-editor-title">
      <header className="section-heading segment-page-heading">
        <div>
          <span className="section-kicker">SEGMENT ANNOTATION</span>
          <h2 id="segment-editor-title">创建片段</h2>
        </div>
        <span className="segment-draft-badge">当前会话草稿 · {segments.length} 个片段</span>
      </header>

      <TrimControls>
        <section className="segment-timeline segment-timeline-embedded" aria-label="片段时间线">
          <header>
            <div className="segment-playback-controls">{playbackControls}</div>
            <button className="button button-primary segment-create-action" type="button" disabled={busy || !canCreate} onClick={addSegment} title={!canCreate && nextStartFrame <= maxFrame ? `请先播放到帧 ${nextStartFrame}` : undefined}>
              <Plus size={14} />{canCreate ? "创建到当前帧" : nextStartFrame > maxFrame ? "已到轨迹末尾" : `请播放到帧 ${nextStartFrame}`}
            </button>
          </header>
          <div className="segment-ruler"><span>{minFrame}</span><span>{Math.round((minFrame + maxFrame) / 2)}</span><span>{maxFrame}</span></div>
          <div className="segment-track" onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            onFrameChange(Math.round(minFrame + ((event.clientX - rect.left) / rect.width) * span));
          }}>
            {ordered.map((segment, index) => {
              const visualStartFrame = index > 0 && ordered[index - 1].endFrame + 1 === segment.startFrame
                ? ordered[index - 1].endFrame
                : segment.startFrame;
              const joinsPrevious = index > 0 && ordered[index - 1].endFrame + 1 === segment.startFrame;
              const joinsNext = index < ordered.length - 1 && segment.endFrame + 1 === ordered[index + 1].startFrame;
              return (
                <button key={segment.id} type="button" className={`segment-block${segment.id === selectedId ? " selected" : ""}`} style={{ left: `${((visualStartFrame - minFrame) / span) * 100}%`, width: `${Math.max(1.5, ((segment.endFrame - visualStartFrame) / span) * 100)}%`, borderRadius: `${joinsPrevious ? 0 : 3}px ${joinsNext ? 0 : 3}px ${joinsNext ? 0 : 3}px ${joinsPrevious ? 0 : 3}px`, boxShadow: joinsPrevious ? "inset 1px 0 rgba(255, 255, 255, .8)" : undefined }} onClick={() => selectSegment(segment)} title={`${segment.title} · 帧 ${segment.startFrame}–${segment.endFrame}`}>
                  <b>{String(index + 1).padStart(2, "0")}</b><span>{segment.title}</span>
                </button>
              );
            })}
            <i className="segment-playhead" style={{ left: `${((currentFrame - minFrame) / span) * 100}%` }} />
          </div>
          {ordered.length ? (
            <div className="segment-list">
              {ordered.map((segment, index) => <button type="button" key={segment.id} className={segment.id === selectedId ? "selected" : ""} onClick={() => selectSegment(segment)}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{segment.title || "未命名片段"}</strong><small>帧 {segment.startFrame}–{segment.endFrame} · {segment.note || "尚未添加注解"}</small></span></button>)}
            </div>
          ) : null}
        </section>
      </TrimControls>

      {selected && <div className="segment-workbench">
        <aside className="segment-inspector">
          <header><Scissors size={16} /><strong>注解</strong></header>
          <label className="segment-note"><textarea aria-label="片段注解" rows={2} maxLength={500} value={selected.note} placeholder="描述这个片段中的动作、事件或质量问题……" onChange={(event) => updateSelected({ note: event.target.value })} /><small>{selected.note.length}/500</small></label>
          <div className="segment-edit-actions">
            <button className="button button-secondary segment-delete" type="button" onClick={() => { setSegments((current) => current.filter((segment) => segment.id !== selectedId)); setSelectedId(null); }}><Trash2 size={15} />删除片段</button>
          </div>
        </aside>
      </div>}

    </section>
  );
}
