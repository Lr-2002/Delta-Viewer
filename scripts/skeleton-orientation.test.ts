import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createSkeletonAlignment, skeletonOrigin, transformSkeletonPoint } from "../src/lib/skeletonOrientation.ts";
import type { SkeletonSeries } from "../src/types.ts";

function skeleton(points: [number, number, number][]): SkeletonSeries {
  return {
    sourceName: "smpl_skeleton.npz",
    frameCount: 1,
    jointCount: points.length,
    frames: [{ frameId: 0, joints: points }],
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} is not close to ${expected}`);
}

test("aligns SMPL Z-up data to a standing Y-up view", () => {
  const points = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  points[0] = [0, 0, 0];
  points[15] = [0, 0, 2];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const head = transformSkeletonPoint(points[15], skeletonOrigin(series.frames[0], 24), alignment);
  assertClose(head.x, 0);
  assertClose(head.y, 2);
  assertClose(head.z, 0);
});

test("keeps an already Y-up skeleton unchanged", () => {
  const points = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  points[0] = [1, 2, 3];
  points[15] = [1, 4, 3];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const head = transformSkeletonPoint(points[15], skeletonOrigin(series.frames[0], 24), alignment);
  assertClose(head.x, 0);
  assertClose(head.y, 2);
  assertClose(head.z, 0);
});

test("keeps the body front-facing after standing alignment", () => {
  const points = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  points[0] = [0, 0, 0];
  points[15] = [0, 0, 2];
  points[1] = [-1, 0, 0];
  points[2] = [1, 0, 0];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const leftHip = transformSkeletonPoint(points[1], skeletonOrigin(series.frames[0], 24), alignment);
  const rightHip = transformSkeletonPoint(points[2], skeletonOrigin(series.frames[0], 24), alignment);
  assert.ok(rightHip.x > leftHip.x);
  assertClose(rightHip.z, leftHip.z);
});

test("uses SMPL foot direction to keep mirrored coordinates front-facing", () => {
  const points = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  points[15] = [0, 2, 0];
  points[1] = [1, 0, 0];
  points[2] = [-1, 0, 0];
  points[7] = [0.5, 0, 0];
  points[8] = [-0.5, 0, 0];
  points[10] = [0.5, 0, 0.4];
  points[11] = [-0.5, 0, 0.4];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const origin = skeletonOrigin(series.frames[0], 24);
  const leftAnkle = transformSkeletonPoint(points[7], origin, alignment);
  const leftFoot = transformSkeletonPoint(points[10], origin, alignment);
  assertClose(leftFoot.x, leftAnkle.x);
  assert.ok(leftFoot.z > leftAnkle.z);
});

test("anchors the fixed heading to the initial reference instead of later turns", () => {
  const first = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  const turned = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  first[15] = [0, 2, 0];
  first[7] = [-0.5, 0, 0];
  first[8] = [0.5, 0, 0];
  first[10] = [-0.5, 0, 0.4];
  first[11] = [0.5, 0, 0.4];
  turned[15] = [0, 2, 0];
  turned[7] = [-0.5, 0, 0];
  turned[8] = [0.5, 0, 0];
  turned[10] = [-0.5, 0, -0.4];
  turned[11] = [0.5, 0, -0.4];
  const series: SkeletonSeries = {
    sourceName: "smpl_skeleton.npz",
    frameCount: 2,
    jointCount: 24,
    frames: [{ frameId: 0, joints: first }, { frameId: 1, joints: turned }],
  };
  const alignment = createSkeletonAlignment(series, 0);
  const origin = skeletonOrigin(series.frames[0], 24);
  const ankle = transformSkeletonPoint(first[7], origin, alignment);
  const foot = transformSkeletonPoint(first[10], origin, alignment);
  assert.ok(foot.z > ankle.z);
});

test("uses the COCO nose direction as the front marker", () => {
  const points = Array.from({ length: 17 }, () => [0, 0, 0] as [number, number, number]);
  points[5] = [-1, 1, 0];
  points[6] = [1, 1, 0];
  points[11] = [-0.5, 0, 0];
  points[12] = [0.5, 0, 0];
  points[0] = [0, 1, 0.5];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const origin = skeletonOrigin(series.frames[0], 17);
  const nose = transformSkeletonPoint(points[0], origin, alignment);
  assert.ok(nose.z > 0);
});

test("uses the corrected horizontal-axis fallback when no front marker exists", () => {
  const points = Array.from({ length: 17 }, () => [0, 0, 0] as [number, number, number]);
  points[5] = [0, 2, 0];
  points[6] = [0, 2, 1];
  points[11] = [0, 0, 0];
  points[12] = [0, 0, 1];
  points[0] = [0, 1, 0.5];
  const series = skeleton(points);
  const alignment = createSkeletonAlignment(series);
  const origin = skeletonOrigin(series.frames[0], 17);
  const leftShoulder = transformSkeletonPoint(points[5], origin, alignment);
  const rightShoulder = transformSkeletonPoint(points[6], origin, alignment);
  assert.ok(rightShoulder.x > leftShoulder.x);
});

test("uses the hip midpoint as the COCO standing origin", () => {
  const points = Array.from({ length: 17 }, () => [0, 0, 0] as [number, number, number]);
  points[5] = [-1, 0, 2];
  points[6] = [1, 0, 2];
  points[11] = [-0.5, 0, 0];
  points[12] = [0.5, 0, 0];
  const origin = skeletonOrigin({ frameId: 0, joints: points }, 17);
  assert.deepEqual(origin.toArray(), [0, 0, 0]);
  const alignment = createSkeletonAlignment(skeleton(points));
  const shoulder = transformSkeletonPoint(points[5], origin, alignment);
  assertClose(shoulder.y, 2);
  assert.ok(new THREE.Vector3(shoulder.x, shoulder.y, shoulder.z).length() > 0);
});

test("keeps frame-relative lean after computing one stable alignment", () => {
  const left = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  const right = Array.from({ length: 24 }, () => [0, 0, 0] as [number, number, number]);
  left[15] = [0, 1, 1];
  right[15] = [0, 1, -1];
  const series: SkeletonSeries = {
    sourceName: "smpl_skeleton.npz",
    frameCount: 2,
    jointCount: 24,
    frames: [{ frameId: 0, joints: left }, { frameId: 1, joints: right }],
  };
  const alignment = createSkeletonAlignment(series);
  const leftHead = transformSkeletonPoint(left[15], skeletonOrigin(series.frames[0], 24), alignment);
  const rightHead = transformSkeletonPoint(right[15], skeletonOrigin(series.frames[1], 24), alignment);
  assertClose(leftHead.y, 1);
  assertClose(rightHead.y, 1);
  assertClose(leftHead.z, 1);
  assertClose(rightHead.z, -1);
});
