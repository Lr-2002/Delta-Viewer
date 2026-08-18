export function nextPlaybackFrame(
  currentFrame: number,
  endFrame: number,
  allStreamsSettled: boolean,
): number {
  if (!allStreamsSettled) return currentFrame;
  return Math.min(endFrame, currentFrame + 1);
}

export function playbackFrameDurationMs(fps: number, speed: number): number {
  return 1000 / (Math.max(1, fps) * Math.max(0.01, speed));
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
