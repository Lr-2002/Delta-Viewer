import type { SkeletonFrame } from "../types";

export interface SkeletonTimelineSample {
  frame: SkeletonFrame;
  index: number;
  before: SkeletonFrame;
  after: SkeletonFrame;
  mix: number;
  sourcePosition: number;
}

function sampleAtPosition(
  frames: readonly SkeletonFrame[],
  sourcePosition: number,
): SkeletonTimelineSample {
  const boundedPosition = Math.max(0, Math.min(frames.length - 1, sourcePosition));
  const beforeIndex = Math.floor(boundedPosition);
  const afterIndex = Math.ceil(boundedPosition);
  const index = Math.round(boundedPosition);
  return {
    frame: frames[index],
    index,
    before: frames[beforeIndex],
    after: frames[afterIndex],
    mix: boundedPosition - beforeIndex,
    sourcePosition: boundedPosition,
  };
}

export function skeletonSampleForTimeline(
  frames: readonly SkeletonFrame[],
  timelineFrame: number,
  timelineStartFrame: number,
  timelineEndFrame: number,
  usesTimelineFrameIds = false,
): SkeletonTimelineSample | null {
  if (frames.length === 0) return null;

  if (!usesTimelineFrameIds) {
    const timelineSpan = Math.max(0, timelineEndFrame - timelineStartFrame);
    const progress = timelineSpan === 0
      ? 0
      : Math.max(0, Math.min(1, (timelineFrame - timelineStartFrame) / timelineSpan));
    const sourcePosition = progress * Math.max(0, frames.length - 1);
    return sampleAtPosition(frames, sourcePosition);
  }

  let lower = 0;
  let upper = frames.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = frames[middle];
    if (candidate.frameId === timelineFrame) {
      return sampleAtPosition(frames, middle);
    }
    if (candidate.frameId < timelineFrame) lower = middle + 1;
    else upper = middle - 1;
  }
  const beforeIndex = Math.max(0, upper);
  const afterIndex = Math.min(frames.length - 1, lower);
  const before = frames[beforeIndex];
  const after = frames[afterIndex];
  const frameSpan = after.frameId - before.frameId;
  const mix = frameSpan <= 0
    ? 0
    : Math.max(0, Math.min(1, (timelineFrame - before.frameId) / frameSpan));
  return sampleAtPosition(frames, beforeIndex + (afterIndex - beforeIndex) * mix);
}

export function skeletonFrameForTimeline(
  frames: readonly SkeletonFrame[],
  timelineFrame: number,
  timelineStartFrame: number,
  timelineEndFrame: number,
  usesTimelineFrameIds = false,
): SkeletonFrame | null {
  return skeletonSampleForTimeline(
    frames,
    timelineFrame,
    timelineStartFrame,
    timelineEndFrame,
    usesTimelineFrameIds,
  )?.frame ?? null;
}
