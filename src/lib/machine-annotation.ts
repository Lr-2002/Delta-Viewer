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

// Restore emergency edits without submitting stale/invalid indices or ranges.
// Range errors preserve the raw snapshot and let the caller keep the loaded source.
export function recoverReviewSegments(value: unknown, frameCount: number, originalFrameCount = frameCount): { segments: ReviewSegment[] | null; repaired: boolean } {
  if (!Array.isArray(value) || value.length > 2000) return { segments: null, repaired: false };
  const used = new Set<number>();
  let next = value.length + 2000;
  let repaired = false;
  const segments: ReviewSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { segments: null, repaired: false };
    const item = entry as Partial<ReviewSegment>;
    if (!Number.isSafeInteger(item.startFrame) || !Number.isSafeInteger(item.endFrame) || item.startFrame! < 0 || item.startFrame! > item.endFrame! || item.endFrame! >= (item.deleted === true ? Math.max(frameCount, originalFrameCount) : frameCount) || typeof item.description !== "string" || new TextEncoder().encode(item.description).length > 16384) return { segments: null, repaired: false };
    let index = item.sourceIndex;
    if (!Number.isSafeInteger(index) || index! < 0 || used.has(index!)) {
      while (used.has(next) || value.some(other => other?.sourceIndex === next)) next++;
      index = next++; repaired = true;
    }
    used.add(index!);
    const decision = ["pending", "approved", "rejected"].includes(item.decision ?? "") ? item.decision! : "pending";
    repaired ||= decision !== item.decision;
    segments.push({ sourceIndex: index!, startFrame: item.startFrame!, endFrame: item.endFrame!, description: item.description, deleted: item.deleted === true, decision });
  }
  return { segments, repaired };
}

// Explicit, human-confirmed intersection with the playable video, never a time stretch.
// Keep fully outside rows as deleted history with their exact original text/range.
export function reviewVideoIntersection(segments: ReviewSegment[], frameCount: number) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) return null;
  const affected = segments.filter(item => !item.deleted && item.endFrame >= frameCount);
  return {
    affected,
    trimmed: affected.filter(item => item.startFrame < frameCount).length,
    excluded: affected.filter(item => item.startFrame >= frameCount).length,
    segments: segments.map(item => item.deleted || item.endFrame < frameCount ? item : {
      ...item, endFrame: item.startFrame < frameCount ? frameCount - 1 : item.endFrame,
      deleted: item.startFrame >= frameCount, decision: "pending" as const,
    }),
  };
}

export function machineSegmentRange(segment: MachineSegment, offset: number, step: number): ExportRange {
  return { startFrame: offset + segment.startFrame * step, endFrame: offset + (segment.endFrame + 1) * step - 1 };
}

export function adjustReviewBoundary(segments: ReviewSegment[], sourceIndex: number, kind: "startFrame" | "endFrame", value: number, frameCount: number) {
  const active = segments.find((segment) => segment.sourceIndex === sourceIndex && !segment.deleted);
  if (!active || !Number.isSafeInteger(value)) return segments;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) return segments;
  const min = kind === "startFrame" ? 0 : active.startFrame;
  const max = kind === "endFrame" ? frameCount - 1 : active.endFrame;
  const next = Math.max(min, Math.min(max, value));
  if (next === active[kind]) return segments;
  return segments.map((segment) => {
    if (segment.sourceIndex === sourceIndex) return { ...segment, [kind]: next, decision: "pending" as const };
    if (segment.deleted) return segment;
    const start = kind === "startFrame" ? next : active.startFrame;
    const end = kind === "endFrame" ? next : active.endFrame;
    // Fully covered rows keep their exact original range/text in recoverable history.
    if (segment.startFrame >= start && segment.endFrame <= end)
      return { ...segment, deleted: true, decision: "pending" as const };
    if (segment.startFrame < start && segment.endFrame >= start)
      return { ...segment, endFrame: start - 1, decision: "pending" as const };
    if (segment.endFrame > end && segment.startFrame <= end)
      return { ...segment, startFrame: end + 1, decision: "pending" as const };
    // Shrinking still moves the previously shared edge, without creating a gap.
    if (kind === "startFrame" && segment.endFrame + 1 === active.startFrame)
      return { ...segment, endFrame: next - 1, decision: "pending" as const };
    if (kind === "endFrame" && segment.startFrame === active.endFrame + 1)
      return { ...segment, startFrame: next + 1, decision: "pending" as const };
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
  const removed = segments.filter(item => item.deleted).sort((a,b) => a.startFrame - b.startFrame);
  let nextIndex = Math.max(-1, ...segments.map(item => item.sourceIndex)) + 1;
  return segments.flatMap((item): ReviewSegment[] => {
    if (item.deleted) return [{ ...item, deleted: false, decision: "pending" }];
    let ranges = [[item.startFrame, item.endFrame]];
    for (const restored of removed) ranges = ranges.flatMap(([start,end]) => {
      if (end < restored.startFrame || start > restored.endFrame) return [[start,end]];
      const pieces: number[][] = [];
      if (start < restored.startFrame) pieces.push([start,restored.startFrame-1]);
      if (end > restored.endFrame) pieces.push([restored.endFrame+1,end]);
      return pieces;
    });
    if (!ranges.length) return [{ ...item, deleted: true, decision: "pending" }];
    if (ranges.length === 1 && ranges[0][0] === item.startFrame && ranges[0][1] === item.endFrame) return [item];
    return ranges.map(([startFrame,endFrame],i) => ({ ...item, sourceIndex:i ? nextIndex++ : item.sourceIndex, startFrame,endFrame,decision:"pending" }));
  });
}

export function addReviewSegment(segments: ReviewSegment[], frame: number, frameCount: number): ReviewSegment[] {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) return segments;
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) return segments;
  if (!segments.some((item) => !item.deleted)) {
    const nextIndex = Math.max(-1, ...segments.map((item) => item.sourceIndex)) + 1;
    return [...segments, { sourceIndex: nextIndex, startFrame: 0, endFrame: frameCount - 1, description: "", deleted: false, decision: "pending" }];
  }
  const containing = segments.find((item) => !item.deleted && item.startFrame <= frame && frame <= item.endFrame);
  if (containing) {
    return splitReviewSegment(segments, containing.sourceIndex, Math.max(containing.startFrame + 1, frame));
  }
  const nextIndex = Math.max(-1, ...segments.map((item) => item.sourceIndex)) + 1;
  return [...segments, { sourceIndex: nextIndex, startFrame: frame, endFrame: frame, description: "", deleted: false, decision: "pending" }];
}
