export const SKELETON_CATCHUP_RATES = [1, 1.02, 1.05, 1.1] as const;
export const MAX_SKELETON_LEAD_SECONDS = 0.8;

/** Display-only experiment, anchored to source time rather than a second clock. */
export function skeletonCatchupFrame(
  frame: number,
  start: number,
  end: number,
  fps: number,
  rate: number,
): number {
  if (![frame, start, end, fps, rate].every(Number.isFinite) || end < start) return frame;
  // Paused inspection can seek outside the selected segment. Do not change
  // exact-mode output, or pin such a seek to the segment's first/last frame.
  if (rate === 1 || frame < start || frame > end) return frame;
  const current = frame;
  if (fps <= 0 || !SKELETON_CATCHUP_RATES.some(value => value === rate)) return current;
  const lead = Math.min(Math.max(0, current - start) * (rate - 1), fps * MAX_SKELETON_LEAD_SECONDS);
  return Math.min(end, current + lead);
}
