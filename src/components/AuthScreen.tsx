import { useState, type FormEvent } from "react";
import { BrandMark } from "./BrandMark";
import { ArrowLeft, ChevronRight, Eye, EyeOff, FolderOpen, KeyRound, LogIn, Network, UserPlus, WifiOff } from "lucide-react";
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
  const [passwordVisible, setPasswordVisible] = useState(false);
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
    setPasswordVisible(false);
  }

  if (workspaceMode === null) {
    return (
      <main className="auth-shell">
        <header className="auth-brand">
          <BrandMark />
          <div><strong>D1 Manager</strong></div>
        </header>
        <section className="auth-panel workspace-mode-panel" aria-labelledby="workspace-mode-title">
          <div className="auth-heading">
            <span className="auth-icon"><Network size={20} /></span>
            <div>
              <span className="section-kicker">开始使用</span>
              <h1 id="workspace-mode-title">选择工作模式</h1>
            </div>
          </div>
          <p className="auth-intro">连接设备，或进入你的数据工作区。</p>
          <div className="workspace-mode-options">
            <button className="workspace-mode-option" type="button" onClick={() => void selectMode("offline")} disabled={busy}>
              <WifiOff size={18} />
              <span><strong>离线模式</strong><small>无需账号或网络，直接回放、编辑、审核与导出本地数据</small></span>
            </button>
            <button className="workspace-mode-option" type="button" onClick={() => void selectMode("managed")} disabled={busy}>
              <Network size={18} />
              <span><strong>登录工作区</strong><small>使用局域网用户中心账号，审核操作纳入审计</small></span>
            </button>
          </div>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
        </section>
        <footer className="auth-footer">离线结果仅在本机处理，不关联公司账号或审核统计</footer>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <header className="auth-brand">
        <BrandMark />
        <div><strong>D1 Manager</strong></div>
      </header>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-heading">
          <span className="auth-icon"><KeyRound size={20} /></span>
          <div>
            <span className="section-kicker">数据工作区</span>
            <h1 id="auth-title">{userCenter.configured ? mode === "login" ? "欢迎回来" : "创建审核员账号" : "连接用户中心"}</h1>
          </div>
        </div>
        <p className="auth-intro">{userCenter.configured ? mode === "login" ? "使用工作账号登录，继续标注与审核。" : "填写账号信息，即可进入工作区。" : "导入配置后，即可使用工作账号登录。"}</p>
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
                  disabled={busy || configuring}
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
                disabled={busy || configuring}
                autoFocus={mode === "login"}
              />
            </label>
            <label className="auth-password-label" htmlFor="auth-password">
              <span>密码</span>
            </label>
            <div className="auth-password-field">
              <input
                id="auth-password"
                type={passwordVisible ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={8}
                maxLength={128}
                required
                disabled={busy || configuring}
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                aria-pressed={passwordVisible}
                title={passwordVisible ? "隐藏密码" : "显示密码"}
                disabled={busy || configuring}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
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
                  disabled={busy || configuring}
                />
              </label>
            ) : null}
            <button className="button button-primary auth-submit" type="submit" disabled={busy || configuring}>
              {mode === "login" ? <LogIn size={17} /> : <UserPlus size={17} />}
              {busy ? "处理中" : mode === "login" ? "登录" : "创建并登录"}
            </button>
          </form>}
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <div className="auth-switch">
          <button type="button" className="auth-offline-entry" onClick={() => void selectMode("offline")} disabled={busy || configuring}>
            <WifiOff size={16} /><span>离线模式 · 直接进入</span><ChevronRight size={15} />
          </button>
          <div className="auth-utilities">
            <button type="button" className="text-button" onClick={() => void returnToModeChoice()} disabled={busy || configuring}>
              <ArrowLeft size={14} />选择工作模式
            </button>
            {userCenter.configured ? (
              <button type="button" className="text-button" onClick={() => switchLoginMode(mode === "login" ? "register" : "login")} disabled={busy || configuring}>
                {mode === "login" ? <UserPlus size={14} /> : <LogIn size={14} />}
                {mode === "login" ? "注册审核员账号" : "返回登录"}
              </button>
            ) : null}
          </div>
          {userCenter.configured ? (
            <button type="button" className="text-button auth-config-entry" onClick={() => void importUserCenter()} disabled={busy || configuring}>
              <FolderOpen size={14} />
              {configuring ? "验证并更新中" : "重新导入用户中心配置"}
            </button>
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
