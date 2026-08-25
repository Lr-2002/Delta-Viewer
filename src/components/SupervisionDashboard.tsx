import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, BarChart3, Check, CheckCircle2, ClipboardCheck, Download,
  FileJson, FileUp, FolderOpen, Gauge, GripVertical, LoaderCircle, LogOut,
  PauseCircle, PlayCircle, RefreshCw, Search, ShieldCheck, Siren, TimerReset,
  Users, X,
} from "lucide-react";
import {
  batchCreateSupervisionAccounts, chooseAndScanSupervisionTasks, chooseDirectory, confirmAction, createQualityReview,
  exportSupervisionReport,
  getSupervisionDashboard, importSupervisionAnnotations, importSupervisionTaskDetails,
  openOutput, revealOutput, setSupervisionAccountStatus, setSupervisionAssignedTasks,
  transferSupervisionAssignment, updateOperationsAlert,
} from "../lib/backend";
import { csvCell, distributeTaskTotals, type TaskAllocationPreview } from "../lib/operationsCockpit";
import { deadlineAtMinute, deadlineDateLabel, deadlineDateTimeInput } from "../lib/deadlines";
import { assignmentConflicts, defaultAssignmentQuantity, validateAssignmentSelection, validateBatchAssignmentTotals } from "../lib/supervisionAssignments";
import type {
  AssignmentPlan, AssignmentPriority, BatchAccountInput, OperationsAlertStatus, QualityReviewRequest,
  SupervisionAnnotationCatalog, SupervisionDashboardData, SupervisionTaskCatalog,
  SupervisionReportFormat, SupervisionReportKind, SupervisionUserSummary, UserIdentity,
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
  const [batchAssignmentMode, setBatchAssignmentMode] = useState<"folder" | "quantity">("folder");
  const [batchTasks, setBatchTasks] = useState<string[]>([]);
  const [batchQuantities, setBatchQuantities] = useState<Record<string, number>>({});
  const [batchPriority, setBatchPriority] = useState<AssignmentPriority>("normal");
  const [batchDeadline, setBatchDeadline] = useState("");
  const [batchStrategy, setBatchStrategy] = useState<"even" | "speed">("even");
  const [batchUsers, setBatchUsers] = useState<string[]>([]);
  const [batchTransferTarget, setBatchTransferTarget] = useState("");
  const [review, setReview] = useState<QualityReviewRequest>(emptyReview());
  const [batchAccountText, setBatchAccountText] = useState("");
  const [reportKind, setReportKind] = useState<SupervisionReportKind>("daily");

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
  const batchTaskTotals = batchTasks.map((task) => ({
    task,
    total: batchAssignmentMode === "folder"
      ? taskMaximum(task, taskCatalog) ?? 0
      : batchQuantities[task] ?? defaultAssignmentQuantity(task, taskCatalog?.tasks ?? []),
  }));
  const batchPreview = distributeTaskTotals(batchTaskTotals, batchSelected, batchStrategy);

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
        completed: 0, remaining: defaultAssignmentQuantity(task, taskCatalog?.tasks ?? []), estimatedCompletionAtMs: null,
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
    if (!batchTasks.length || !batchSelected.length) return setError("请选择至少一个任务和一位标注员");
    if (batchTaskTotals.some((item) => !Number.isSafeInteger(item.total) || item.total < 1)) {
      return setError(batchAssignmentMode === "folder" ? "整文件夹模式只能选择已读取且包含视频的任务目录" : "每个任务的分配数量必须是正整数");
    }
    const totals = Object.fromEntries(batchTaskTotals.map((item) => [item.task, item.total]));
    const selectionError = validateAssignmentSelection(totals, taskCatalog?.tasks ?? [], availableTasks)
      ?? validateBatchAssignmentTotals(batchUsers, totals, taskCatalog?.tasks ?? [], data?.users ?? []);
    if (selectionError) return setError(selectionError);
    const preview = batchPreview.flatMap((allocation) => [
      `${allocation.task}（共 ${allocation.total} 条）`,
      ...allocation.shares.map((share) => {
        const old = drafts[share.username]?.find((plan) => plan.task.toLowerCase() === allocation.task.toLowerCase())?.quantity ?? 0;
        return `  @${share.username}：${old} → ${share.quantity}（${signed(share.quantity - old)}）`;
      }),
    ]).join("\n");
    if (!await confirmAction(`批量操作预览：\n\n${preview}\n\n用户中心将按任务生成不重叠区间。是否确认？`, "确认批量分配")) return;
    setBusy("batch");
    setError("");
    try {
      const deadlineAtMs = deadlineAtMinute(batchDeadline);
      for (const user of batchSelected) {
        const selectedKeys = new Set(batchTasks.map((task) => task.toLowerCase()));
        const next = (drafts[user.username] ?? []).filter((plan) => !selectedKeys.has(plan.task.toLowerCase()));
        for (const allocation of batchPreview) {
          const quantity = allocation.shares.find((share) => share.username === user.username)?.quantity ?? 0;
          if (!quantity) continue;
          next.push({ task: allocation.task, quantity, startIndex: 0, priority: batchPriority, deadlineAtMs, status: "active" as const, order: next.length, completed: 0, remaining: quantity, estimatedCompletionAtMs: null });
        }
        await savePlans(user.username, next);
      }
      await refresh();
      const total = batchTaskTotals.reduce((sum, item) => sum + item.total, 0);
      setNotice(`已按${batchStrategy === "speed" ? "历史速度建议" : "平均"}方案分配 ${batchTaskTotals.length} 类任务，共 ${total} 条`);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function scanTasks() {
    setBusy("scan"); setError("");
    try {
      const catalog = await chooseAndScanSupervisionTasks();
      if (catalog) {
        setTaskCatalog(catalog);
        setBatchTasks((current) => current.length ? current : catalog.tasks.slice(0, 1).map((task) => task.task));
        setBatchQuantities((current) => ({ ...Object.fromEntries(catalog.tasks.map((task) => [task.task, task.total])), ...current }));
        setNotice(`已在本机读取 ${catalog.tasks.length} 类任务`);
      }
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function importTasks() {
    setBusy("tasks"); setError("");
    try {
      const result = await importSupervisionTaskDetails();
      if (result) {
        setImportedTasks(result.importedTaskNames);
        setData((current) => current ? { ...current, taskDetails: result.taskDetails } : current);
        setBatchTasks((current) => current.length ? current : result.importedTaskNames.slice(0, 1));
        setBatchQuantities((current) => ({ ...Object.fromEntries(result.importedTaskNames.map((task) => [task, 1])), ...current }));
        setNotice(`已读取 ${result.importedTaskNames.length} 项任务定义`);
      }
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
    try { const saved = await createQualityReview(review); await refresh(); setReview(emptyReview()); setNotice(saved.reworkAssignmentCreated ? "独立复核已保存，并自动生成返工任务" : "独立复核结果已保存"); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function transferTasksInBatch() {
    if (!selectedUser || !batchTransferTarget || !batchTasks.length) return setError("请选择转出账号、转入账号和任务");
    const transferable = batchTasks.filter((task) => selectedPlans.some((plan) => plan.task.toLowerCase() === task.toLowerCase()));
    if (!transferable.length) return setError("所选任务不在当前转出账号的队列中");
    const preview = transferable.map((task) => { const plan = selectedPlans.find((item) => item.task.toLowerCase() === task.toLowerCase())!; return `${task}：${plan.quantity} 条，区间 ${plan.startIndex + 1}–${plan.startIndex + plan.quantity}`; }).join("\n");
    if (!await confirmAction(`从 @${selectedUser.username} 批量转移给 @${batchTransferTarget}：\n\n${preview}\n\n用户中心会为目标账号重新生成互斥区间。`, "确认批量转移任务")) return;
    setBusy("batch-transfer"); setError("");
    try { for (const task of transferable) await transferSupervisionAssignment(selectedUser.username, batchTransferTarget, task); await refresh(); setNotice(`已批量转移 ${transferable.length} 类任务`); }
    catch (reason) { await refresh(); setError(`批量转移已停止，请核对已完成项：${message(reason)}`); } finally { setBusy(""); }
  }

  async function createAccounts() {
    let accounts: BatchAccountInput[];
    try { accounts = parseBatchAccounts(batchAccountText); }
    catch (reason) { return setError(message(reason)); }
    const preview = accounts.map((account) => `@${account.username}（${account.displayName}）`).join("\n");
    if (!await confirmAction(`将创建 ${accounts.length} 个普通账号：\n\n${preview}\n\n密码不会显示在预览或日志中。`, "确认批量创建账号")) return;
    setBusy("accounts"); setError("");
    try { await batchCreateSupervisionAccounts(accounts); setBatchAccountText(""); await refresh(); setNotice(`已批量创建 ${accounts.length} 个账号`); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function updateAccountStatus(status: "active" | "paused") {
    if (!batchUsers.length) return setError("请先选择至少一个标注员");
    const label = status === "paused" ? "暂停" : "恢复";
    const rows = operators.filter((user) => batchUsers.includes(user.username)).map((user) => `@${user.username}：${user.remainingTasks} 条剩余任务`).join("\n");
    if (!await confirmAction(`将${label}以下 ${batchUsers.length} 个账号：\n\n${rows}`, `确认批量${label}账号`)) return;
    setBusy("account-status"); setError("");
    try { await setSupervisionAccountStatus(batchUsers, status); await refresh(); setNotice(`已${label} ${batchUsers.length} 个账号`); }
    catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function exportReport(format: SupervisionReportFormat) {
    if (!data) return;
    setBusy(`report:${format}`); setError("");
    try {
      const destination = await chooseDirectory("选择监管报表输出文件夹");
      if (!destination) return;
      const content = format === "json"
        ? `${JSON.stringify(reportPayload(data, annotations, reportKind), null, 2)}\n`
        : format === "csv" ? reportCsv(data, reportKind) : reportHtml(data, annotations, reportKind);
      const result = await exportSupervisionReport(destination, reportKind, format, dateKey(data.generatedAtMs), data.generatedAtMs, content);
      if (format === "html") await openOutput(result.outputPath);
      await revealOutput(result.outputPath);
      setNotice(`已生成${reportKindLabel(reportKind)} ${format.toUpperCase()}，并打开文件所在文件夹：${result.outputPath}`);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  }

  async function exportDailyWeekly(format: SupervisionReportFormat) {
    if (!data) return;
    setBusy(`report-bundle:${format}`); setError("");
    try {
      const destination = await chooseDirectory("选择日报和周报输出文件夹");
      if (!destination) return;
      let lastPath = "";
      for (const kind of ["daily", "weekly"] as const) {
        const content = format === "json" ? `${JSON.stringify(reportPayload(data, annotations, kind), null, 2)}\n` : format === "csv" ? reportCsv(data, kind) : reportHtml(data, annotations, kind);
        lastPath = (await exportSupervisionReport(destination, kind, format, dateKey(data.generatedAtMs), data.generatedAtMs, content)).outputPath;
      }
      await revealOutput(lastPath);
      setNotice(`已批量生成日报和周报 ${format.toUpperCase()}，并打开输出文件夹`);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
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
      {data && view === "assignment" ? <Assignment data={data} operators={operators} availableTasks={availableTasks} selectedUser={selectedUser} selectedPlans={selectedPlans} drafts={drafts} taskCatalog={taskCatalog} taskSearch={taskSearch} setTaskSearch={setTaskSearch} setSelectedOperator={setSelectedOperator} toggleTask={toggleTask} updatePlan={updatePlan} reorderPlan={reorderPlan} setDraggedTask={setDraggedTask} saveAssignment={saveAssignment} busy={busy} batchAssignmentMode={batchAssignmentMode} setBatchAssignmentMode={setBatchAssignmentMode} batchTasks={batchTasks} setBatchTasks={setBatchTasks} batchQuantities={batchQuantities} setBatchQuantities={setBatchQuantities} batchPriority={batchPriority} setBatchPriority={setBatchPriority} batchDeadline={batchDeadline} setBatchDeadline={setBatchDeadline} batchStrategy={batchStrategy} setBatchStrategy={setBatchStrategy} batchUsers={batchUsers} setBatchUsers={setBatchUsers} batchPreview={batchPreview} applyBatch={applyBatch} scanTasks={scanTasks} importTasks={importTasks} transferTargets={transferTargets} setTransferTargets={setTransferTargets} transferTask={transferTask} batchAccountText={batchAccountText} setBatchAccountText={setBatchAccountText} createAccounts={createAccounts} updateAccountStatus={updateAccountStatus} batchTransferTarget={batchTransferTarget} setBatchTransferTarget={setBatchTransferTarget} transferTasksInBatch={transferTasksInBatch} /> : null}
      {data && view === "alerts" ? <Alerts data={data} notes={alertNotes} setNotes={setAlertNotes} busy={busy} handle={handleAlert} adjust={(username) => { setSelectedOperator(username); setView("assignment"); }} /> : null}
      {data && view === "quality" ? <Quality data={data} annotations={annotations} review={review} setReview={setReview} importAnnotations={importAnnotations} busy={busy} saveReview={saveReview} /> : null}
      {data && view === "reports" ? <Reports data={data} annotations={annotations} kind={reportKind} setKind={setReportKind} exportReport={exportReport} exportDailyWeekly={exportDailyWeekly} busy={busy} /> : null}
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
    <section className="cockpit-kpis"><Metric icon={<CheckCircle2 />} label="今日完成" value={data.overview.completedToday} hint="episode" /><Metric icon={<Gauge />} label="累计完成" value={data.overview.totalCompleted} hint="episode" /><Metric icon={<TimerReset />} label="当前剩余" value={data.overview.remaining} hint={`已分配 ${data.overview.assigned}`} /><Metric icon={<Users />} label="活跃标注员" value={data.overview.activeOperators} hint={`${data.overview.possibleStagnation} 人可能停滞`} /><Metric icon={<ClipboardCheck />} label="片段数" value={local.segments} hint={annotations ? "本机汇总" : "待导入"} /><Metric icon={<BarChart3 />} label="覆盖帧数" value={local.frames} hint={`${local.episodes} episodes`} /><Metric icon={<TimerReset />} label="平均单条耗时" value={formatDuration(data.overview.averageCompletionMs)} hint="全部已完成任务" /></section>
    <div className="cockpit-grid two-columns"><section className="supervision-section trend-panel"><div className="supervision-section-heading"><div><span className="section-kicker">TODAY TREND</span><h2>今日每小时完成量</h2></div><small>峰值 {peak?.hour ?? 0}:00 · {peak?.completed ?? 0} 条<br />低效 {low?.hour ?? 0}:00 · {low?.completed ?? 0} 条</small></div><div className="hourly-chart">{data.hourlyTrend.map((row) => <div key={row.hour} title={`${row.hour}:00 · ${row.completed} 条`}><span style={{ height: `${Math.max(row.completed ? 8 : 1, row.completed / max * 100)}%` }} /><small>{row.hour % 3 === 0 ? row.hour : ""}</small></div>)}</div></section><section className="supervision-section local-metrics"><div className="supervision-section-heading"><div><span className="section-kicker">LOCAL DETAIL</span><h2>片段与帧明细</h2></div><button className="button button-secondary" type="button" onClick={onImport} disabled={importing}><FileJson size={15} />{importing ? "读取中" : "导入标注 JSON"}</button></div><p>片段与帧不上传用户中心，只从当前管理员电脑选择的 JSON 汇总。</p><div><span><strong>{formatCount(local.episodes)}</strong>episode</span><span><strong>{formatCount(local.segments)}</strong>片段</span><span><strong>{formatCount(local.frames)}</strong>帧</span></div></section></div>
    <section className="supervision-section"><Heading kicker="TASK TYPES" title="按任务类型" note="分配、完成、未完成与平均耗时" /><div className="supervision-table-wrap"><table><thead><tr><th>任务类型</th><th>分配</th><th>今日</th><th>累计</th><th>未完成</th><th>episode / 片段 / 帧</th><th>平均耗时</th><th>人数</th></tr></thead><tbody>{data.taskSummaries.map((task) => { const detail = localTask(annotations, task.task); return <tr key={task.task}><td><strong>{task.task}</strong></td><td>{task.assigned}</td><td>{task.completedToday}</td><td>{task.totalCompleted}</td><td>{task.remaining}</td><td>{detail ? `${detail.episodes} / ${detail.segments} / ${formatCount(detail.frames)}` : "—"}</td><td>{formatDuration(task.averageCompletionMs)}</td><td>{task.operatorCount}</td></tr>; })}</tbody></table></div></section>
    <section className="supervision-section"><Heading kicker="WHO IS DOING WHAT" title="按账号查看进度与速度" note="可能停滞仅作提醒，不直接判定异常" /><div className="supervision-table-wrap"><table><thead><tr><th>账号</th><th>当前任务</th><th>今日 / 累计</th><th>剩余</th><th>速度</th><th>平均耗时</th><th>最近活跃</th><th>预计完成</th><th>状态</th></tr></thead><tbody>{data.users.filter((user) => user.role === "operator").map((user) => <tr key={user.username}><td><strong>{user.displayName}</strong><small>@{user.username}</small></td><td>{user.assignmentPlans.filter((plan) => plan.status === "active").map((plan) => plan.task).join("、") || "—"}</td><td>{user.completedToday} / {user.totalCompleted}</td><td>{user.remainingTasks}</td><td>{user.completionRatePerHour} 条/小时</td><td>{formatDuration(user.averageCompletionMs)}</td><td>{formatTime(user.lastActivityAtMs ?? user.lastLoginAtMs)}</td><td>{formatTime(user.estimatedCompletionAtMs)}</td><td>{user.accountStatus === "paused" ? <span className="status-pill warning"><PauseCircle size={13} />账号暂停</span> : user.possibleStagnation ? <span className="status-pill warning"><Siren size={13} />可能停滞</span> : <span className="status-pill"><Check size={13} />正常</span>}</td></tr>)}</tbody></table></div></section>
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
  batchAssignmentMode: "folder" | "quantity"; setBatchAssignmentMode: (value: "folder" | "quantity") => void;
  batchTasks: string[]; setBatchTasks: (value: string[]) => void;
  batchQuantities: Record<string, number>; setBatchQuantities: (value: Record<string, number>) => void;
  batchPriority: AssignmentPriority; setBatchPriority: (value: AssignmentPriority) => void;
  batchDeadline: string; setBatchDeadline: (value: string) => void; batchStrategy: "even" | "speed"; setBatchStrategy: (value: "even" | "speed") => void;
  batchUsers: string[]; setBatchUsers: (value: string[]) => void; batchPreview: TaskAllocationPreview[];
  applyBatch: () => Promise<void>; scanTasks: () => Promise<void>; importTasks: () => Promise<void>;
  transferTargets: Record<string, string>; setTransferTargets: (value: Record<string, string>) => void;
  transferTask: (fromUsername: string, task: string) => Promise<void>;
  batchAccountText: string; setBatchAccountText: (value: string) => void;
  createAccounts: () => Promise<void>; updateAccountStatus: (status: "active" | "paused") => Promise<void>;
  batchTransferTarget: string; setBatchTransferTarget: (value: string) => void;
  transferTasksInBatch: () => Promise<void>;
};

function Assignment(props: AssignmentProps) {
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const filtered = props.availableTasks.filter((task) => task.toLowerCase().includes(props.taskSearch.toLowerCase()));
  const visibleAssignedPlans = props.operators.flatMap((user) => user.assignmentPlans
    .filter((plan) => !onlyIncomplete || (plan.remaining ?? plan.quantity) > 0)
    .map((plan) => ({ user, plan })));
  const toggleBatchTask = (task: string) => {
    const selected = props.batchTasks.includes(task);
    props.setBatchTasks(selected ? props.batchTasks.filter((item) => item !== task) : [...props.batchTasks, task]);
    if (!selected && props.batchQuantities[task] === undefined) {
      props.setBatchQuantities({ ...props.batchQuantities, [task]: taskMaximum(task, props.taskCatalog) ?? 1 });
    }
  };
  return <>
    <section className="supervision-section account-batch-tools">
      <Heading kicker="BULK ACCOUNTS" title="批量账号管理" note="每行格式：账号,显示名称,初始密码；确认前只预览账号，不显示密码" />
      <textarea value={props.batchAccountText} onChange={(event) => props.setBatchAccountText(event.target.value)} placeholder={"operator01,标注员01,至少8位密码\noperator02,标注员02,至少8位密码"} aria-label="批量账号清单" />
      <div className="account-batch-actions"><button className="button button-primary" type="button" onClick={() => void props.createAccounts()} disabled={!props.batchAccountText.trim() || props.busy === "accounts"}><Users size={15} />批量创建账号</button><button className="button button-secondary" type="button" onClick={() => void props.updateAccountStatus("paused")} disabled={!props.batchUsers.length || props.busy === "account-status"}><PauseCircle size={15} />批量暂停所选账号</button><button className="button button-secondary" type="button" onClick={() => void props.updateAccountStatus("active")} disabled={!props.batchUsers.length || props.busy === "account-status"}><PlayCircle size={15} />批量恢复所选账号</button></div>
    </section>
    <section className="supervision-section cockpit-tools"><div><span className="section-kicker">TASK SOURCES</span><h2>任务来源与容量</h2><small>目录仅在本机只读统计，用户中心不接收 NAS 路径。</small></div><div><button className="button button-secondary" type="button" onClick={() => void props.importTasks()}><FileUp size={15} />导入任务 JSON</button><button className="button button-secondary" type="button" onClick={() => void props.scanTasks()}><FolderOpen size={15} />读取任务目录</button></div></section>
    <section className="supervision-section batch-assignment">
      <Heading kicker="BATCH ASSIGNMENT" title="批量任务分配" note="多选任务与标注员；整文件夹模式自动使用目录全部视频" />
      <div className="batch-mode-switch" role="group" aria-label="批量分配模式">
        <button className={props.batchAssignmentMode === "folder" ? "active" : ""} type="button" onClick={() => { props.setBatchAssignmentMode("folder"); props.setBatchTasks(props.batchTasks.filter((task) => (taskMaximum(task, props.taskCatalog) ?? 0) > 0)); }}><FolderOpen size={15} /><span><strong>整文件夹一键分配</strong><small>把所选任务目录的全部视频分配完</small></span></button>
        <button className={props.batchAssignmentMode === "quantity" ? "active" : ""} type="button" onClick={() => props.setBatchAssignmentMode("quantity")}><BarChart3 size={15} /><span><strong>按任务分配数量</strong><small>多选任务并分别填写分配总量</small></span></button>
      </div>
      <div className="batch-task-picker">
        {props.availableTasks.map((task) => {
          const maximum = taskMaximum(task, props.taskCatalog);
          const selected = props.batchTasks.includes(task);
          const unavailable = props.batchAssignmentMode === "folder" && (maximum === null || maximum < 1);
          return <label key={task} className={`${selected ? "selected" : ""}${unavailable ? " disabled" : ""}`}>
            <input type="checkbox" checked={selected} disabled={unavailable} onChange={() => toggleBatchTask(task)} />
            <span><strong>{task}</strong><small>{maximum === null ? "来自任务 JSON，需按数量分配" : `文件夹共 ${maximum} 条`}</small></span>
            {props.batchAssignmentMode === "quantity" && selected
              ? <input aria-label={`${task} 分配数量`} type="number" min={1} max={maximum ?? 1_000_000} value={props.batchQuantities[task] ?? maximum ?? 1} onChange={(event) => props.setBatchQuantities({ ...props.batchQuantities, [task]: Math.max(1, Number(event.target.value) || 1) })} />
              : <b>{selected && maximum !== null ? `${maximum} 条` : ""}</b>}
          </label>;
        })}
      </div>
      <div className="batch-controls compact">
        <label>优先级<select value={props.batchPriority} onChange={(event) => props.setBatchPriority(event.target.value as AssignmentPriority)}><option value="normal">普通</option><option value="urgent">紧急</option><option value="rework">返工</option></select></label>
        <label>截止时间<input type="datetime-local" step={60} value={props.batchDeadline} onChange={(event) => props.setBatchDeadline(event.target.value)} /><small>精确到分钟</small></label>
        <label>分配策略<select value={props.batchStrategy} onChange={(event) => props.setBatchStrategy(event.target.value as "even" | "speed")}><option value="even">一键平均</option><option value="speed">按历史速度建议</option></select></label>
      </div>
      <div className="batch-user-picker">{props.operators.map((user) => <label key={user.username}><input type="checkbox" checked={props.batchUsers.includes(user.username)} onChange={() => props.setBatchUsers(props.batchUsers.includes(user.username) ? props.batchUsers.filter((name) => name !== user.username) : [...props.batchUsers, user.username])} /><span>{user.displayName}<small>@{user.username} · {user.completionRatePerHour} 条/小时 · {user.accountStatus === "paused" ? "账号暂停" : `容量余量 ${Math.max(0, 1_000_000 - user.assignedTasks)}`}</small></span></label>)}</div>
      <div className="batch-preview"><strong>操作预览</strong><small>{validateBatchAssignmentTotals(props.batchUsers, Object.fromEntries(props.batchPreview.map((item) => [item.task, item.total])), props.taskCatalog?.tasks ?? [], props.data.users) ?? "重复区间：无 · 账号容量：未超限；保存时由用户中心重新生成互斥区间"}</small><div className="batch-preview-list">{props.batchPreview.map((allocation) => <article key={allocation.task}><header><strong>{allocation.task}</strong><b>共 {allocation.total} 条</b></header><div>{allocation.shares.map((share) => { const old = props.drafts[share.username]?.find((plan) => plan.task.toLowerCase() === allocation.task.toLowerCase())?.quantity ?? 0; return <span key={share.username}>@{share.username}<b>{old} → {share.quantity}</b><small>{signed(share.quantity - old)} 条</small></span>; })}</div></article>)}</div><button className="button button-primary" type="button" onClick={() => void props.applyBatch()} disabled={!props.batchTasks.length || !props.batchUsers.length || props.busy === "batch"}>{props.busy === "batch" ? "应用中" : "确认批量分配"}</button></div>
      <div className="bulk-transfer-row"><span>批量转移所选任务</span><strong>{props.selectedUser ? `从 @${props.selectedUser.username}` : "请先选择转出账号"}</strong><select value={props.batchTransferTarget} onChange={(event) => props.setBatchTransferTarget(event.target.value)} aria-label="批量转入账号"><option value="">转移给…</option>{props.operators.filter((user) => user.username !== props.selectedUser?.username).map((user) => <option value={user.username} key={user.username}>@{user.username} · {user.displayName}</option>)}</select><button className="button button-secondary" type="button" onClick={() => void props.transferTasksInBatch()} disabled={!props.selectedUser || !props.batchTransferTarget || !props.batchTasks.length || props.busy === "batch-transfer"}><FileUp size={15} />预览并批量转移</button></div>
    </section>
    <section className="supervision-section assignment-workbench">
      <Heading kicker="ASSIGNMENT QUEUE" title="账号任务队列" note="拖拽排序；支持暂停、追加、减少、转移、优先级与截止日期" />
      <div className="assignment-layout">
        <aside className="operator-list"><header><Users size={15} /><strong>标注员</strong><span>{props.operators.length}</span></header>{props.operators.map((user) => <button key={user.username} className={props.selectedUser?.username === user.username ? "active" : ""} type="button" onClick={() => props.setSelectedOperator(user.username)}><span><strong>{user.displayName}</strong><small>@{user.username}</small></span><b>{props.drafts[user.username]?.length ?? 0}</b></button>)}</aside>
        <div className="assignment-task-picker">{props.selectedUser ? <>
          <header className="assignment-picker-header"><div><strong>{props.selectedUser.displayName} 的队列</strong><span>剩余 {props.selectedUser.remainingTasks} 条 · 预计 {formatTime(props.selectedUser.estimatedCompletionAtMs)}</span></div><button className="button button-primary" type="button" onClick={() => void props.saveAssignment(props.selectedUser!.username)} disabled={props.busy === `save:${props.selectedUser.username}`}>保存队列</button></header>
          <div className="assignment-toolbar"><label><Search size={14} /><input value={props.taskSearch} onChange={(event) => props.setTaskSearch(event.target.value)} placeholder="搜索任务" /></label></div>
          <div className="assignment-plan-list">{props.selectedPlans.map((plan) => {
            const transferKey = `${props.selectedUser!.username}:${plan.task}`;
            const deadlineInput = deadlineDateTimeInput(plan.deadlineAtMs);
            return <div key={plan.task} className={`assignment-plan-row priority-${plan.priority}${plan.status === "paused" ? " paused" : ""}`} draggable onDragStart={() => props.setDraggedTask(plan.task)} onDragOver={(event) => event.preventDefault()} onDrop={() => props.reorderPlan(props.selectedUser!.username, plan.task)}>
              <GripVertical size={16} />
              <div><strong>{plan.task}</strong><small>区间 {plan.startIndex + 1}–{plan.startIndex + plan.quantity}</small></div>
              <label>数量<input type="number" min={1} max={taskMaximum(plan.task, props.taskCatalog) ?? 1_000_000} value={plan.quantity} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { quantity: Math.max(1, Number(event.target.value) || 1) })} /></label>
              <label>优先级<select value={plan.priority} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { priority: event.target.value as AssignmentPriority })}><option value="normal">普通</option><option value="urgent">紧急</option><option value="rework">返工</option></select></label>
              <label>截止时间<input type="datetime-local" step={60} value={deadlineInput} onChange={(event) => props.updatePlan(props.selectedUser!.username, plan.task, { deadlineAtMs: deadlineAtMinute(event.target.value) })} /><small>完成 {plan.completed ?? 0} · 剩余 {plan.remaining ?? plan.quantity} · 预计 {formatTime(plan.estimatedCompletionAtMs ?? null)}</small></label>
              <div className="assignment-transfer"><select value={props.transferTargets[transferKey] ?? ""} onChange={(event) => props.setTransferTargets({ ...props.transferTargets, [transferKey]: event.target.value })}><option value="">转移给…</option>{props.operators.filter((user) => user.username !== props.selectedUser!.username).map((user) => <option key={user.username} value={user.username}>{user.displayName}</option>)}</select><button type="button" onClick={() => void props.transferTask(props.selectedUser!.username, plan.task)} disabled={!props.transferTargets[transferKey] || props.busy === `transfer:${transferKey}`}>转移</button></div>
              <button className="icon-button" type="button" onClick={() => props.updatePlan(props.selectedUser!.username, plan.task, { status: plan.status === "active" ? "paused" : "active" })}>{plan.status === "active" ? <PauseCircle size={17} /> : <PlayCircle size={17} />}</button>
              <button className="icon-button" type="button" onClick={() => props.toggleTask(props.selectedUser!.username, plan.task)}><X size={16} /></button>
            </div>;
          })}</div>
          <div className="assignment-task-grid compact">{filtered.filter((task) => !props.selectedPlans.some((plan) => plan.task.toLowerCase() === task.toLowerCase())).map((task) => <button key={task} className="assignment-add-card" type="button" onClick={() => props.toggleTask(props.selectedUser!.username, task)}><strong>{task}</strong><small>{taskMaximum(task, props.taskCatalog) ? `可用 ${taskMaximum(task, props.taskCatalog)} 条` : "来自任务 JSON"}</small><CheckCircle2 size={16} /></button>)}</div>
        </> : <div className="cockpit-empty">暂无标注员</div>}</div>
      </div>
    </section>
    <section className="supervision-section"><Heading kicker="ASSIGNED RANGES" title="当前已分配区间与未完成任务" note="同一任务的区间由用户中心串行计算，避免重复分配" /><label className="inline-check"><input type="checkbox" checked={onlyIncomplete} onChange={(event) => setOnlyIncomplete(event.target.checked)} />只看未完成任务</label><div className="supervision-table-wrap"><table><thead><tr><th>账号</th><th>任务</th><th>区间</th><th>已完成 / 剩余</th><th>优先级</th><th>截止</th><th>预计完成</th><th>状态</th></tr></thead><tbody>{visibleAssignedPlans.map(({ user, plan }) => <tr key={`${user.username}-${plan.task}`}><td>@{user.username}</td><td>{plan.task}</td><td>{plan.startIndex + 1}–{plan.startIndex + plan.quantity}</td><td>{plan.completed ?? 0} / {plan.remaining ?? plan.quantity}</td><td>{priorityLabel(plan.priority)}</td><td>{deadlineDateLabel(plan.deadlineAtMs)}</td><td>{formatTime(plan.estimatedCompletionAtMs ?? null)}</td><td>{plan.status === "paused" ? "已暂停" : (plan.remaining ?? plan.quantity) === 0 ? "已完成" : "进行中"}</td></tr>)}</tbody></table></div></section>
  </>;
}

function Alerts({ data, notes, setNotes, busy, handle, adjust }: { data: SupervisionDashboardData; notes: Record<string, string>; setNotes: (value: Record<string, string>) => void; busy: string; handle: (id: string, status: OperationsAlertStatus) => Promise<void>; adjust: (username: string) => void }) {
  return <section className="supervision-section alert-center"><Heading kicker="EXCEPTION CENTER" title="异常与进度预警" note="支持确认、备注、转派和关闭；可能停滞不等于异常" />{data.alerts.length ? <div className="alert-list">{data.alerts.map((alert) => <article key={alert.alertId} className={`alert-card severity-${alert.severity} status-${alert.status}`}><header>{alert.type === "duplicate_assignment" ? <AlertTriangle size={18} /> : <TimerReset size={18} />}<div><strong>{alert.message}</strong><small>{formatTime(alert.detectedAtMs)} · @{alert.username || "—"}</small></div><span>{alert.status === "open" ? "待处理" : alert.status === "acknowledged" ? "已确认" : "已关闭"}</span></header><textarea value={notes[alert.alertId] ?? alert.note} onChange={(event) => setNotes({ ...notes, [alert.alertId]: event.target.value })} maxLength={500} placeholder="填写确认情况（不要填写源路径或原始数据）" /><footer><button type="button" onClick={() => adjust(alert.username)}>转派 / 调整</button><button type="button" onClick={() => void handle(alert.alertId, "acknowledged")} disabled={busy === `alert:${alert.alertId}`}>确认并备注</button><button type="button" onClick={() => void handle(alert.alertId, "closed")} disabled={busy === `alert:${alert.alertId}`}>关闭</button></footer></article>)}</div> : <div className="cockpit-empty"><CheckCircle2 size={24} /><strong>当前没有运营预警</strong></div>}</section>;
}

function Quality({ data, annotations, review, setReview, importAnnotations, busy, saveReview }: { data: SupervisionDashboardData; annotations: SupervisionAnnotationCatalog | null; review: QualityReviewRequest; setReview: (value: QualityReviewRequest) => void; importAnnotations: () => Promise<void>; busy: string; saveReview: () => Promise<void> }) {
  const candidates = annotations?.users.flatMap((user) => user.entries.map((entry) => ({ user, entry }))) ?? [];
  const ordered = [...data.qualityReviews].sort((left, right) => left.reviewedAtMs - right.reviewedAtMs);
  const firstReviews = [...new Map(ordered.map((item) => [item.trajectoryCode, item])).values()];
  const firstPassed = firstReviews.filter((item) => item.outcome === "passed").length;
  const rework = firstReviews.filter((item) => item.outcome === "rework").length;
  const errorCounts = [...data.qualityReviews.reduce((map, item) => {
    if (item.errorType) map.set(item.errorType, (map.get(item.errorType) ?? 0) + 1);
    return map;
  }, new Map<string, number>())].sort((left, right) => right[1] - left[1]);
  const taskErrorCounts = [...data.qualityReviews.reduce((map, item) => {
    if (item.errorType) { const key = `${item.taskId} · ${item.errorType}`; map.set(key, (map.get(key) ?? 0) + 1); }
    return map;
  }, new Map<string, number>())].sort((left, right) => right[1] - left[1]);
  const selectCandidate = (index: number) => {
    const candidate = candidates[index];
    if (!candidate) return;
    const parent = [...data.qualityReviews].find((item) => item.trajectoryCode === candidate.entry.trajectoryCode && item.outcome === "rework" && !data.qualityReviews.some((next) => next.parentReviewId === item.reviewId && next.outcome === "passed"));
    setReview({ ...emptyReview(), taskId: candidate.entry.taskId, trajectoryCode: candidate.entry.trajectoryCode, annotatorUsername: candidate.user.username, annotationRevision: candidate.entry.revision, parentReviewId: parent?.reviewId ?? null });
  };
  return <>
    <section className="cockpit-kpis quality-kpis"><Metric icon={<CheckCircle2 />} label="复核总数" value={data.qualityReviews.length} hint="独立复核" /><Metric icon={<ClipboardCheck />} label="首次通过率" value={`${firstReviews.length ? Math.round(firstPassed / firstReviews.length * 100) : 0}%`} hint={`${firstPassed} 条首次通过`} /><Metric icon={<AlertTriangle />} label="返工率" value={`${firstReviews.length ? Math.round(rework / firstReviews.length * 100) : 0}%`} hint={`${rework} 条生成返工`} /></section>
    <div className="cockpit-grid quality-layout"><section className="supervision-section"><Heading kicker="REVIEW SAMPLE" title="随机抽取已完成片段复核" note="候选来自本机标注 JSON" /><div className="account-batch-actions"><button className="button button-secondary" type="button" onClick={() => void importAnnotations()}><FileJson size={15} />导入标注 JSON</button><button className="button button-primary" type="button" disabled={!candidates.length} onClick={() => selectCandidate(Math.floor(Math.random() * candidates.length))}><ClipboardCheck size={15} />随机抽检一条</button></div><div className="quality-samples">{candidates.length ? candidates.map(({ user, entry }, index) => <button type="button" key={`${user.username}-${entry.trajectoryCode}`} onClick={() => selectCandidate(index)}><span><strong>{entry.trajectoryCode}</strong><small>{user.displayName} · {entry.taskId} · r{entry.revision} · {entry.segmentCount} 段 · {entry.annotatedFrameCount} 帧</small></span><ClipboardCheck size={15} /></button>) : <span>导入后可选择具体轨迹复核</span>}</div></section>
      <section className="supervision-section review-form"><Heading kicker="INDEPENDENT REVIEW" title="保存复核结果" note="复核人固定为当前监管账号；返工会自动生成任务" /><label>原标注员<input value={review.annotatorUsername} onChange={(event) => setReview({ ...review, annotatorUsername: event.target.value })} /></label><label>任务<input value={review.taskId} onChange={(event) => setReview({ ...review, taskId: event.target.value })} /></label><label>轨迹码<input value={review.trajectoryCode} onChange={(event) => setReview({ ...review, trajectoryCode: event.target.value })} /></label><label>标注修订<input type="number" min={1} value={review.annotationRevision ?? ""} onChange={(event) => setReview({ ...review, annotationRevision: event.target.value ? event.currentTarget.valueAsNumber : null })} /></label><label>片段序号<input type="number" min={0} value={review.segmentIndex ?? ""} onChange={(event) => setReview({ ...review, segmentIndex: event.target.value ? event.currentTarget.valueAsNumber : null })} /></label><div className="review-frame-range"><label>起始帧<input type="number" min={0} value={review.startFrame ?? ""} onChange={(event) => setReview({ ...review, startFrame: event.target.value ? event.currentTarget.valueAsNumber : null })} /></label><label>结束帧<input type="number" min={0} value={review.endFrame ?? ""} onChange={(event) => setReview({ ...review, endFrame: event.target.value ? event.currentTarget.valueAsNumber : null })} /></label></div><label>结果<select value={review.outcome} onChange={(event) => setReview({ ...review, outcome: event.target.value as "passed" | "rework" })}><option value="passed">通过</option><option value="rework">需要返工</option></select></label><label>错误类型<input value={review.errorType} onChange={(event) => setReview({ ...review, errorType: event.target.value })} placeholder="片段边界、漏标等" /></label><label>复核意见<textarea value={review.note} onChange={(event) => setReview({ ...review, note: event.target.value })} maxLength={1000} /></label><button className="button button-primary" type="button" onClick={() => void saveReview()} disabled={busy === "review" || !review.taskId || !review.trajectoryCode || !review.annotatorUsername}>保存独立复核</button></section></div>
    <section className="supervision-section"><Heading kicker="QUALITY DISTRIBUTION" title="错误类型、任务差异与账号质量趋势" /><div className="quality-distribution"><div>{errorCounts.length ? errorCounts.map(([type, count]) => <span key={type}><strong>{type}</strong><b>{count}</b></span>) : <span>暂无质量错误</span>}</div><div>{taskErrorCounts.length ? taskErrorCounts.map(([type, count]) => <span key={type}><strong>{type}</strong><b>{count}</b></span>) : <span>暂无任务错误分布</span>}</div><div>{[...new Set(data.qualityReviews.map((item) => item.annotatorUsername).filter(Boolean))].map((username) => { const rows = data.qualityReviews.filter((item) => item.annotatorUsername === username); const passes = rows.filter((item) => item.outcome === "passed").length; return <span key={username}><strong>@{username}</strong><b>{passes}/{rows.length} 通过</b></span>; })}</div></div></section>
    <section className="supervision-section"><Heading kicker="REVIEW HISTORY" title="完成、复核、返工与再通过历史" /><div className="supervision-table-wrap"><table><thead><tr><th>复核时间</th><th>标注员 / 修订</th><th>任务 / 轨迹</th><th>片段 / 帧</th><th>结果</th><th>错误类型</th><th>复核人</th><th>返工链</th><th>意见</th></tr></thead><tbody>{data.qualityReviews.map((item) => <tr key={item.reviewId}><td>{formatTime(item.reviewedAtMs)}</td><td>@{item.annotatorUsername || "—"} / {item.annotationRevision ? `r${item.annotationRevision}` : "—"}</td><td>{item.taskId}<br /><code>{item.trajectoryCode}</code></td><td>{item.segmentIndex ?? "—"} / {item.startFrame !== null && item.endFrame !== null ? `${item.startFrame}–${item.endFrame}` : "—"}</td><td>{item.outcome === "passed" ? "通过" : "返工"}</td><td>{item.errorType || "—"}</td><td>@{item.reviewer}</td><td>{item.parentReviewId ? "返工后复核" : item.reworkAssignmentCreated ? "已生成返工任务" : "首次复核"}</td><td>{item.note || "—"}</td></tr>)}</tbody></table></div></section>
  </>;
}

function Reports({ data, annotations, kind, setKind, exportReport, exportDailyWeekly, busy }: { data: SupervisionDashboardData; annotations: SupervisionAnnotationCatalog | null; kind: SupervisionReportKind; setKind: (value: SupervisionReportKind) => void; exportReport: (format: SupervisionReportFormat) => Promise<void>; exportDailyWeekly: (format: SupervisionReportFormat) => Promise<void>; busy: string }) {
  const local = annotationTotals(annotations);
  return <><section className="supervision-section report-kind-picker"><Heading kicker="REPORT TYPE" title="选择报表范围" note="日报、周报和任务报表均支持三种格式" /><div role="group">{(["daily", "weekly", "task"] as const).map((value) => <button type="button" className={kind === value ? "active" : ""} onClick={() => setKind(value)} key={value}>{reportKindLabel(value)}</button>)}</div></section><section className="report-actions"><button type="button" onClick={() => void exportReport("json")} disabled={Boolean(busy)}><FileJson size={22} /><strong>导出 JSON</strong><span>结构化{reportKindLabel(kind)}</span></button><button type="button" onClick={() => void exportReport("csv")} disabled={Boolean(busy)}><Download size={22} /><strong>导出 CSV</strong><span>可在表格软件中查看</span></button><button type="button" onClick={() => void exportReport("html")} disabled={Boolean(busy)}><ClipboardCheck size={22} /><strong>导出可打印 HTML</strong><span>生成后自动打开所在文件夹</span></button><button type="button" onClick={() => void exportDailyWeekly("json")} disabled={Boolean(busy)}><FileUp size={22} /><strong>批量导出日报 + 周报</strong><span>一次生成两份 JSON 并打开文件夹</span></button></section><section className="supervision-section report-preview"><Heading kicker={kind.toUpperCase()} title={`${reportKindLabel(kind)}预览`} note={dateKey(data.generatedAtMs)} /><div className="report-summary"><span>今日分配<strong>{assignedToday(data)}</strong></span><span>今日完成<strong>{data.overview.completedToday}</strong></span><span>当前剩余<strong>{data.overview.remaining}</strong></span><span>异常数量<strong>{data.alerts.filter((item) => item.status !== "closed").length}</strong></span><span>episode / 片段<strong>{local.episodes || data.overview.totalCompleted} / {local.segments}</strong></span><span>平均耗时<strong>{formatDuration(data.overview.averageCompletionMs ?? weightedAverage(data.users))}</strong></span></div>{kind === "weekly" ? <div className="weekly-preview">{data.dailyTrend.map((item) => <span key={item.date}><small>{item.date.slice(5)}</small><strong>{item.completed}</strong></span>)}</div> : null}{kind === "task" ? <div className="supervision-table-wrap"><table><thead><tr><th>任务</th><th>总量</th><th>已分配</th><th>已完成</th><th>剩余</th><th>参与人数</th><th>平均时长</th></tr></thead><tbody>{data.taskSummaries.map((task) => <tr key={task.task}><td>{task.task}</td><td>{Math.max(task.assigned, task.totalCompleted + task.remaining)}</td><td>{task.assigned}</td><td>{task.totalCompleted}</td><td>{task.remaining}</td><td>{task.operatorCount}</td><td>{formatDuration(task.averageCompletionMs)}</td></tr>)}</tbody></table></div> : null}<p>报表不包含源路径、图像、状态、片段文本、原始数据或 hash。文件使用 partial 回读验证后原子发布，不覆盖已有输出。</p></section></>;
}

function Heading({ kicker, title, note }: { kicker: string; title: string; note?: string }) { return <div className="supervision-section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div>{note ? <small>{note}</small> : null}</div>; }
function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string | number; hint: string }) { return <div>{icon}<span>{label}</span><strong>{typeof value === "number" ? formatCount(value) : value}</strong><small>{hint}</small></div>; }
function plansFor(user: SupervisionUserSummary): AssignmentPlan[] { return user.assignmentPlans.length ? user.assignmentPlans.map((plan, order) => ({ ...plan, order })) : Object.entries(user.assignedTaskQuantities).map(([task, quantity], order) => ({ task, quantity, startIndex: 0, priority: "normal", deadlineAtMs: null, status: "active", order, completed: 0, remaining: quantity, estimatedCompletionAtMs: null })); }
function emptyReview(): QualityReviewRequest { return { taskId: "", trajectoryCode: "", outcome: "passed", errorType: "", note: "", annotatorUsername: "", annotationRevision: null, segmentIndex: null, startFrame: null, endFrame: null, parentReviewId: null }; }
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
function weightedAverage(users: SupervisionUserSummary[]) { const rows = users.filter((user) => user.averageCompletionMs !== null && user.totalCompleted); const total = rows.reduce((sum, user) => sum + user.totalCompleted, 0); return total ? Math.round(rows.reduce((sum, user) => sum + (user.averageCompletionMs ?? 0) * user.totalCompleted, 0) / total) : null; }

function reportPayload(data: SupervisionDashboardData, annotations: SupervisionAnnotationCatalog | null, kind: SupervisionReportKind) {
  const users = data.users.filter((user) => user.role === "operator").map((user) => ({ username: user.username, displayName: user.displayName, accountStatus: user.accountStatus, assigned: user.assignedTasks, completedToday: user.completedToday, totalCompleted: user.totalCompleted, remaining: user.remainingTasks, averageCompletionMs: user.averageCompletionMs, completionRatePerHour: user.completionRatePerHour, lastActivityAtMs: user.lastActivityAtMs, possibleStagnation: user.possibleStagnation }));
  const quality = { reviewCount: data.qualityReviews.length, firstPassRate: qualityRate(data, "passed"), reworkRate: qualityRate(data, "rework"), commonErrors: commonQualityErrors(data) };
  const common = { schemaVersion: 2, reportKind: kind, generatedAtMs: data.generatedAtMs, privacy: "No source paths, episode IDs, descriptions, segment text, images, states, reports, or hashes are included." };
  if (kind === "daily") return { ...common, assignedToday: assignedToday(data), completedToday: data.overview.completedToday, remainingToday: data.overview.remaining, users, averageCompletionMs: data.overview.averageCompletionMs, exceptionCount: data.alerts.filter((item) => item.status !== "closed").length, localCounts: annotationTotals(annotations) };
  if (kind === "weekly") return { ...common, dailyCompletionTrend: data.dailyTrend, accountEfficiency: accountWeeklyEfficiency(data, users), taskTypeEfficiency: data.taskSummaries, quality, slowestTask: [...data.taskSummaries].filter((task) => task.averageCompletionMs !== null).sort((left, right) => (right.averageCompletionMs ?? 0) - (left.averageCompletionMs ?? 0))[0] ?? null, mostCommonError: quality.commonErrors[0] ?? null };
  return { ...common, tasks: data.taskSummaries.map((task) => ({ task: task.task, total: Math.max(task.assigned, task.totalCompleted + task.remaining), assigned: task.assigned, completed: task.totalCompleted, remaining: task.remaining, averageCompletionMs: task.averageCompletionMs, participantCount: task.operatorCount, quality: taskQuality(data, task.task) })) };
}
function reportCsv(data: SupervisionDashboardData, kind: SupervisionReportKind) { const rows: (string | number | null)[][] = kind === "daily" ? [["账号", "显示名称", "今日完成", "累计完成", "剩余", "平均耗时毫秒", "异常标记"], ...data.users.filter((user) => user.role === "operator").map((user) => [user.username, user.displayName, user.completedToday, user.totalCompleted, user.remainingTasks, user.averageCompletionMs, user.possibleStagnation ? "可能停滞" : "正常"])] : kind === "weekly" ? [["日期", "账号/任务", "类别", "完成量/速度", "平均耗时毫秒", "返工数"], ...data.dailyTrend.map((item) => [item.date, "全部账号", "每日趋势", item.completed, null, null]), ...data.users.filter((user) => user.role === "operator").flatMap((user) => data.dailyTrend.map((day) => [day.date, user.username, "账号每日效率", new Set(data.events.filter((event) => event.username === user.username && event.action === "annotation_saved" && dateKey(event.receivedAtMs) === day.date).map((event) => `${event.taskId}\0${event.trajectoryCode}`)).size, user.averageCompletionMs, data.qualityReviews.filter((item) => item.annotatorUsername === user.username && item.outcome === "rework" && dateKey(item.reviewedAtMs) === day.date).length])), ...data.taskSummaries.map((task) => [dateKey(data.generatedAtMs), task.task, "任务类型效率", task.completedToday, task.averageCompletionMs, taskQuality(data, task.task).rework])] : [["任务", "总量", "已分配", "已完成", "剩余", "平均完成时长毫秒", "参与人数", "复核数", "返工数"], ...data.taskSummaries.map((task) => { const quality = taskQuality(data, task.task); return [task.task, Math.max(task.assigned, task.totalCompleted + task.remaining), task.assigned, task.totalCompleted, task.remaining, task.averageCompletionMs, task.operatorCount, quality.reviews, quality.rework]; })]; return `\uFEFF${rows.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`; }
function reportHtml(data: SupervisionDashboardData, annotations: SupervisionAnnotationCatalog | null, kind: SupervisionReportKind) { const payload = reportPayload(data, annotations, kind); const rows = kind === "task" ? data.taskSummaries.map((task) => `<tr><td>${escapeHtml(task.task)}</td><td>${task.assigned}</td><td>${task.totalCompleted}</td><td>${task.remaining}</td><td>${escapeHtml(formatDuration(task.averageCompletionMs))}</td><td>${task.operatorCount}</td></tr>`).join("") : data.users.filter((user) => user.role === "operator").map((user) => `<tr><td>${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</td><td>${user.assignedTasks}</td><td>${user.completedToday}</td><td>${user.totalCompleted}</td><td>${user.remainingTasks}</td><td>${escapeHtml(formatDuration(user.averageCompletionMs))}</td></tr>`).join(""); return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DOHC ${reportKindLabel(kind)}</title><style>body{font:14px system-ui;padding:32px;color:#111}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #bbb;text-align:left}@media print{button{display:none}}</style></head><body><h1>DOHC ${reportKindLabel(kind)}</h1><p>生成时间：${escapeHtml(formatTime(data.generatedAtMs))}</p><p>今日完成 ${data.overview.completedToday} · 累计 ${data.overview.totalCompleted} · 当前剩余 ${data.overview.remaining}</p><table><thead><tr>${kind === "task" ? "<th>任务</th><th>分配</th><th>完成</th><th>剩余</th><th>平均耗时</th><th>人数</th>" : "<th>账号</th><th>分配</th><th>今日</th><th>累计</th><th>剩余</th><th>平均耗时</th>"}</tr></thead><tbody>${rows}</tbody></table><h2>完整结构化数据</h2><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre><script>window.addEventListener('load',()=>window.print())</script></body></html>`; }
function reportKindLabel(kind: SupervisionReportKind) { return kind === "daily" ? "日报" : kind === "weekly" ? "周报" : "任务报表"; }
function assignedToday(data: SupervisionDashboardData) { const today = dateKey(data.generatedAtMs); return data.accounts.filter((account) => dateKey(account.assignmentUpdatedAtMs) === today).reduce((sum, account) => sum + account.assignedTasks, 0); }
function accountWeeklyEfficiency(data: SupervisionDashboardData, users: Array<Record<string, unknown>>) { return users.map((user) => ({ ...user, dailyCompleted: data.dailyTrend.map((day) => ({ date: day.date, completed: new Set(data.events.filter((event) => event.username === user.username && event.action === "annotation_saved" && dateKey(event.receivedAtMs) === day.date).map((event) => `${event.taskId}\0${event.trajectoryCode}`)).size })) })); }
function qualityRate(data: SupervisionDashboardData, outcome: "passed" | "rework") { const first = [...new Map([...data.qualityReviews].sort((a, b) => a.reviewedAtMs - b.reviewedAtMs).map((item) => [item.trajectoryCode, item])).values()]; return first.length ? Math.round(first.filter((item) => item.outcome === outcome).length / first.length * 1000) / 10 : 0; }
function commonQualityErrors(data: SupervisionDashboardData) { return [...data.qualityReviews.reduce((map, item) => { if (item.errorType) map.set(item.errorType, (map.get(item.errorType) ?? 0) + 1); return map; }, new Map<string, number>())].sort((left, right) => right[1] - left[1]).map(([errorType, count]) => ({ errorType, count })); }
function taskQuality(data: SupervisionDashboardData, task: string) { const rows = data.qualityReviews.filter((item) => item.taskId.toLowerCase() === task.toLowerCase()); return { reviews: rows.length, passed: rows.filter((item) => item.outcome === "passed").length, rework: rows.filter((item) => item.outcome === "rework").length, errors: commonQualityErrors({ ...data, qualityReviews: rows }) }; }
function parseBatchAccounts(value: string): BatchAccountInput[] { const accounts = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => { const [username, displayName, password, ...extra] = line.split(",").map((part) => part.trim()); if (extra.length || !/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/.test(username ?? "") || !displayName || [...displayName].length > 40 || !password || [...password].length < 8 || [...password].length > 128) throw new Error(`第 ${index + 1} 行账号格式无效`); return { username, displayName, password }; }); if (!accounts.length || accounts.length > 100 || new Set(accounts.map((item) => item.username)).size !== accounts.length) throw new Error("账号清单必须包含 1-100 个不重复账号"); return accounts; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
