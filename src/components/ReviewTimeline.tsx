import { useRef, type PointerEvent } from "react";
import type { ReviewSegment } from "../types";

const COLORS = ["#087e79", "#5489a3", "#b3914b", "#797895", "#628969"];
interface Props {
  frame: number; frameCount: number; start: number; end: number; editable: boolean;
  segments: ReviewSegment[]; selected?: number;
  onSeek: (frame: number) => void;
  onBoundary: (kind: "startFrame" | "endFrame", value: number) => void;
  onChoose: (sourceIndex: number) => void;
}

export function ReviewTimeline({ frame, frameCount, start, end, editable, segments, selected, onSeek, onBoundary, onChoose }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<"startFrame" | "endFrame" | null>(null);
  const update = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || !track.current || !editable) return;
    const bounds = track.current.getBoundingClientRect();
    const edge = Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * frameCount);
    onBoundary(drag.current, drag.current === "endFrame" ? edge - 1 : edge);
  };
  return <div className="review-timeline">
    <div className="review-track" ref={track} aria-label="动作分段条">
      {segments.map((segment, index) => <button type="button" className="review-span" key={segment.sourceIndex}
        title={`${segment.description || "暂无中文描述"} [${segment.startFrame}, ${segment.endFrame + 1})`}
        aria-label={`选择机标片段 ${index + 1}`} aria-pressed={segment.sourceIndex === selected}
        onClick={() => onChoose(segment.sourceIndex)} style={{ left: `${segment.startFrame / frameCount * 100}%`, width: `${(segment.endFrame + 1 - segment.startFrame) / frameCount * 100}%`, background: COLORS[segment.sourceIndex % COLORS.length] }} />)}
      <input type="range" className="review-playhead-input" min={0} max={frameCount - 1} value={frame} step={1} aria-label="校对播放帧" onChange={(event) => onSeek(event.currentTarget.valueAsNumber)} />
      <i className="review-playhead" style={{ left: `${frame / frameCount * 100}%` }} />
      {editable && (["startFrame", "endFrame"] as const).map((kind) => {
        const isStart = kind === "startFrame";
        const value = isStart ? start : end + 1;
        return <button key={kind} type="button" role="slider" className={`review-edge ${isStart ? "start" : "end"}`}
          aria-label={isStart ? "微调起始帧" : "微调结束帧"} title={isStart ? "拖动起始帧" : "拖动结束帧"}
          aria-valuemin={isStart ? 0 : start + 1} aria-valuemax={isStart ? end : frameCount} aria-valuenow={value}
          style={{ left: `${value / frameCount * 100}%` }}
          onPointerDown={(event) => { event.preventDefault(); drag.current = kind; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={update} onPointerUp={(event) => { update(event); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={(event) => {
            const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (!delta) return;
            event.preventDefault(); onBoundary(kind, (isStart ? start : end) + delta);
          }} />;
      })}
    </div>
    <div className="review-frame-fields">
      <label>起始帧<input aria-label="复核起始帧" type="number" min={0} max={end} value={start} disabled={!editable} onChange={(event) => onBoundary("startFrame", event.currentTarget.valueAsNumber)} /></label>
      <label>结束帧（不含）<input aria-label="复核结束帧" type="number" min={start + 1} max={frameCount} value={end + 1} disabled={!editable} onChange={(event) => onBoundary("endFrame", event.currentTarget.valueAsNumber - 1)} /></label>
    </div>
  </div>;
}
