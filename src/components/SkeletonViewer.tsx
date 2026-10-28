import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SkeletonSeries } from "../types";
import {
  skeletonSampleForTimeline,
  type SkeletonTimelineSample,
} from "../lib/skeleton-frame";
import {
  createSkeletonGroundReference,
  skeletonOrigin,
  transformSkeletonPoint,
  type SkeletonGroundReference,
} from "../lib/skeletonOrientation";

interface SkeletonViewerProps {
  skeleton: SkeletonSeries;
  frameId: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  playing?: boolean;
  nativePlayback?: boolean;
  onFramePresenterChange?: (presenter: ((frameId: number) => void) | null) => void;
}

interface RendererState {
  update: (frameId: number) => void;
  render: () => void;
}

interface SkeletonBounds {
  extent: number;
  minY: number;
  maxY: number;
}

const SMPL_EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8],
  [6, 9], [7, 10], [8, 11], [9, 12], [12, 13], [12, 14], [12, 15],
  [13, 16], [14, 17], [16, 18], [17, 19], [18, 20], [19, 21], [20, 22], [21, 23],
];
const COCO_EDGES: [number, number][] = [
  [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
];

export const SkeletonViewer = memo(function SkeletonViewer({
  skeleton,
  frameId,
  timelineStartFrame,
  timelineEndFrame,
  playing = false,
  nativePlayback = false,
  onFramePresenterChange,
}: SkeletonViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const frameLabelRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<RendererState | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    setUnavailable(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
        // The viewer's canvas is also used for deterministic screenshots and
        // pixel checks, so keep its drawing buffer available after compositing.
        preserveDrawingBuffer: true,
      });
    } catch {
      setUnavailable(true);
      return undefined;
    }

    renderer.setClearColor(0x111516, 1);
    // The skeleton is a compact overlay. A 1.5x cap avoids making WebView2
    // rasterize a needlessly large MSAA buffer on high-DPI displays.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.domElement.setAttribute("aria-label", "SMPL 骨架三维视图");
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.001, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    camera.up.set(0, 1, 0);

    const jointsGeometry = new THREE.BufferGeometry();
    const jointPositions = new Float32Array(skeleton.jointCount * 3);
    jointsGeometry.setAttribute("position", new THREE.BufferAttribute(jointPositions, 3));
    const jointsMaterial = new THREE.PointsMaterial({ color: 0xf2f5f5, size: 0.042, sizeAttenuation: true });
    const joints = new THREE.Points(jointsGeometry, jointsMaterial);
    joints.frustumCulled = false;
    scene.add(joints);

    const edges = skeletonEdges(skeleton.jointCount);
    const reference = createSkeletonGroundReference(skeleton);
    const bonesGeometry = new THREE.BufferGeometry();
    const bonePositions = new Float32Array(edges.length * 6);
    bonesGeometry.setAttribute("position", new THREE.BufferAttribute(bonePositions, 3));
    const bonesMaterial = new THREE.LineBasicMaterial({ color: 0x35bab0, transparent: true, opacity: 0.96 });
    const bones = new THREE.LineSegments(bonesGeometry, bonesMaterial);
    bones.frustumCulled = false;
    scene.add(bones);

    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(2, 3, 4);
    scene.add(ambient, keyLight);

    const { bodyHeight, floorY } = reference;
    const floorGeometry = new THREE.PlaneGeometry(bodyHeight * 400, bodyHeight * 400);
    const floorMaterial = new THREE.MeshBasicMaterial({ color: 0x1c2427, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY - bodyHeight * 0.002;
    scene.add(floor);
    scene.fog = new THREE.Fog(0x111516, bodyHeight * 5, bodyHeight * 18);
    const gridSize = bodyHeight * 16;
    const grid = new THREE.GridHelper(gridSize, 32, 0x829396, 0x415356);
    grid.position.y = floorY;
    scene.add(grid);
    const markerGeometry = new THREE.RingGeometry(bodyHeight * 0.1, bodyHeight * 0.112, 48);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x95a8aa, side: THREE.DoubleSide });
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = floorY + bodyHeight * 0.002;
    scene.add(marker);
    let previousRoot: THREE.Vector3 | null = null;
    let displayedFrame = Math.max(
      timelineStartFrame,
      Math.min(timelineEndFrame, frameId),
    );
    let displayedSourcePosition = -1;
    const render = () => {
      renderer.render(scene, camera);
    };
    const paintFrame = (requestedFrame: number, sample = skeletonSampleForTimeline(
        skeleton.frames,
        requestedFrame,
        timelineStartFrame,
        timelineEndFrame,
        skeleton.usesTimelineFrameIds,
      )) => {
      if (!sample) return { extent: 1, minY: -1, maxY: 1 };
      const bounds = fillJointPositions(sample, jointPositions, bonePositions, edges, reference, skeleton.jointCount);
      const root = skeletonOrigin(sample.before, skeleton.jointCount).lerp(skeletonOrigin(sample.after, skeleton.jointCount), sample.mix);
      root.sub(reference.origin).applyQuaternion(reference.alignment).setY(0);
      if (previousRoot) {
        const delta = root.clone().sub(previousRoot);
        camera.position.add(delta);
        controls.target.add(delta);
      }
      previousRoot = root;
      marker.position.x = root.x;
      marker.position.z = root.z;
      // Move by whole cells only; the world grid stays visually fixed even on
      // long walks, while geometry remains small and independent of clip length.
      const cell = gridSize / 32;
      grid.position.x = Math.round(root.x / cell) * cell;
      grid.position.z = Math.round(root.z / cell) * cell;
      floor.position.x = root.x;
      floor.position.z = root.z;
      jointsGeometry.attributes.position.needsUpdate = true;
      bonesGeometry.attributes.position.needsUpdate = true;
      displayedFrame = requestedFrame;
      displayedSourcePosition = sample.sourcePosition;
      renderer.domElement.dataset.floorY = String(floorY);
      renderer.domElement.dataset.rootY = String(jointPositions[1]);
      renderer.domElement.dataset.frameId = String(Math.round(displayedFrame));
      renderer.domElement.dataset.skeletonFrameId = String(sample.frame.frameId);
      if (frameLabelRef.current) {
        frameLabelRef.current.textContent = `帧 ${Math.round(displayedFrame)} · ${skeleton.jointCount} 关节`;
      }
      render();
      return bounds;
    };
    const update = (requestedFrame: number) => {
      const targetFrame = Math.max(
        timelineStartFrame,
        Math.min(timelineEndFrame, requestedFrame),
      );
      const sample = skeletonSampleForTimeline(
        skeleton.frames,
        targetFrame,
        timelineStartFrame,
        timelineEndFrame,
        skeleton.usesTimelineFrameIds,
      );
      if (sample && Math.abs(sample.sourcePosition - displayedSourcePosition) > 1e-4) paintFrame(targetFrame, sample);
    };
    const initialBounds = paintFrame(displayedFrame);
    const targetY = floorY + bodyHeight * 0.55;
    const cameraDistance = Math.max(bodyHeight * 2.1, initialBounds.extent * 2.6);
    const rootX = marker.position.x;
    const rootZ = marker.position.z;
    controls.target.set(rootX, targetY, rootZ);
    camera.position.set(rootX + cameraDistance * 0.22, targetY + cameraDistance * 0.28, rootZ + cameraDistance);
    camera.near = Math.max(0.001, bodyHeight / 1000);
    camera.far = Math.max(100, bodyHeight * 500);
    controls.update();

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Resize and initial mount must paint synchronously so the canvas never
      // presents a blank frame while the first animation tick is pending.
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    controls.addEventListener("change", render);
    rendererRef.current = { update, render };
    onFramePresenterChange?.(update);
    resize();

    return () => {
      onFramePresenterChange?.(null);
      rendererRef.current = null;
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      jointsGeometry.dispose();
      jointsMaterial.dispose();
      bonesGeometry.dispose();
      bonesMaterial.dispose();
      grid.geometry.dispose();
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach(material => material.dispose());
      floorGeometry.dispose();
      floorMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onFramePresenterChange, skeleton, timelineEndFrame, timelineStartFrame]);

  useLayoutEffect(() => {
    // JPEG timeline updates become visible with the React commit. Native MP4
    // presentation callbacks retain ownership of continuous subframe updates.
    if (!playing || !nativePlayback) rendererRef.current?.update(frameId);
  }, [frameId, nativePlayback, playing, skeleton]);

  return (
    <section className="skeleton-viewer" aria-label="SMPL 骨架">
      <header className="skeleton-heading">
        <div>
          <span className="section-kicker">SMPL / SKELETON</span>
          <h2>三维骨架</h2>
        </div>
        <span ref={frameLabelRef}>帧 {frameId} · {skeleton.jointCount} 关节</span>
      </header>
      <div ref={mountRef} className="skeleton-canvas" />
      {unavailable ? <p className="skeleton-unavailable">当前设备不支持 3D 渲染</p> : null}
      <footer>{skeleton.sourceName} · {skeleton.frameCount} 帧 · {skeleton.jointSource === "raw_smpl_joints" ? "原始同帧估计 · " : skeleton.jointSource === "smpl_joints" ? "滤波估计 · " : ""}估计地面参照</footer>
    </section>
  );
});

function skeletonEdges(jointCount: number): [number, number][] {
  const definition = jointCount >= 24 ? SMPL_EDGES : jointCount >= 17 ? COCO_EDGES : [];
  if (definition.length > 0) return definition.filter(([from, to]) => from < jointCount && to < jointCount);
  return Array.from({ length: Math.max(0, jointCount - 1) }, (_, index) => [index, index + 1]);
}

function fillJointPositions(
  sample: SkeletonTimelineSample,
  jointPositions: Float32Array,
  bonePositions: Float32Array,
  edges: [number, number][],
  reference: SkeletonGroundReference,
  jointCount: number,
): SkeletonBounds {
  const beforeOrigin = skeletonOrigin(sample.before, jointCount);
  const afterOrigin = skeletonOrigin(sample.after, jointCount);
  const { origin, alignment } = reference;
  const movingOrigin = beforeOrigin.clone().lerp(afterOrigin, sample.mix).sub(origin).applyQuaternion(alignment);
  let extent = 0.5;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const transformed = new THREE.Vector3();
  const interpolatedPoint: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < jointPositions.length / 3; index += 1) {
    const before = sample.before.joints[index] ?? [beforeOrigin.x, beforeOrigin.y, beforeOrigin.z] as [number, number, number];
    const after = sample.after.joints[index] ?? before;
    interpolatedPoint[0] = before[0] + (after[0] - before[0]) * sample.mix;
    interpolatedPoint[1] = before[1] + (after[1] - before[1]) * sample.mix;
    interpolatedPoint[2] = before[2] + (after[2] - before[2]) * sample.mix;
    const offset = index * 3;
    transformSkeletonPoint(interpolatedPoint, origin, alignment, transformed);
    jointPositions[offset] = transformed.x;
    jointPositions[offset + 1] = transformed.y;
    jointPositions[offset + 2] = transformed.z;
    extent = Math.max(extent, transformed.distanceTo(movingOrigin));
    minY = Math.min(minY, transformed.y);
    maxY = Math.max(maxY, transformed.y);
  }
  for (const [edgeIndex, [from, to]] of edges.entries()) {
    const target = edgeIndex * 6;
    const fromOffset = from * 3;
    const toOffset = to * 3;
    bonePositions.set(jointPositions.subarray(fromOffset, fromOffset + 3), target);
    bonePositions.set(jointPositions.subarray(toOffset, toOffset + 3), target + 3);
  }
  return {
    extent,
    minY: Number.isFinite(minY) ? minY : -extent * 0.8,
    maxY: Number.isFinite(maxY) ? maxY : extent * 0.2,
  };
}
