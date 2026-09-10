import assert from "node:assert/strict";
import { test } from "node:test";
import { addReviewSegment, splitReviewSegment, deleteReviewSegment, restoreReviewSegments, adjustReviewBoundary, machineSegmentRange, machineTimelineMapping } from "../src/lib/machine-annotation.ts";
import type { ReviewSegment } from "../src/types.ts";

test("deletion aligns actual frames, preserves the following end, and restores coverage", () => {
  const original: ReviewSegment[] = [[0,99],[100,199],[200,299]].map(([startFrame,endFrame], sourceIndex) => ({startFrame,endFrame,sourceIndex,description:`action ${sourceIndex}`,deleted:false,decision:"approved"}));
  const deleted = deleteReviewSegment(original, 1);
  assert.deepEqual(deleted.filter((item) => !item.deleted).map((item) => [item.startFrame,item.endFrame]), [[0,99],[100,299]]);
  assert.equal(deleted[2].decision, "pending");
  assert.deepEqual(restoreReviewSegments(deleted).map((item) => [item.startFrame,item.endFrame,item.deleted]), original.map((item) => [item.startFrame,item.endFrame,item.deleted]));
  assert.equal(deleteReviewSegment(original, 0)[1].startFrame, 0);
  assert.equal(deleteReviewSegment(original, 2)[1].endFrame, 199);
  const twice = deleteReviewSegment(deleted, 0);
  assert.equal(twice[2].startFrame, 0);
  assert.deepEqual(restoreReviewSegments(twice).map((item) => [item.startFrame,item.endFrame]), original.map((item) => [item.startFrame,item.endFrame]));
  assert.equal(deleteReviewSegment(deleted, 1), deleted);
});

test("shared boundaries stay continuous and never collapse their neighbours", () => {
  const segments: ReviewSegment[] = [[0,44],[45,112],[113,194],[210,220]].map(([startFrame,endFrame], sourceIndex) => ({ startFrame,endFrame,sourceIndex,description:"",deleted:false,decision:"approved" }));
  const moved = adjustReviewBoundary(segments, 1, "startFrame", 48, 221);
  assert.equal(moved[0].endFrame, 47);
  assert.equal(moved[1].startFrame, 48);
  assert.equal(moved[0].decision, "pending");
  assert.equal(moved[2].decision, "approved");
  const limited = adjustReviewBoundary(segments, 1, "startFrame", 0, 221);
  assert.equal(limited[0].endFrame, 0);
  assert.equal(limited[1].startFrame, 1);
  const end = adjustReviewBoundary(segments, 1, "endFrame", 220, 221);
  assert.equal(end[1].endFrame, 193);
  assert.equal(end[2].startFrame, 194);
  const gap = adjustReviewBoundary(segments, 3, "startFrame", 209, 221);
  assert.equal(gap[2].endFrame, 194);
  assert.equal(gap[3].startFrame, 209);
  const acrossGap = adjustReviewBoundary(segments, 3, "startFrame", 150, 221);
  assert.equal(acrossGap[3].startFrame, 195);
  assert.equal(acrossGap[2].endFrame, 194);
  const afterDeletion = segments.map((item) => item.sourceIndex === 1 ? { ...item, deleted: true } : item);
  const expanded = adjustReviewBoundary(afterDeletion, 0, "endFrame", 219, 221);
  assert.equal(expanded[0].endFrame, 112);
  assert.equal(expanded[2].startFrame, 113);
});
import type { MachineAnnotation, StreamSummary } from "../src/types.ts";

test("add and split preserve coverage, unique identities and deleted records", () => {
  const segments: ReviewSegment[] = [{ sourceIndex: 0, startFrame: 0, endFrame: 9, description: "动作", deleted: false, decision: "approved" },
    { sourceIndex: 8, startFrame: 10, endFrame: 19, description: "删除", deleted: true, decision: "pending" }];
  const split = splitReviewSegment(segments, 0, 4);
  assert.deepEqual(split.filter((item) => !item.deleted).map((item) => [item.sourceIndex, item.startFrame, item.endFrame]), [[0,0,3],[9,4,9]]);
  assert.equal(split[2].description, "动作");
  assert.equal(split[0].decision, "pending");
  assert.equal(split[1], segments[1]);
  assert.equal(splitReviewSegment(segments, 0, 0), segments);
  assert.equal(splitReviewSegment(segments, 0, 10), segments);
  const added = addReviewSegment(segments, 10, 20);
  assert.equal(added[2].sourceIndex, 9);
  assert.equal(added[2].startFrame, 10);
  assert.equal(addReviewSegment(segments, 20, 20), segments);
  assert.equal(addReviewSegment(segments, 0, 20)[0].endFrame, 0);
});

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
