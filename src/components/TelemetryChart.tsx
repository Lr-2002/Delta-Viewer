import { useEffect, useMemo, useRef } from "react";
import type { MetricKey, StateRecord } from "../types";

interface TelemetryChartProps {
  states: StateRecord[];
  metric: MetricKey;
  frameId: number;
}

interface FrameBounds {
  firstFrame: number;
  lastFrame: number;
}
const COLORS = ["#d1495b", "#007c73", "#2f67c7", "#8b4fb3"];
const LINE_DASHES = [[], [7, 3], [2, 3], [9, 3, 2, 3]];

const METRIC_LABELS: Record<MetricKey, string> = {
  position: "位置",
  velocity: "速度",
  euler: "欧拉角",
  omega: "角速度",
};

export function TelemetryChart({ states, metric, frameId }: TelemetryChartProps) {
  const plotCanvasRef = useRef<HTMLCanvasElement>(null);
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameIdRef = useRef(frameId);
  frameIdRef.current = frameId;
  const values = useMemo(() => states.map((state) => state[metric]), [metric, states]);
  const stateByFrame = useMemo(
    () => new Map(states.map((state) => [state.frameId, state])),
    [states],
  );
  const frameBounds = useMemo(() => {
    let firstFrame = Number.POSITIVE_INFINITY;
    let lastFrame = Number.NEGATIVE_INFINITY;
    for (const state of states) {
      firstFrame = Math.min(firstFrame, state.frameId);
      lastFrame = Math.max(lastFrame, state.frameId);
    }
    return Number.isFinite(firstFrame) && Number.isFinite(lastFrame)
      ? { firstFrame, lastFrame }
      : null;
  }, [states]);

  useEffect(() => {
    const plotCanvas = plotCanvasRef.current;
    const markerCanvas = markerCanvasRef.current;
    if (!plotCanvas || !markerCanvas) return;
    const container = plotCanvas.parentElement;
    if (!container) return;

    const draw = () => {
      const bounds = container.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, Math.floor(bounds.width));
      const height = Math.max(180, Math.floor(bounds.height));
      for (const canvas of [plotCanvas, markerCanvas]) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const context = plotCanvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

      const padding = { top: 18, right: 18, bottom: 28, left: 54 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const row of values) {
        for (const value of row) {
          if (!Number.isFinite(value)) continue;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return;
      if (minimum === maximum) {
        minimum -= 1;
        maximum += 1;
      }
      const margin = (maximum - minimum) * 0.08;
      minimum -= margin;
      maximum += margin;

      context.strokeStyle = "#dddddd";
      context.lineWidth = 1;
      context.fillStyle = "#666666";
      context.font = "11px system-ui, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let index = 0; index <= 4; index += 1) {
        const y = padding.top + (plotHeight * index) / 4;
        context.beginPath();
        context.moveTo(padding.left, y + 0.5);
        context.lineTo(width - padding.right, y + 0.5);
        context.stroke();
        const value = maximum - ((maximum - minimum) * index) / 4;
        context.fillText(formatAxis(value), padding.left - 8, y);
      }

      const firstFrame = frameBounds?.firstFrame ?? 0;
      const lastFrame = frameBounds?.lastFrame ?? firstFrame;
      const frameSpan = Math.max(lastFrame - firstFrame, 1);
      const xFor = (frame: number) => padding.left + ((frame - firstFrame) / frameSpan) * plotWidth;
      const yFor = (value: number) =>
        padding.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
      const dimensions = values[0]?.length ?? 0;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        context.strokeStyle = COLORS[dimension];
        context.lineWidth = 1.8;
        context.setLineDash(LINE_DASHES[dimension]);
        context.beginPath();
        let started = false;
        for (const index of sampledIndexes(values, dimension, Math.max(1, Math.floor(plotWidth)))) {
          const value = values[index][dimension];
          if (!Number.isFinite(value)) continue;
          const x = xFor(states[index].frameId);
          const y = yFor(value);
          if (!started) {
            context.moveTo(x, y);
            started = true;
          } else {
            context.lineTo(x, y);
          }
        }
        context.stroke();
      }

      context.fillStyle = "#666666";
      context.textAlign = "left";
      context.textBaseline = "bottom";
      context.fillText("0", padding.left, height - 7);
      context.textAlign = "right";
      context.fillText(String(states.at(-1)?.frameId ?? 0), width - padding.right, height - 7);
      if (frameBounds) {
        drawPlaybackMarker(markerCanvas, container, frameBounds, frameIdRef.current);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frameBounds, states, values]);

  useEffect(() => {
    const canvas = markerCanvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container || !frameBounds) return;
    drawPlaybackMarker(canvas, container, frameBounds, frameId);
  }, [frameBounds, frameId]);

  const selected = stateByFrame.get(frameId)?.[metric] ?? null;
  return (
    <section className="telemetry-chart" aria-label={`${METRIC_LABELS[metric]}曲线`}>
      <canvas ref={plotCanvasRef} className="telemetry-plot" />
      <canvas ref={markerCanvasRef} className="telemetry-marker" />
      <div className="chart-legend">
        {selected ? selected.map((value, index) => (
            <span key={index} data-series-color={COLORS[index]}>
              <i style={{ backgroundColor: COLORS[index] }} />
              {index < 3 ? ["X", "Y", "Z"][index] : "W"} {value.toFixed(4)}
            </span>
          )) : <span className="telemetry-unavailable">当前帧无状态数据</span>}
      </div>
    </section>
  );
}

function drawPlaybackMarker(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  frameBounds: FrameBounds,
  frameId: number,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(320, Math.floor(container.getBoundingClientRect().width));
  const height = Math.max(180, Math.floor(container.getBoundingClientRect().height));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const padding = { top: 18, right: 18, bottom: 28, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const frameSpan = Math.max(frameBounds.lastFrame - frameBounds.firstFrame, 1);
  const boundedFrame = Math.max(frameBounds.firstFrame, Math.min(frameBounds.lastFrame, frameId));
  const markerX = padding.left + ((boundedFrame - frameBounds.firstFrame) / frameSpan) * plotWidth;
  context.setLineDash([]);
  context.strokeStyle = "#171717";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(markerX + 0.5, padding.top);
  context.lineTo(markerX + 0.5, padding.top + plotHeight);
  context.stroke();
}

function sampledIndexes(values: number[][], dimension: number, bucketCount: number): number[] {
  if (values.length <= bucketCount * 2) return values.map((_, index) => index);
  const bucketSize = Math.ceil(values.length / bucketCount);
  const indexes: number[] = [];
  for (let start = 0; start < values.length; start += bucketSize) {
    const end = Math.min(values.length, start + bucketSize);
    let minimumIndex = start;
    let maximumIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (values[index][dimension] < values[minimumIndex][dimension]) minimumIndex = index;
      if (values[index][dimension] > values[maximumIndex][dimension]) maximumIndex = index;
    }
    if (minimumIndex <= maximumIndex) {
      indexes.push(minimumIndex);
      if (maximumIndex !== minimumIndex) indexes.push(maximumIndex);
    } else {
      indexes.push(maximumIndex, minimumIndex);
    }
  }
  return indexes;
}

function formatAxis(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000 || (absolute > 0 && absolute < 0.001)) return value.toExponential(1);
  return value.toFixed(absolute >= 10 ? 1 : 2);
}
