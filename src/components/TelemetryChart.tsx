import { useEffect, useMemo, useRef } from "react";
import type { MetricKey, StateRecord } from "../types";

interface TelemetryChartProps {
  states: StateRecord[];
  metric: MetricKey;
  frameId: number;
}
const COLORS = ["#167f6b", "#d25b40", "#3175b9", "#9b6a20"];

const METRIC_LABELS: Record<MetricKey, string> = {
  position: "位置",
  velocity: "速度",
  euler: "欧拉角",
  omega: "角速度",
};

export function TelemetryChart({ states, metric, frameId }: TelemetryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const values = useMemo(() => states.map((state) => state[metric]), [metric, states]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const draw = () => {
      const bounds = container.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, Math.floor(bounds.width));
      const height = Math.max(180, Math.floor(bounds.height));
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

      const padding = { top: 18, right: 18, bottom: 28, left: 54 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const flat = values.flat().filter(Number.isFinite);
      if (!flat.length) return;
      let minimum = Math.min(...flat);
      let maximum = Math.max(...flat);
      if (minimum === maximum) {
        minimum -= 1;
        maximum += 1;
      }
      const margin = (maximum - minimum) * 0.08;
      minimum -= margin;
      maximum += margin;

      context.strokeStyle = "#d9ddda";
      context.lineWidth = 1;
      context.fillStyle = "#68716b";
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

      const pointCount = Math.max(states.length - 1, 1);
      const xFor = (index: number) => padding.left + (index / pointCount) * plotWidth;
      const yFor = (value: number) =>
        padding.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
      const dimensions = values[0]?.length ?? 0;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        context.strokeStyle = COLORS[dimension];
        context.lineWidth = 1.5;
        context.beginPath();
        values.forEach((row, index) => {
          const x = xFor(index);
          const y = yFor(row[dimension]);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }

      const selectedIndex = Math.max(0, states.findIndex((state) => state.frameId >= frameId));
      const markerX = xFor(selectedIndex);
      context.strokeStyle = "#151a17";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(markerX + 0.5, padding.top);
      context.lineTo(markerX + 0.5, padding.top + plotHeight);
      context.stroke();

      context.fillStyle = "#68716b";
      context.textAlign = "left";
      context.textBaseline = "bottom";
      context.fillText("0", padding.left, height - 7);
      context.textAlign = "right";
      context.fillText(String(states.at(-1)?.frameId ?? 0), width - padding.right, height - 7);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frameId, states, values]);

  const selected = states.find((state) => state.frameId === frameId)?.[metric] ?? values[0] ?? [];
  return (
    <section className="telemetry-chart" aria-label={`${METRIC_LABELS[metric]}曲线`}>
      <canvas ref={canvasRef} />
      <div className="chart-legend" aria-hidden="true">
        {selected.map((value, index) => (
          <span key={index}>
            <i style={{ backgroundColor: COLORS[index] }} />
            {index < 3 ? ["X", "Y", "Z"][index] : "W"} {value.toFixed(4)}
          </span>
        ))}
      </div>
    </section>
  );
}

function formatAxis(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000 || (absolute > 0 && absolute < 0.001)) return value.toExponential(1);
  return value.toFixed(absolute >= 10 ? 1 : 2);
}
