import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, LoaderCircle, Square, X } from "lucide-react";
import { cancelTaskCenterScan, scanTaskCenter, type TaskNode } from "../lib/task-center";
import { recordBatchRejection } from "../lib/review-audit";
import type { MachineReview } from "../types";

export interface RejectionTarget { path: string; name: string }
interface Props {
  folder?: string;
  selected?: RejectionTarget[];
  onSaved: (path: string) => void;
  onClose: () => void;
}
type Result = RejectionTarget & { status: "rejected" | "skipped" | "failed"; message: string };

export function BatchRejectionDialog({ folder, selected, onSaved, onClose }: Props) {
  const [targets, setTargets] = useState<RejectionTarget[]>(selected ?? []);
  const [preparing, setPreparing] = useState(Boolean(folder));
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [excluded, setExcluded] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const stop = useRef(false);
  const active = useRef(false);
  const busy = preparing || running;
  useEffect(() => {
    if (!folder) return;
    let alive = true;
    void scanTaskCenter(folder, update => {
      if (alive && update.kind === "progress") setProgress(`已检查 ${update.sessions} 条`);
    }, true).then(catalog => {
      if (!alive) return;
      const pending: RejectionTarget[] = [];
      let other = 0;
      function visit(node: TaskNode) {
        if (node.incomplete || node.scanning) throw Error("目录检查不完整，请恢复目录访问后重试");
        if (node.session) {
          if (node.status === "pending") pending.push({path: node.relativePath ? `${catalog.sourceRoot}/${node.relativePath}` : catalog.sourceRoot, name: node.relativePath || node.name});
          else other++;
        } else node.children.forEach(visit);
      }
      visit(catalog.tree);
      if (pending.length > 20000) throw Error("单次最多处理 20000 条，请选择更小的文件夹");
      setTargets(pending); setExcluded(other);
    }).catch(cause => { if (alive) setError(String(cause)); })
      .finally(() => { if (alive) setPreparing(false); });
    return () => { alive = false; void cancelTaskCenterScan(folder).catch(() => {}); };
  }, [folder]);
  async function cancel() {
    stop.current = true;
    if (preparing && folder) await cancelTaskCenterScan(folder).catch(cause => setError(String(cause)));
  }
  async function submit() {
    if (active.current || busy || finished || error || !confirmed || !reason.trim() || !targets.length) return;
    active.current = true; stop.current = false; setRunning(true);
    const savedReason = `其他原因：${reason.trim()}`;
    const completed: Result[] = [];
    for (const target of targets) {
      if (stop.current) break;
      setProgress(target.name);
      const started = performance.now();
      try {
        const result = await invoke<MachineReview | null>("reject_pending_machine_review", { sourcePath: target.path, reason: savedReason, operationId: Date.now() });
        if (!result) completed.push({...target, status:"skipped", message:"已审核，未修改"});
        else {
          completed.push({...target, status:"rejected", message:"已保存不通过"});
          onSaved(target.path);
          try { await recordBatchRejection(target.path, target.name, result.revisionLabel ?? String(result.revision), savedReason, performance.now() - started); }
          catch (cause) { setError(String(cause)); stop.current = true; }
        }
      } catch (cause) { completed.push({...target, status:"failed", message:String(cause)}); }
      setResults([...completed]);
    }
    setRunning(false); setFinished(true); active.current = false;
  }
  const success = results.filter(item => item.status === "rejected").length;
  const skipped = results.filter(item => item.status === "skipped").length;
  const failed = results.filter(item => item.status === "failed").length;
  return <dialog className="batch-rejection-dialog rejection-dialog" aria-labelledby="batch-rejection-title"
    ref={node => { if (node && !node.open) node.showModal(); }} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header><h2 id="batch-rejection-title">{folder ? "文件夹不通过" : "批量不通过"}</h2><button type="button" className="icon-button" title="关闭" aria-label="关闭批量不通过" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <p className="batch-rejection-warning"><AlertTriangle size={18} />此操作会将待处理数据标记为不通过，并记录审核人和原因。已有审核结果保持不变。</p>
      {folder && <p className="batch-rejection-path">{folder}</p>}
      <p role="status">{preparing ? `正在检查目录 QC · ${progress}` : `待处理 ${targets.length} 条${excluded ? ` · 已排除已审核或异常数据 ${excluded} 条` : ""}`}</p>
      <label className="rejection-detail">不通过原因<textarea aria-label="批量不通过原因" required maxLength={1000} value={reason} disabled={busy || finished} onChange={event => setReason(event.target.value)} /></label>
      <label className="batch-rejection-confirm"><input type="checkbox" checked={confirmed} disabled={busy || finished} onChange={event => setConfirmed(event.target.checked)} />我已确认这些未审核数据应判为不通过</label>
      {error && <p role="alert" className="task-center-error">{error}</p>}
      {(running || finished) && <p role="status">成功 {success} · 跳过 {skipped} · 失败 {failed} · 未执行 {targets.length - results.length}{running ? ` · ${progress}` : ""}</p>}
      {results.length > 0 && <ul className="batch-rejection-results">{results.map(item => <li key={item.path} className={item.status === "failed" ? "task-qc-error" : ""}><span>{item.name}</span><span>{item.message}</span></li>)}</ul>}
      <footer>{busy ? <button type="button" className="button button-secondary" onClick={() => void cancel()}><Square size={14} />停止</button> : <button type="button" className="button button-secondary" onClick={onClose}>{finished ? "完成" : "取消"}</button>}
        {!finished && <button type="submit" className="button button-primary" disabled={busy || Boolean(error) || !targets.length || !confirmed || !reason.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}确认不通过</button>}</footer>
    </form>
  </dialog>;
}
