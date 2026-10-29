import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatBytes, formatRate, shortPath } from "../lib/format";
import type { TaskProgress } from "../types";

interface ProgressStripProps {
  progress: TaskProgress;
  onCancel: () => void;
}
export function ProgressStrip({ progress, onCancel }: ProgressStripProps) {
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  useEffect(() => {
    setWaitingSeconds(0);
    if (progress.task !== "scan" && progress.task !== "validate") return;
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
  return (
    <div className="progress-strip" role="status" aria-live="polite">
      <div className="progress-copy">
        <strong>{progress.phase}</strong>
        <span title={progress.currentPath}>{shortPath(progress.currentPath)}</span>
      </div>
      <div className="progress-track" aria-label={`${progress.phase} ${percent}%`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-stats">
        <span>{percent}%</span>
        {progress.totalBytes ? (
          <span>
            {formatBytes(progress.bytesDone)} / {formatBytes(progress.totalBytes)}
          </span>
        ) : null}
        <span>{formatRate(progress.bytesDone, progress.elapsedMs)}</span>
      </div>
      <button className="icon-button" type="button" onClick={onCancel} title="取消任务" aria-label="取消任务">
        <X size={17} />
      </button>
      {waitingSeconds >= 8 && <div className="progress-read-wait" role="alert">
        <AlertTriangle size={15} />
        <span>当前读取阶段已等待 {waitingSeconds} 秒。数据目录可能响应缓慢；若为共享目录，请检查 NAS 磁盘负载、剩余空间及共享连接。可取消后重试。</span>
      </div>}
    </div>
  );
}
