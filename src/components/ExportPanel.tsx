import {
  Bot,
  CheckCircle2,
  Database,
  FileArchive,
  FolderOutput,
  LoaderCircle,
} from "lucide-react";
import { formatBytes, shortPath } from "../lib/format";
import type {
  EpisodeData,
  ExportFormat,
  ExportResult,
  ValidationReport,
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
    contents: "JSON state + 5 路 JPEG topic",
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
  report,
  selectedFormat,
  result,
  busy,
  onSelectFormat,
  onExport,
}: {
  data: EpisodeData;
  report: ValidationReport | null;
  selectedFormat: ExportFormat;
  result: ExportResult | null;
  busy: boolean;
  onSelectFormat: (format: ExportFormat) => void;
  onExport: () => void;
}) {
  const blocked = report?.status === "error";
  const selected = FORMATS.find((format) => format.id === selectedFormat) ?? FORMATS[0];

  return (
    <div className="export-view">
      <div className="section-heading export-heading">
        <div>
          <span className="section-kicker">DATA ADAPTERS</span>
          <h2>导出数据</h2>
        </div>
        <span className={`status-mark status-${report?.status ?? "warning"}`}>
          {blocked ? "检查未通过" : report?.status === "warning" ? "带警告导出" : "可导出"}
        </span>
      </div>

      <div className="export-source-band">
        <div>
          <span>记录</span>
          <strong>{data.summary.name}</strong>
        </div>
        <div>
          <span>数据量</span>
          <strong>{formatBytes(data.summary.totalBytes)}</strong>
        </div>
        <div>
          <span>帧 / 状态</span>
          <strong>{data.summary.streams[0]?.frameCount ?? 0} / {data.states.length}</strong>
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
        </div>
      ) : null}

      {blocked ? (
        <div className="export-blocked">
          当前记录包含错误。请先在“检查”中处理解码、空流或状态数据问题。
        </div>
      ) : null}
    </div>
  );
}
