import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SkeletonSeries } from "../types";
import {
  skeletonFrameForTimeline,
  skeletonSampleForTimeline,
  type SkeletonTimelineSample,
} from "../lib/skeleton-frame";
import {
  createSkeletonAlignment,
  skeletonOrigin,
  transformSkeletonPoint,
} from "../lib/skeletonOrientation";

interface SkeletonViewerProps {
  skeleton: SkeletonSeries;
  frameId: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  playing?: boolean;
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
    scene.add(new THREE.Points(jointsGeometry, jointsMaterial));

    const edges = skeletonEdges(skeleton.jointCount);
    const initialFrame = skeletonFrameForTimeline(
      skeleton.frames,
      frameId,
      timelineStartFrame,
      timelineEndFrame,
      skeleton.usesTimelineFrameIds,
    );
    const alignment = createSkeletonAlignment(skeleton, initialFrame?.frameId ?? frameId);
    const bonesGeometry = new THREE.BufferGeometry();
    const bonePositions = new Float32Array(edges.length * 6);
    bonesGeometry.setAttribute("position", new THREE.BufferAttribute(bonePositions, 3));
    const bonesMaterial = new THREE.LineBasicMaterial({ color: 0x35bab0, transparent: true, opacity: 0.96 });
    scene.add(new THREE.LineSegments(bonesGeometry, bonesMaterial));

    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(2, 3, 4);
    scene.add(ambient, keyLight);

    let displayedFrame = Math.max(
      timelineStartFrame,
      Math.min(timelineEndFrame, frameId),
    );
    let displayedSourcePosition = -1;
    const render = () => {
      renderer.render(scene, camera);
    };
    const paintFrame = (requestedFrame: number) => {
      const sample = skeletonSampleForTimeline(
        skeleton.frames,
        requestedFrame,
        timelineStartFrame,
        timelineEndFrame,
        skeleton.usesTimelineFrameIds,
      );
      if (!sample) return { extent: 1, minY: -1, maxY: 1 };
      const bounds = fillJointPositions(sample, jointPositions, bonePositions, edges, alignment, skeleton.jointCount);
      jointsGeometry.attributes.position.needsUpdate = true;
      bonesGeometry.attributes.position.needsUpdate = true;
      displayedFrame = requestedFrame;
      displayedSourcePosition = sample.sourcePosition;
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
      if (sample && Math.abs(sample.sourcePosition - displayedSourcePosition) > 1e-4) paintFrame(targetFrame);
    };
    const initialBounds = paintFrame(displayedFrame);
    const bodyHeight = Math.max(0.5, initialBounds.maxY - initialBounds.minY);
    const targetY = initialBounds.minY + bodyHeight * 0.52;
    const cameraDistance = Math.max(1.5, initialBounds.extent * 2.6);
    controls.target.set(0, targetY, 0);
    camera.position.set(0, targetY + cameraDistance * 0.28, cameraDistance);
    camera.near = Math.max(0.001, initialBounds.extent / 1000);
    camera.far = Math.max(100, initialBounds.extent * 100);
    controls.update();
    const grid = new THREE.GridHelper(Math.max(2, initialBounds.extent * 2.4), 10, 0x536061, 0x263032);
    grid.position.y = initialBounds.minY;
    scene.add(grid);

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
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onFramePresenterChange, skeleton, timelineEndFrame, timelineStartFrame]);

  useEffect(() => {
    if (!playing) rendererRef.current?.update(frameId);
  }, [frameId, playing, skeleton]);

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
      <footer>{skeleton.sourceName} · {skeleton.frameCount} 帧</footer>
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
  alignment: THREE.Quaternion,
  jointCount: number,
): SkeletonBounds {
  const beforeOrigin = skeletonOrigin(sample.before, jointCount);
  const afterOrigin = skeletonOrigin(sample.after, jointCount);
  const origin = beforeOrigin.clone().lerp(afterOrigin, sample.mix);
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
    extent = Math.max(extent, Math.hypot(jointPositions[offset], jointPositions[offset + 1], jointPositions[offset + 2]));
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
