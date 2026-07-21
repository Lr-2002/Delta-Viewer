import { useState, type FormEvent } from "react";
import { KeyRound, LogIn, UserPlus } from "lucide-react";
import { loginLocalAccount, registerLocalAccount } from "../lib/backend";
import type { UserIdentity } from "../types";

interface AuthScreenProps {
  hasAccounts: boolean;
  onAuthenticated: (user: UserIdentity) => void;
}

export function AuthScreen({ hasAccounts, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">(hasAccounts ? "login" : "register");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const user = mode === "login"
        ? await loginLocalAccount(username, password)
        : await registerLocalAccount(username, displayName, password);
      setPassword("");
      setConfirmation("");
      onAuthenticated(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setError("");
    setPassword("");
    setConfirmation("");
  }

  return (
    <main className="auth-shell">
      <header className="auth-brand">
        <span className="brand-mark">D</span>
        <div>
          <strong>DOHC Viewer</strong>
          <span>recording workspace</span>
        </div>
      </header>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-heading">
          <span className="auth-icon"><KeyRound size={20} /></span>
          <div>
            <span className="section-kicker">LOCAL ACCOUNT</span>
            <h1 id="auth-title">{mode === "login" ? "登录" : hasAccounts ? "创建本地账号" : "创建首个账号"}</h1>
          </div>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {mode === "register" ? (
            <label>
              <span>显示名称</span>
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                maxLength={40}
                required
                autoFocus
              />
            </label>
          ) : null}
          <label>
            <span>账号</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-)*[A-Za-z0-9]"
              required
              autoFocus={mode === "login"}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          {mode === "register" ? (
            <label>
              <span>确认密码</span>
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
              />
            </label>
          ) : null}
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>
            {mode === "login" ? <LogIn size={17} /> : <UserPlus size={17} />}
            {busy ? "处理中" : mode === "login" ? "登录" : "创建并登录"}
          </button>
        </form>
        <div className="auth-switch">
          {mode === "login" ? (
            <button type="button" className="text-button" onClick={() => switchMode("register")}>
              创建新账号
            </button>
          ) : hasAccounts ? (
            <button type="button" className="text-button" onClick={() => switchMode("login")}>
              返回登录
            </button>
          ) : null}
        </div>
      </section>
      <footer className="auth-footer">账号与标注仅保存在本机</footer>
    </main>
  );
}
