import { X } from "lucide-react";
import { formatBytes, formatRate, shortPath } from "../lib/format";
import type { TaskProgress } from "../types";

interface ProgressStripProps {
  progress: TaskProgress;
  onCancel: () => void;
}
export function ProgressStrip({ progress, onCancel }: ProgressStripProps) {
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
    </div>
  );
}
