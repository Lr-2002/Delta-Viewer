import {
  CircleCheck,
  CircleX,
  Clock3,
  FileCheck2,
  FileJson,
  LocateFixed,
  TriangleAlert,
} from "lucide-react";
import { formatDuration } from "../lib/format";
import type { EpisodeData, ValidationReport } from "../types";

interface ChecksPanelProps {
  data: EpisodeData;
  report: ValidationReport | null;
  busy: boolean;
  onExportReport: () => void;
  onLocateIssue: (frameId: number) => void;
}
export function ChecksPanel({
  data,
  report,
  busy,
  onExportReport,
  onLocateIssue,
}: ChecksPanelProps) {
  const stateStatus = data.states.length ? "ok" : "error";
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
            <FileJson size={16} />
            导出 JSON
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
          <CircleCheck size={18} />
          <span>有效状态</span>
          <strong>{data.states.length}</strong>
        </div>
      </section>

      <section className="stream-checks" aria-label="数据流检查结果">
        <div className="check-table-head">
          <span>数据流</span>
          <span>帧数</span>
          <span>解码失败</span>
          <span>结果</span>
        </div>
        {data.summary.streams.map((stream) => {
          const result = report?.streams.find((item) => item.name === stream.name);
          return (
            <div className="check-table-row" key={stream.name}>
              <span>
                <strong>{stream.label}</strong>
                <small>
                  {stream.width ?? "—"}×{stream.height ?? "—"}
                </small>
              </span>
              <span>{stream.frameCount}</span>
              <span>{result?.decodeFailures ?? "—"}</span>
              <span>
                <StatusMark status={result?.status ?? "warning"} compact />
              </span>
            </div>
          );
        })}
        <div className="check-table-row">
          <span>
            <strong>states.jsonl</strong>
            <small>状态记录</small>
          </span>
          <span>{data.states.length}</span>
          <span>{stateStatus === "ok" ? 0 : 1}</span>
          <span>
            <StatusMark status={stateStatus} compact />
          </span>
        </div>
      </section>

      <section className="issue-list" aria-label="检查问题">
        <h3>问题与警告</h3>
        {report?.issues.length ? (
          report.issues.map((issue, index) => (
            <div className={`issue-row issue-${issue.severity}`} key={`${issue.code}-${index}`}>
              {issue.severity === "error" ? <CircleX size={17} /> : <TriangleAlert size={17} />}
              <span className="issue-scope">{issue.scope}</span>
              <span>{issue.message}</span>
              <code>{issue.code}</code>
              {issue.frameId !== null ? (
                <button
                  className="icon-button issue-locate"
                  type="button"
                  onClick={() => onLocateIssue(issue.frameId as number)}
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
  const labels = { ok: "通过", warning: "警告", error: "失败" };
  const Icon = status === "ok" ? CircleCheck : status === "warning" ? TriangleAlert : CircleX;
  return (
    <span className={`status-mark status-${status}${compact ? " status-compact" : ""}`}>
      <Icon size={compact ? 15 : 17} />
      {labels[status]}
    </span>
  );
}
