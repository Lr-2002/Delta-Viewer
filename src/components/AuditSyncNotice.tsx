import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, CircleAlert, LogIn, RefreshCw } from "lucide-react";
import { flushPendingAnnotationAudits, loginLocalAccount } from "../lib/backend";

import { auditFailureReason, auditNeedsLogin, type ReviewSyncStatus } from "../lib/review-audit-status";

interface AuditSyncNoticeProps {
  status?: ReviewSyncStatus | null;
  additionalError?: string;
  additionalPending?: boolean;
  username: string;
  error: string;
  onError: (message: string) => void;
  onPendingChange: (pending: boolean) => void;
  flush?: () => Promise<number>;
  message?: string;
  autoRetry?: boolean;
}

export function AuditSyncNotice({ username, error, onError, onPendingChange, flush = flushPendingAnnotationAudits, message, autoRetry = true, status, additionalError = "", additionalPending = false }: AuditSyncNoticeProps) {
  const [expanded, setExpanded] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(Date.now);
  const issue = [status?.localError, status?.uploadError, status?.blockedError, actionError, additionalError, ...(status ? [] : [error])].filter(Boolean).join("；");
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

  const retryInputs = useRef({ flush, status, onError, onPendingChange });
  retryInputs.current = { flush, status, onError, onPendingChange };
  const retry = useCallback(async () => {
    const { flush, status, onError, onPendingChange } = retryInputs.current;
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
  }, []);

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
  if (status && severity === "normal" && !loginOpen && !additionalPending) return null;

  const title = atRisk ? "操作记录未保存到本机，有丢失风险"
    : needsLogin ? "登录已失效，操作记录等待补传"
    : status?.blocked || status?.legacyInvalid ? "部分操作记录异常，需要处理"
    : status?.volatile ? "操作记录正在保存到本机"
    : status?.pending === null ? "操作记录同步状态待核实"
    : "操作记录已保存到本机，但尚未全部上传用户中心";
  return (
    <section data-audit-severity={status && severity !== "normal" ? severity : "warning"} className={`audit-sync-notice audit-sync-${status && severity !== "normal" ? severity : "warning"}`}
      role={atRisk ? "alert" : "status"} aria-label="操作记录同步状态">
      <div className="audit-sync-heading">
        <CircleAlert size={18} aria-hidden="true" />
        <div className="audit-sync-summary">
          <strong>{status ? title : needsLogin ? "登录已失效，记录等待补传" : message ?? "操作记录等待补传"}</strong>
          <p>{atRisk ? "请保持应用打开并重试，保存恢复前请勿关闭、更新或退出。"
            : status?.pending === null ? "尚未确认本机队列状态，请保持应用打开并重试。"
            : status?.volatile ? "请保持应用打开，正在等待本机保存完成。"
            : "当前审核内容保留；工作台统计可能不完整，恢复连接及登录后自动补传。"}</p>
        </div>
        <div className="audit-sync-actions">
          {status && <span className="audit-sync-count">待传 <b>{status.pending ?? "未知"}</b> 条操作事件</span>}
          <button type="button" className="text-button audit-sync-toggle" aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}>{expanded ? "收起详情" : "同步详情"}<ChevronDown size={14} /></button>
          {!loginOpen && <button type="button" className="button button-secondary" disabled={busy}
            onClick={() => needsLogin ? setLoginOpen(true) : void retry()}>
            {needsLogin ? <LogIn size={14} /> : <RefreshCw size={14} className={busy ? "spin" : undefined} />}
            {busy ? "正在重试…" : needsLogin ? (status ? "重新登录并补传" : "重新登录") : "重试上传"}
          </button>}
        </div>
      </div>
      {(status?.blocked || status?.legacyInvalid) ? <p className="audit-sync-blocked">
        异常操作事件：服务端拒绝 {status.blocked} 条；旧缓存无法解析 {status.legacyInvalid} 条。已单独保留，不计为上传成功。
      </p> : null}
      {issue && <p className="audit-sync-reason" hidden={!expanded && !actionError}>失败原因：{auditFailureReason(actionError || status?.localError || status?.uploadError || status?.blockedError || additionalError || error)}</p>}
      <div className="audit-sync-detail" hidden={!expanded}>
        {status && <div className="audit-sync-facts">
          <span>待传操作事件：{status.pending ?? "未知"} 条（含未落盘及异常）</span>
          <span>未落盘：{status.volatile} 条</span>
          <span>最早待传时间：{status.pending === 0 ? "无" : time(status.oldestPendingAtMs)}</span>
          <span>最近成功同步（收到用户中心确认）：{time(status.lastSuccessAtMs)}</span>
        </div>}
        {additionalPending && <p>另有标注操作记录等待用户中心确认，未计入上方操作事件数量。</p>}
        <p>用户中心接收确认不代表工作台已完成统计。</p>
        {issue && <details><summary>查看错误详情</summary><div>{issue}</div></details>}
      </div>
      {loginOpen ? (
        <form onSubmit={(event) => void renewSession(event)} className="audit-sync-login">
          <span>@{username}</span>
          <input aria-label="当前账号密码" type="password" autoComplete="current-password"
            required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} autoFocus />
          <button type="submit" className="button button-secondary" disabled={busy}><LogIn size={14} />登录并补传</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => { setPassword(""); setLoginOpen(false); }}>取消</button>
        </form>
      ) : null}
    </section>
  );
}
