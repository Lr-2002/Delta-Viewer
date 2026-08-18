import * as THREE from "three";
import type { SkeletonFrame, SkeletonSeries } from "../types";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MAX_ALIGNMENT_SAMPLES = 24;

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

function bodyRight(frame: SkeletonFrame, jointCount: number): THREE.Vector3 | null {
  const pairs: [number, number][] = jointCount >= 24
    ? [[2, 1], [14, 13], [17, 16], [8, 7]]
    : jointCount >= 17
      ? [[12, 11], [6, 5]]
      : [];
  for (const [rightIndex, leftIndex] of pairs) {
    const right = pointAt(frame, rightIndex);
    const left = pointAt(frame, leftIndex);
    if (!right || !left) continue;
    const direction = right.sub(left);
    if (direction.lengthSq() > 1e-8) return direction;
  }
  return null;
}

function bodyForward(frame: SkeletonFrame, jointCount: number): THREE.Vector3 | null {
  if (jointCount >= 24) {
    // SMPL foot joints sit ahead of their corresponding ankles. Unlike the
    // left/right axis, this remains meaningful when a source has been mirrored.
    const directions: THREE.Vector3[] = [];
    for (const [footIndex, ankleIndex] of [[10, 7], [11, 8]]) {
      const foot = pointAt(frame, footIndex);
      const ankle = pointAt(frame, ankleIndex);
      if (!foot || !ankle) continue;
      const direction = foot.sub(ankle);
      if (direction.lengthSq() > 1e-8) directions.push(direction.normalize());
    }
    if (directions.length > 0) {
      return directions.reduce((total, direction) => total.add(direction), new THREE.Vector3());
    }
  } else if (jointCount >= 17) {
    // COCO has no toe joints. The nose projects from the shoulder line toward
    // the face, providing the available non-symmetric front direction.
    const nose = pointAt(frame, 0);
    const leftShoulder = pointAt(frame, 5);
    const rightShoulder = pointAt(frame, 6);
    if (nose && leftShoulder && rightShoulder) {
      const direction = nose.sub(midpoint(leftShoulder, rightShoulder));
      if (direction.lengthSq() > 1e-8) return direction;
    }
  }
  return null;
}

function closestFrameIndex(frames: SkeletonFrame[], frameId: number | undefined): number {
  if (frameId === undefined || frames.length <= 1) return 0;
  let closest = 0;
  let closestDistance = Math.abs(frames[0].frameId - frameId);
  for (let index = 1; index < frames.length; index += 1) {
    const distance = Math.abs(frames[index].frameId - frameId);
    if (distance >= closestDistance) continue;
    closest = index;
    closestDistance = distance;
  }
  return closest;
}

function alignmentSamples(frames: SkeletonFrame[], referenceFrameId: number | undefined): SkeletonFrame[] {
  const center = closestFrameIndex(frames, referenceFrameId);
  const samples: SkeletonFrame[] = [];
  for (let distance = 0; samples.length < MAX_ALIGNMENT_SAMPLES; distance += 1) {
    const after = center + distance;
    if (after < frames.length) samples.push(frames[after]);
    if (distance === 0 || samples.length >= MAX_ALIGNMENT_SAMPLES) continue;
    const before = center - distance;
    if (before >= 0) samples.push(frames[before]);
    if (after >= frames.length && before < 0) break;
  }
  return samples;
}

function averageDirection(
  frames: SkeletonFrame[],
  jointCount: number,
  vertical: THREE.Quaternion | null,
  select: (frame: SkeletonFrame, jointCount: number) => THREE.Vector3 | null,
): THREE.Vector3 | null {
  const directions: THREE.Vector3[] = [];
  for (const frame of frames) {
    const direction = select(frame, jointCount);
    if (!direction) continue;
    if (vertical) direction.applyQuaternion(vertical).setY(0);
    if (direction.lengthSq() > 1e-8) directions.push(direction.normalize());
  }
  const reference = directions[0];
  if (!reference) return null;

  // Keep the loaded pose as the anchor. Later turns must remain visible during
  // playback rather than cancelling out or flipping the initial orientation.
  const average = new THREE.Vector3();
  for (const direction of directions) {
    if (direction.dot(reference) > 0) average.add(direction);
  }
  return average.lengthSq() > 1e-8 ? average.normalize() : null;
}

export function createSkeletonAlignment(
  skeleton: SkeletonSeries,
  referenceFrameId?: number,
): THREE.Quaternion {
  const { frames, jointCount } = skeleton;
  const samples = alignmentSamples(frames, referenceFrameId);
  const averageUp = new THREE.Vector3();
  for (const frame of samples) {
    const direction = bodyUp(frame, jointCount);
    if (direction) averageUp.add(direction.normalize());
  }
  const vertical = averageUp.lengthSq() <= 1e-8
    ? new THREE.Quaternion()
    : new THREE.Quaternion().setFromUnitVectors(averageUp.normalize(), WORLD_UP);

  let forward = averageDirection(samples, jointCount, vertical, bodyForward);
  if (!forward) {
    const right = averageDirection(samples, jointCount, vertical, bodyRight);
    if (right) forward = right.cross(WORLD_UP).normalize();
  }
  if (!forward || forward.lengthSq() <= 1e-8) return vertical;

  // The initial camera is on +Z. Align an anatomical front marker there, which
  // works for both normal and mirrored source coordinate systems.
  const yaw = -Math.atan2(forward.x, forward.z);
  return new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw).multiply(vertical);
}

export function transformSkeletonPoint(
  point: [number, number, number],
  origin: THREE.Vector3,
  alignment: THREE.Quaternion,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.set(point[0], point[1], point[2]).sub(origin).applyQuaternion(alignment);
}
