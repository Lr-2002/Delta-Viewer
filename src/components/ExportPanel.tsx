import { t, tr, useLanguage } from "../lib/i18n";
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
  EpisodeAnnotation,
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
    contents: "Foxglove 图像 + 位姿 + JSON state + 片段 Metadata",
    icon: FileArchive,
  },
  {
    id: "hdf5",
    name: "HDF5",
    extension: ".h5",
    contents: "结构化 state + 原始 JPEG 数据集 + 片段 Metadata",
    icon: Database,
  },
  {
    id: "lerobot_v2",
    name: "LeRobot v2.1",
    extension: "dataset/",
    contents: "Parquet + 5 路 MP4 + 片段 Metadata",
    icon: Bot,
  },
];

export function ExportPanel({
  data,
  annotation,
  range,
  rangeStatus,
  rangeStateCount,
  rangeDurationMs,
  validationReady,
  selectedFormat,
  result,
  busy,
  onSelectFormat,
  onCheck,
  onExport,
  onReveal,
}: {
  data: EpisodeData;
  annotation: EpisodeAnnotation | null;
  range: ExportRange;
  rangeStatus: "ok" | "warning" | "error";
  rangeStateCount: number;
  rangeDurationMs: number | null;
  validationReady: boolean;
  selectedFormat: ExportFormat;
  result: ExportResult | null;
  busy: boolean;
  onSelectFormat: (format: ExportFormat) => void;
  onCheck: () => void;
  onExport: () => void;
  onReveal: (path: string) => void;
}) {
  useLanguage();
  const blocked = !validationReady || rangeStatus === "error";
  const selected = FORMATS.find((format) => format.id === selectedFormat) ?? FORMATS[0];

  return (
    <div className="export-view">
      <div className="section-heading export-heading">
        <div>
          <span className="section-kicker">{t("导出格式")}</span>
          <h2>{t("导出数据")}</h2>
        </div>
        <span className={`status-mark status-${rangeStatus}`}>
          {!validationReady ? t("等待检查") : rangeStatus === "error" ? t("检查未通过") : rangeStatus === "warning" ? t("带警告导出") : t("可导出")}
        </span>
      </div>

      <div className="export-source-band">
        <div>
          <span>{annotation ? t("轨迹编码") : t("记录")}</span>
          <strong>{tr(annotation?.trajectoryCode) ?? data.summary.name}</strong>
        </div>
        <div>
          <span>{t("裁剪范围")}</span>
          <strong>{t("帧") + " "}{range.startFrame}–{range.endFrame}</strong>
        </div>
        <div>
          <span>{t("片段状态")}</span>
          <strong>{rangeStateCount}{" " + t("条 ·") + " "}{tr(formatDuration(rangeDurationMs))}</strong>
        </div>
        <div>
          <span>{t("任务")}</span>
          <strong>{tr(annotation?.taskId) ?? t("未标注")}</strong>
        </div>
      </div>

      <fieldset className="format-picker" disabled={busy}>
        <legend>{t("目标格式")}</legend>
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
                <small>{tr(format.contents)}</small>
              </span>
              <code>{tr(format.extension)}</code>
              <span className="radio-mark" aria-hidden="true" />
            </label>
          );
        })}
      </fieldset>

      <div className="export-action-row">
        <div>
          <span>{t("当前 adapter")}</span>
          <strong>{selected.name}</strong>
        </div>
        <button
          className="button button-primary export-button"
          type="button"
          onClick={validationReady ? onExport : onCheck}
          disabled={busy || (validationReady && blocked)}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <FolderOutput size={17} />}
          {validationReady ? t("选择目录并导出") : t("检查数据后导出")}
        </button>
      </div>

      {result ? (
        <div className="export-result" role="status">
          <CheckCircle2 size={21} />
          <div>
            <strong>{t("导出完成")}</strong>
            <span title={tr(result.outputPath)}>{shortPath(result.outputPath, 86)}</span>
            {result.metadataPath ? <small title={tr(result.metadataPath)}>{t("Metadata 已写入：")}{shortPath(result.metadataPath, 72)}</small> : null}
          </div>
          <div className="export-result-meta">
            <span>{result.totalFiles}{" " + t("个文件")}</span>
            <span>{tr(formatBytes(result.totalBytes))}</span>
            <span>{tr((result.elapsedMs / 1000).toFixed(1))} s</span>
          </div>
          <button
            className="icon-button export-reveal"
            type="button"
            onClick={() => onReveal(result.outputPath)}
            title={t("在文件管理器中显示")}
            aria-label={t("在文件管理器中显示")}
          >
            <FolderOpen size={17} />
          </button>
        </div>
      ) : null}

      {blocked ? (
        <div className="export-blocked">
          {validationReady ? t("当前裁剪片段包含错误。请先在“检查”中处理解码、空流或状态数据问题。") : t("数据检查完成后才可导出。")}
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
