import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, BarChart3, Check, CheckCircle2, ClipboardCheck, Download,
  FileJson, FileUp, FolderOpen, Gauge, GripVertical, LoaderCircle, LogOut,
  PauseCircle, PlayCircle, RefreshCw, Search, ShieldCheck, Siren, TimerReset,
  Users, X,
} from "lucide-react";
import {
  chooseAndScanSupervisionTasks, confirmAction, createQualityReview,
  getSupervisionDashboard, importSupervisionAnnotations, importSupervisionTaskDetails,
  setSupervisionAssignedTasks, transferSupervisionAssignment, updateOperationsAlert,
} from "../lib/backend";
import { csvCell, distributeBySpeed, distributeEvenly } from "../lib/operationsCockpit";
import { assignmentConflicts, defaultAssignmentQuantity, validateAssignmentSelection } from "../lib/supervisionAssignments";
import type {
  AssignmentPlan, AssignmentPriority, OperationsAlertStatus, QualityReviewRequest,
  SupervisionAnnotationCatalog, SupervisionDashboardData, SupervisionTaskCatalog,
  SupervisionUserSummary, UserIdentity,
} from "../types";

interface Props { currentUser: UserIdentity; onLogout: () => Promise<void> }
type View = "overview" | "assignment" | "alerts" | "quality" | "reports";

const NAVIGATION: { id: View; label: string }[] = [
  { id: "overview", label: "监管总览" },
  { id: "assignment", label: "任务分配" },
  { id: "alerts", label: "异常中心" },
  { id: "quality", label: "质量管理" },
  { id: "reports", label: "报表" },
];

export function SupervisionDashboard({ currentUser, onLogout }: Props) {
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<SupervisionDashboardData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AssignmentPlan[]>>({});
  const [selectedOperator, setSelectedOperator] = useState<string | null>(null);
  const [taskCatalog, setTaskCatalog] = useState<SupervisionTaskCatalog | null>(null);
  const [importedTasks, setImportedTasks] = useState<string[]>([]);
  const [annotations, setAnnotations] = useState<SupervisionAnnotationCatalog | null>(null);
  const [taskSearch, setTaskSearch] = useState("");
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [alertNotes, setAlertNotes] = useState<Record<string, string>>({});
  const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});
  const [batchTask, setBatchTask] = useState("");
  const [batchQuantity, setBatchQuantity] = useState(20);
  const [batchPriority, setBatchPriority] = useState<AssignmentPriority>("normal");
  const [batchDeadline, setBatchDeadline] = useState("");
  const [batchMode, setBatchMode] = useState<"even" | "speed">("even");
  const [batchUsers, setBatchUsers] = useState<string[]>([]);
  const [review, setReview] = useState<QualityReviewRequest>({ taskId: "", trajectoryCode: "", outcome: "passed", errorType: "", note: "" });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getSupervisionDashboard();
      setData(next);
      setDrafts(Object.fromEntries(next.users.map((user) => [user.username, plansFor(user)])));
      const operators = next.users.filter((user) => user.role === "operator");
      setSelectedOperator((current) => current && operators.some((user) => user.username === current) ? current : operators[0]?.username ?? null);
      setBatchUsers((current) => current.length ? current.filter((name) => operators.some((user) => user.username === name)) : operators.map((user) => user.username));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const operators = data?.users.filter((user) => user.role === "operator") ?? [];
  const availableTasks = useMemo(() => [...new Map([
    ...(taskCatalog?.tasks.map((task) => task.task) ?? []),
    ...importedTasks,
    ...(data?.users.flatMap((user) => user.assignedTaskNames) ?? []),
  ].map((task) => [task.toLowerCase(), task])).values()], [data, importedTasks, taskCatalog]);
  const selectedUser = operators.find((user) => user.username === selectedOperator) ?? null;
  const selectedPlans = selectedUser ? drafts[selectedUser.username] ?? [] : [];
  const batchSelected = operators.filter((user) => batchUsers.includes(user.username));
  const batchPreview = batchMode === "speed"
    ? distributeBySpeed(batchQuantity, batchSelected)
    : distributeEvenly(batchQuantity, batchSelected.map((user) => user.username));

  async function savePlans(username: string, plans: AssignmentPlan[]) {
    const normalized = plans.map((plan, order) => ({ ...plan, order }));
    const quantities = Object.fromEntries(normalized.map((plan) => [plan.task, plan.quantity]));
    const validation = validateAssignmentSelection(quantities, taskCatalog?.tasks ?? [], availableTasks);
    if (validation) throw new Error(validation);
    const saved = await setSupervisionAssignedTasks(username, quantities, normalized);
    setDrafts((current) => ({ ...current, [username]: saved.assignmentPlans }));
    setData((current) => current ? {
      ...current,
      users: current.users.map((user) => user.username === username ? {
        ...user, assignedTasks: saved.assignedTasks, assignedTaskNames: saved.assignedTaskNames,
        assignedTaskQuantities: saved.assignedTaskQuantities, assignmentPlans: saved.assignmentPlans,
      } : user),
      accounts: current.accounts.map((account) => account.username === username ? saved : account),
    } : current);
    return saved;
  }

  async function saveAssignment(username: string) {
    const plans = drafts[username] ?? [];
    const conflicts = assignmentConflicts(username, Object.fromEntries(plans.map((plan) => [plan.task, plan.quantity])), data?.users ?? []);
    if (conflicts.length && !await confirmAction(
      `以下任务也分配给其他账号，系统会重新计算不重叠区间：\n\n${conflicts.map((item) => `${item.task}：${item.assignees.join("、")}`).join("\n")}\n\n是否继续？`,
      "确认分配区间",
    )) return;
    setBusy(`save:${username}`);
    setError("");
    try {
      const saved = await savePlans(username, plans);
      setNotice(`已保存 @${username} 的 ${saved.assignmentPlans.length} 类任务，共 ${saved.assignedTasks} 条`);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  function toggleTask(username: string, task: string) {
    setDrafts((current) => {
      const plans = current[username] ?? [];
      const exists = plans.some((plan) => plan.task.toLowerCase() === task.toLowerCase());
      const next = exists ? plans.filter((plan) => plan.task.toLowerCase() !== task.toLowerCase()) : [...plans, {
        task, quantity: defaultAssignmentQuantity(task, taskCatalog?.tasks ?? []), startIndex: 0,
        priority: "normal" as const, deadlineAtMs: null, status: "active" as const, order: plans.length,
      }];
      return { ...current, [username]: next.map((plan, order) => ({ ...plan, order })) };
    });
  }

  function updatePlan(username: string, task: string, changes: Partial<AssignmentPlan>) {
    setDrafts((current) => ({ ...current, [username]: (current[username] ?? []).map((plan) => plan.task === task ? { ...plan, ...changes } : plan) }));
  }

  function reorderPlan(username: string, target: string) {
    if (!draggedTask || draggedTask === target) return;
    setDrafts((current) => {
      const plans = [...(current[username] ?? [])];
      const from = plans.findIndex((plan) => plan.task === draggedTask);
      const to = plans.findIndex((plan) => plan.task === target);
      if (from < 0 || to < 0) return current;
      const [moved] = plans.splice(from, 1);
      plans.splice(to, 0, moved);
      return { ...current, [username]: plans.map((plan, order) => ({ ...plan, order })) };
    });
    setDraggedTask(null);
  }

  async function applyBatch() {
    if (!batchTask || !batchSelected.length) return setError("请选择任务和标注员");
    const preview = batchPreview.map((share) => {
      const old = drafts[share.username]?.find((plan) => plan.task.toLowerCase() === batchTask.toLowerCase())?.quantity ?? 0;
      return `@${share.username}：${old} → ${share.quantity}（${signed(share.quantity - old)}）`;
    }).join("\n");
    if (!await confirmAction(`批量操作预览：\n\n${preview}\n\n用户中心将生成不重叠区间。是否确认？`, "确认批量分配")) return;
    setBusy("batch");
    setError("");
    try {
      const deadlineAtMs = batchDeadline ? new Date(batchDeadline).getTime() : null;
      for (const share of batchPreview) {
        if (!share.quantity) continue;
        const current = drafts[share.username] ?? [];
        const exists = current.some((plan) => plan.task.toLowerCase() === batchTask.toLowerCase());
        const next = exists ? current.map((plan) => plan.task.toLowerCase() === batchTask.toLowerCase()
          ? { ...plan, quantity: share.quantity, priority: batchPriority, deadlineAtMs } : plan)
          : [...current, { task: batchTask, quantity: share.quantity, startIndex: 0, priority: batchPriority, deadlineAtMs, status: "active" as const, order: current.length }];
        await savePlans(share.username, next);
      }
      await refresh();
      setNotice(`已按${batchMode === "speed" ? "历史速度建议" : "平均"}方案分配 ${batchQuantity} 条 ${batchTask}`);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function scanTasks() {
    setBusy("scan"); setError("");
    try {
      const catalog = await chooseAndScanSupervisionTasks();
      if (catalog) { setTaskCatalog(catalog); setBatchTask((current) => current || catalog.tasks[0]?.task || ""); setNotice(`已在本机读取 ${catalog.tasks.length} 类任务`); }
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function importTasks() {
    setBusy("tasks"); setError("");
    try {
      const result = await importSupervisionTaskDetails();
      if (result) { setImportedTasks(result.importedTaskNames); setData((current) => current ? { ...current, taskDetails: result.taskDetails } : current); setBatchTask((current) => current || result.importedTaskNames[0] || ""); setNotice(`已读取 ${result.importedTaskNames.length} 项任务定义`); }
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function importAnnotations() {
    setBusy("annotations"); setError("");
    try {
      const catalog = await importSupervisionAnnotations();
      if (catalog) { setAnnotations(catalog); setNotice(`已在本机汇总 ${catalog.users.length} 位标注员的片段与帧`); }
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function handleAlert(alertId: string, status: OperationsAlertStatus) {
    setBusy(`alert:${alertId}`); setError("");
    try { await updateOperationsAlert(alertId, status, alertNotes[alertId] ?? ""); await refresh(); setNotice(status === "closed" ? "预警已关闭" : "预警已确认"); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function transferTask(fromUsername: string, task: string) {
    const key = `${fromUsername}:${task}`;
    const toUsername = transferTargets[key];
    if (!toUsername) return setError("请选择任务转入账号");
    if (!await confirmAction(`将 ${task} 的完整分配从 @${fromUsername} 转移给 @${toUsername}。该操作会原子更新两个账号，是否继续？`, "确认转移任务")) return;
    setBusy(`transfer:${key}`); setError("");
    try { await transferSupervisionAssignment(fromUsername, toUsername, task); await refresh(); setNotice(`已将 ${task} 转移给 @${toUsername}`); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function saveReview() {
    setBusy("review"); setError("");
    try { await createQualityReview(review); await refresh(); setReview({ taskId: "", trajectoryCode: "", outcome: "passed", errorType: "", note: "" }); setNotice("独立复核结果已保存"); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  function exportReport(format: "json" | "csv") {
    if (!data) return;
    const content = format === "json" ? `${JSON.stringify(safeReport(data, annotations), null, 2)}\n` : reportCsv(data);
    downloadText(`dohc-operations-${dateKey(data.generatedAtMs)}.${format}`, content, format === "json" ? "application/json" : "text/csv");
    setNotice(`已生成 ${format.toUpperCase()} 报表，不包含源路径、图像或原始数据`);
  }

  return <main className="supervision-shell operations-cockpit">
    <header className="supervision-header"><div className="brand-lockup"><span className="brand-mark">D</span><div><strong>DOHC Viewer</strong><span>任务运营驾驶舱</span></div></div><div className="supervision-account"><ShieldCheck size={17} /><span><strong>{currentUser.displayName}</strong><small>@{currentUser.username} · 监管账户</small></span><button className="icon-button" type="button" onClick={() => void onLogout()} title="退出"><LogOut size={16} /></button></div></header>
    <section className="supervision-content">
      <div className="supervision-title"><div><span className="section-kicker">OPERATIONS COCKPIT</span><h1>任务运营驾驶舱</h1><p>谁在做什么、进度如何、哪里可能卡住，以及下一步如何调整。</p></div><button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : undefined} size={16} />刷新</button></div>
      <div className="cockpit-statusbar"><span className={data ? "connected" : "disconnected"}><i />用户中心：{data ? "已连接" : "未连接"}</span><span>数据更新：{data ? formatTime(data.generatedAtMs) : "—"}</span><span>片段/帧：{annotations ? "本机标注 JSON" : "待本机导入"}</span></div>
      <nav className="cockpit-nav">{NAVIGATION.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} type="button" onClick={() => setView(item.id)}>{item.label}{item.id === "alerts" && data?.alerts.some((alert) => alert.status !== "closed") ? <b>{data.alerts.filter((alert) => alert.status !== "closed").length}</b> : null}</button>)}</nav>
      {error ? <div className="auth-error supervision-feedback" role="alert">{error}</div> : null}
      {notice ? <div className="supervision-notice" role="status"><Check size={15} />{notice}<button className="icon-button" type="button" onClick={() => setNotice("")}><X size={14} /></button></div> : null}
      {loading && !data ? <div className="supervision-loading"><LoaderCircle className="spin" size={22} />正在聚合运营数据</div> : null}
      {data && view === "overview" ? <Overview data={data} annotations={annotations} onImport={() => void importAnnotations()} importing={busy === "annotations"} /> : null}
      {data && view === "assignment" ? <Assignment data={data} operators={operators} availableTasks={availableTasks} selectedUser={selectedUser} selectedPlans={selectedPlans} drafts={drafts} taskCatalog={taskCatalog} taskSearch={taskSearch} setTaskSearch={setTaskSearch} setSelectedOperator={setSelectedOperator} toggleTask={toggleTask} updatePlan={updatePlan} reorderPlan={reorderPlan} setDraggedTask={setDraggedTask} saveAssignment={saveAssignment} busy={busy} batchTask={batchTask} setBatchTask={setBatchTask} batchQuantity={batchQuantity} setBatchQuantity={setBatchQuantity} batchPriority={batchPriority} setBatchPriority={setBatchPriority} batchDeadline={batchDeadline} setBatchDeadline={setBatchDeadline} batchMode={batchMode} setBatchMode={setBatchMode} batchUsers={batchUsers} setBatchUsers={setBatchUsers} batchPreview={batchPreview} applyBatch={applyBatch} scanTasks={scanTasks} importTasks={importTasks} transferTargets={transferTargets} setTransferTargets={setTransferTargets} transferTask={transferTask} /> : null}
      {data && view === "alerts" ? <Alerts data={data} notes={alertNotes} setNotes={setAlertNotes} busy={busy} handle={handleAlert} adjust={(username) => { setSelectedOperator(username); setView("assignment"); }} /> : null}
      {data && view === "quality" ? <Quality data={data} annotations={annotations} review={review} setReview={setReview} importAnnotations={importAnnotations} busy={busy} saveReview={saveReview} /> : null}
      {data && view === "reports" ? <Reports data={data} annotations={annotations} json={() => exportReport("json")} csv={() => exportReport("csv")} print={() => printReport(data)} /> : null}
    </section>
  </main>;
}

function Overview({ data, annotations, onImport, importing }: { data: SupervisionDashboardData; annotations: SupervisionAnnotationCatalog | null; onImport: () => void; importing: boolean }) {
  const local = annotationTotals(annotations);
  const max = Math.max(1, ...data.hourlyTrend.map((row) => row.completed));
  const peak = data.hourlyTrend.reduce((best, row) => row.completed > best.completed ? row : best, data.hourlyTrend[0]);
  const active = data.hourlyTrend.filter((row) => row.completed);
  const low = active.reduce((best, row) => row.completed < best.completed ? row : best, active[0] ?? data.hourlyTrend[0]);
  return <>
    <section className="cockpit-kpis"><Metric icon={<CheckCircle2 />} label="今日完成" value={data.overview.completedToday} hint="episode" /><Metric icon={<Gauge />} label="累计完成" value={data.overview.totalCompleted} hint="episode" /><Metric icon={<TimerReset />} label="当前剩余" value={data.overview.remaining} hint={`已分配 ${data.overview.assigned}`} /><Metric icon={<Users />} label="活跃标注员" value={data.overview.activeOperators} hint={`${data.overview.possibleStagnation} 人可能停滞`} /><Metric icon={<ClipboardCheck />} label="片段数" value={local.segments} hint={annotations ? "本机汇总" : "待导入"} /><Metric icon={<BarChart3 />} label="覆盖帧数" value={local.frames} hint={`${local.episodes} episodes`} /></section>
    <div className="cockpit-grid two-columns"><section className="supervision-section trend-panel"><div className="supervision-section-heading"><div><span className="section-kicker">TODAY TREND</span><h2>今日每小时完成量</h2></div><small>峰值 {peak?.hour ?? 0}:00 · {peak?.completed ?? 0} 条<br />低效 {low?.hour ?? 0}:00 · {low?.completed ?? 0} 条</small></div><div className="hourly-chart">{data.hourlyTrend.map((row) => <div key={row.hour} title={`${row.hour}:00 · ${row.completed} 条`}><span style={{ height: `${Math.max(row.completed ? 8 : 1, row.completed / max * 100)}%` }} /><small>{row.hour % 3 === 0 ? row.hour : ""}</small></div>)}</div></section><section className="supervision-section local-metrics"><div className="supervision-section-heading"><div><span className="section-kicker">LOCAL DETAIL</span><h2>片段与帧明细</h2></div><button className="button button-secondary" type="button" onClick={onImport} disabled={importing}><FileJson size={15} />{importing ? "读取中" : "导入标注 JSON"}</button></div><p>片段与帧不上传用户中心，只从当前管理员电脑选择的 JSON 汇总。</p><div><span><strong>{formatCount(local.episodes)}</strong>episode</span><span><strong>{formatCount(local.segments)}</strong>片段</span><span><strong>{formatCount(local.frames)}</strong>帧</span></div></section></div>
    <section className="supervision-section"><Heading kicker="TASK TYPES" title="按任务类型" note="分配、完成、未完成与平均耗时" /><div className="supervision-table-wrap"><table><thead><tr><th>任务类型</th><th>分配</th><th>今日</th><th>累计</th><th>未完成</th><th>episode / 片段 / 帧</th><th>平均耗时</th><th>人数</th></tr></thead><tbody>{data.taskSummaries.map((task) => { const detail = localTask(annotations, task.task); return <tr key={task.task}><td><strong>{task.task}</strong></td><td>{task.assigned}</td><td>{task.completedToday}</td><td>{task.totalCompleted}</td><td>{task.remaining}</td><td>{detail ? `${detail.episodes} / ${detail.segments} / ${formatCount(detail.frames)}` : "—"}</td><td>{formatDuration(task.averageCompletionMs)}</td><td>{task.operatorCount}</td></tr>; })}</tbody></table></div></section>
    <section className="supervision-section"><Heading kicker="WHO IS DOING WHAT" title="按账号查看进度与速度" note="可能停滞仅作提醒，不直接判定异常" /><div className="supervision-table-wrap"><table><thead><tr><th>账号</th><th>当前任务</th><th>今日 / 累计</th><th>剩余</th><th>速度</th><th>平均耗时</th><th>最近活跃</th><th>预计完成</th><th>状态</th></tr></thead><tbody>{data.users.filter((user) => user.role === "operator").map((user) => <tr key={user.username}><td><strong>{user.displayName}</strong><small>@{user.username}</small></td><td>{user.assignmentPlans.filter((plan) => plan.status === "active").map((plan) => plan.task).join("、") || "—"}</td><td>{user.completedToday} / {user.totalCompleted}</td><td>{user.remainingTasks}</td><td>{user.completionRatePerHour} 条/小时</td><td>{formatDuration(user.averageCompletionMs)}</td><td>{formatTime(user.lastActivityAtMs ?? user.lastLoginAtMs)}</td><td>{formatTime(user.estimatedCompletionAtMs)}</td><td>{user.possibleStagnation ? <span className="status-pill warning"><Siren size={13} />可能停滞</span> : <span className="status-pill"><Check size={13} />正常</span>}</td></tr>)}</tbody></table></div></section>
  </>;
}

type AssignmentProps = {
  data: SupervisionDashboardData; operators: SupervisionUserSummary[]; availableTasks: string[];
  selectedUser: SupervisionUserSummary | null; selectedPlans: AssignmentPlan[]; drafts: Record<string, AssignmentPlan[]>;
  taskCatalog: SupervisionTaskCatalog | null; taskSearch: string; setTaskSearch: (value: string) => void;
  setSelectedOperator: (value: string) => void; toggleTask: (username: string, task: string) => void;
  updatePlan: (username: string, task: string, changes: Partial<AssignmentPlan>) => void;
  reorderPlan: (username: string, task: string) => void; setDraggedTask: (value: string) => void;
  saveAssignment: (username: string) => Promise<void>; busy: string;
  batchTask: string; setBatchTask: (value: string) => void; batchQuantity: number; setBatchQuantity: (value: number) => void;
  batchPriority: AssignmentPriority; setBatchPriority: (value: AssignmentPriority) => void;
  batchDeadline: string; setBatchDeadline: (value: string) => void; batchMode: "even" | "speed"; setBatchMode: (value: "even" | "speed") => void;
  batchUsers: string[]; setBatchUsers: (value: string[]) => void; batchPreview: { username: string; quantity: number }[];
  applyBatch: () => Promise<void>; scanTasks: () => Promise<void>; importTasks: () => Promise<void>;
  transferTargets: Record<string, string>; setTransferTargets: (value: Record<string, string>) => void;
  transferTask: (fromUsername: string, task: string) => Promise<void>;
};

function Assignment(props: AssignmentProps) {
  const filtered = props.availableTasks.filter((task) => task.toLowerCase().includes(props.taskSearch.toLowerCase()));
  return <>
    <section className="supervision-section cockpit-tools"><div><span className="section-kicker">TASK SOURCES</span><h2>任务来源与容量</h2><small>目录仅在本机只读统计，用户中心不接收 NAS 路径。</small></div><div><button className="button button-secondary" type="button" onClick={() => void props.importTasks()}><FileUp size={15} />导入任务 JSON</button><button className="button button-secondary" type="button" onClick={() => void props.scanTasks()}><FolderOpen size={15} />读取任务目录</button></div></section>
    <section className="supervision-section batch-assignment"><Heading kicker="BATCH PREVIEW" title="批量平均 / 速度建议分配" /><div className="batch-controls"><label>任务<select value={props.batchTask} onChange={(event) => props.setBatchTask(event.target.value)}><option value="">请选择</option>{props.availableTasks.map((task) => <option key={task}>{task}</option>)}</select></label><label>总数量<input type="number" min={1} value={props.batchQuantity} onChange={(event) => props.setBatchQuantity(Math.max(1, Number(event.target.value) || 1))} /></label><label>优先级<select value={props.batchPriority} onChange={(event) => props.setBatchPriority(event.target.value as AssignmentPriority)}><option value="normal">普通</option><option value="urgent">紧急</option><option value="rework">返工</option></select></label><label>截止时间<input type="datetime-local" value={props.batchDeadline} onChange={(event) => props.setBatchDeadline(event.target.value)} /></label><label>策略<select value={props.batchMode} onChange={(event) => props.setBatchMode(event.target.value as "even" | "speed")}><option value="even">一键平均</option><option value="speed">按历史速度建议</option></select></label></div><div className="batch-user-picker">{props.operators.map((user) => <label key={user.username}><input type="checkbox" checked={props.batchUsers.includes(user.username)} onChange={() => props.setBatchUsers(props.batchUsers.includes(user.username) ? props.batchUsers.filter((name) => name !== user.username) : [...props.batchUsers, user.username])} /><span>{user.displayName}<small>@{user.username} · {user.completionRatePerHour} 条/小时</small></span></label>)}</div><div className="batch-preview"><strong>操作预览</strong>{props.batchPreview.map((share) => { const old = props.drafts[share.username]?.find((plan) => plan.task.toLowerCase() === props.batchTask.toLowerCase())?.quantity ?? 0; return <span key={share.username}>@{share.username}<b>{old} → {share.quantity}</b><small>{signed(share.quantity - old)} 条</small></span>; })}<button className="button button-primary" type="button" onClick={() => void props.applyBatch()} disabled={!props.batchTask || props.busy === "batch"}>{props.busy === "batch" ? "应用中" : "确认批量分配"}</button></div></section>
    <section className="supervision-section assignment-workbench"><Heading kicker="ASSIGNMENT QUEUE" title="账号任务队列" note="拖拽排序；支持暂停、追加、减少、转移、优先级与截止时间" /><div className="assignment-layout"><aside className="operator-list"><header><Users size={15} /><strong>标注员</strong><span>{props.operators.length}</span></header>{props.operators.map((user) => <button key={user.username} className={props.selectedUser?.username === user.username ? "active" : ""} type="button" onClick={() => props.setSelectedOperator(user.username)}><span><strong>{user.displayName}</strong><small>@{user.username}</small></span><b>{props.drafts[user.username]?.length ?? 0}</b></button>)}</aside><div className="assignment-task-picker">{props.selectedUser ? <><header className="assignment-picker-header"><div><strong>{props.selectedUser.displayName} 的队列</strong><span>剩余 {props.selectedUser.remainingTasks} 条 · 预计 {formatTime(props.selectedUser.estimatedCompletionAtMs)}</span></div><button className="button button-primary" type="button" onClick={() => void props.saveAssignment(props.selectedUser!.username)} disabled={props.busy === `save:${props.selectedUser.username}`}>保存队列</button></header><div className="assignment-toolbar"><label><Search size={14} /><input value={props.taskSearch} onChange={(event) => props.setTaskSearch(event.target.value)} placeholder="搜索任务" /></label></div><div className="assignment-plan-list">{props.selectedPlans.map((plan) => { const transferKey = `${props.selectedUser!.username}:${plan.task}`; return <div key={plan.task} className={`assignment-plan-row priority-${plan.priority}${plan.status === "paused" ? " paused" : ""}`} draggable onDragStart={() => props.setDraggedTask(plan.task)} onDragOver={(event) => event.preventDefault()} onDrop={() => props.reorderPlan(props.selectedUser!.username, plan.task)}><GripVertical size={16} /><div><strong>{plan.task}</strong><small>区间 {plan.startIndex + 1}–{plan.startIndex + plan.quantity}</small></div><label>数量<input type="number" min={1} max={taskMaximum(plan.task, props.taskCatalog) ?? 1_000_000} value={plan.quantity} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { quantity: Math.max(1, Number(event.target.value) || 1) })} /></label><label>优先级<select value={plan.priority} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { priority: event.target.value as AssignmentPriority })}><option value="normal">普通</option><option value="urgent">紧急</option><option value="rework">返工</option></select></label><label>截止<input type="datetime-local" value={dateTimeInput(plan.deadlineAtMs)} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { deadlineAtMs: event.target.value ? new Date(event.target.value).getTime() : null })} /></label><div className="assignment-transfer"><select value={props.transferTargets[transferKey] ?? ""} onChange={(event) => props.setTransferTargets({ ...props.transferTargets, [transferKey]: event.target.value })}><option value="">转移给…</option>{props.operators.filter((user) => user.username !== props.selectedUser!.username).map((user) => <option key={user.username} value={user.username}>{user.displayName}</option>)}</select><button type="button" onClick={() => void props.transferTask(props.selectedUser!.username, plan.task)} disabled={!props.transferTargets[transferKey] || props.busy === `transfer:${transferKey}`}>转移</button></div><button className="icon-button" type="button" onClick={() => props.updatePlan(props.selectedUser!.username, plan.task, { status: plan.status === "active" ? "paused" : "active" })}>{plan.status === "active" ? <PauseCircle size={17} /> : <PlayCircle size={17} />}</button><button className="icon-button" type="button" onClick={() => props.toggleTask(props.selectedUser!.username, plan.task)}><X size={16} /></button></div>; })}</div><div className="assignment-task-grid compact">{filtered.filter((task) => !props.selectedPlans.some((plan) => plan.task.toLowerCase() === task.toLowerCase())).map((task) => <button key={task} className="assignment-add-card" type="button" onClick={() => props.toggleTask(props.selectedUser!.username, task)}><strong>{task}</strong><small>{taskMaximum(task, props.taskCatalog) ? `可用 ${taskMaximum(task, props.taskCatalog)} 条` : "来自任务 JSON"}</small><CheckCircle2 size={16} /></button>)}</div></> : <div className="cockpit-empty">暂无标注员</div>}</div></div></section>
    <section className="supervision-section"><Heading kicker="ASSIGNED RANGES" title="当前已分配区间" note="同一任务的区间由用户中心串行计算，避免重复分配" /><div className="supervision-table-wrap"><table><thead><tr><th>账号</th><th>任务</th><th>区间</th><th>数量</th><th>优先级</th><th>截止</th><th>状态</th></tr></thead><tbody>{props.operators.flatMap((user) => user.assignmentPlans.map((plan) => <tr key={`${user.username}-${plan.task}`}><td>@{user.username}</td><td>{plan.task}</td><td>{plan.startIndex + 1}–{plan.startIndex + plan.quantity}</td><td>{plan.quantity}</td><td>{priorityLabel(plan.priority)}</td><td>{formatTime(plan.deadlineAtMs)}</td><td>{plan.status === "paused" ? "已暂停" : "进行中"}</td></tr>))}</tbody></table></div></section>
  </>;
}

function Alerts({ data, notes, setNotes, busy, handle, adjust }: { data: SupervisionDashboardData; notes: Record<string, string>; setNotes: (value: Record<string, string>) => void; busy: string; handle: (id: string, status: OperationsAlertStatus) => Promise<void>; adjust: (username: string) => void }) {
  return <section className="supervision-section alert-center"><Heading kicker="EXCEPTION CENTER" title="异常与进度预警" note="支持确认、备注、转派和关闭；可能停滞不等于异常" />{data.alerts.length ? <div className="alert-list">{data.alerts.map((alert) => <article key={alert.alertId} className={`alert-card severity-${alert.severity} status-${alert.status}`}><header>{alert.type === "duplicate_assignment" ? <AlertTriangle size={18} /> : <TimerReset size={18} />}<div><strong>{alert.message}</strong><small>{formatTime(alert.detectedAtMs)} · @{alert.username || "—"}</small></div><span>{alert.status === "open" ? "待处理" : alert.status === "acknowledged" ? "已确认" : "已关闭"}</span></header><textarea value={notes[alert.alertId] ?? alert.note} onChange={(event) => setNotes({ ...notes, [alert.alertId]: event.target.value })} maxLength={500} placeholder="填写确认情况（不要填写源路径或原始数据）" /><footer><button type="button" onClick={() => adjust(alert.username)}>转派 / 调整</button><button type="button" onClick={() => void handle(alert.alertId, "acknowledged")} disabled={busy === `alert:${alert.alertId}`}>确认并备注</button><button type="button" onClick={() => void handle(alert.alertId, "closed")} disabled={busy === `alert:${alert.alertId}`}>关闭</button></footer></article>)}</div> : <div className="cockpit-empty"><CheckCircle2 size={24} /><strong>当前没有运营预警</strong></div>}</section>;
}

function Quality({ data, annotations, review, setReview, importAnnotations, busy, saveReview }: { data: SupervisionDashboardData; annotations: SupervisionAnnotationCatalog | null; review: QualityReviewRequest; setReview: (value: QualityReviewRequest) => void; importAnnotations: () => Promise<void>; busy: string; saveReview: () => Promise<void> }) {
  const passed = data.qualityReviews.filter((item) => item.outcome === "passed").length;
  const rework = data.qualityReviews.length - passed;
  return <><section className="cockpit-kpis quality-kpis"><Metric icon={<CheckCircle2 />} label="复核总数" value={data.qualityReviews.length} hint="独立复核" /><Metric icon={<ClipboardCheck />} label="首次通过率" value={`${data.qualityReviews.length ? Math.round(passed / data.qualityReviews.length * 100) : 0}%`} hint={`${passed} 条通过`} /><Metric icon={<AlertTriangle />} label="返工率" value={`${data.qualityReviews.length ? Math.round(rework / data.qualityReviews.length * 100) : 0}%`} hint={`${rework} 条返工`} /></section><div className="cockpit-grid quality-layout"><section className="supervision-section"><Heading kicker="REVIEW SAMPLE" title="已完成轨迹抽检" note="候选来自本机标注 JSON" /><button className="button button-secondary" type="button" onClick={() => void importAnnotations()}><FileJson size={15} />导入标注 JSON</button><div className="quality-samples">{annotations?.users.flatMap((user) => user.entries.map((entry) => <button type="button" key={`${user.username}-${entry.trajectoryCode}`} onClick={() => setReview({ ...review, taskId: entry.taskId, trajectoryCode: entry.trajectoryCode })}><span><strong>{entry.trajectoryCode}</strong><small>{user.displayName} · {entry.taskId} · {entry.segmentCount} 段 · {entry.annotatedFrameCount} 帧</small></span><ClipboardCheck size={15} /></button>)) ?? <span>导入后可选择具体轨迹复核</span>}</div></section><section className="supervision-section review-form"><Heading kicker="INDEPENDENT REVIEW" title="保存复核结果" note="复核人固定为当前监管账号，标注员不能自评" /><label>任务<input value={review.taskId} onChange={(event) => setReview({ ...review, taskId: event.target.value })} /></label><label>轨迹码<input value={review.trajectoryCode} onChange={(event) => setReview({ ...review, trajectoryCode: event.target.value })} /></label><label>结果<select value={review.outcome} onChange={(event) => setReview({ ...review, outcome: event.target.value as "passed" | "rework" })}><option value="passed">通过</option><option value="rework">需要返工</option></select></label><label>错误类型<input value={review.errorType} onChange={(event) => setReview({ ...review, errorType: event.target.value })} placeholder="片段边界、漏标等" /></label><label>复核意见<textarea value={review.note} onChange={(event) => setReview({ ...review, note: event.target.value })} maxLength={1000} /></label><button className="button button-primary" type="button" onClick={() => void saveReview()} disabled={busy === "review" || !review.taskId || !review.trajectoryCode}>保存独立复核</button></section></div><section className="supervision-section"><Heading kicker="REVIEW HISTORY" title="复核与返工历史" /><div className="supervision-table-wrap"><table><thead><tr><th>时间</th><th>任务</th><th>轨迹码</th><th>结果</th><th>错误类型</th><th>复核人</th><th>意见</th></tr></thead><tbody>{data.qualityReviews.map((item) => <tr key={item.reviewId}><td>{formatTime(item.reviewedAtMs)}</td><td>{item.taskId}</td><td><code>{item.trajectoryCode}</code></td><td>{item.outcome === "passed" ? "通过" : "返工"}</td><td>{item.errorType || "—"}</td><td>@{item.reviewer}</td><td>{item.note || "—"}</td></tr>)}</tbody></table></div></section></>;
}

function Reports({ data, annotations, json, csv, print }: { data: SupervisionDashboardData; annotations: SupervisionAnnotationCatalog | null; json: () => void; csv: () => void; print: () => void }) {
  const local = annotationTotals(annotations);
  return <><section className="report-actions"><button type="button" onClick={json}><FileJson size={22} /><strong>导出 JSON</strong><span>结构化日报、周报与任务统计</span></button><button type="button" onClick={csv}><Download size={22} /><strong>导出 CSV</strong><span>账号效率与进度明细</span></button><button type="button" onClick={print}><ClipboardCheck size={22} /><strong>打印 HTML</strong><span>可打印的运营日报</span></button></section><section className="supervision-section report-preview"><Heading kicker="DAILY REPORT" title="今日日报预览" note={dateKey(data.generatedAtMs)} /><div className="report-summary"><span>今日分配<strong>{data.overview.assigned}</strong></span><span>今日完成<strong>{data.overview.completedToday}</strong></span><span>今日剩余<strong>{data.overview.remaining}</strong></span><span>异常数量<strong>{data.alerts.filter((item) => item.status !== "closed").length}</strong></span><span>episode<strong>{local.episodes || data.overview.totalCompleted}</strong></span><span>平均耗时<strong>{formatDuration(weightedAverage(data.users))}</strong></span></div><div className="weekly-preview">{data.dailyTrend.map((item) => <span key={item.date}><small>{item.date.slice(5)}</small><strong>{item.completed}</strong></span>)}</div><p>报表不包含源路径、图像、状态、片段内容、原始数据或 hash。</p></section></>;
}

function Heading({ kicker, title, note }: { kicker: string; title: string; note?: string }) { return <div className="supervision-section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div>{note ? <small>{note}</small> : null}</div>; }
function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string | number; hint: string }) { return <div>{icon}<span>{label}</span><strong>{typeof value === "number" ? formatCount(value) : value}</strong><small>{hint}</small></div>; }
function plansFor(user: SupervisionUserSummary): AssignmentPlan[] { return user.assignmentPlans.length ? user.assignmentPlans.map((plan, order) => ({ ...plan, order })) : Object.entries(user.assignedTaskQuantities).map(([task, quantity], order) => ({ task, quantity, startIndex: 0, priority: "normal", deadlineAtMs: null, status: "active", order })); }
function annotationTotals(catalog: SupervisionAnnotationCatalog | null) { return (catalog?.users ?? []).reduce((sum, user) => ({ episodes: sum.episodes + user.trajectoryCount, segments: sum.segments + user.segmentCount, frames: sum.frames + user.annotatedFrameCount }), { episodes: 0, segments: 0, frames: 0 }); }
function localTask(catalog: SupervisionAnnotationCatalog | null, task: string) { const rows = (catalog?.users ?? []).flatMap((user) => user.tasks).filter((row) => row.taskId.toLowerCase() === task.toLowerCase()); return rows.length ? rows.reduce((sum, row) => ({ episodes: sum.episodes + row.trajectoryCount, segments: sum.segments + row.segmentCount, frames: sum.frames + row.annotatedFrameCount }), { episodes: 0, segments: 0, frames: 0 }) : null; }
function taskMaximum(task: string, catalog: SupervisionTaskCatalog | null) { return catalog?.tasks.find((row) => row.task.toLowerCase() === task.toLowerCase())?.total ?? null; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function signed(value: number) { return `${value >= 0 ? "+" : ""}${value}`; }
function priorityLabel(value: AssignmentPriority) { return value === "urgent" ? "紧急" : value === "rework" ? "返工" : "普通"; }
function formatCount(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function formatDuration(value: number | null) { if (value === null) return "—"; const seconds = Math.max(0, Math.round(value / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); return hours ? `${hours}时${minutes}分` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`; }
function formatTime(value: number | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function dateKey(value: number) { return new Date(value).toLocaleDateString("sv-SE"); }
function dateTimeInput(value: number | null) { if (!value) return ""; return new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function weightedAverage(users: SupervisionUserSummary[]) { const rows = users.filter((user) => user.averageCompletionMs !== null && user.totalCompleted); const total = rows.reduce((sum, user) => sum + user.totalCompleted, 0); return total ? Math.round(rows.reduce((sum, user) => sum + (user.averageCompletionMs ?? 0) * user.totalCompleted, 0) / total) : null; }

function safeReport(data: SupervisionDashboardData, annotations: SupervisionAnnotationCatalog | null) {
  return { schemaVersion: 1, generatedAtMs: data.generatedAtMs, overview: data.overview, localAnnotationTotals: annotationTotals(annotations), hourlyTrend: data.hourlyTrend, weeklyTrend: data.dailyTrend, tasks: data.taskSummaries, users: data.users.map((user) => ({ username: user.username, displayName: user.displayName, assignedTasks: user.assignedTasks, completedToday: user.completedToday, totalCompleted: user.totalCompleted, remainingTasks: user.remainingTasks, averageCompletionMs: user.averageCompletionMs, completionRatePerHour: user.completionRatePerHour, lastActivityAtMs: user.lastActivityAtMs, possibleStagnation: user.possibleStagnation })), alertSummary: { open: data.alerts.filter((item) => item.status === "open").length, acknowledged: data.alerts.filter((item) => item.status === "acknowledged").length, closed: data.alerts.filter((item) => item.status === "closed").length }, quality: { reviews: data.qualityReviews.length, passed: data.qualityReviews.filter((item) => item.outcome === "passed").length, rework: data.qualityReviews.filter((item) => item.outcome === "rework").length }, privacy: "No source paths, images, states, segment content, raw data, reports, or hashes are included." };
}
function reportCsv(data: SupervisionDashboardData) { const lines: (string | number | null)[][] = [["账号", "显示名称", "已分配", "今日完成", "累计完成", "剩余", "平均耗时毫秒", "每小时完成", "最近活跃", "可能停滞"], ...data.users.filter((user) => user.role === "operator").map((user) => [user.username, user.displayName, user.assignedTasks, user.completedToday, user.totalCompleted, user.remainingTasks, user.averageCompletionMs, user.completionRatePerHour, user.lastActivityAtMs, user.possibleStagnation ? "是" : "否"])]; return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`; }
function downloadText(filename: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function printReport(data: SupervisionDashboardData) { const popup = window.open("", "_blank", "noopener,noreferrer"); if (!popup) return; const rows = data.users.filter((user) => user.role === "operator").map((user) => `<tr><td>${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</td><td>${user.assignedTasks}</td><td>${user.completedToday}</td><td>${user.totalCompleted}</td><td>${user.remainingTasks}</td><td>${escapeHtml(formatDuration(user.averageCompletionMs))}</td><td>${user.possibleStagnation ? "可能停滞" : "正常"}</td></tr>`).join(""); popup.document.write(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DOHC 运营日报</title><style>body{font:14px system-ui;padding:32px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #bbb;text-align:left}</style><h1>任务运营日报</h1><p>${escapeHtml(formatTime(data.generatedAtMs))}</p><h2>今日完成 ${data.overview.completedToday} · 累计 ${data.overview.totalCompleted} · 剩余 ${data.overview.remaining}</h2><table><thead><tr><th>账号</th><th>分配</th><th>今日</th><th>累计</th><th>剩余</th><th>平均耗时</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table><p>不包含源路径、图像、状态、片段内容或原始数据。</p></html>`); popup.document.close(); popup.focus(); popup.print(); }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
