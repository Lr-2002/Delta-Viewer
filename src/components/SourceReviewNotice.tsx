import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { getPendingSourceReviews, publishPendingSourceReviews } from "../lib/backend";
import type { PendingSourceReviewStatus } from "../types";

export function SourceReviewNotice({ disabled, onBusy, onWritten }: { disabled: boolean; onBusy: (busy: boolean) => void; onWritten: () => void }) {
  const [status, setStatus] = useState<PendingSourceReviewStatus | null>(null);
  const [error, setError] = useState("");
  const [queryError, setQueryError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const dismissed = useRef(false);
  const alive = useRef(true);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  async function refresh(checkStorage = true) {
    if (running.current) return;
    running.current = true;
    try {
      const next = await getPendingSourceReviews(checkStorage);
      if (!alive.current) return;
      setStatus(next); setQueryError("");
      if (next.ready && next.pending && !dismissed.current && !blocked.current && !document.querySelector("dialog[open]")) setOpen(true);
      if (checkStorage && !next.ready) dismissed.current = false;
    } catch (cause) { if (alive.current) setQueryError(`本机待写结果查询失败：${String(cause)}`); }
    finally { running.current = false; }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const update = () => void refresh();
    const timer = window.setInterval(update, 30000);
    window.addEventListener("source-review-pending", update);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("source-review-pending", update); };
  }, []);
  useEffect(() => {
    if (busy) {
      const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
      window.addEventListener("beforeunload", protect);
      return () => window.removeEventListener("beforeunload", protect);
    }
  }, [busy]);
  async function publish() {
    if (busy || disabled || running.current) return;
    running.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const result = await publishPendingSourceReviews();
      setError(result.errors.length ? `${result.written} 条已写回，${result.remaining} 条仍在本机。${result.errors.join("；")}` : "");
      if (result.written) onWritten();
      if (!result.remaining) setOpen(false);
      dismissed.current = true;
    } catch (cause) { setError(`待写结果仍保留在本机：${String(cause)}`); }
    finally { running.current = false; setBusy(false); onBusy(false); void refresh(false); }
  }
  const issue = [error, queryError].filter(Boolean).join("；");
  if (!status?.pending && !issue) return null;
  return <>
    <div className="source-review-notice" role="status"><AlertTriangle size={17} /><span><strong>{status?.pending ? `${status.pending} 条审核结果已保存本机，待写回数据目录` : "本机待写结果状态未知，请重新检查"}</strong><br />{status?.ready ? "存储检查已通过，可确认写回。" : "后台每 30 秒检查存储恢复；恢复后提醒确认写回。"}任务进度以 NAS 已写入 QC 为准。</span><button className="button button-secondary" onClick={() => { setOpen(true); void refresh(); }}>查看待写结果</button></div>
    {issue && !open && <p role="alert" className="machine-message">{issue}</p>}
    {open && <dialog className="rejection-dialog source-review-dialog" aria-label="本机审核结果待写回" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={event => { event.preventDefault(); if (!busy) { dismissed.current = true; setOpen(false); } }}>
      <header><h2>本机审核结果待写回</h2><button className="icon-button" title="稍后写回" aria-label="关闭待写回提示" disabled={busy} onClick={() => { dismissed.current = true; setOpen(false); }}><X size={18} /></button></header>
      <p>{status?.ready ? "数据目录容量和连接检查已通过。" : "数据目录尚未确认恢复。"}共有 {status?.pending ?? "未知"} 条本机结果，包含编辑草稿和审核结论。</p>
      <p>点击写回后才会更新共享目录和任务进度；若其他人已修改结果，会保留本机记录并提示冲突。请勿卸载软件或清理应用数据。</p>
      {status?.storageError && <p className="machine-message">{status.storageError}</p>}
      {status && status.pending > status.items.length && <p>以下显示前 {status.items.length} 条；确认写回会依次处理全部 {status.pending} 条。</p>}
      <ul className="batch-rejection-results">{status?.items.map(item => <li key={item.sourcePath}><span>{item.name} · {item.status === "approved" ? "本机通过" : item.status === "rejected" ? "本机不通过" : "本机草稿"}</span><span>{new Date(item.createdAtMs).toLocaleString("zh-CN")}</span><small>{item.error}</small></li>)}</ul>
      {issue && <p role="alert" className="machine-message">{issue}</p>}
      <footer><button className="button button-secondary" disabled={busy} onClick={() => { dismissed.current = true; setOpen(false); }}>稍后</button><button className="button button-secondary" disabled={busy} onClick={() => void refresh()}>重新检查</button><button className="button button-primary" disabled={busy || disabled || !status?.pending} onClick={() => void publish()}><RefreshCw size={15} />{busy ? "正在写回…" : "确认写回数据目录"}</button></footer>
    </dialog>}
  </>;
}
