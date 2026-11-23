import { t, tr, useLanguage } from "../lib/i18n";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatBytes, formatRate, shortPath } from "../lib/format";
import type { TaskProgress } from "../types";

interface ProgressStripProps {
  progress: TaskProgress;
  onCancel: () => void;
}
export function ProgressStrip({ progress, onCancel }: ProgressStripProps) {
  useLanguage();
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  useEffect(() => {
    setWaitingSeconds(0);
    if (progress.task !== "scan" && progress.task !== "validate" && progress.task !== "playback-cache") return;
    const started = Date.now();
    const timer = window.setInterval(() => setWaitingSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [progress.operationId, progress.task, progress.phase, progress.current, progress.bytesDone]);
  const fraction = progress.totalBytes
    ? progress.bytesDone / progress.totalBytes
    : progress.total
      ? progress.current / progress.total
      : 0;
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const scanningDirectories = progress.task === "scan" && progress.phase === "正在扫描记录目录";
  return (
    <div className="progress-strip" role="status" aria-live="polite">
      <div className="progress-copy">
        <strong>{tr(progress.phase)}</strong>
        <span title={tr(progress.currentPath)}>{shortPath(progress.currentPath)}</span>
      </div>
      <div className="progress-track" aria-label={t("{0} {1}%", [tr(progress.phase), percent])}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-stats">
        <span>{scanningDirectories ? t("已扫描 {0} 个目录", [progress.current]) : `${percent}%`}</span>
        {progress.totalBytes ? (
          <span>
            {tr(formatBytes(progress.bytesDone))} / {tr(formatBytes(progress.totalBytes))}
          </span>
        ) : null}
        <span>{tr(formatRate(progress.bytesDone, progress.elapsedMs))}</span>
      </div>
      <button className="icon-button" type="button" onClick={onCancel} title={t("取消任务")} aria-label={t("取消任务")}>
        <X size={17} />
      </button>
      {waitingSeconds >= 8 && <div className="progress-read-wait" role="alert">
        <AlertTriangle size={15} />
        <span>{t("当前读取阶段已等待") + " "}{waitingSeconds}{" " + t("秒。读取尚未完成，可继续等待或取消后重试。")}</span>
      </div>}
    </div>
  );
}
