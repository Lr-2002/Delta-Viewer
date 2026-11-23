import { localeTag, t, tr, useLanguage } from "../lib/i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  BookOpenText,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Keyboard,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  FlaskConical,
  UserPlus,
  XCircle,
  X,
} from "lucide-react";
import {
  batchCreateSupervisionAccounts,
  chooseDirectory,
  exportReviewedSessions,
  scanReviewedSessions,
  cancelTask,
  onTaskProgress,
  type ReviewedCatalog,
  exportSupervisionReport,
  getReviewDashboard,
  isTauriRuntime,
  setSupervisionAccountStatus,
  deleteSupervisionAccount,
  openCaptureWorkbench,
  getClientVersions,
  pushUpdateReminders,
} from "../lib/backend";
import type { CloudOperationHandle } from "../lib/cloud-qc";
import { TextCorrectionsPanel } from "./TextCorrectionsPanel";
import {
  reviewActionLabels,
  type ReviewDashboardData,
  type ReviewEvent,
} from "../lib/review-audit-types";
import type { UserIdentity, ClientVersions } from "../types";
import "./review-supervision.css";
import { SourceWritebackAdmin } from "./SourceWritebackAdmin";
import { DataWorkspaceMore } from "./DataWorkspaceMore";
import { TaskCenter } from "./TaskCenter";
import { currentClientVersion } from "../lib/client-versions";

type View = "overview" | "events" | "sessions" | "accounts" | "writeback" | "corrections" | "tasks";
const tabs: [View, string][] = [
  ["accounts", "审核账号"],
  ["overview", "审核总览"],
  ["events", "实时行为"],
  ["sessions", "审核记录"],
  ["tasks", "任务中心"],
  ["writeback", "NAS 写回"],
  ["corrections", "文字勘误"],
];
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString(localeTag(), { hour12: false }) : "--";
const duration = (value: number | null) =>
  value === null
    ? "--"
    : `${Math.floor(value / 60000)} 分 ${Math.round((value % 60000) / 1000)} 秒`;
const detailNames: Record<string, string> = {
  target: "控件",
  value: "内容",
  before: "修改前",
  after: "修改后",
  frameFrom: "起始帧",
  frameTo: "目标帧",
  mediaTimeMs: "视频位置(ms)",
  durationMs: "操作耗时(ms)",
  segmentIndex: "片段索引",
  startFrame: "开始帧",
  endFrame: "结束帧",
  revision: "修订",
  reason: "原因",
  labelId: "标签ID",
  sourceName: "机标来源",
};
function eventDetails(event: ReviewEvent) {
  return Object.entries(event.details)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${detailNames[key] ?? key}: ${value}`)
    .join("；");
}

export function SupervisionDashboard({
  currentUser,
  writebackOwner,
  onLogout,
  updateControls,
  updateBusy = false,
  onTestMode,
  onManagerHome,
  onEditProfile,
  onOpenShortcuts,
  onOpenReleaseHistory,
  syncNotice,
  onOpenCloudReview,
  onOpenOutboundReview,
  beginCloudOperation,
}: {
  currentUser: UserIdentity;
  writebackOwner?: import("../lib/source-writeback").WritebackOwner;
  onLogout: () => Promise<void>;
  updateControls?: (busy: boolean) => ReactNode;
  updateBusy?: boolean;
  onTestMode?: () => void;
  onManagerHome?: () => void;
  onEditProfile?: () => void;
  onOpenShortcuts?: () => void;
  onOpenReleaseHistory?: () => void;
  syncNotice?: ReactNode;
  onOpenCloudReview?: (root: string) => Promise<void>;
  onOpenOutboundReview?: (batch: import("../lib/outbound-review").OutboundBatch) => Promise<void>;
  beginCloudOperation?: () => CloudOperationHandle | null;
}) {
  useLanguage();
  const [view, setView] = useState<View>(currentUser.canManage ? "accounts" : "overview");
  const needsVersions = view === "accounts" || view === "writeback";
  const isAuditView = view === "overview" || view === "events" || view === "sessions";
  const [refreshId, setRefreshId] = useState(0);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versions, setVersions] = useState<ClientVersions | null>(null);
  const [versionError, setVersionError] = useState("");
  const versionClock=useRef({server:Date.now(),received:performance.now()});
  const [clockTick,setClockTick]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setClockTick(x=>x+1),15000);return()=>clearInterval(timer);},[]);
  const versionNow=versionClock.current.server+performance.now()-versionClock.current.received;void clockTick;
  const [checkedAccounts, setCheckedAccounts] = useState<string[]>([]);
  const [versionLogAccount, setVersionLogAccount] = useState<string | null>(null);
  const versionLogDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!versionLogAccount) return;
    const node = versionLogDialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    return () => { node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [versionLogAccount]);
  useEffect(() => {
    if (!needsVersions) return;
    let active = true, inFlight = false;
    async function refreshVersions() {
      if (inFlight) return;
      inFlight = true;setVersionsLoading(true);
      try { const next = await getClientVersions(); if(active) {versionClock.current={server:next.generatedAtMs,received:performance.now()};setVersions(next);setVersionError("");} }
      catch(reason) {if(active)setVersionError(String(reason));}
      finally {inFlight=false;if(active)setVersionsLoading(false);}
    }
    void refreshVersions();
    const timer=window.setInterval(()=>void refreshVersions(),15_000);
    return()=>{active=false;window.clearInterval(timer);};
  },[needsVersions,refreshId]);
  const [data, setData] = useState<ReviewDashboardData | null>(null);
  const [username, setUsername] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [action, setAction] = useState("");
  const [date, setDate] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [before, setBefore] = useState("");
  const [previous, setPrevious] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionBusy, setBusy] = useState("");
  const [correctionsBusy, setCorrectionsBusy] = useState(false);
  const busy = actionBusy || (updateBusy ? "update" : correctionsBusy ? "corrections" : "");
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ username: string; displayName: string } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const deleteDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (deleteTarget) deleteDialog.current?.showModal(); }, [deleteTarget]);
  const [selected, setSelected] = useState<ReviewEvent | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [catalog, setCatalog] = useState<ReviewedCatalog | null>(null);
  const [catalogFilter, setCatalogFilter] = useState("all");
  const [catalogPage, setCatalogPage] = useState(0);
  const [catalogProgress, setCatalogProgress] = useState("");
  const catalogOperation = useRef<number | null>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void onTaskProgress((progress) => {
      if (progress.operationId === catalogOperation.current) setCatalogProgress(`${progress.phase}：${progress.currentPath}`);
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  const seconds = (value: number | null) => value === null ? "未计入" : `${Math.floor(value / 3600)} 时 ${Math.floor(value % 3600 / 60)} 分 ${(value % 60).toFixed(2)} 秒`;
  const catalogRows = catalog?.rows.filter((row) => catalogFilter === "all" || (catalogFilter === "error" ? Boolean(row.error) : row.status === catalogFilter)) ?? [];
  const [account, setAccount] = useState({
    username: "",
    displayName: "",
    password: "",
  });
  const query = useMemo(
    () =>
      ({
        ...(username ? { username } : {}),
        ...(action ? { action } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(before
          ? { [view === "sessions" ? "sessionBefore" : "before"]: before }
          : {}),
        ...(date
          ? {
              fromMs: String(new Date(`${date}T00:00:00`).getTime()),
              toMs: String(new Date(`${date}T23:59:59.999`).getTime()),
            }
          : {}),
      }) as Record<string, string>,
    [username, action, sessionId, before, date, view],
  );
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (!isAuditView) return;
    const generation = ++requestGeneration.current;
    let active = true,
      inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const next = await getReviewDashboard(query);
        if (active && generation === requestGeneration.current) {
          setData(next);
          setError("");
        }
      } catch (reason) {
        if (active) setError(String(reason));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    }
    void refresh();
    const timer =
      live && !before
        ? window.setInterval(() => {
            void refresh();
          }, 3000)
        : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [query, live, refreshId, before, view, isAuditView]);
  useEffect(() => {
    setBefore("");
    setPrevious([]);
    setSelected(null);
  }, [username, action, date, sessionId, view]);
  useEffect(() => {
    if (!selected) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = document.querySelector<HTMLButtonElement>(
      '[aria-label="关闭明细"]',
    );
    close?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "Tab") {
        event.preventDefault();
        close?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previousFocus?.focus();
    };
  }, [selected]);
  const users = (data?.users ?? []).filter(
    (user) => !username || user.username === username,
  );
  const visibleUsers = users.filter(
    (user) => user.accountStatus !== "deleted" || (view === "sessions" && includeDeleted),
  );
  const visibleSessions = data?.sessions.filter((row) => {
    const user = data.users.find((candidate) => candidate.username === row.username);
    return user?.accountStatus !== "deleted" || includeDeleted;
  });
  const visibleEvents = data?.events.filter((event) => {
    const user = data.users.find((candidate) => candidate.username === event.username);
    return user?.accountStatus !== "deleted" || (view === "sessions" && includeDeleted);
  });
  const totals = visibleUsers.reduce(
    (total, user) => ({
      approved: total.approved + user.approved,
      rejected: total.rejected + user.rejected,
      operations: total.operations + user.operations,
      online: total.online + Number(user.online),
    }),
    { approved: 0, rejected: 0, operations: 0, online: 0 },
  );
  async function exportEvents() {
    setBusy("export");
    setNotice("");
    try {
      const rows: ReviewEvent[] = [];
      const filter = { ...query };
      delete filter.before;
      delete filter.sessionBefore;
      let cursor: string | undefined;
      do {
        const page = await getReviewDashboard({
          ...filter,
          ...(cursor ? { before: cursor } : {}),
        });
        rows.push(...page.events);
        cursor = page.nextBefore ? String(page.nextBefore) : undefined;
        setNotice(`已读取 ${rows.length} 条审核事件`);
      } while (cursor);
      const cell = (value: unknown) => {
        const text = String(value ?? "");
        return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
      };
      const content =
        "\uFEFF" +
        [
          [
            "账号",
            "姓名",
            "数据",
            "审核会话",
            "操作",
            "发生时间",
            "收到时间",
            "距加载(ms)",
            "明细",
          ],
          ...rows.map((row) => [
            row.username,
            row.displayName,
            row.episodeName,
            row.sessionId,
            reviewActionLabels[row.action],
            time(row.occurredAtMs),
            time(row.receivedAtMs),
            row.elapsedMs,
            eventDetails(row),
          ]),
        ]
          .map((row) => row.map(cell).join(","))
          .join("\r\n");
      if (isTauriRuntime()) {
        const destination = await chooseDirectory("导出审核行为记录");
        if (!destination) return;
        const result = await exportSupervisionReport(
          destination,
          "daily",
          "csv",
          new Date().toISOString().slice(0, 10),
          Date.now(),
          content,
        );
        setNotice(`已导出 ${rows.length} 条事件：${result.outputPath}`);
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "review-events.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(`已导出 ${rows.length} 条事件`);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  async function exportReviewed() {
    if (!catalog || catalogOperation.current) return;
    setBusy("reviewed-export"); setError(""); setNotice("");
    try {
      const destination = await chooseDirectory("选择集中导出目录");
      if (!destination) return;
      const operationId = Date.now(); catalogOperation.current = operationId;
      const result = await exportReviewedSessions(catalog.scanId, destination, operationId);
      setNotice(`已导出 ${result.sessions} 条通过数据：${result.outputPath}`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); catalogOperation.current = null; setCatalogProgress(""); }
  }
  async function chooseReviewSource() {
    setBusy("reviewed-choose"); setError("");
    try {
      const selectedPath = await chooseDirectory("选择包含 session 的数据根目录");
      if (selectedPath) { setSourcePath(selectedPath); setCatalog(null); setNotice(""); }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }
  async function scanReviewed() {
    if (!sourcePath.trim() || catalogOperation.current) return;
    const operationId = Date.now(); catalogOperation.current = operationId;
    setBusy("reviewed-scan"); setCatalog(null); setNotice(""); setError(""); setCatalogPage(0);
    try { setCatalog(await scanReviewedSessions(sourcePath.trim(), operationId)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(""); catalogOperation.current = null; setCatalogProgress(""); }
  }
  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy("account");
    setNotice("");
    try {
      await batchCreateSupervisionAccounts([account]);
      setAccount({ username: "", displayName: "", password: "" });
      setNotice("审核账号已创建");
      setRefreshId((id) => id + 1);
    } catch (reason) {
      setNotice(`账号操作失败：${String(reason)}`);
    } finally {
      setBusy("");
    }
  }
  async function setAccountStatus(name: string, status: "active" | "paused") {
    setBusy(name);
    try {
      await setSupervisionAccountStatus([name], status);
      setRefreshId((id) => id + 1);
    } catch (reason) {
      setNotice(`账号操作失败：${String(reason)}`);
    } finally {
      setBusy("");
    }
  }
  async function deleteAccount() {
    if (!deleteTarget || busy) return;
    const target = deleteTarget;
    setBusy(`delete:${target.username}`);
    setDeleteError("");
    try {
      await deleteSupervisionAccount(target.username);
      requestGeneration.current++;
      setVersions(previous=>previous?{...previous,users:previous.users.filter(user=>user.username!==target.username)}:previous);
      setCheckedAccounts(previous=>previous.filter(name=>name!==target.username));
      setData((previous) => previous ? { ...previous, users: previous.users.map((user) =>
        user.username === target.username ? { ...user, accountStatus: "deleted", online: false } : user) } : previous);
      setNotice(`已删除 @${target.username}，历史审核记录已保留`);
      setDeleteTarget(null);
      setRefreshId((id) => id + 1);
    } catch (reason) {
      setDeleteError(String(reason));
    } finally { setBusy(""); }
  }
  async function remind(usernames: string[], all = false) {
    if (busy) return;
    setBusy("reminder");setNotice("");
    try {
      const result=await pushUpdateReminders(usernames,all);
      setNotice(`已为 ${result.queued.length} 个账号安排更新提醒；在线且支持此功能的客户端将在约 15 秒内收到弹窗，离线账号重新连接后接收。重复待处理提醒会合并。旧版客户端需先手动更新。`);
      setCheckedAccounts([]);
      try {const next=await getClientVersions();versionClock.current={server:next.generatedAtMs,received:performance.now()};setVersions(next);setVersionError("");} catch(reason) {setVersionError(String(reason));}
    } catch(reason) {setNotice(`推送失败：${String(reason)}`);}
    finally {setBusy("");}
  }
  const accountUsers=(versions?.users ?? []).filter(user=>!username || user.username===username);
  const eligibleAccounts=accountUsers.filter(user=>user.accountStatus==="active" && user.username!==currentUser.username);
  const checkedEligible=checkedAccounts.filter(name=>eligibleAccounts.some(user=>user.username===name));
  const navigationBusy = Boolean(busy) || Boolean(catalogOperation.current);
  return (
    <main className="review-supervision">
      <header className="review-supervision-header">
        <div>
          <ShieldCheck size={25} />
          <h1>{t("审核监管")}</h1>
        </div>
        <div className="review-supervision-actions">
          {onManagerHome && <button className="button button-secondary" type="button" disabled={navigationBusy} onClick={onManagerHome}>{t("D1 Manager 首页")}</button>}
          {tr(updateControls?.(Boolean(busy)))}
          <DataWorkspaceMore account={currentUser} onEdit={onEditProfile}>
            <div className="data-more-group">
              {onOpenShortcuts && <button type="button" onClick={onOpenShortcuts}><Keyboard size={17} />{t("快捷键设置")}</button>}
              <div className="data-guide-slot" />
              {onOpenReleaseHistory && <button type="button" onClick={onOpenReleaseHistory} aria-label={t("查看历史版本")}><BookOpenText size={17} />{t("历史版本")}</button>}
              <button className="supervision-workbench-trigger" type="button" onClick={() => void openCaptureWorkbench().catch(reason => setNotice(`审核总览打开失败：${String(reason)}`))}><Activity size={17} />{t("打开审核工作台")}</button>
            </div>
            <div className="data-more-group">
              {onTestMode && <button type="button" disabled={navigationBusy} onClick={onTestMode}><FlaskConical size={17} />{t("测试模式")}</button>}
              <button type="button" disabled={navigationBusy} onClick={() => void onLogout()}><LogOut size={17} />{t("退出登录")}</button>
            </div>
          </DataWorkspaceMore>
        </div>
      </header>
      <div id="app-update-notices" />
      {tr(syncNotice)}
      <nav className="review-supervision-nav" aria-label={t("审核监管视图")}>
        {tabs.filter(([id]) => id !== "writeback" || writebackOwner).map(([id, label]) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
            aria-current={view === id ? "page" : undefined}
            disabled={correctionsBusy || Boolean(actionBusy)} onClick={() => setView(id)}
          >
            {tr(label)}
          </button>
        ))}
      </nav>
      {view === "tasks" && <TaskCenter workspaceBusy={updateBusy} beginCloudOperation={beginCloudOperation} currentUser={{...currentUser, role:"admin"}} cloudCurrentUser={currentUser} onOpenCloudReview={onOpenCloudReview} onOpenOutboundReview={onOpenOutboundReview} />}
      <div className="review-supervision-filters" hidden={!isAuditView}>
        <label>
          {t("审核账号")}<select
            aria-label={t("审核账号筛选")}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          >
            <option value="">{t("全部账号")}</option>
            {data?.users.filter((user) => user.accountStatus !== "deleted" || (view === "sessions" && includeDeleted)).map((user) => (
              <option key={user.username} value={user.username}>
                {user.displayName} (@{user.username})
                {user.accountStatus === "deleted" ? t("（已删除）") : ""}
              </option>
            ))}
          </select>
        </label>
        {view === "sessions" && (
          <label className="review-deleted-toggle">
            <input
              type="checkbox"
              aria-label={t("包含已删除账号")}
              checked={includeDeleted}
              onChange={(event) => setIncludeDeleted(event.target.checked)}
            />
            {t("包含已删除账号")}</label>
        )}
        <label>
          {t("日期")}<input
            aria-label={t("审核日期")}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          {t("操作")}<select
            aria-label={t("操作筛选")}
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">{t("全部操作")}</option>
            {Object.entries(reviewActionLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {tr(label)}
              </option>
            ))}
          </select>
        </label>
        {tr(sessionId && (
          <button
            className="button button-secondary"
            onClick={() => setSessionId("")}
          >
            <XCircle size={15} />
            {t("清除条目筛选")}</button>
        ))}
        <div className="review-supervision-sync">
          <span className={error ? "sync-error" : ""}>
            {error ? t("同步失败") : loading ? t("同步中") : t("更新于 {0}", [tr(time(data?.generatedAtMs ?? null))])}
          </span>
          <button
            className="icon-button"
            aria-label={live ? t("暂停实时刷新") : t("恢复实时刷新")}
            title={live ? t("暂停实时刷新") : t("恢复实时刷新")}
            onClick={() => {
              setLive(!live);
              setBefore("");
              setPrevious([]);
            }}
          >
            {live ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button
            className="icon-button"
            title={t("刷新")}
            aria-label={t("刷新")}
            onClick={() => setRefreshId((id) => id + 1)}
            disabled={loading}
          >
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
        <button
          className="button button-secondary"
          disabled={Boolean(busy)}
          aria-label={t("导出审核事件")}
          title={t("导出审核事件")}
          onClick={() => void exportEvents()}
        >
          {busy === "export" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
          {t("导出审核事件")}</button>
      </div>
      {tr(isAuditView && error && (
        <p role="alert" className="review-audit-error">
          {data ? t("统计刷新失败，下面保留上次结果；") : t("统计尚未获取，数字暂不显示；")}{tr(error)}
        </p>
      ))}
      {tr(notice && <p role="status">{tr(notice)}</p>)}
      {view === "corrections" && <TextCorrectionsPanel onBusyChange={setCorrectionsBusy} />}
      {view === "overview" && (
        <>
          <section className="review-kpis">
            <div>
              <Activity />
              <span>
                {t("在线审核员")}<strong>{data ? totals.online : "—"}</strong>
              </span>
            </div>
            <div>
              <CheckCircle2 />
              <span>
                {t("通过操作")}<strong>{data ? totals.approved : "—"}</strong>
              </span>
            </div>
            <div>
              <XCircle />
              <span>
                {t("不通过操作")}<strong>{data ? totals.rejected : "—"}</strong>
              </span>
            </div>
            <div>
              <Activity />
              <span>
                {t("交互操作")}<strong>{data ? totals.operations : "—"}</strong>
              </span>
            </div>
          </section>
          <section className="review-decision-overview">
            <h2>{t("已通过 / 不通过总览")}</h2>
            <p>{t("选择数据根目录并扫描，以各条数据的 QC 和已保存人工裁剪结果为准。每条数据只计一次。")}</p>
            <div className="review-export-controls">
              <label className="review-source-path">{t("数据根目录")}<input aria-label={t("数据根目录")} placeholder={t("选择或输入本机 / 已挂载共享目录")} value={sourcePath} disabled={Boolean(busy)} onChange={(event) => { setSourcePath(event.target.value); setCatalog(null); setNotice(""); }} /></label>
              <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void chooseReviewSource()}>{t("选择路径")}</button>
              <button className="button button-primary" disabled={Boolean(busy) || !sourcePath.trim()} onClick={() => void scanReviewed()}>{busy === "reviewed-scan" ? t("正在扫描…") : t("扫描总览")}</button>
              <button className="button button-secondary" disabled={Boolean(busy) || !catalog?.approved || Boolean(catalog.rows.some((row) => row.status === "approved" && row.error))} onClick={() => void exportReviewed()}><Download size={16} />{t("导出通过数据")}</button>
              {(busy === "reviewed-scan" || busy === "reviewed-export") && <button className="button button-secondary" onClick={() => { if (catalogOperation.current) void cancelTask(catalogOperation.current); }}>{t("取消操作")}</button>}
            </div>
            {tr(catalogProgress && <p role="status" className="review-scan-progress">{tr(catalogProgress)}</p>)}
            {catalog && <>
              <p>{t("扫描目录：")}{tr(catalog.sourceRoot)}{" " + t("· 扫描时间：")}{tr(time(catalog.scannedAtMs))}</p>
              <div className="review-catalog-counts"><span>{t("全部") + " "}{catalog.rows.length}{" " + t("条")}</span><span>{t("通过") + " "}{catalog.approved}{" " + t("条")}</span><span>{t("不通过") + " "}{catalog.rejected}{" " + t("条")}</span><span>{t("待审核") + " "}{catalog.pending}{" " + t("条")}</span><span>{t("存在异常") + " "}{catalog.errors}{" " + t("条")}</span></div>
              <dl className="review-duration-totals"><div><dt>{t("原始数据总时长")}</dt><dd>{tr(seconds(catalog.originalSeconds))}</dd><small>{catalog.unknownOriginal}{" " + t("条时长未知，未计入")}</small></div><div><dt>{t("通过数据原始时长")}</dt><dd>{tr(seconds(catalog.approvedOriginalSeconds))}</dd><small>{catalog.rows.filter((row) => row.status === "approved" && row.originalSeconds === null).length}{" " + t("条时长未知，未计入")}</small></div><div><dt>{t("通过数据有效总时长")}</dt><dd>{tr(seconds(catalog.effectiveSeconds))}</dd><small>{catalog.unknownEffective}{" " + t("条无法核验，未计入")}</small></div></dl>
              <p>{t("有效时长按人工保留片段合并重叠后计算；导出保留完整源数据和人工裁剪记录。通过数据存在异常时，请处理后重新扫描。")}</p>
              <label>{t("数据状态")}<select aria-label={t("数据状态筛选")} value={catalogFilter} onChange={(event) => { setCatalogFilter(event.target.value); setCatalogPage(0); }}><option value="all">{t("全部数据")}</option><option value="approved">{t("通过")}</option><option value="rejected">{t("不通过")}</option><option value="pending">{t("待审核")}</option><option value="error">{t("存在异常")}</option></select></label>
              <div className="review-table-wrap"><table aria-label={t("数据扫描明细")}><thead><tr><th>{t("相对路径")}</th><th>{t("QC 结论")}</th><th>{t("审核人")}</th><th>{t("原始时长")}</th><th>{t("有效时长")}</th><th>{t("时长依据 / 异常")}</th></tr></thead><tbody>{catalogRows.slice(catalogPage * 50, catalogPage * 50 + 50).map((row) => <tr key={row.path}><td>{row.path}</td><td>{tr(row.qc) || t("待审核")}</td><td>{row.reviewer || "--"}</td><td>{tr(seconds(row.originalSeconds))}</td><td>{row.status === "approved" ? tr(seconds(row.effectiveSeconds)) : "--"}</td><td>{tr(row.error) || tr(row.timingSource)}</td></tr>)}</tbody></table></div>
              <div className="review-pagination"><button disabled={!catalogPage} onClick={() => setCatalogPage(catalogPage - 1)}>{t("上一页数据")}</button><span>{catalogRows.length}{" " + t("条 · 第") + " "}{catalogPage + 1}{" " + t("页")}</span><button disabled={(catalogPage + 1) * 50 >= catalogRows.length} onClick={() => setCatalogPage(catalogPage + 1)}>{t("下一页数据")}</button></div>
            </>}
          </section>
          <h2>{t("账号审核进度")}</h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("审核账号")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("通过 / 不通过")}</th>
                  <th>{t("平均加载至提交")}</th>
                  <th>{t("视频定位")}</th>
                  <th>{t("标签新增 / 删除")}</th>
                  <th>{t("最近操作")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => (
                  <tr key={user.username}>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => {
                          setUsername(user.username);
                          setView("events");
                        }}
                      >
                        {user.displayName}
                        <small>@{user.username}</small>
                      </button>
                    </td>
                    <td>
                      <span className={user.online ? "review-online" : ""}>
                        {user.accountStatus === "deleted" ? t("已删除") : user.online ? t("在线") : t("离线")}
                      </span>
                    </td>
                    <td>
                      {user.approved} / {user.rejected}
                      {user.completed !== undefined && <small>{t("当前完成") + " "}{user.completed}{" " + t("· 待写 NAS") + " "}{user.pendingNas ?? 0}</small>}
                    </td>
                    <td>{tr(duration(user.averageMs))}</td>
                    <td>{user.seeks}</td>
                    <td>
                      {user.labelsAdded} / {user.labelsDeleted}
                    </td>
                    <td>{tr(time(user.lastActivityAtMs))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view === "events" && (
        <>
          <h2>
            {t("交互时间线") + " "}<small>{data?.total ?? 0}{" " + t("条")}</small>
          </h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("发生时间")}</th>
                  <th>{t("审核账号")}</th>
                  <th>{t("数据条目")}</th>
                  <th>{t("操作")}</th>
                  <th>{t("距加载")}</th>
                  <th>{t("操作明细")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleEvents?.map((event) => (
                  <tr key={event.id}>
                    <td>{tr(time(event.occurredAtMs))}</td>
                    <td>
                      {event.displayName}
                      <small>@{event.username}</small>
                    </td>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => setSessionId(event.sessionId)}
                      >
                        {tr(event.episodeName)}
                      </button>
                    </td>
                    <td>{tr(reviewActionLabels[event.action])}</td>
                    <td>{tr(duration(event.elapsedMs))}</td>
                    <td>
                      <button
                        className="review-event-detail"
                        onClick={() => setSelected(event)}
                      >
                        {tr(eventDetails(event)) || t("查看记录")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="review-pagination">
            <button
              className="icon-button"
              title={t("上一页")}
              aria-label={t("上一页")}
              disabled={!previous.length}
              onClick={() => {
                setBefore(previous.at(-1)!);
                setPrevious(previous.slice(0, -1));
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <span>{previous.length + 1}</span>
            <button
              className="icon-button"
              title={t("更早记录")}
              aria-label={t("更早记录")}
              disabled={!data?.nextBefore}
              onClick={() => {
                setPrevious([...previous, before]);
                setBefore(String(data!.nextBefore));
              }}
            >
              <ChevronRight size={18} />
            </button>
          </footer>
        </>
      )}
      {view === "sessions" && (
        <>
          <h2>{t("逐条审核记录")}</h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("数据条目")}</th>
                  <th>{t("账号")}</th>
                  <th>{t("载入时间")}</th>
                  <th>{t("最近操作")}</th>
                  <th>{t("结论")}</th>
                  <th>{t("加载至提交")}</th>
                  <th>{t("交互次数")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions?.map((row) => (
                  <tr key={`${row.username}:${row.sessionId}`}>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => {
                          setSessionId(row.sessionId);
                          setView("events");
                        }}
                      >
                        {tr(row.episodeName)}
                      </button>
                    </td>
                    <td>@{row.username}</td>
                    <td>{tr(time(row.loadedAtMs))}</td>
                    <td>{tr(time(row.lastActivityAtMs))}</td>
                    <td>
                      {row.status === "approved" ? t("通过") : row.status === "rejected" ? t("不通过") : t("待审核")}
                    </td>
                    <td>{tr(duration(row.durationMs))}</td>
                    <td>{row.operations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view === "sessions" && (
        <footer className="review-pagination">
          <button
            className="icon-button"
            aria-label={t("上一页审核记录")}
            title={t("上一页审核记录")}
            disabled={!previous.length}
            onClick={() => {
              setBefore(previous.at(-1)!);
              setPrevious(previous.slice(0, -1));
            }}
          >
            <ChevronLeft size={18} />
          </button>
          <span>{previous.length + 1}</span>
          <button
            className="icon-button"
            aria-label={t("更早审核记录")}
            title={t("更早审核记录")}
            disabled={!data?.nextSessionBefore}
            onClick={() => {
              setPrevious([...previous, before]);
              setBefore(String(data!.nextSessionBefore));
            }}
          >
            <ChevronRight size={18} />
          </button>
        </footer>
      )}
      {view === "writeback" && writebackOwner && <SourceWritebackAdmin owner={writebackOwner} accounts={versions?.users ?? []} disabled={Boolean(busy)}/>}
      {view === "accounts" && (
        <>
          <h2>{t("审核账号")}</h2>
          <div className="version-push-toolbar">
            <label>{t("账号筛选")}<select aria-label={t("账号筛选")} value={username} onChange={event=>setUsername(event.target.value)}><option value="">{t("全部账号")}</option>{versions?.users.map(user=><option key={user.username} value={user.username}>{user.displayName} (@{user.username})</option>)}</select></label>
            <button className="button button-secondary" disabled={versionsLoading} onClick={()=>setRefreshId(value=>value+1)}>{versionsLoading ? t("刷新中…") : t("刷新账号与版本")}</button>
            <span>{versions ? t("版本信息更新于 {0}", [tr(time(versions.generatedAtMs))]) : versionsLoading ? t("正在读取账号与版本…") : t("账号与版本尚未读取")}</span>
          </div>
          <div className="version-push-toolbar">
            <button className="button button-secondary" disabled={Boolean(busy) || !(versions?.users ?? []).some(user=>user.accountStatus==="active" && user.username!==currentUser.username)} onClick={()=>void remind([],true)}>{t("一键推送更新提醒")}</button>
            <button className="button button-secondary" disabled={Boolean(busy) || !checkedEligible.length} onClick={()=>void remind(checkedEligible)}>{t("推送选中（")}{checkedEligible.length}）</button>
            <span>{t("每 15 秒刷新 · 超过 90 秒未上报显示离线 · 提醒保留 7 天")}</span>
          </div>
          <p className="version-help">{t("每人显示一个已确认在线的版本，多设备及上报时间见“版本日志”。版本未确认不代表未工作：审核记录与版本上报独立；1.3.3 之前的客户端需先手动更新。")}</p>
          {tr(versionError && <p role="alert" className="version-error">{t("版本状态暂不可刷新，下面保留最近记录，当前在线状态未知：")}{tr(versionError)}</p>)}
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label={t("全选当前账号")} checked={eligibleAccounts.length>0 && checkedEligible.length===eligibleAccounts.length} onChange={event=>setCheckedAccounts(event.target.checked?eligibleAccounts.map(user=>user.username):[])} /></th>
                  <th>{t("账号")}</th>
                  <th>{t("姓名")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("当前软件版本")}</th>
                  <th>{t("更新提醒")}</th>
                  <th>{t("账号管理")}</th>
                </tr>
              </thead>
              <tbody>
                {accountUsers.map((user) => {
                  const clientState = currentClientVersion(user.clients, versions?.generatedAtMs ?? 0,versionNow);
                  return (
                  <tr key={user.username}>
                    <td><input type="checkbox" aria-label={t("选择账号 @{0}", [user.username])} disabled={!eligibleAccounts.some(item=>item.username===user.username)} checked={checkedEligible.includes(user.username)} onChange={event=>setCheckedAccounts(previous=>event.target.checked?[...new Set([...previous,user.username])]:previous.filter(name=>name!==user.username))} /></td>
                    <td>@{user.username}</td>
                    <td>{user.displayName}</td>
                    <td>{user.accountStatus === "active" ? t("启用") : t("暂停")}</td>
                    <td className="account-version-cell">
                      <div>{!versionError && clientState.current ? <><strong>v{clientState.current.version}</strong><span className="account-platform">{tr(clientState.current.platform)}</span></> : <span>{t("当前版本未确认 ·") + " "}{versionError ? t("连接异常") : user.clients.length ? t("设备未在线") : t("尚未收到上报")}</span>}</div>
                      {!versionError && clientState.otherVersions > 0 && <small>{t("另有") + " "}{clientState.otherVersions}{" " + t("个在线版本")}</small>}
                      <button className="text-button account-version-log" onClick={() => setVersionLogAccount(user.username)} aria-label={t("版本日志 @{0}", [user.username])}>{t("版本日志")}</button>
                    </td>
                    <td><button className="button button-secondary" disabled={Boolean(busy) || user.accountStatus!=="active" || user.username===currentUser.username} onClick={()=>void remind([user.username])}>{t("推送更新提醒")}</button>
                      {versions?.users.find(item=>item.username===user.username)?.pendingReminder && <small>{t("提醒待处理 / 等待客户端确认")}</small>}</td>
                    <td><div className="review-account-actions">
                      <button
                        className="button button-secondary"
                        disabled={Boolean(busy) || user.canManage}
                        onClick={() =>
                          void setAccountStatus(
                            user.username,
                            user.accountStatus === "active"
                              ? "paused"
                              : "active",
                          )
                        }
                      >
                        {user.accountStatus === "active" ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {user.accountStatus === "active" ? t("暂停账号") : t("启用账号")}
                      </button>
                      <button className="icon-button review-delete-account" title={t("删除账号")}
                        aria-label={t("删除账号 @{0}", [user.username])} disabled={Boolean(busy) || user.canManage}
                        onClick={() => { setDeleteError(""); setDeleteTarget(user); }}>
                        <Trash2 size={17} />
                      </button>
                    </div>
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          </div>
          <form
            className="review-account-form"
            onSubmit={(event) => void createAccount(event)}
          >
            <h2>{t("新建审核账号")}</h2>
            <label>
              {t("账号")}<input
                required
                minLength={3}
                maxLength={32}
                autoComplete="off"
                value={account.username}
                onChange={(event) =>
                  setAccount({ ...account, username: event.target.value })
                }
              />
            </label>
            <label>
              {t("姓名")}<input
                required
                maxLength={40}
                value={account.displayName}
                onChange={(event) =>
                  setAccount({ ...account, displayName: event.target.value })
                }
              />
            </label>
            <label>
              {t("初始密码")}<input
                required
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={account.password}
                onChange={(event) =>
                  setAccount({ ...account, password: event.target.value })
                }
              />
            </label>
            <button className="button button-primary" disabled={Boolean(busy)}>
              <UserPlus size={16} />
              {t("创建账号")}</button>
          </form>
        </>
      )}
      {!loading && !visibleEvents?.length && ["overview", "events", "sessions"].includes(view) && (
        <p className="review-empty">{t("暂无符合条件的审核操作")}</p>
      )}
      {tr(versionLogAccount && <dialog ref={versionLogDialog} className="account-version-dialog" aria-labelledby="account-version-log-title"
        onCancel={() => setVersionLogAccount(null)} onClick={event => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setVersionLogAccount(null);
        }}>
        <header><div><h2 id="account-version-log-title">{t("版本日志")}</h2><p>@{tr(versionLogAccount)}{" " + t("· 设备最近上报记录")}</p></div>
          <button autoFocus className="icon-button" aria-label={t("关闭版本日志")} onClick={() => setVersionLogAccount(null)}><X size={18} /></button></header>
        <div className="account-version-log-body">
          <p>{t("仅展示服务端保留的设备上报，不是完整升级历史。审核活动不包含软件版本，不能用审核统计推测版本或将未上报判为未工作。")}</p>
          {tr(versionError && <p role="alert">{t("查询失败，以下为缓存记录，在线状态未知：")}{tr(versionError)}</p>)}
          {(versions?.users.find(user => user.username === versionLogAccount)?.clients ?? []).length ? [...versions!.users.find(user => user.username === versionLogAccount)!.clients].sort((a,b) => b.lastSeenAtMs-a.lastSeenAtMs).map(client => <article key={client.clientId}>
              <strong>v{client.version}</strong><span>{tr(client.platform)} · {versionError ? t("状态未知") : currentClientVersion([client], versions!.generatedAtMs,versionNow).current ? t("在线") : t("离线 / 历史上报")}</span>
              <time>{tr(time(client.lastSeenAtMs))}</time>
            </article>) : <p>{t("暂无版本上报。可能使用早于 1.3.3 的客户端，或版本上报连接尚未成功；具体原因需核对该电脑。旧客户端需先手动安装新版，之后才能接收推送。")}</p>}
        </div>
      </dialog>)}
      {deleteTarget && <dialog ref={deleteDialog} className="review-delete-dialog" aria-labelledby="delete-account-title"
        onCancel={(event) => { event.preventDefault(); if (!busy) setDeleteTarget(null); }}>
        <h2 id="delete-account-title">{t("删除审核账号")}</h2>
        <p>{deleteTarget.displayName} (@{deleteTarget.username})</p>
        <p>{t("账号将无法登录，当前会话立即注销。历史审核记录保留，账号名不可再次注册。删除后不可恢复。")}</p>
        {tr(deleteError && <p role="alert" className="review-audit-error">{tr(deleteError)}</p>)}
        <footer>
          <button autoFocus className="button button-secondary" disabled={Boolean(busy)} onClick={() => setDeleteTarget(null)}>{t("取消")}</button>
          <button className="button review-delete-confirm" disabled={Boolean(busy)} onClick={() => void deleteAccount()}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{t("确认删除")}</button>
        </footer>
      </dialog>}
      {selected && (
        <div
          className="review-dialog-backdrop"
          onClick={() => setSelected(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("审核操作明细")}
            className="review-detail-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{tr(reviewActionLabels[selected.action])}</h2>
              <button
                className="icon-button"
                title={t("关闭明细")}
                aria-label={t("关闭明细")}
                onClick={() => setSelected(null)}
              >
                <XCircle size={18} />
              </button>
            </header>
            <p>
              {selected.displayName} (@{selected.username}) ·{" "}
              {tr(selected.episodeName)}
            </p>
            <dl>
              <dt>{t("发生时间")}</dt>
              <dd>{tr(time(selected.occurredAtMs))}</dd>
              <dt>{t("接收时间")}</dt>
              <dd>{tr(time(selected.receivedAtMs))}</dd>
              <dt>{t("事件 ID")}</dt>
              <dd>{tr(selected.eventId)}</dd>
              {Object.entries(selected.details).map(([key, value]) => (
                <div key={key}>
                  <dt>{tr(detailNames[key]) ?? tr(key)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </main>
  );
}
