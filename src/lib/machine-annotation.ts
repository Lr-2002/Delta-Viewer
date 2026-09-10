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

export function splitReviewSegment(segments: ReviewSegment[], sourceIndex: number, frame: number): ReviewSegment[] {
  const active = segments.find((item) => item.sourceIndex === sourceIndex && !item.deleted);
  if (!active || !Number.isSafeInteger(frame) || frame <= active.startFrame || frame > active.endFrame) return segments;
  const nextIndex = Math.max(-1, ...segments.map((item) => item.sourceIndex)) + 1;
  return [...segments.map((item) => item === active ? { ...item, endFrame: frame - 1, decision: "pending" as const } : item),
    { ...active, sourceIndex: nextIndex, startFrame: frame, decision: "pending" }];
}

export function deleteReviewSegment(segments: ReviewSegment[], sourceIndex: number): ReviewSegment[] {
  const removed = segments.find((item) => item.sourceIndex === sourceIndex && !item.deleted);
  if (!removed) return segments;
  const retained = segments.filter((item) => !item.deleted && item !== removed);
  const previous = retained.filter((item) => item.endFrame < removed.startFrame).sort((a, b) => b.endFrame - a.endFrame)[0];
  const following = retained.filter((item) => item.startFrame > removed.endFrame).sort((a, b) => a.startFrame - b.startFrame)[0];
  return segments.map((item) => {
    if (item === removed) return { ...item, deleted: true, decision: "pending" };
    if (item === following) return { ...item, startFrame: previous ? previous.endFrame + 1 : removed.startFrame, decision: "pending" };
    return item;
  });
}

export function restoreReviewSegments(segments: ReviewSegment[]): ReviewSegment[] {
  let next = segments.map((item) => ({ ...item }));
  const removed = segments.filter((item) => item.deleted).sort((a, b) => b.startFrame - a.startFrame);
  for (const item of removed) {
    next = next.map((current) => {
      if (current.sourceIndex === item.sourceIndex) return { ...current, deleted: false, decision: "pending" };
      if (!current.deleted && current.startFrame <= item.endFrame && current.endFrame > item.endFrame) {
        return { ...current, startFrame: item.endFrame + 1, decision: "pending" };
      }
      return current;
    });
  }
  return next;
}

export function addReviewSegment(segments: ReviewSegment[], frame: number, frameCount: number): ReviewSegment[] {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) return segments;
  const containing = segments.find((item) => !item.deleted && item.startFrame <= frame && frame <= item.endFrame);
  if (containing) {
    return splitReviewSegment(segments, containing.sourceIndex, Math.max(containing.startFrame + 1, frame));
  }
  const nextIndex = Math.max(-1, ...segments.map((item) => item.sourceIndex)) + 1;
  return [...segments, { sourceIndex: nextIndex, startFrame: frame, endFrame: frame, description: "", deleted: false, decision: "pending" }];
}
