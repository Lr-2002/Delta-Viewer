import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, LogIn, RefreshCw } from "lucide-react";
import { flushPendingAnnotationAudits, loginLocalAccount } from "../lib/backend";

import { auditFailureReason, auditNeedsLogin, type ReviewSyncStatus } from "../lib/review-audit-status";

interface AuditSyncNoticeProps {
  status?: ReviewSyncStatus | null;
  username: string;
  error: string;
  onError: (message: string) => void;
  onPendingChange: (pending: boolean) => void;
  flush?: () => Promise<number>;
  message?: string;
  autoRetry?: boolean;
}

export function AuditSyncNotice({ username, error, onError, onPendingChange, flush = flushPendingAnnotationAudits, message, autoRetry = true, status }: AuditSyncNoticeProps) {
  const [loginOpen, setLoginOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(Date.now);
  const issue = status ? [status.localError, status.uploadError, status.blockedError, actionError].filter(Boolean).join("；") : error;
  const needsLogin = auditNeedsLogin(issue) || loginOpen;
  useEffect(() => {
    if (!status?.pending && !status?.volatile) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.pending, status?.volatile]);
  const backlogSince = useRef<number | null>(null);
  if (status?.pending) backlogSince.current ??= Date.now();
  else backlogSince.current = null;
  const age = status?.oldestPendingAtMs ? Math.max(0, now - status.oldestPendingAtMs) : 0;
  const atRisk = Boolean(status?.volatile && (status.localError || (status.oldestVolatileAtMs && now - status.oldestVolatileAtMs >= 5000)));
  const warning = Boolean(status && (issue || status.blocked || status.legacyInvalid
    || (status.pending && (age >= 30000 || (backlogSince.current !== null && now - backlogSince.current >= 30000)))));
  const severity = atRisk ? "danger" : warning ? "warning" : "normal";
  const time = (value: number | null) => value && Number.isFinite(value)
    ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";

  const retry = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setActionError("");
    try {
      const remaining = await flush();
      if (!remaining && !status) onError("");
      onPendingChange(remaining > 0);
    } catch (reason) {
      setActionError(String(reason));
      onError(String(reason));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [onError, onPendingChange, flush, status]);

  useEffect(() => {
    if (needsLogin || !autoRetry) return;
    const timer = window.setInterval(() => void retry(), 30_000);
    const online = () => void retry();
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [needsLogin, retry, autoRetry]);

  async function renewSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setActionError("");
    const submittedPassword = password;
    setPassword("");
    try {
      // Renew only the current account so in-progress work keeps its owner.
      await loginLocalAccount(username, submittedPassword);
      setLoginOpen(false);
      if (!status) onError("");
    } catch (reason) {
      setActionError(String(reason));
      onError(String(reason));
      return;
    } finally {
      running.current = false;
      setBusy(false);
    }
    await retry();
  }

  // Keep queue monitoring/retry effects active without occupying the workspace
  // while idle or briefly queued. An open recovery form stays usable.
  if (status && severity === "normal" && !loginOpen) return null;

  return (
    <div data-audit-severity={status ? severity : undefined} className={`alert-banner alert-notice audit-sync-notice${status ? ` audit-sync-${severity}` : ""}`}
      role={atRisk ? "alert" : "status"} aria-label="操作记录同步状态">
      <CircleAlert size={17} aria-hidden="true" />
      {status ? <div className="audit-sync-summary">
        <strong>{atRisk ? "操作记录未保存到本机，有丢失风险"
          : status.volatile ? "操作记录正在保存到本机"
          : status.pending === null ? "正在核实本机操作记录，待传数量未知"
          : status.pending ? warning ? "操作记录已保存到本机，但尚未全部上传用户中心" : "操作记录已保存到本机，正常排队上传"
          : "当前账号暂无待传操作记录"}</strong>
        <div>{atRisk ? "请保持应用打开并重试；保存恢复前请勿关闭、更新或退出登录。"
          : status.pending ? "工作台统计可能不完整，连接及登录恢复后会自动补传。"
          : "用户中心接收确认不代表工作台已完成统计。"}</div>
        <div className="audit-sync-facts">
          <span>待传操作事件：{status.pending ?? "未知"} 条（含未落盘及异常）</span>
          <span>未落盘：{status.volatile} 条</span>
          <span>最早待传时间：{status.pending === 0 ? "无" : time(status.oldestPendingAtMs)}</span>
          <span>最近成功同步（收到用户中心确认）：{time(status.lastSuccessAtMs)}</span>
        </div>
        {(status.blocked > 0 || status.legacyInvalid > 0) && <div className="audit-sync-blocked">
          异常操作事件：服务端拒绝 {status.blocked} 条；旧缓存无法解析 {status.legacyInvalid} 条。已单独保留，不计为上传成功。
          {status.blocked > 0 && <span> {auditFailureReason(status.blockedError)}</span>}
        </div>}
        {issue && <div className="audit-sync-reason">失败原因：{auditFailureReason(actionError || status.localError || status.uploadError || status.blockedError)}</div>}
        {issue && <details><summary>查看错误详情</summary><div>{issue}</div></details>}
      </div> : <span>{needsLogin
        ? "监管登录已失效，记录待上传。当前工作仍保留。"
        : message ?? "监管记录待上传，正在等待重试。"}</span>}
      {loginOpen ? (
        <form onSubmit={(event) => void renewSession(event)} className="audit-sync-login">
          <span>@{username}</span>
          <input aria-label="当前账号密码" type="password" autoComplete="current-password"
            required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} autoFocus />
          <button type="submit" className="button button-secondary" disabled={busy}><LogIn size={14} />登录并补传</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => { setPassword(""); setLoginOpen(false); }}>取消</button>
        </form>
      ) : (
        <button type="button" className="button button-secondary" disabled={busy}
          onClick={() => needsLogin ? setLoginOpen(true) : void retry()}>
          {needsLogin ? <LogIn size={14} /> : <RefreshCw size={14} />}{needsLogin ? (status ? "重新登录并补传" : "重新登录") : "重试上传"}
        </button>
      )}
      {!status && error && !error.includes("AUTH_REQUIRED") ? <span>{error.includes("AUDIT_TIME_INVALID")
        ? "监管时间校验失败：请检查客户端与服务端时钟；跨天待传记录需用户中心升级后重试。原记录已保留。"
        : error}</span> : null}
    </div>
  );
}
