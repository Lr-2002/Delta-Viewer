import { localeTag, t, tr, useLanguage } from "../lib/i18n";
import { useState } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  Database,
  FileArchive,
  FileText,
  FolderOpen,
  FolderOutput,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { formatBytes, shortPath } from "../lib/format";
import type {
  AnnotatedEpisodeSummary,
  BatchExportResult,
  ExportFormat,
  TaskDefinition,
} from "../types";

const BATCH_FORMATS: Array<{
  id: ExportFormat;
  label: string;
  icon: typeof FileArchive;
}> = [
  { id: "mcap", label: "MCAP", icon: FileArchive },
  { id: "hdf5", label: "HDF5", icon: Database },
  { id: "lerobot_v2", label: "LeRobot v2.1", icon: Bot },
];

export function BatchExportPanel({
  items,
  tasks,
  selectedIds,
  selectedFormat,
  result,
  loading,
  busy,
  onRefresh,
  onToggle,
  onToggleAll,
  onSelectFormat,
  onExport,
  onReveal,
}: {
  items: AnnotatedEpisodeSummary[];
  tasks: TaskDefinition[];
  selectedIds: string[];
  selectedFormat: ExportFormat;
  result: BatchExportResult | null;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onToggle: (episodeId: string) => void;
  onToggleAll: () => void;
  onSelectFormat: (format: ExportFormat) => void;
  onExport: () => void;
  onReveal: (path: string) => void;
}) {
  useLanguage();
  const selected = new Set(selectedIds);
  const availableItems = items.filter((item) => item.sourceAvailable);
  const allAvailableSelected = availableItems.length > 0
    && availableItems.every((item) => selected.has(item.annotation.episodeId));
  const taskLabels = new Map(tasks.map((task) => [task.id, task.label]));
  const [selectedFailureId, setSelectedFailureId] = useState<string | null>(null);
  const selectedFailure = result?.items.find((item) => (
    item.status === "failed" && item.episodeId === selectedFailureId
  )) ?? null;

  return (
    <div className="batch-export-view">
      <div className="section-heading batch-export-heading">
        <div>
          <span className="section-kicker">{t("本机标注")}</span>
          <h2>{t("批量导出")}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onRefresh}
          disabled={busy || loading}
          title={t("刷新本地标注")}
          aria-label={t("刷新本地标注")}
        >
          {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>

      <div className="batch-summary-band">
        <div><span>{t("本地标注")}</span><strong>{items.length}</strong></div>
        <div><span>{t("源可用")}</span><strong>{availableItems.length}</strong></div>
        <div><span>{t("已选择")}</span><strong>{selectedIds.length}</strong></div>
      </div>

      <div className="batch-toolbar">
        <label className="batch-select-all">
          <input
            type="checkbox"
            checked={allAvailableSelected}
            disabled={busy || !availableItems.length}
            onChange={onToggleAll}
          />
          <span>{t("全选可用项")}</span>
        </label>
        <div className="batch-format-picker" role="radiogroup" aria-label={t("批量导出格式")}>
          {BATCH_FORMATS.map((format) => {
            const Icon = format.icon;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selectedFormat === format.id}
                className={selectedFormat === format.id ? "active" : ""}
                disabled={busy}
                onClick={() => onSelectFormat(format.id)}
                key={format.id}
              >
                <Icon size={14} />{tr(format.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="batch-table" aria-label={t("本地已标注数据")}>
        <div className="batch-table-head" aria-hidden="true">
          <span />
          <span>{t("轨迹")}</span>
          <span>{t("任务")}</span>
          <span>{t("源路径")}</span>
          <span>{t("最近处理")}</span>
          <span>{t("状态")}</span>
        </div>
        {items.length ? items.map(({ annotation, sourceAvailable }) => (
          <label
            className={`batch-table-row${sourceAvailable ? "" : " source-missing"}`}
            key={annotation.episodeId}
          >
            <input
              type="checkbox"
              checked={selected.has(annotation.episodeId)}
              disabled={busy || !sourceAvailable}
              onChange={() => onToggle(annotation.episodeId)}
              aria-label={t("选择轨迹 {0}", [tr(annotation.trajectoryCode)])}
            />
            <span className="batch-trajectory">
              <strong>{tr(annotation.trajectoryCode)}</strong>
              <small>r{annotation.revision}</small>
            </span>
            <span className="batch-task" title={tr(annotation.taskDescription)}>
              <strong>{tr(taskLabels.get(annotation.taskId)) ?? tr(annotation.taskId)}</strong>
              <small>{tr(annotation.taskDescription)}</small>
            </span>
            <span className="batch-source" title={tr(annotation.episodeRoot)}>
              {shortPath(annotation.episodeRoot, 48)}
            </span>
            <span className="batch-processor">
              <strong>{annotation.processedBy.displayName}</strong>
              <small>{tr(formatUpdatedAt(annotation.updatedAtMs))}</small>
            </span>
            <span className={`batch-source-status ${sourceAvailable ? "available" : "missing"}`}>
              {sourceAvailable ? <Check size={13} /> : <CircleAlert size={13} />}
              {sourceAvailable ? t("可用") : t("源断开")}
            </span>
          </label>
        )) : (
          <div className="batch-empty">
            {loading ? <LoaderCircle className="spin" size={18} /> : <FileArchive size={18} />}
            <span>{loading ? t("正在读取本地标注") : t("暂无已保存标注")}</span>
          </div>
        )}
      </div>

      <div className="batch-action-row">
        <div>
          <span>{t("完整轨迹")}</span>
          <strong>{selectedIds.length}{" " + t("条 ·") + " "}{tr(batchFormatLabel(selectedFormat))}</strong>
        </div>
        <button
          className="button button-primary batch-export-button"
          type="button"
          onClick={onExport}
          disabled={busy || loading || !selectedIds.length}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <FolderOutput size={17} />}
          {t("选择目录并批量导出")}</button>
      </div>

      {result ? (
        <section className="batch-result" aria-label={t("批量导出结果")}>
          <header>
            <div>
              <strong>{result.cancelled ? t("批量导出已停止") : t("批量导出完成")}</strong>
              <span>
                {t("成功") + " "}{result.exportedCount}{" " + t("· 失败") + " "}{result.failedCount}
                {result.cancelled ? t(" · 未处理 {0}", [result.requestedCount - result.items.length]) : ""}
              </span>
            </div>
            <span>{result.totalFiles}{" " + t("个文件 ·") + " "}{tr(formatBytes(result.totalBytes))} · {tr((result.elapsedMs / 1000).toFixed(1))} s</span>
          </header>
          <div className="batch-result-list">
            {result.items.map((item) => (
              <div className={`batch-result-row result-${item.status}`} key={item.episodeId}>
                <span className="batch-result-status-icon">
                  {item.status === "exported" ? <Check size={15} /> : <CircleAlert size={15} />}
                </span>
                <strong>{tr(item.trajectoryCode)}</strong>
                <div className="batch-result-copy">
                  <span title={tr(item.result?.outputPath) ?? tr(item.error) ?? undefined}>
                    {item.result ? shortPath(item.result.outputPath, 72) : tr(item.error) ?? t("导出失败")}
                  </span>
                  {item.errorLogPath ? (
                    <small title={tr(item.errorLogPath)}>{t("日志：")}{shortPath(item.errorLogPath, 72)}</small>
                  ) : null}
                </div>
                <div className="batch-result-actions">
                  {item.result ? (
                    <button
                      className="button button-secondary batch-result-action"
                      type="button"
                      onClick={() => onReveal(item.result?.outputPath ?? "")}
                      title={t("打开导出文件所在位置")}
                    >
                      <FolderOpen size={14} />
                      <span>{t("打开文件所在位置")}</span>
                    </button>
                  ) : (
                    <button
                      className="button button-secondary batch-result-action"
                      type="button"
                      onClick={() => setSelectedFailureId(item.episodeId)}
                      aria-label={t("查看 {0} 失败日志", [tr(item.trajectoryCode)])}
                    >
                      <FileText size={14} />
                      <span>{t("查看失败日志")}</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {selectedFailure ? (
            <section className="batch-failure-log" aria-label={t("{0} 失败日志", [tr(selectedFailure.trajectoryCode)])}>
              <header>
                <div>
                  <strong>{tr(selectedFailure.trajectoryCode)}{" " + t("· 失败日志")}</strong>
                  <span title={selectedFailure.sourcePath}>{shortPath(selectedFailure.sourcePath, 80)}</span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setSelectedFailureId(null)}
                  title={t("关闭失败日志")}
                  aria-label={t("关闭失败日志")}
                >
                  <X size={14} />
                </button>
              </header>
              <code>{tr(selectedFailure.error) ?? t("导出失败")}</code>
              <footer>
                <span title={tr(selectedFailure.errorLogPath) ?? undefined}>
                  {selectedFailure.errorLogPath ? shortPath(selectedFailure.errorLogPath, 88) : t("失败日志文件未生成")}
                </span>
                {selectedFailure.errorLogPath ? (
                  <button
                    className="button button-secondary batch-log-reveal"
                    type="button"
                    onClick={() => onReveal(selectedFailure.errorLogPath ?? "")}
                  >
                    <FolderOpen size={14} />
                    <span>{t("打开日志所在位置")}</span>
                  </button>
                ) : null}
              </footer>
            </section>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function batchFormatLabel(format: ExportFormat): string {
  return format === "mcap" ? "MCAP" : format === "hdf5" ? "HDF5" : "LeRobot v2.1";
}

function formatUpdatedAt(value: number): string {
  return new Intl.DateTimeFormat(localeTag(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
