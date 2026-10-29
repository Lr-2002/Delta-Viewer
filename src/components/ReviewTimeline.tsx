import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ReviewSegment } from "../types";
import { adjustReviewBoundary } from "../lib/machine-annotation";

const COLORS = ["#087e79", "#5489a3", "#b3914b", "#797895", "#628969"];
function segmentColor(sourceIndex: number): string {
  // Identity survives clipping, temporary coverage and reordering. Never use
  // the visible row position: removing a covered row recolored every successor.
  return COLORS[sourceIndex] ?? `hsl(${(sourceIndex * 137.508) % 360} 38% 42%)`;
}
interface Props {
  frame: number; frameCount: number; start: number; end: number; editable: boolean;
  segments: ReviewSegment[]; selected?: number;
  onSeek: (frame: number) => void;
  onBoundary: (kind: "startFrame" | "endFrame", value: number) => void;
  previewBoundary?: (kind: "startFrame" | "endFrame", value: number) => ReviewSegment[];
  onChoose: (sourceIndex: number) => void;
  onBoundaryFocus?: (kind: "startFrame" | "endFrame" | "playhead") => void;
}

export function ReviewTimeline({ frame, frameCount, start, end, editable, segments, selected, onSeek, onBoundary, previewBoundary, onChoose, onBoundaryFocus }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<"startFrame" | "endFrame" | null>(null);
  const origin = useRef({ x: 0, moved: false });
  const animation = useRef<number | null>(null);
  const pendingEdge = useRef<number | null>(null);
  const [preview, setPreview] = useState<{ kind: "startFrame" | "endFrame"; value: number } | null>(null);
  const cancelPreview = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null; pendingEdge.current = null; drag.current = null; setPreview(null);
  };
  useEffect(() => () => { if (animation.current !== null) cancelAnimationFrame(animation.current); }, []);
  const [selectedControl, setSelectedControl] = useState("endFrame");
  const selectControl = (kind: "startFrame" | "endFrame" | "playhead") => {
    setSelectedControl(kind);
    onBoundaryFocus?.(kind);
  };
  const update = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || !track.current || !editable) return;
    if (!origin.current.moved && Math.abs(event.clientX - origin.current.x) < 3) return;
    origin.current.moved = true;
    const bounds = track.current.getBoundingClientRect();
    const edge = Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * frameCount);
    pendingEdge.current = drag.current === "endFrame" ? edge - 1 : edge;
    if (animation.current === null) animation.current = requestAnimationFrame(() => {
      animation.current = null;
      if (drag.current && pendingEdge.current !== null) setPreview({ kind: drag.current, value: pendingEdge.current });
    });
  };
  // Use the editor's retained baseline even after a previous drag was saved.
  // Only pointer-up performs disk saves, audit edits and seeking.
  const shown = preview && selected !== undefined ? (previewBoundary?.(preview.kind, preview.value) ?? adjustReviewBoundary(segments, selected, preview.kind, preview.value, frameCount)) : segments;
  const activePreview = shown.find(segment => segment.sourceIndex === selected && !segment.deleted);
  const shownStart = activePreview?.startFrame ?? start;
  const shownEnd = activePreview?.endFrame ?? end;
  return <div className="review-timeline">
    <div className="review-track" ref={track} aria-label="动作分段条">
      {shown.filter(segment => !segment.deleted).map((segment, index) => <button type="button" className="review-span" key={segment.sourceIndex} data-source-index={segment.sourceIndex}
        title={`${segment.description || "暂无中文描述"} [${segment.startFrame}, ${segment.endFrame + 1})`}
        aria-label={`选择机标片段 ${index + 1}`} aria-pressed={segment.sourceIndex === selected}
        onClick={() => onChoose(segment.sourceIndex)} style={{ left: `${segment.startFrame / frameCount * 100}%`, width: `${(segment.endFrame + 1 - segment.startFrame) / frameCount * 100}%`, background: segmentColor(segment.sourceIndex) }} />)}
      <input type="range" className={`review-playhead-input${selectedControl === "playhead" ? " selected-control" : ""}`} min={0} max={frameCount - 1} value={frame} step={1} aria-label="校对播放帧" onFocus={() => selectControl("playhead")} onPointerDown={() => selectControl("playhead")} onChange={(event) => onSeek(event.currentTarget.valueAsNumber)} />
      <i className="review-playhead" style={{ left: `${frame / frameCount * 100}%` }} />
      {(["startFrame", "endFrame"] as const).map((kind) => {
        const isStart = kind === "startFrame";
        const value = isStart ? shownStart : shownEnd + 1;
        return <button key={kind} type="button" role="slider" className={`review-edge ${isStart ? "start" : "end"}${selectedControl === kind ? " selected-control" : ""}`}
          disabled={!editable} aria-label={isStart ? "微调起始帧" : "微调结束帧"} title={!editable ? "当前片段只读，请先处理上方提示" : isStart ? "拖动起始帧" : "拖动结束帧"}
          aria-valuemin={isStart ? 0 : start + 1} aria-valuemax={isStart ? end : frameCount} aria-valuenow={value}
          style={{ left: `${value / frameCount * 100}%` }}
          onFocus={() => selectControl(kind)} onClick={() => selectControl(kind)}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); selectControl(kind); origin.current = { x: event.clientX, moved: false }; drag.current = kind; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={update} onPointerUp={(event) => {
            update(event);
            const value = pendingEdge.current;
            cancelPreview();
            if (value !== null) onBoundary(kind, value);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancelPreview} onLostPointerCapture={cancelPreview}
          onKeyDown={(event) => {
            const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (!delta) return;
            event.preventDefault(); onBoundary(kind, (isStart ? start : end) + delta);
          }} />;
      })}
    </div>
    <div className="review-frame-fields">
      <label>起始帧<input aria-label="复核起始帧" type="number" min={0} max={shownEnd} value={shownStart} disabled={!editable} onChange={(event) => onBoundary("startFrame", event.currentTarget.valueAsNumber)} /></label>
      <label>结束帧（不含）<input aria-label="复核结束帧" type="number" min={shownStart + 1} max={frameCount} value={shownEnd + 1} disabled={!editable} onChange={(event) => onBoundary("endFrame", event.currentTarget.valueAsNumber - 1)} /></label>
    </div>
  </div>;
}
