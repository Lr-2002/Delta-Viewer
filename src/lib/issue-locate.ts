import type { EpisodeData, StreamSummary, ValidationIssue } from "../types";

export interface PlaybackFrameBounds {
  minFrame: number;
  maxFrame: number;
}

export type IssueLocation =
  | { kind: "target"; frameId: number }
  | {
    kind: "unavailable";
    code: "ISSUE_FRAME_UNAVAILABLE" | "STREAM_BOUNDS_UNAVAILABLE" | "STREAM_FRAME_OUT_OF_BOUNDS" | "NO_SYNCHRONIZED_STATE";
    message: string;
  };

export function getPlaybackFrameBounds(data: EpisodeData): PlaybackFrameBounds {
  let maxFrame = -1;
  let minFrame = Number.POSITIVE_INFINITY;
  for (const state of data.states) {
    if (state.frameId < 0) continue;
    minFrame = Math.min(minFrame, state.frameId);
    maxFrame = Math.max(maxFrame, state.frameId);
  }
  if (maxFrame >= 0 && Number.isFinite(minFrame)) {
    return { minFrame, maxFrame };
  }

  for (const stream of data.summary.streams) {
    if (stream.firstFrame !== null) minFrame = Math.min(minFrame, stream.firstFrame);
    maxFrame = Math.max(maxFrame, stream.lastFrame ?? -1);
  }
  return {
    minFrame: Number.isFinite(minFrame) ? minFrame : 0,
    maxFrame: Math.max(0, maxFrame),
  };
}

export function resolveIssueLocation(data: EpisodeData, issue: ValidationIssue): IssueLocation {
  if (issue.frameId === null) {
    return {
      kind: "unavailable",
      code: "ISSUE_FRAME_UNAVAILABLE",
      message: "该检查问题没有可定位的帧。",
    };
  }

  const stream = data.summary.streams.find((candidate) => candidate.name === issue.scope);
  if (!stream) {
    const bounds = getPlaybackFrameBounds(data);
    return { kind: "target", frameId: clamp(issue.frameId, bounds) };
  }

  const bounds = getStreamFrameBounds(stream);
  if (!bounds) {
    return {
      kind: "unavailable",
      code: "STREAM_BOUNDS_UNAVAILABLE",
      message: `无法定位 ${stream.label} 的帧 ${issue.frameId}：该流没有可用的帧范围。`,
    };
  }
  if (issue.frameId < bounds.minFrame || issue.frameId > bounds.maxFrame) {
    return {
      kind: "unavailable",
      code: "STREAM_FRAME_OUT_OF_BOUNDS",
      message: `无法定位 ${stream.label} 的帧 ${issue.frameId}：该流的可用帧范围为 ${bounds.minFrame}–${bounds.maxFrame}。`,
    };
  }
  if (!data.states.some((state) => state.frameId === issue.frameId)) {
    return {
      kind: "unavailable",
      code: "NO_SYNCHRONIZED_STATE",
      message: `无法定位 ${stream.label} 的帧 ${issue.frameId}：没有同帧状态数据，未跳转到相邻状态帧。`,
    };
  }
  return { kind: "target", frameId: issue.frameId };
}

function getStreamFrameBounds(stream: StreamSummary): PlaybackFrameBounds | null {
  if (
    stream.firstFrame === null
    || stream.lastFrame === null
    || stream.firstFrame > stream.lastFrame
  ) {
    return null;
  }
  return { minFrame: stream.firstFrame, maxFrame: stream.lastFrame };
}

function clamp(frameId: number, bounds: PlaybackFrameBounds): number {
  return Math.max(bounds.minFrame, Math.min(bounds.maxFrame, frameId));
}
