import assert from "node:assert/strict";
import { test } from "node:test";
import { machineSegmentRange, machineTimelineMapping } from "../src/lib/machine-annotation.ts";
import type { MachineAnnotation, StreamSummary } from "../src/types.ts";

const annotation = { frameCount: 383 } as MachineAnnotation;
const stream = { firstFrame: 0, lastFrame: 765, frameCount: 383 } as StreamSummary;
test("Camera 0 media frames map to a 60 Hz timeline without stretching to state count", () => {
  const map = machineTimelineMapping(annotation, stream);
  assert.equal(map.error, null);
  assert.equal(map.step, 2);
  const segment = { startFrame: 23, endFrame: 104, label: "walk", description: "", attributes: {} };
  assert.deepEqual(machineSegmentRange(segment, map.offset, map.step), { startFrame: 46, endFrame: 209 });
});
test("hybrid timeline keeps its nonzero frame origin", () => {
  const map = machineTimelineMapping(annotation, { ...stream, firstFrame: 300, lastFrame: 682 });
  assert.equal(map.error, null);
  assert.deepEqual(machineSegmentRange({ startFrame: 0, endFrame: 22, label: "", description: "", attributes: {} }, map.offset, map.step), { startFrame: 300, endFrame: 322 });
});
test("mismatched media and missing camera cannot silently align", () => {
  assert.ok(machineTimelineMapping({ ...annotation, frameCount: 385 }, stream).error);
  assert.ok(machineTimelineMapping(annotation, undefined).error);
  assert.ok(machineTimelineMapping(annotation, { ...stream, lastFrame: 764 }).error);
});
