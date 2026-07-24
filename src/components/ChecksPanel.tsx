import {
  CircleCheck,
  CircleX,
  Clock3,
  FileCheck2,
  FileDown,
  LocateFixed,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import { formatDuration } from "../lib/format";
import type { EpisodeData, ValidationIssue, ValidationReport } from "../types";

interface ChecksPanelProps {
  data: EpisodeData;
  report: ValidationReport | null;
  busy: boolean;
  onExportReport: () => void;
  onLocateIssue: (issue: ValidationIssue) => void;
}

type CheckStatus = "ok" | "warning" | "error";
const STATUS_ORDER: Record<CheckStatus, number> = { error: 0, warning: 1, ok: 2 };

export function ChecksPanel({
  data,
  report,
  busy,
  onExportReport,
  onLocateIssue,
}: ChecksPanelProps) {
  const sampledImages = report?.imageValidationMode === "sampled";
  const sampleTitle = sampledImages
    ? `固定位置：${report.imageSamplePercentages.map((value) => `${value}%`).join(" / ")}`
    : "全量图像检查";
  const stateIssues = report?.issues.filter((issue) => issue.scope === "states") ?? [];
  const stateStatus: CheckStatus = stateIssues.some((issue) => issue.severity === "error")
    ? "error"
    : stateIssues.some((issue) => issue.severity === "warning")
      ? "warning"
      : data.states.length
        ? "ok"
        : "error";
  const checkRows = [
    ...data.summary.streams.map((stream) => {
      const result = report?.streams.find((item) => item.name === stream.name);
      return {
        key: stream.name,
        label: stream.label,
        detail: `${stream.width ?? "—"}×${stream.height ?? "—"}`,
        totalFrames: stream.frameCount,
        checkedFrames: result?.checkedFrames ?? "—",
        decodeFailures: result?.decodeFailures ?? "—",
        status: result?.status ?? "warning",
      };
    }),
    {
      key: "states",
      label: "states.jsonl",
      detail: "状态记录",
      totalFrames: data.states.length,
      checkedFrames: "—",
      decodeFailures: "—",
      status: stateStatus,
    },
  ].sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
  const orderedIssues = report
    ? [...report.issues].sort(
      (left, right) => STATUS_ORDER[left.severity] - STATUS_ORDER[right.severity],
    )
    : [];
  const backgroundReportStatus = !report
    ? "—"
    : report.status === "ok"
      ? "无需生成"
      : report.autoReportPath
        ? "已生成"
        : "生成失败";
  return (
    <div className="checks-view">
      <header className="section-heading">
        <div>
          <span className="section-kicker">DATA HEALTH</span>
          <h2>数据检查</h2>
        </div>
        <div className="check-heading-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onExportReport}
            disabled={!report || busy}
          >
            <FileDown size={16} />
            导出报告
          </button>
          {report ? <StatusMark status={report.status} /> : null}
        </div>
      </header>

      <section className="check-summary-band">
        <div>
          <FileCheck2 size={18} />
          <span>已检查文件</span>
          <strong>{report?.checkedFiles ?? 0}</strong>
        </div>
        <div>
          <Clock3 size={18} />
          <span>检查耗时</span>
          <strong>{report ? formatDuration(report.elapsedMs) : "—"}</strong>
        </div>
        <div>
          <ScrollText size={18} />
          <span>本地后台报告</span>
          <strong title={report?.autoReportPath ?? undefined}>{backgroundReportStatus}</strong>
        </div>
      </section>

      <section className="stream-checks" aria-label="数据流检查结果">
        <div className="check-table-head">
          <span>数据流</span>
          <span>总帧</span>
          <span title={sampleTitle}>{sampledImages ? "抽检帧" : "已检帧"}</span>
          <span>解码失败</span>
          <span>结果</span>
        </div>
        {checkRows.map((row) => (
          <div className="check-table-row" key={row.key}>
            <span>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </span>
            <span>{row.totalFrames}</span>
            <span>{row.checkedFrames}</span>
            <span>{row.decodeFailures}</span>
            <span>
              <StatusMark status={row.status} compact />
            </span>
          </div>
        ))}
      </section>

      <section className="issue-list" aria-label="检查问题">
        <h3>错误与警告</h3>
        {orderedIssues.length ? (
          orderedIssues.map((issue, index) => (
            <div className={`issue-row issue-${issue.severity}`} key={`${issue.code}-${index}`}>
              <span className="issue-severity">
                {issue.severity === "error" ? <CircleX size={16} /> : <TriangleAlert size={16} />}
                {issue.severity === "error" ? "错误" : "警告"}
              </span>
              <span className="issue-scope">{issue.scope}</span>
              <span>{issue.message}</span>
              <code>{issue.code}</code>
              {issue.frameId !== null ? (
                <button
                  className="icon-button issue-locate"
                  type="button"
                  onClick={() => onLocateIssue(issue)}
                  title={`定位到帧 ${issue.frameId}`}
                  aria-label={`定位到帧 ${issue.frameId}`}
                >
                  <LocateFixed size={15} />
                </button>
              ) : <span />}
            </div>
          ))
        ) : (
          <div className="issue-empty">
            <CircleCheck size={18} />
            未发现问题
          </div>
        )}
      </section>
    </div>
  );
}

function StatusMark({
  status,
  compact = false,
}: {
  status: "ok" | "warning" | "error";
  compact?: boolean;
}) {
  const labels = { ok: "通过", warning: "警告", error: "错误" };
  const Icon = status === "ok" ? CircleCheck : status === "warning" ? TriangleAlert : CircleX;
  return (
    <span className={`status-mark status-${status}${compact ? " status-compact" : ""}`}>
      <Icon size={compact ? 15 : 17} />
      {labels[status]}
    </span>
  );
}
