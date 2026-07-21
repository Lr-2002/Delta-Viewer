import {
  Bot,
  CheckCircle2,
  Database,
  FileArchive,
  FolderOpen,
  FolderOutput,
  LoaderCircle,
} from "lucide-react";
import { formatBytes, shortPath } from "../lib/format";
import type {
  EpisodeData,
  ExportFormat,
  ExportRange,
  ExportResult,
} from "../types";

const FORMATS: Array<{
  id: ExportFormat;
  name: string;
  extension: string;
  contents: string;
  icon: typeof FileArchive;
}> = [
  {
    id: "mcap",
    name: "MCAP",
    extension: ".mcap",
    contents: "Foxglove 图像 + 位姿 + JSON state",
    icon: FileArchive,
  },
  {
    id: "hdf5",
    name: "HDF5",
    extension: ".h5",
    contents: "结构化 state + 原始 JPEG 数据集",
    icon: Database,
  },
  {
    id: "lerobot_v2",
    name: "LeRobot v2.1",
    extension: "dataset/",
    contents: "Parquet + 5 路 MP4 + meta",
    icon: Bot,
  },
];

export function ExportPanel({
  data,
  range,
  rangeStatus,
  rangeStateCount,
  rangeDurationMs,
  selectedFormat,
  result,
  busy,
  onSelectFormat,
  onExport,
  onReveal,
}: {
  data: EpisodeData;
  range: ExportRange;
  rangeStatus: "ok" | "warning" | "error";
  rangeStateCount: number;
  rangeDurationMs: number | null;
  selectedFormat: ExportFormat;
  result: ExportResult | null;
  busy: boolean;
  onSelectFormat: (format: ExportFormat) => void;
  onExport: () => void;
  onReveal: (path: string) => void;
}) {
  const blocked = rangeStatus === "error";
  const selected = FORMATS.find((format) => format.id === selectedFormat) ?? FORMATS[0];

  return (
    <div className="export-view">
      <div className="section-heading export-heading">
        <div>
          <span className="section-kicker">DATA ADAPTERS</span>
          <h2>导出数据</h2>
        </div>
        <span className={`status-mark status-${rangeStatus}`}>
          {blocked ? "检查未通过" : rangeStatus === "warning" ? "带警告导出" : "可导出"}
        </span>
      </div>

      <div className="export-source-band">
        <div>
          <span>记录</span>
          <strong>{data.summary.name}</strong>
        </div>
        <div>
          <span>裁剪范围</span>
          <strong>帧 {range.startFrame}–{range.endFrame}</strong>
        </div>
        <div>
          <span>片段状态</span>
          <strong>{rangeStateCount} 条 · {formatDuration(rangeDurationMs)}</strong>
        </div>
        <div>
          <span>视频流</span>
          <strong>{data.summary.streams.length}</strong>
        </div>
      </div>

      <fieldset className="format-picker" disabled={busy}>
        <legend>目标格式</legend>
        {FORMATS.map((format) => {
          const Icon = format.icon;
          const checked = selectedFormat === format.id;
          return (
            <label className={`format-option${checked ? " selected" : ""}`} key={format.id}>
              <input
                type="radio"
                name="export-format"
                value={format.id}
                checked={checked}
                onChange={() => onSelectFormat(format.id)}
              />
              <span className="format-icon"><Icon size={20} /></span>
              <span className="format-copy">
                <strong>{format.name}</strong>
                <small>{format.contents}</small>
              </span>
              <code>{format.extension}</code>
              <span className="radio-mark" aria-hidden="true" />
            </label>
          );
        })}
      </fieldset>

      <div className="export-action-row">
        <div>
          <span>当前 adapter</span>
          <strong>{selected.name}</strong>
        </div>
        <button
          className="button button-primary export-button"
          type="button"
          onClick={onExport}
          disabled={busy || blocked}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <FolderOutput size={17} />}
          选择目录并导出
        </button>
      </div>

      {result ? (
        <div className="export-result" role="status">
          <CheckCircle2 size={21} />
          <div>
            <strong>导出完成</strong>
            <span title={result.outputPath}>{shortPath(result.outputPath, 86)}</span>
          </div>
          <div className="export-result-meta">
            <span>{result.totalFiles} 个文件</span>
            <span>{formatBytes(result.totalBytes)}</span>
            <span>{(result.elapsedMs / 1000).toFixed(1)} s</span>
          </div>
          <button
            className="icon-button export-reveal"
            type="button"
            onClick={() => onReveal(result.outputPath)}
            title="在文件管理器中显示"
            aria-label="在文件管理器中显示"
          >
            <FolderOpen size={17} />
          </button>
        </div>
      ) : null}

      {blocked ? (
        <div className="export-blocked">
          当前裁剪片段包含错误。请先在“检查”中处理解码、空流或状态数据问题。
        </div>
      ) : null}
    </div>
  );
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "时长 —";
  if (durationMs < 1000) return `${durationMs.toFixed(0)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}
