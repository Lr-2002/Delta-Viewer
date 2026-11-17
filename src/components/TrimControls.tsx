import { t, tr, useLanguage } from "../lib/i18n";
import { RotateCcw, Scissors, SkipBack, SkipForward } from "lucide-react";
import type { ExportRange } from "../types";

interface TrimControlsProps {
  minFrame: number;
  maxFrame: number;
  currentFrame: number;
  range: ExportRange;
  stateCount: number;
  durationMs: number | null;
  disabled: boolean;
  onStartChange: (frame: number) => void;
  onEndChange: (frame: number) => void;
  onMarkStart: () => void;
  onMarkEnd: () => void;
  onReset: () => void;
}

export function TrimControls({
  minFrame,
  maxFrame,
  currentFrame,
  range,
  stateCount,
  durationMs,
  disabled,
  onStartChange,
  onEndChange,
  onMarkStart,
  onMarkEnd,
  onReset,
}: TrimControlsProps) {
  useLanguage();
  const span = Math.max(1, maxFrame - minFrame);
  const startPercent = ((range.startFrame - minFrame) / span) * 100;
  const endPercent = ((range.endFrame - minFrame) / span) * 100;
  const playheadPercent = ((currentFrame - minFrame) / span) * 100;

  return (
    <section className="trim-editor" aria-label={t("轨迹时间裁剪")}>
      <div className="trim-heading">
        <span className="trim-title">
          <Scissors size={16} />
          <strong>{t("时间裁剪")}</strong>
        </span>
        <span className="trim-summary">
          {t("帧") + " "}{range.startFrame}–{range.endFrame}
          <i />
          {stateCount}{" " + t("条状态")}<i />
          {tr(formatDuration(durationMs))}
        </span>
        <button
          className="icon-button trim-reset"
          type="button"
          onClick={onReset}
          disabled={disabled || (range.startFrame === minFrame && range.endFrame === maxFrame)}
          title={t("重置为完整轨迹")}
          aria-label={t("重置为完整轨迹")}
        >
          <RotateCcw size={15} />
        </button>
      </div>

      <div className="trim-selection-rail" aria-hidden="true">
        <span
          style={{
            left: `${startPercent}%`,
            width: `${Math.max(0, endPercent - startPercent)}%`,
          }}
        />
        <i style={{ left: `${Math.max(0, Math.min(100, playheadPercent))}%` }} />
      </div>

      <div className="trim-range-row">
        <label htmlFor="trim-start-range">{t("起点")}</label>
        <input
          id="trim-start-range"
          type="range"
          min={minFrame}
          max={range.endFrame}
          value={range.startFrame}
          onChange={(event) => onStartChange(event.currentTarget.valueAsNumber)}
          disabled={disabled}
        />
        <input
          className="trim-frame-input"
          type="number"
          min={minFrame}
          max={range.endFrame}
          value={range.startFrame}
          onChange={(event) => {
            if (Number.isFinite(event.currentTarget.valueAsNumber)) {
              onStartChange(event.currentTarget.valueAsNumber);
            }
          }}
          disabled={disabled}
          aria-label={t("裁剪起始帧")}
        />
        <button className="button button-secondary trim-mark" type="button" onClick={onMarkStart} disabled={disabled} title={t("将起点设为当前帧")}>
          <SkipBack size={14} />
          <span>{t("当前帧")}</span>
        </button>
      </div>

      <div className="trim-range-row">
        <label htmlFor="trim-end-range">{t("终点")}</label>
        <input
          id="trim-end-range"
          type="range"
          min={range.startFrame}
          max={maxFrame}
          value={range.endFrame}
          onChange={(event) => onEndChange(event.currentTarget.valueAsNumber)}
          disabled={disabled}
        />
        <input
          className="trim-frame-input"
          type="number"
          min={range.startFrame}
          max={maxFrame}
          value={range.endFrame}
          onChange={(event) => {
            if (Number.isFinite(event.currentTarget.valueAsNumber)) {
              onEndChange(event.currentTarget.valueAsNumber);
            }
          }}
          disabled={disabled}
          aria-label={t("裁剪结束帧")}
        />
        <button className="button button-secondary trim-mark" type="button" onClick={onMarkEnd} disabled={disabled} title={t("将终点设为当前帧")}>
          <SkipForward size={14} />
          <span>{t("当前帧")}</span>
        </button>
      </div>
    </section>
  );
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "时长 —";
  if (durationMs < 1000) return `${durationMs.toFixed(0)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}
