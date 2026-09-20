import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, LogIn, RefreshCw } from "lucide-react";
import { flushPendingAnnotationAudits, loginLocalAccount } from "../lib/backend";

interface AuditSyncNoticeProps {
  username: string;
  error: string;
  onError: (message: string) => void;
  onPendingChange: (pending: boolean) => void;
  flush?: () => Promise<number>;
  message?: string;
  autoRetry?: boolean;
}

export function AuditSyncNotice({ username, error, onError, onPendingChange, flush = flushPendingAnnotationAudits, message, autoRetry = true }: AuditSyncNoticeProps) {
  const [loginOpen, setLoginOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const needsLogin = error.includes("AUTH_REQUIRED") || error.includes("REVIEWER_REQUIRED") || loginOpen;

  const retry = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const remaining = await flush();
      if (!remaining) onError("");
      onPendingChange(remaining > 0);
    } catch (reason) {
      onError(String(reason));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [onError, onPendingChange, flush]);

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
    const submittedPassword = password;
    setPassword("");
    try {
      // Renew only the current account so in-progress work keeps its owner.
      await loginLocalAccount(username, submittedPassword);
      setLoginOpen(false);
      onError("");
    } catch (reason) {
      onError(String(reason));
      return;
    } finally {
      running.current = false;
      setBusy(false);
    }
    await retry();
  }

  return (
    <div className="alert-banner alert-notice audit-sync-notice" role="status">
      <CircleAlert size={17} aria-hidden="true" />
      <span>{needsLogin
        ? "监管登录已失效，记录待上传。当前工作仍保留。"
        : message ?? "监管记录待上传，正在等待重试。"}</span>
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
          {needsLogin ? <LogIn size={14} /> : <RefreshCw size={14} />}{needsLogin ? "重新登录" : "重试上传"}
        </button>
      )}
      {error && !error.includes("AUTH_REQUIRED") ? <span>{error.includes("AUDIT_TIME_INVALID")
        ? "监管时间校验失败：请检查客户端与服务端时钟；跨天待传记录需用户中心升级后重试。原记录已保留。"
        : error}</span> : null}
    </div>
  );
}
