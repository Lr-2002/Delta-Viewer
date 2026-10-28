import "./cloud-qc.css";
import { useEffect, useState } from "react";
import { cloudQcAccess, cloudQcError, pendingCloudQc, syncCloudQc } from "../lib/cloud-qc";

/** Native durable drafts and exact pending payloads are the source of truth. */
export function CloudQcSyncStatus({ username }: { username: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const [claimable, setClaimable] = useState<string[]>([]);
  const [claiming, setClaiming] = useState(false);
  useEffect(() => {
    let alive = true, running = false;
    setError(""); setPending(0); setClaimable([]);
    async function flush() {
      if (!alive || running) return;
      running = true;
      try {
        const result = await pendingCloudQc();
        if (!alive) return;
        setPending(result.items.length);
        const failures: string[] = [];
        const unclaimed: string[] = [];
        for (const entry of result.items) {
          if (!alive) break;
          try { await syncCloudQc(entry.directory); }
          catch (cause) {
            // Another native fetch/sync owns the single flight. Keep the prior
            // business error until an actual ACK, rather than replacing it.
            if (String(cause).includes("CLOUD_QC_SYNC_BUSY")) continue;
            failures.push(cloudQcError(cause));
            if (String(cause).includes("QC_TASK_NOT_CLAIMED")) {
              try { if ((await cloudQcAccess(entry.directory)).claimable) unclaimed.push(entry.directory); } catch { /* Keep the original failure. */ }
            }
          }
        }
        if (!alive) return;
        const remaining = await pendingCloudQc();
        if (alive) {
          setPending(remaining.items.length);
          setClaimable(unclaimed);
          setError(previous => failures.length ? failures.join("；") : remaining.items.length ? previous : "");
        }
      } catch (cause) { if (alive) setError(cloudQcError(cause)); }
      finally { running = false; }
    }
    const retry = () => void flush();
    window.addEventListener("cloud-qc-retry", retry); window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 15_000); void flush();
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("cloud-qc-retry", retry); window.removeEventListener("online", retry); };
  }, [username]);
  if (!pending && !error) return null;
  return <div className="cloud-qc-sync-status" role="status"><span>{error ? `云端尚未确认 · 本机保留 ${pending} 条：${error}` : `待云端确认 ${pending} 条 QC 结果或撤回请求`}</span><div className="cloud-qc-sync-actions">{claimable.length > 0 && <button type="button" className="button button-primary" disabled={claiming} onClick={async () => {
    if (!window.confirm(`领取这 ${claimable.length} 条已有本机结论的云端任务，并原样补传？不会重新审核或修改原提交时间。`)) return;
    setClaiming(true);
    try { for (const directory of claimable) { const status = await cloudQcAccess(directory, true); if (!status.canEdit) throw Error(status.reason ?? "QC_TASK_NOT_CLAIMED"); } window.dispatchEvent(new Event("cloud-qc-retry")); }
    catch (cause) { setError(cloudQcError(cause)); }
    finally { setClaiming(false); }
  }}>领取并补传原结论</button>}<button type="button" className="button button-secondary" disabled={claiming} onClick={() => window.dispatchEvent(new Event("cloud-qc-retry"))}>重试同步 QC</button></div></div>;
}
