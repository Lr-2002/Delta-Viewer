/** Source frame indices are split by encoded frame count, not wall clock time. */
export function captureFrameIndex(times: readonly number[], frame: number): number {
  let low = 0, high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] <= frame + 1e-7) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
export function captureVideoPosition(times: readonly number[], frame: number, fps: number, segmentSeconds: number) {
  const index = captureFrameIndex(times, frame);
  const perSegment = Math.max(1, Math.round(fps * segmentSeconds));
  const segment = Math.floor(index / perSegment);
  return { segment, seconds: (index % perSegment + 0.5) / fps };
}
export function captureTimelinePosition(times: readonly number[], seconds: number, segment: number, fps: number, segmentSeconds: number): number {
  const position = Math.max(0, segment * Math.round(fps * segmentSeconds) + seconds * fps);
  const index = Math.min(times.length - 1, Math.floor(position + 1e-6));
  const next = Math.min(times.length - 1, index + 1);
  return times[index] + (times[next] - times[index]) * Math.max(0, Math.min(1, position - index));
}
export function capturePlaybackRate(times: readonly number[], segment: number, fps: number, segmentSeconds: number, timelineFps: number): number {
  const perSegment = Math.max(1, Math.round(fps * segmentSeconds));
  const first = Math.min(times.length - 1, segment * perSegment);
  const last = Math.min(times.length - 1, first + perSegment - 1);
  const actual = (times[last] - times[first]) / timelineFps;
  const rate = actual > 0 ? (last - first) / fps / actual : 1;
  return Math.max(0.5, Math.min(2, rate));
}
