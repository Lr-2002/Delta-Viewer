export interface FrameRenderProgressState {
  root: string | null;
  frameId: number;
  settled: number;
  total: number;
}

export function nextFrameRenderProgress(
  current: FrameRenderProgressState,
  next: FrameRenderProgressState,
): FrameRenderProgressState {
  return current.root === next.root
    && current.frameId === next.frameId
    && current.settled === next.settled
    && current.total === next.total
    ? current
    : next;
}

export function playbackStreamsSettled(
  streamNames: readonly string[],
  settledFrameByStream: ReadonlyMap<string, number>,
  frameId: number,
): boolean {
  return streamNames.every((streamName) => settledFrameByStream.get(streamName) === frameId);
}

export function sequentialFallbackFrame(frameId: number): number {
  return frameId;
}

export function sourceAlignedTimelineFrame(
  frameId: number,
  timelineStartFrame: number,
  timelineFps: number,
  sourceFps: number,
): number {
  if (sourceFps >= timelineFps || frameId <= timelineStartFrame) return frameId;
  const relative = frameId - timelineStartFrame;
  const sourceIndex = Math.floor((relative * sourceFps) / timelineFps + 1e-9);
  return timelineStartFrame + Math.round((sourceIndex * timelineFps) / sourceFps);
}

export function nextPlaybackFrame(
  currentFrame: number,
  endFrame: number,
  shouldAdvance: boolean,
  frameStep = 1,
): number {
  if (!shouldAdvance) return currentFrame;
  return Math.min(endFrame, currentFrame + Math.max(1, Math.round(frameStep)));
}

export function primaryPlaybackFrameStep(timelineFps: number, primarySourceFps: number | null): number {
  if (!primarySourceFps || primarySourceFps >= timelineFps) return 1;
  return Math.max(1, Math.round(timelineFps / primarySourceFps));
}

export function secondaryPlaybackFrame(
  frameId: number,
  timelineStartFrame: number,
  timelineFps: number,
  previewFps = 10,
): number {
  if (frameId <= timelineStartFrame || previewFps >= timelineFps) return frameId;
  const stride = Math.max(1, Math.round(timelineFps / Math.max(1, previewFps)));
  return timelineStartFrame + Math.floor((frameId - timelineStartFrame) / stride) * stride;
}

export function playbackFrameDurationMs(fps: number, speed: number): number {
  return 1000 / (Math.max(1, fps) * Math.max(0.01, speed));
}

export function playbackFrameDue(elapsedMs: number, frameDurationMs: number): boolean {
  // requestAnimationFrame timestamps fluctuate around the nominal refresh
  // period. A small tolerance prevents a 60 FPS clock from falling to 30 FPS
  // whenever a 16.6 ms callback arrives just before a 16.67 ms deadline.
  return elapsedMs >= Math.max(0, frameDurationMs - 1.5);
}

export function playbackAdvanceTimestamp(
  nowMs: number,
  previousAdvanceMs: number,
  frameDurationMs: number,
): number {
  const scheduledAdvanceMs = previousAdvanceMs + frameDurationMs;
  // Preserve the nominal cadence through normal display jitter, but do not
  // emit a rapid catch-up burst after decoding or rendering blocked the UI.
  return nowMs - scheduledAdvanceMs > frameDurationMs
    ? nowMs
    : scheduledAdvanceMs;
}

export function playbackBufferRequirement(
  currentFrame: number,
  playbackEndFrame: number,
  streamEndFrame: number | null,
  readAheadLimit: number,
): number {
  const effectiveEndFrame = Math.min(
    playbackEndFrame,
    streamEndFrame ?? playbackEndFrame,
  );
  return Math.min(
    Math.max(0, readAheadLimit),
    Math.max(0, effectiveEndFrame - currentFrame),
  );
}

export function playbackBufferRatio(readyFrames: number, requiredFrames: number): number {
  if (requiredFrames <= 0) return 1;
  return Math.max(0, Math.min(1, readyFrames / requiredFrames));
}

export function playbackStartFrame(
  liveFrame: number,
  startFrame: number,
  endFrame: number,
): number {
  return liveFrame >= endFrame ? startFrame : liveFrame;
}

export function clampPlaybackFrame(
  liveFrame: number,
  startFrame: number,
  endFrame: number,
): number {
  return Math.max(startFrame, Math.min(endFrame, liveFrame));
}
