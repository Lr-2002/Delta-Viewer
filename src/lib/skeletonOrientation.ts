import * as THREE from "three";
import type { SkeletonFrame, SkeletonSeries } from "../types";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MAX_ALIGNMENT_SAMPLES = 64;

function pointAt(frame: SkeletonFrame, index: number): THREE.Vector3 | null {
  const point = frame.joints[index];
  if (!point || point.length !== 3 || point.some((value) => !Number.isFinite(value))) return null;
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function midpoint(left: THREE.Vector3, right: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().addVectors(left, right).multiplyScalar(0.5);
}

export function skeletonOrigin(frame: SkeletonFrame, jointCount: number): THREE.Vector3 {
  if (jointCount >= 24) return pointAt(frame, 0) ?? new THREE.Vector3();
  if (jointCount >= 17) {
    const leftHip = pointAt(frame, 11);
    const rightHip = pointAt(frame, 12);
    if (leftHip && rightHip) return midpoint(leftHip, rightHip);
  }
  return pointAt(frame, 0) ?? new THREE.Vector3();
}

function bodyUp(frame: SkeletonFrame, jointCount: number): THREE.Vector3 | null {
  const origin = skeletonOrigin(frame, jointCount);
  if (jointCount >= 24) {
    // SMPL joint 15 is the head; the fallback chain handles reduced captures.
    for (const index of [15, 12, 9, 6, 3]) {
      const upper = pointAt(frame, index);
      if (upper) {
        const direction = upper.sub(origin);
        if (direction.lengthSq() > 1e-8) return direction;
      }
    }
  } else if (jointCount >= 17) {
    const leftHip = pointAt(frame, 11);
    const rightHip = pointAt(frame, 12);
    const leftShoulder = pointAt(frame, 5);
    const rightShoulder = pointAt(frame, 6);
    if (leftHip && rightHip && leftShoulder && rightShoulder) {
      const direction = midpoint(leftShoulder, rightShoulder).sub(midpoint(leftHip, rightHip));
      if (direction.lengthSq() > 1e-8) return direction;
    }
  }
  return null;
}

export function createSkeletonAlignment(skeleton: SkeletonSeries): THREE.Quaternion {
  const { frames, jointCount } = skeleton;
  const sampleCount = Math.min(MAX_ALIGNMENT_SAMPLES, frames.length);
  const average = new THREE.Vector3();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const index = sampleCount <= 1 ? 0 : Math.round((sample * (frames.length - 1)) / (sampleCount - 1));
    const direction = bodyUp(frames[index], jointCount);
    if (direction) average.add(direction.normalize());
  }
  if (average.lengthSq() <= 1e-8) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(average.normalize(), WORLD_UP);
}

export function transformSkeletonPoint(
  point: [number, number, number],
  origin: THREE.Vector3,
  alignment: THREE.Quaternion,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.set(point[0], point[1], point[2]).sub(origin).applyQuaternion(alignment);
}
