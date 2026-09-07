import assert from "node:assert/strict";
import test from "node:test";
import {
  skeletonFrameForTimeline,
  skeletonSampleForTimeline,
} from "../src/lib/skeleton-frame.ts";
import type { SkeletonFrame } from "../src/types.ts";

function frame(frameId: number): SkeletonFrame {
  return { frameId, joints: [] };
}

test("maps a zero-based skeleton to a one-based timeline by sample position", () => {
  const frames = [frame(0), frame(1), frame(2), frame(3)];
  assert.equal(skeletonFrameForTimeline(frames, 1, 1, 4)?.frameId, 0);
  assert.equal(skeletonFrameForTimeline(frames, 3, 1, 4)?.frameId, 2);
  assert.equal(skeletonFrameForTimeline(frames, 4, 1, 4)?.frameId, 3);
});

test("keeps explicit frame ids when skeleton and timeline lengths differ", () => {
  const frames = [frame(10), frame(20), frame(30)];
  assert.equal(skeletonFrameForTimeline(frames, 21, 1, 40, true)?.frameId, 20);
  assert.equal(skeletonFrameForTimeline(frames, 29, 1, 40, true)?.frameId, 30);
});

test("maps an un-timestamped processed skeleton across the complete video duration", () => {
  const frames = Array.from({ length: 634 }, (_, frameId) => frame(frameId));
  assert.equal(skeletonSampleForTimeline(frames, 0, 0, 473)?.index, 0);
  const middle = skeletonSampleForTimeline(frames, 236.5, 0, 473);
  assert.equal(middle?.sourcePosition, 316.5);
  assert.equal(middle?.before.frameId, 316);
  assert.equal(middle?.after.frameId, 317);
  assert.equal(middle?.mix, 0.5);
  assert.equal(skeletonSampleForTimeline(frames, 473, 0, 473)?.index, 633);
});
