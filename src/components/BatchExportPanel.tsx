import {
  Bot,
  Check,
  CircleAlert,
  Database,
  FileArchive,
  FolderOpen,
  FolderOutput,
  LoaderCircle,
  RefreshCw,
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
  const selected = new Set(selectedIds);
  const availableItems = items.filter((item) => item.sourceAvailable);
  const allAvailableSelected = availableItems.length > 0
    && availableItems.every((item) => selected.has(item.annotation.episodeId));
  const taskLabels = new Map(tasks.map((task) => [task.id, task.label]));

  return (
    <div className="batch-export-view">
      <div className="section-heading batch-export-heading">
        <div>
          <span className="section-kicker">LOCAL ANNOTATIONS</span>
          <h2>批量导出</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onRefresh}
          disabled={busy || loading}
          title="刷新本地标注"
          aria-label="刷新本地标注"
        >
          {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>

      <div className="batch-summary-band">
        <div><span>本地标注</span><strong>{items.length}</strong></div>
        <div><span>源可用</span><strong>{availableItems.length}</strong></div>
        <div><span>已选择</span><strong>{selectedIds.length}</strong></div>
      </div>

      <div className="batch-toolbar">
        <label className="batch-select-all">
          <input
            type="checkbox"
            checked={allAvailableSelected}
            disabled={busy || !availableItems.length}
            onChange={onToggleAll}
          />
          <span>全选可用项</span>
        </label>
        <div className="batch-format-picker" role="radiogroup" aria-label="批量导出格式">
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
                <Icon size={14} />{format.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="batch-table" aria-label="本地已标注数据">
        <div className="batch-table-head" aria-hidden="true">
          <span />
          <span>轨迹</span>
          <span>任务</span>
          <span>源路径</span>
          <span>最近处理</span>
          <span>状态</span>
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
              aria-label={`选择轨迹 ${annotation.trajectoryCode}`}
            />
            <span className="batch-trajectory">
              <strong>{annotation.trajectoryCode}</strong>
              <small>r{annotation.revision}</small>
            </span>
            <span className="batch-task" title={annotation.taskDescription}>
              <strong>{taskLabels.get(annotation.taskId) ?? annotation.taskId}</strong>
              <small>{annotation.taskDescription}</small>
            </span>
            <span className="batch-source" title={annotation.episodeRoot}>
              {shortPath(annotation.episodeRoot, 48)}
            </span>
            <span className="batch-processor">
              <strong>{annotation.processedBy.displayName}</strong>
              <small>{formatUpdatedAt(annotation.updatedAtMs)}</small>
            </span>
            <span className={`batch-source-status ${sourceAvailable ? "available" : "missing"}`}>
              {sourceAvailable ? <Check size={13} /> : <CircleAlert size={13} />}
              {sourceAvailable ? "可用" : "源断开"}
            </span>
          </label>
        )) : (
          <div className="batch-empty">
            {loading ? <LoaderCircle className="spin" size={18} /> : <FileArchive size={18} />}
            <span>{loading ? "正在读取本地标注" : "暂无已保存标注"}</span>
          </div>
        )}
      </div>

      <div className="batch-action-row">
        <div>
          <span>完整轨迹</span>
          <strong>{selectedIds.length} 条 · {batchFormatLabel(selectedFormat)}</strong>
        </div>
        <button
          className="button button-primary batch-export-button"
          type="button"
          onClick={onExport}
          disabled={busy || loading || !selectedIds.length}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <FolderOutput size={17} />}
          选择目录并批量导出
        </button>
      </div>

      {result ? (
        <section className="batch-result" aria-label="批量导出结果">
          <header>
            <div>
              <strong>{result.cancelled ? "批量导出已停止" : "批量导出完成"}</strong>
              <span>
                成功 {result.exportedCount} · 失败 {result.failedCount}
                {result.cancelled ? ` · 未处理 ${result.requestedCount - result.items.length}` : ""}
              </span>
            </div>
            <span>{result.totalFiles} 个文件 · {formatBytes(result.totalBytes)} · {(result.elapsedMs / 1000).toFixed(1)} s</span>
          </header>
          <div className="batch-result-list">
            {result.items.map((item) => (
              <div className={`batch-result-row result-${item.status}`} key={item.episodeId}>
                {item.status === "exported" ? <Check size={15} /> : <CircleAlert size={15} />}
                <strong>{item.trajectoryCode}</strong>
                <span title={item.result?.outputPath ?? item.error ?? undefined}>
                  {item.result
                    ? shortPath(item.result.outputPath, 72)
                    : item.error ?? "导出失败"}
                </span>
                {item.result ? (
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => onReveal(item.result?.outputPath ?? "")}
                    title="在文件管理器中显示"
                    aria-label={`显示 ${item.trajectoryCode} 导出结果`}
                  >
                    <FolderOpen size={15} />
                  </button>
                ) : <span />}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function batchFormatLabel(format: ExportFormat): string {
  return format === "mcap" ? "MCAP" : format === "hdf5" ? "HDF5" : "LeRobot v2.1";
}

function formatUpdatedAt(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
