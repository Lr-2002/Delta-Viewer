import type { ExportRange, MachineAnnotation, MachineSegment, StreamSummary } from "../types.ts";

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
