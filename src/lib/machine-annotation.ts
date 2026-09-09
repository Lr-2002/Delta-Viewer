import type { ExportRange, MachineAnnotation, MachineSegment, ReviewSegment, StreamSummary } from "../types.ts";

export function machineTimelineMapping(annotation: MachineAnnotation, stream: StreamSummary | undefined) {
  if (!stream || stream.firstFrame === null || stream.lastFrame === null || !stream.frameCount) {
    return { error: "Camera 0 不可用，无法对齐机标帧号。", offset: 0, step: 1 };
  }
  if (annotation.frameCount !== stream.frameCount) {
    return { error: `机标视频 ${annotation.frameCount} 帧，Camera 0 ${stream.frameCount} 帧，无法可靠对齐。`, offset: 0, step: 1 };
  }
  const step = (stream.lastFrame - stream.firstFrame + 1) / stream.frameCount;
  if (!Number.isInteger(step) || step < 1) {
    return { error: "视频帧号与主时间轴不是连续整数映射，无法可靠对齐。", offset: 0, step: 1 };
  }
  return { error: null, offset: stream.firstFrame, step };
}

export function machineSegmentRange(segment: MachineSegment, offset: number, step: number): ExportRange {
  return { startFrame: offset + segment.startFrame * step, endFrame: offset + (segment.endFrame + 1) * step - 1 };
}

export function adjustReviewBoundary(segments: ReviewSegment[], sourceIndex: number, kind: "startFrame" | "endFrame", value: number, frameCount: number) {
  const active = segments.find((segment) => segment.sourceIndex === sourceIndex && !segment.deleted);
  if (!active || !Number.isSafeInteger(value)) return segments;
  const neighbours = segments.filter((segment) => !segment.deleted && segment.sourceIndex !== sourceIndex &&
    (kind === "startFrame" ? segment.endFrame + 1 === active.startFrame : segment.startFrame === active.endFrame + 1));
  const separated = segments.filter((segment) => !segment.deleted && segment.sourceIndex !== sourceIndex && !neighbours.includes(segment));
  const min = kind === "startFrame" ? Math.max(0, ...neighbours.map((item) => item.startFrame + 1),
    ...separated.filter((item) => item.endFrame < active.startFrame).map((item) => item.endFrame + 1)) : active.startFrame;
  const max = kind === "endFrame" ? Math.min(frameCount - 1, ...neighbours.map((item) => item.endFrame - 1),
    ...separated.filter((item) => item.startFrame > active.endFrame).map((item) => item.startFrame - 1)) : active.endFrame;
  const next = Math.max(min, Math.min(max, value));
  if (next === active[kind]) return segments;
  return segments.map((segment) => {
    if (segment.sourceIndex === sourceIndex) return { ...segment, [kind]: next, decision: "pending" as const };
    // Move a shared boundary as one edge, preserving at least one frame per segment.
    if (neighbours.includes(segment)) return { ...segment, [kind === "startFrame" ? "endFrame" : "startFrame"]: next + (kind === "startFrame" ? -1 : 1), decision: "pending" as const };
    return segment;
  });
}
