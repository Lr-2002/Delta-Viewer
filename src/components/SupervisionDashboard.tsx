import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileUp, FolderOpen, LoaderCircle, LogOut, Pencil, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { chooseAndScanSupervisionTasks, getSupervisionDashboard, importSupervisionTaskDetails, setSupervisionAssignedTasks, updateSupervisionTaskDetail } from "../lib/backend";
import type { SupervisionDashboardData, SupervisionTaskCatalog, UserIdentity } from "../types";

interface SupervisionDashboardProps {
  currentUser: UserIdentity;
  onLogout: () => Promise<void>;
}

export function SupervisionDashboard({ currentUser, onLogout }: SupervisionDashboardProps) {
  const [data, setData] = useState<SupervisionDashboardData | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [taskCatalog, setTaskCatalog] = useState<SupervisionTaskCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingUser, setSavingUser] = useState<string | null>(null);
  const [scanningTasks, setScanningTasks] = useState(false);
  const [importingDetails, setImportingDetails] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [detailDrafts, setDetailDrafts] = useState<Record<string, string>>({});
  const [savingDetail, setSavingDetail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getSupervisionDashboard();
      setData(next);
      setAssignments(Object.fromEntries(next.users.map((user) => [user.username, String(user.assignedTasks)])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function saveAssignment(username: string) {
    const value = Number(assignments[username]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      setError("分配任务数必须是 0-1000000 的整数");
      return;
    }
    setSavingUser(username);
    setError("");
    setNotice("");
    try {
      await setSupervisionAssignedTasks(username, value);
      setData((current) => current ? {
        ...current,
        users: current.users.map((user) => user.username === username ? { ...user, assignedTasks: value } : user),
        accounts: current.accounts.map((account) => account.username === username ? { ...account, assignedTasks: value } : account),
      } : current);
      setNotice(`已为 @${username} 分配 ${value} 个任务`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingUser(null);
    }
  }

  async function chooseTaskRoot() {
    setScanningTasks(true);
    setError("");
    setNotice("");
    try {
      const catalog = await chooseAndScanSupervisionTasks();
      if (catalog) {
        setTaskCatalog(catalog);
        setNotice(`已读取 ${catalog.tasks.length} 个任务`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScanningTasks(false);
    }
  }

  async function importDetails() {
    setImportingDetails(true);
    setError("");
    try {
      const details = await importSupervisionTaskDetails();
      if (details) {
        setData((current) => current ? { ...current, taskDetails: details } : current);
        setNotice(`已导入 ${details.length} 条任务详情`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingDetails(false);
    }
  }

  async function saveDetail(task: string) {
    const detail = (detailDrafts[task] ?? taskDetail(data, task)?.detail ?? "").trim();
    if (!detail) {
      setError("任务详情不能为空");
      return;
    }
    setSavingDetail(task);
    setError("");
    try {
      const details = await updateSupervisionTaskDetail(task, detail);
      setData((current) => current ? { ...current, taskDetails: details } : current);
      setNotice(`已保存 ${displayTaskName(task)} 的任务详情`);
      setEditingTask(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingDetail(null);
    }
  }

  return (
    <main className="supervision-shell">
      <header className="supervision-header">
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div><strong>DOHC Viewer</strong><span>监管工作台</span></div>
        </div>
        <div className="supervision-account">
          <ShieldCheck size={17} />
          <span><strong>{currentUser.displayName}</strong><small>@{currentUser.username} · 监管账户</small></span>
          <button className="icon-button" type="button" onClick={() => void onLogout()} title="退出登录" aria-label="退出登录"><LogOut size={16} /></button>
        </div>
      </header>

      <section className="supervision-content">
        <div className="supervision-title">
          <div><span className="section-kicker">SUPERVISION</span><h1>任务监管</h1><p>按账号分配任务并查看整段视频标注完成情况。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : undefined} size={16} />刷新
          </button>
        </div>

        {error ? <div className="auth-error supervision-feedback" role="alert">{error}</div> : null}
        {notice ? <div className="supervision-notice" role="status"><Check size={15} />{notice}</div> : null}
        {loading && !data ? <div className="supervision-loading"><LoaderCircle className="spin" size={22} />正在读取监管数据</div> : null}
        {data ? <>
          <section className="supervision-section supervision-primary-module">
            <div className="supervision-section-heading"><div><span className="section-kicker">TASK OVERVIEW</span><h2>账号任务概览</h2></div><small>当天以用户中心所在主机的自然日计算</small></div>
            <div className="supervision-table-wrap"><table><thead><tr><th>账号</th><th>分配任务</th><th>当天完成</th><th>总计完成</th><th>平均完成时间</th></tr></thead><tbody>
              {data.users.map((user) => <tr key={user.username}>
                <td><strong>{user.displayName}</strong><small>@{user.username} · {user.role === "admin" ? "监管账户" : "普通账户"}</small></td>
                <td>{user.role === "operator" ? <div className="assignment-control"><input type="number" min={0} max={1_000_000} step={1} value={assignments[user.username] ?? "0"} onChange={(event) => setAssignments((current) => ({ ...current, [user.username]: event.target.value }))} aria-label={`为 ${user.displayName} 分配任务数量`} /><button className="button button-secondary" type="button" disabled={savingUser === user.username || assignments[user.username] === String(user.assignedTasks)} onClick={() => void saveAssignment(user.username)}>{savingUser === user.username ? "保存中" : "保存"}</button></div> : "—"}</td>
                <td className="supervision-number">{user.completedToday}</td>
                <td className="supervision-number">{user.totalCompleted}</td>
                <td>{formatDuration(user.averageCompletionMs)}</td>
              </tr>)}
            </tbody></table></div>
          </section>

          <section className="supervision-section supervision-secondary-module">
            <div className="supervision-section-heading task-catalog-heading">
              <div><span className="section-kicker">TASK CATALOG</span><h2>任务完成概览</h2>{taskCatalog ? <small title={taskCatalog.sourcePath}>{taskCatalog.sourcePath}</small> : null}</div>
              <div className="task-catalog-actions"><button className="button button-secondary" type="button" onClick={() => void importDetails()} disabled={importingDetails}><FileUp size={16} />{importingDetails ? "导入中" : "导入任务详情"}</button><button className="button button-secondary" type="button" onClick={() => void chooseTaskRoot()} disabled={scanningTasks}>
                {scanningTasks ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}{scanningTasks ? "读取中" : taskCatalog ? "更换任务目录" : "选择任务目录"}
              </button></div>
            </div>
            {taskCatalog ? <div className="supervision-table-wrap"><table className="task-catalog-table"><thead><tr><th>任务</th><th>现已完成 / 总计数量</th></tr></thead><tbody>
              {taskCatalog.tasks.length ? taskCatalog.tasks.map((task) => {
                const detail = taskDetail(data, task.task);
                const expanded = expandedTask === task.task;
                const editing = editingTask === task.task;
                return <Fragment key={task.task}><tr><td><button className="task-name-button" type="button" onClick={() => { setExpandedTask(expanded ? null : task.task); if (expanded) setEditingTask(null); }} aria-expanded={expanded}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>{displayTaskName(task.task)}</strong><small>{task.task}</small></span></button></td><td><div className="task-completion"><strong>{task.completed} / {task.total}</strong><span><i style={{ width: `${task.total ? Math.min(100, task.completed / task.total * 100) : 0}%` }} /></span></div></td></tr>{expanded ? <tr className="task-detail-row"><td colSpan={2}>{editing ? <div className="task-detail-edit"><header><div><strong>{detail ? "编辑任务详情" : "添加任务详情"}</strong><small>填写任务目标、完成标准或注意事项</small></div><button className="icon-button" type="button" onClick={() => setEditingTask(null)} title="取消编辑" aria-label="取消编辑"><X size={15} /></button></header><textarea autoFocus value={detailDrafts[task.task] ?? detail?.detail ?? ""} onChange={(event) => setDetailDrafts((current) => ({ ...current, [task.task]: event.target.value }))} maxLength={4000} placeholder="输入任务详情" /><footer><span>{(detailDrafts[task.task] ?? detail?.detail ?? "").length} / 4000</span><button className="button button-primary" type="button" onClick={() => void saveDetail(task.task)} disabled={savingDetail === task.task}>{savingDetail === task.task ? "保存中" : "保存详情"}</button></footer></div> : detail ? <div className="task-detail-read"><div><span className="section-kicker">任务详情</span><p>{detail.detail}</p><small>{detail.source === "imported" ? "外部导入" : "管理员编辑"} · {new Date(detail.updatedAtMs).toLocaleString("zh-CN", { hour12: false })}</small></div><button className="button button-secondary" type="button" onClick={() => setEditingTask(task.task)}><Pencil size={14} />编辑</button></div> : <div className="task-detail-empty"><div><strong>还没有任务详情</strong><span>可以导入外部 JSON，或在这里补充任务目标与完成标准。</span></div><button className="button button-secondary" type="button" onClick={() => setEditingTask(task.task)}><Plus size={14} />添加详情</button></div>}</td></tr> : null}</Fragment>;
              }) : <tr><td colSpan={2} className="supervision-empty">所选目录中没有识别到任务和 episode</td></tr>}
            </tbody></table></div> : <div className="task-catalog-empty"><FolderOpen size={22} /><strong>选择 NAS 导出的任务目录</strong><span>例如 DOHC_JPEG/Seed_sample；应用只读统计 episode 和 description.json，不修改目录内容。</span></div>}
          </section>
        </> : null}
      </section>
    </main>
  );
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function displayTaskName(task: string): string {
  return task.replaceAll("_", " ");
}

function taskDetail(data: SupervisionDashboardData | null, task: string) {
  return data?.taskDetails.find((detail) => detail.task.toLowerCase() === task.toLowerCase()) ?? null;
}
