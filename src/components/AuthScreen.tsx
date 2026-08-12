import { useState, type FormEvent } from "react";
import { ArrowLeft, FolderOpen, KeyRound, LogIn, Network, UserPlus } from "lucide-react";
import {
  configureUserCenter,
  loginLocalAccount,
  registerLocalAccount,
} from "../lib/backend";
import type { UserCenterStatus, UserIdentity, WorkspaceMode } from "../types";

interface AuthScreenProps {
  workspaceMode: WorkspaceMode | null;
  userCenter: UserCenterStatus;
  allowDemoRegistration: boolean;
  onWorkspaceModeSelected: (mode: WorkspaceMode) => Promise<void>;
  onChooseMode: () => Promise<void>;
  onUserCenterConfigured: (status: UserCenterStatus) => void;
  onAuthenticated: (user: UserIdentity) => void;
}

export function AuthScreen({
  workspaceMode,
  userCenter,
  allowDemoRegistration,
  onWorkspaceModeSelected,
  onChooseMode,
  onUserCenterConfigured,
  onAuthenticated,
}: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">(allowDemoRegistration ? "register" : "login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configuring, setConfiguring] = useState(false);

  async function selectMode(nextMode: WorkspaceMode) {
    setBusy(true);
    setError("");
    try {
      await onWorkspaceModeSelected(nextMode);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function returnToModeChoice() {
    setBusy(true);
    setError("");
    try {
      await onChooseMode();
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusy(false);
    }
  }

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
      setError(toMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function importUserCenter() {
    setConfiguring(true);
    setError("");
    try {
      const status = await configureUserCenter();
      onUserCenterConfigured(status);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setConfiguring(false);
    }
  }

  function switchLoginMode(next: "login" | "register") {
    setMode(next);
    setError("");
    setPassword("");
    setConfirmation("");
  }

  if (workspaceMode === null) {
    return (
      <main className="auth-shell">
        <header className="auth-brand">
          <span className="brand-mark">D</span>
          <div>
            <strong>DOHC Viewer</strong>
            <span>recording workspace</span>
          </div>
        </header>
        <section className="auth-panel workspace-mode-panel" aria-labelledby="workspace-mode-title">
          <div className="auth-heading">
            <span className="auth-icon"><Network size={20} /></span>
            <div>
              <span className="section-kicker">WORKSPACE MODE</span>
              <h1 id="workspace-mode-title">选择工作模式</h1>
            </div>
          </div>
          <div className="workspace-mode-options">
            <button className="workspace-mode-option" type="button" onClick={() => void selectMode("managed")} disabled={busy}>
              <Network size={18} />
              <span><strong>登录工作区</strong><small>使用局域网用户中心账号，标注操作纳入审计</small></span>
            </button>
          </div>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
        </section>
        <footer className="auth-footer">所有用户必须登录；采集数据仍只在本机目录处理</footer>
      </main>
    );
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
            <span className="section-kicker">USER CENTER</span>
            <h1 id="auth-title">{userCenter.configured ? mode === "login" ? "登录" : "演示账号" : "连接用户中心"}</h1>
          </div>
        </div>
        {!userCenter.configured ? (
          <div className="auth-connect">
            <p>请导入管理员在局域网服务主机生成的用户中心配置文件。</p>
            <button className="button button-primary auth-submit" type="button" onClick={() => void importUserCenter()} disabled={configuring}>
              <FolderOpen size={17} />
              {configuring ? "连接中" : "导入用户中心配置"}
            </button>
          </div>
        ) : <form onSubmit={(event) => void submit(event)}>
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
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>
            {mode === "login" ? <LogIn size={17} /> : <UserPlus size={17} />}
            {busy ? "处理中" : mode === "login" ? "登录" : "创建并登录"}
          </button>
        </form>}
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <div className="auth-switch">
          <button type="button" className="text-button" onClick={() => void returnToModeChoice()} disabled={busy || configuring}>
            <ArrowLeft size={14} />
            选择工作模式
          </button>
          {allowDemoRegistration && mode === "login" ? (
            <button type="button" className="text-button" onClick={() => switchLoginMode("register")}>创建新账号</button>
          ) : allowDemoRegistration && mode === "register" ? (
            <button type="button" className="text-button" onClick={() => switchLoginMode("login")}>返回登录</button>
          ) : null}
        </div>
      </section>
      <footer className="auth-footer">账号由局域网用户中心管理；采集数据仍只在本机处理</footer>
    </main>
  );
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
