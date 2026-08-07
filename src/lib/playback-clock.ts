export function nextPlaybackFrame(
  currentFrame: number,
  endFrame: number,
  allStreamsSettled: boolean,
): number {
  if (!allStreamsSettled) return currentFrame;
  return Math.min(endFrame, currentFrame + 1);
}
