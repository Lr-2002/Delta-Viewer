import { t, tr, useLanguage } from "../lib/i18n";
import { useState } from "react";
import { LoaderCircle, Pencil, X } from "lucide-react";

export function BatchRenameDialog({ path, onRename, onClose }: {
  path: string;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  useLanguage();
  const oldName = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  const [name, setName] = useState(oldName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <dialog className="rejection-dialog batch-rename-dialog" aria-labelledby="batch-rename-title"
    ref={node => { if (node && !node.open) node.showModal(); }}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError("");
      void onRename(name).catch(reason => setError(String(reason))).finally(() => setBusy(false));
    }}>
      <header><h2 id="batch-rename-title">{t("修改批次文件夹名称")}</h2><button type="button" className="icon-button" aria-label={t("关闭更名窗口")} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <p>{t("直接修改磁盘上的文件夹名，保留领取归属、审核结果和本机待写记录。文件内容保持不变。")}</p>
      <p className="batch-rejection-path">{path}</p>
      <label className="rejection-detail">{t("新文件夹名称")}<input autoFocus aria-label={t("新文件夹名称")} required value={name} maxLength={160} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <p className="batch-rename-help">{t("请保留原采集日期。确认后将重新加载当前数据，其他电脑请使用最新版打开。")}</p>
      {tr(error && <p role="alert" className="task-center-error">{tr(error)}</p>)}
      <footer><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>{t("取消")}</button>
        <button type="submit" className="button button-primary" disabled={busy || !name.trim() || name === oldName}>{busy ? <LoaderCircle size={16} className="spin" /> : <Pencil size={16} />}{busy ? t("正在更名") : t("确认更名")}</button></footer>
    </form>
  </dialog>;
}
