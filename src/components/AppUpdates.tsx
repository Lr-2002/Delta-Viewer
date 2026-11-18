import { t, tr, useLanguage } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { checkForAppUpdate, type AppUpdateSource } from "../lib/backend";
import type { AppUpdateInfo } from "../types";
import { UpdateToast } from "./UpdateToast";

const seenKey = "delta.updates.release-notes.seen";
const notifiedKey = "delta.updates.available.notified";
const sourceKey = "delta.updates.download-source";
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Keep this session's acknowledgement. */ } }
function summary(notes: string | null) {
  return notes?.split("\n").map(line => line.replace(/^\s*[-*#]+\s*/, "").trim()).find(Boolean) ?? "查看本次更新的改进和修复。";
}

export function AppUpdates({ version, currentSummary, currentNotes, busy, onDownload, onInstall, onViewHistory,
  check = checkForAppUpdate }: {
  version: string; currentSummary: string; currentNotes: string[]; busy: boolean;
  onDownload: () => Promise<void>; onInstall: () => Promise<void>; onViewHistory: () => void;
  check?: (source?: AppUpdateSource) => Promise<AppUpdateInfo>;
}) {
  useLanguage();
  const [downloadSource, setDownloadSource] = useState<AppUpdateSource>(() => {
    const value = read(sourceKey); return value === "lan" || value === "github" ? value : "auto";
  });
  const sourceRef = useRef(downloadSource); sourceRef.current = downloadSource;
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

  async function inspect(source = sourceRef.current) {
    if (pending.current || phaseRef.current === "ready" || phaseRef.current === "installing") return;
    pending.current = true; setInfo(null); setNotice(current => current === "installed" ? current : null); deferredNotice.current = null; setPhase("checking"); setError("");
    try {
      const result = await check(source);
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

  useEffect(() => {
    const open = () => { setPanel(true); void inspect(); };
    window.addEventListener("delta-open-update-panel", open);
    return () => window.removeEventListener("delta-open-update-panel", open);
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
    <button type="button" className={`button button-secondary app-update-entry${available ? " has-update" : ""}`} onClick={() => setPanel(true)} aria-label={t("版本与更新")} title={tr(label)}>
      {working ? <LoaderCircle size={15} className="spin" /> : error ? <CircleAlert size={15} /> : available ? <Download size={15} /> : <RefreshCw size={15} />}
      <span>{t("版本与更新")}</span>{available && <span className="update-dot" aria-label={ready ? t("更新已准备好") : t("有新版本")} />}
    </button>
    {notice && createPortal(<UpdateToast key={`${notice}:${notice === "installed" ? version : info?.latestVersion}`}
      title={notice === "installed" ? t("已更新至 v{0}", [tr(version)]) : notice === "ready" ? t("更新已准备好") : t("新版本 v{0} 可用", [tr(info?.latestVersion)])}
      message={notice === "installed" ? tr(currentSummary) : notice === "ready" ? t("v{0} 已下载并验证，您可以选择合适的时间安装。", [tr(info?.latestVersion)]) : tr(summary(info?.notes ?? null))}
      primaryLabel={notice === "installed" ? t("查看完整更新记录") : notice === "ready" ? t("查看并安装") : t("查看更新")}
      secondaryLabel={notice === "installed" ? t("知道了") : notice === "ready" ? t("稍后") : t("稍后提醒")}
      onPrimary={notice === "installed" ? onViewHistory : () => { setNotice(null); setPanel(true); }} onDismiss={dismissNotice}
    />, document.getElementById("app-update-notices") ?? document.body)}
    {panel && <dialog className="app-update-dialog" aria-label={t("版本与更新详情")} ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setPanel(false)}>
      <header><div><h2>{tr(label)}</h2><p>{t("当前版本 v")}{tr(version)}</p></div><button className="icon-button" type="button" aria-label={t("关闭版本与更新")} onClick={() => setPanel(false)}><X size={18} /></button></header>
      <label className="update-source-choice">{t("下载线路")}<select aria-label={t("更新下载线路")} value={downloadSource} disabled={working || ready} onChange={event => {
          const source = event.target.value as AppUpdateSource;
          write(sourceKey, source); setDownloadSource(source); setInfo(null); void inspect(source);
        }}>
          <option value="auto">{t("自动（优先公司内网）")}</option>
          <option value="lan">{t("公司内网（无需代理）")}</option>
          <option value="github">{t("GitHub（外网备用）")}</option>
        </select>
      </label>
      {phase === "checking" && <p role="status">{t("正在检查候选及正式更新，数据载入可继续进行。")}</p>}
      {phase === "current" && <p role="status">{info?.downloadSource === "lan" ? t("公司内网已同步至 v{0}，当前无需更新。", [tr(info.latestVersion)]) : info?.downloadSource === "candidate" ? t("当前已是最新候选版本，尚未正式发布。") : t("当前没有可安装的更新。")}</p>}
      <div className="app-update-notes">{available ? <><h3>{t("本次更新内容")}</h3><pre>{info?.notes || t("此版本未提供更新说明。")}</pre></> : <><h3>{t("当前版本更新摘要")}</h3><p>{tr(currentSummary)}</p><ul>{currentNotes.map((note, i) => <li key={i}>{tr(note)}</li>)}</ul></>}</div>
      <p className="muted">{info?.downloadSource === "candidate" ? t("发布通道：公开候选更新 · 尚未发布 GitHub 正式版") : t("发布来源：github.com/Lr-2002/Delta-Viewer · 正式 Release")}<br />{t("下载线路：")}{info?.downloadSource === "lan" ? t("公司内网 · 无需访问 GitHub") : info?.downloadSource === "github" ? "GitHub" : info?.downloadSource === "candidate" ? t("候选更新服务 · HTTPS") : t("等待检查")}</p>
      {tr(info?.sourceNote && <p className="muted update-source-note">{tr(info.sourceNote)}</p>)}
      {busy && <p role="status">{t("正在处理数据或导出，请等待完成后再下载或安装更新。")}</p>}
      {tr(error && <p className="update-error" role="alert">{tr(error)}{t("。当前版本可继续使用。")}</p>)}
      <footer className="update-actions">
        {tr(ready && error && <button type="button" className="button button-secondary" disabled={busy || working} onClick={() => void download()}>{t("重新下载")}</button>)}
        <button type="button" className="button button-secondary" onClick={() => { setPanel(false); if (!installedAcknowledged.current) { write(seenKey, version); installedAcknowledged.current = true; } setNotice(null); }}>{t("稍后")}</button>
        {ready ? <button className="button button-primary" type="button" disabled={busy || working} onClick={() => void install()}>{phase === "installing" ? t("正在保存并安装…") : t("保存并重启更新")}</button> : available ? <button type="button" className="button button-primary" disabled={busy || working} onClick={() => void download()}>{phase === "downloading" ? t("正在下载…") : t("下载更新")}</button> : <button type="button" className="button button-primary" disabled={working} onClick={() => void inspect()}>{t("检查更新")}</button>}
      </footer>
    </dialog>}
  </>;
}
