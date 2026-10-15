import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { checkForAppUpdate } from "../lib/backend";
import type { AppUpdateInfo } from "../types";

const seenKey = "delta.updates.release-notes.seen";
const notifiedKey = "delta.updates.available.notified";
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Keep this session's acknowledgement. */ } }
function summary(notes: string | null) {
  return notes?.split("\n").map(line => line.replace(/^\s*[-*#]+\s*/, "").trim()).find(Boolean) ?? "查看本次更新的改进和修复。";
}

export function AppUpdates({ version, currentSummary, currentNotes, busy, onDownload, onInstall, onViewHistory,
  check = checkForAppUpdate }: {
  version: string; currentSummary: string; currentNotes: string[]; busy: boolean;
  onDownload: () => Promise<void>; onInstall: () => Promise<void>; onViewHistory: () => void;
  check?: () => Promise<AppUpdateInfo>;
}) {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "available" | "current" | "downloading" | "ready" | "installing">("idle");
  const [error, setError] = useState("");
  const [panel, setPanel] = useState(false);
  const [notice, setNotice] = useState<"available" | "ready" | "installed" | null>(() => read(seenKey) !== version ? "installed" : null);
  const pending = useRef(false);
  const deferredNotice = useRef<"available" | "ready" | null>(null);
  const mounted = useRef(true);
  const notified = useRef(new Set<string>());
  const installedAcknowledged = useRef(read(seenKey) === version);
  const phaseRef = useRef(phase); phaseRef.current = phase;

  async function inspect() {
    if (pending.current || phaseRef.current === "ready" || phaseRef.current === "installing") return;
    pending.current = true; setPhase("checking"); setError("");
    try {
      const result = await check();
      if (!mounted.current) return;
      setInfo(result); setPhase(result.available ? result.ready ? "ready" : "available" : "current");
      if (result.available && !notified.current.has(result.latestVersion) && read(notifiedKey) !== result.latestVersion) {
        notified.current.add(result.latestVersion); write(notifiedKey, result.latestVersion);
        const next = result.ready ? "ready" : "available";
        deferredNotice.current = next;
        setNotice(current => current === "installed" ? current : next);
      }
    } catch (reason) {
      if (mounted.current) { setError(String(reason).replace(/^Error:\s*/, "").replace(/^UPDATE_[A-Z_]+:\s*/, "")); setPhase("idle"); }
    } finally { pending.current = false; }
  }
  useEffect(() => {
    mounted.current = true;
    void inspect();
    const timer = window.setInterval(() => { if (!["downloading", "ready", "installing"].includes(phaseRef.current)) void inspect(); }, 30 * 60_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  function dismissNotice() {
    if (notice === "installed") { write(seenKey, version); installedAcknowledged.current = true; }
    setNotice(notice === "installed" ? deferredNotice.current : null);
    deferredNotice.current = null;
  }
  async function download() {
    if (pending.current || busy) return;
    pending.current = true; setPhase("downloading"); setError(""); setNotice(null);
    try {
      await onDownload();
      if (mounted.current) { setPhase("ready"); setInfo(current => current ? { ...current, ready: true } : current); setNotice("ready"); }
    } catch (reason) {
      if (mounted.current) { setPhase("available"); setError(String(reason).replace(/^Error:\s*/, "")); }
    } finally { pending.current = false; }
  }
  async function install() {
    if (pending.current || busy) return;
    pending.current = true; setPhase("installing"); setError("");
    try {
      await onInstall();
      // Native installation normally exits/restarts; leave a retryable state if it returns.
      if (mounted.current) setPhase("ready");
    } catch (reason) {
      if (mounted.current) { setPhase("ready"); setError(String(reason).replace(/^Error:\s*/, "")); setPanel(true); }
    } finally { pending.current = false; }
  }
  const working = ["checking", "downloading", "installing"].includes(phase);
  const available = Boolean(info?.available);
  const ready = phase === "ready" || phase === "installing";
  const label = ready ? "更新已准备好" : available ? `新版本 v${info?.latestVersion} 可用` : "版本与更新";

  return <>
    <button type="button" className={`button button-secondary app-update-entry${available ? " has-update" : ""}`} onClick={() => setPanel(true)} aria-label="版本与更新" title={label}>
      {working ? <LoaderCircle size={15} className="spin" /> : error ? <CircleAlert size={15} /> : available ? <Download size={15} /> : <RefreshCw size={15} />}
      <span>版本与更新</span>{available && <span className="update-dot" aria-label={ready ? "更新已准备好" : "有新版本"} />}
    </button>
    {notice && createPortal(<aside className="update-notice" aria-label="版本更新提示" role="status">
      <strong>{notice === "installed" ? `已更新至 v${version}` : notice === "ready" ? "更新已准备好" : `新版本 v${info?.latestVersion} 可用`}</strong>
      <p>{notice === "installed" ? currentSummary : notice === "ready" ? `v${info?.latestVersion} 已下载并验证，您可以选择合适的时间安装。` : summary(info?.notes ?? null)}</p>
      <div className="update-actions">{notice === "installed" ? <><button type="button" className="text-button" onClick={() => { dismissNotice(); onViewHistory(); }}>查看完整更新记录</button><button type="button" className="text-button" onClick={dismissNotice}>知道了</button></> : <><button type="button" className="text-button" onClick={() => { setNotice(null); setPanel(true); }}>{notice === "ready" ? "查看并安装" : "查看更新"}</button><button type="button" className="text-button" onClick={dismissNotice}>{notice === "ready" ? "稍后" : "稍后提醒"}</button></>}</div>
    </aside>, document.getElementById("app-update-notices") ?? document.body)}
    {panel && <dialog className="app-update-dialog" aria-label="版本与更新详情" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setPanel(false)}>
      <header><div><h2>{label}</h2><p>当前版本 v{version}</p></div><button className="icon-button" type="button" aria-label="关闭版本与更新" onClick={() => setPanel(false)}><X size={18} /></button></header>
      {phase === "checking" && <p role="status">正在后台检查 GitHub 最新正式版本，数据载入可继续进行。网络短暂波动时自动重试，最多 3 次。</p>}
      {phase === "current" && <p role="status">已是最新正式版本。</p>}
      <div className="app-update-notes">{available ? <><h3>本次更新内容</h3><pre>{info?.notes || "此版本未提供更新说明。"}</pre></> : <><h3>当前版本更新摘要</h3><p>{currentSummary}</p><ul>{currentNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></>}</div>
      <p className="muted">更新来源：github.com/Lr-2002/Delta-Viewer · 正式 Release</p>
      {busy && <p role="status">正在处理数据或导出，请等待完成后再下载或安装更新。</p>}
      {error && <p className="update-error" role="alert">{error}。当前版本可继续使用。</p>}
      <footer className="update-actions">
        {ready && error && <button type="button" className="button button-secondary" disabled={busy || working} onClick={() => void download()}>重新下载</button>}
        <button type="button" className="button button-secondary" onClick={() => { setPanel(false); if (!installedAcknowledged.current) { write(seenKey, version); installedAcknowledged.current = true; } setNotice(null); }}>稍后</button>
        {ready ? <button className="button button-primary" type="button" disabled={busy || working} onClick={() => void install()}>{phase === "installing" ? "正在保存并安装…" : "保存并重启更新"}</button>
          : available ? <button type="button" className="button button-primary" disabled={busy || working} onClick={() => void download()}>{phase === "downloading" ? "正在下载…" : "下载更新"}</button>
            : <button type="button" className="button button-primary" disabled={working} onClick={() => void inspect()}>检查更新</button>}
      </footer>
    </dialog>}
  </>;
}
