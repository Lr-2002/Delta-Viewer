import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, CheckSquare, ChevronDown, ChevronRight, FileJson, FileUp, FolderOpen, LoaderCircle, LogOut, Pencil, Plus, RefreshCw, Search, ShieldCheck, Square, Users, X } from "lucide-react";
import { chooseAndScanSupervisionTasks, getSupervisionDashboard, importSupervisionAnnotations, importSupervisionTaskDetails, setSupervisionAssignedTasks, updateSupervisionTaskDetail } from "../lib/backend";
import { sameAssignmentQuantities, validateAssignmentSelection } from "../lib/supervisionAssignments";
import type { SupervisionAnnotationCatalog, SupervisionDashboardData, SupervisionTaskCatalog, UserIdentity } from "../types";

interface SupervisionDashboardProps {
  currentUser: UserIdentity;
  onLogout: () => Promise<void>;
}

export function SupervisionDashboard({ currentUser, onLogout }: SupervisionDashboardProps) {
  const [data, setData] = useState<SupervisionDashboardData | null>(null);
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, Record<string, number>>>({});
  const [selectedOperator, setSelectedOperator] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskCatalog, setTaskCatalog] = useState<SupervisionTaskCatalog | null>(null);
  const [importedTaskNames, setImportedTaskNames] = useState<string[]>([]);
  const [annotationCatalog, setAnnotationCatalog] = useState<SupervisionAnnotationCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingUser, setSavingUser] = useState<string | null>(null);
  const [scanningTasks, setScanningTasks] = useState(false);
  const [importingDetails, setImportingDetails] = useState(false);
  const [importingAnnotations, setImportingAnnotations] = useState(false);
  const [expandedAnnotator, setExpandedAnnotator] = useState<string | null>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [detailDrafts, setDetailDrafts] = useState<Record<string, string>>({});
  const [savingDetail, setSavingDetail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignmentError, setAssignmentError] = useState("");
  const [assignmentNotice, setAssignmentNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getSupervisionDashboard();
      setData(next);
      setAssignmentDrafts(Object.fromEntries(next.users.map((user) => [
        user.username,
        Object.keys(user.assignedTaskQuantities).length
          ? user.assignedTaskQuantities
          : Object.fromEntries(user.assignedTaskNames.map((task) => [task, 1])),
      ])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function selectOperator(username: string | null) {
    setSelectedOperator(username);
    setAssignmentError("");
    setAssignmentNotice("");
  }

  async function saveAssignment(username: string) {
    const quantities = assignmentDrafts[username] ?? {};
    const validationError = validateAssignmentSelection(
      quantities,
      taskCatalog?.tasks ?? [],
      importedTaskNames,
    );
    if (validationError) {
      setAssignmentError(validationError);
      setAssignmentNotice("");
      return;
    }
    setSavingUser(username);
    setError("");
    setNotice("");
    setAssignmentError("");
    setAssignmentNotice("");
    try {
      const saved = await setSupervisionAssignedTasks(username, quantities);
      setData((current) => current ? {
        ...current,
        users: current.users.map((user) => user.username === username ? { ...user, assignedTasks: saved.assignedTasks, assignedTaskNames: saved.assignedTaskNames, assignedTaskQuantities: saved.assignedTaskQuantities } : user),
        accounts: current.accounts.map((account) => account.username === username ? saved : account),
      } : current);
      setAssignmentDrafts((current) => ({
        ...current,
        [username]: { ...saved.assignedTaskQuantities },
      }));
      setAssignmentNotice(`已保存：@${username} 获得 ${saved.assignedTaskNames.length} 类、共 ${saved.assignedTasks} 个任务`);
    } catch (reason) {
      setAssignmentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingUser(null);
    }
  }

  function toggleTaskAssignment(username: string, task: string) {
    setAssignmentError("");
    setAssignmentNotice("");
    setAssignmentDrafts((current) => {
      const selected = current[username] ?? {};
      const existingKey = Object.keys(selected).find((item) => item.toLowerCase() === task.toLowerCase());
      const next = { ...selected };
      if (existingKey) delete next[existingKey];
      else next[task] = 1;
      return {
        ...current,
        [username]: next,
      };
    });
  }

  function setTaskQuantity(username: string, task: string, quantity: number, maximum: number | null) {
    setAssignmentError("");
    setAssignmentNotice("");
    const bounded = Math.max(1, Math.min(maximum ?? 1_000_000, Math.round(quantity) || 1));
    setAssignmentDrafts((current) => ({
      ...current,
      [username]: { ...(current[username] ?? {}), [task]: bounded },
    }));
  }

  function selectAllFolderData(username: string, catalog: SupervisionTaskCatalog | null, imported: string[]) {
    const quantities = Object.fromEntries([
      ...(catalog?.tasks ?? []).map((item) => [item.task, Math.max(1, item.total)] as const),
      ...imported.filter((task) => !(catalog?.tasks ?? []).some((item) => item.task.toLowerCase() === task.toLowerCase())).map((task) => [task, 1] as const),
    ]);
    setAssignmentError("");
    setAssignmentNotice("");
    setAssignmentDrafts((current) => ({ ...current, [username]: quantities }));
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
      const result = await importSupervisionTaskDetails();
      if (result) {
        setData((current) => current ? { ...current, taskDetails: result.taskDetails } : current);
        setImportedTaskNames(result.importedTaskNames);
        setNotice(`已从当前文件读取 ${result.importedTaskNames.length} 个任务`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingDetails(false);
    }
  }

  async function importAnnotations() {
    setImportingAnnotations(true);
    setError("");
    setNotice("");
    try {
      const catalog = await importSupervisionAnnotations();
      if (catalog) {
        setAnnotationCatalog(catalog);
        setExpandedAnnotator(null);
        setNotice(`已读取 ${catalog.users.length} 位标注人`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingAnnotations(false);
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

  const catalogRows = mergedCatalogRows(taskCatalog, importedTaskNames);

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
            <div className="supervision-section-heading overview-heading"><div><span className="section-kicker">TASK OVERVIEW</span><h2>账号任务概览</h2><small>完成时间按用户中心主机的自然日统计；帧数按已分配任务汇总</small></div></div>
            <div className="supervision-table-wrap"><table className="account-overview-table"><colgroup><col className="account-column" /><col className="assignment-column" /><col span={2} className="count-column" /><col className="duration-column" /><col span={2} className="frame-column" /></colgroup><thead><tr><th>账号</th><th>具体分配</th><th>当天完成</th><th>总计完成</th><th>平均完成时间</th><th>已完成帧数</th><th>总帧数</th></tr></thead><tbody>
              {data.users.map((user) => <tr key={user.username}>
                <td><strong>{user.displayName}</strong><small>@{user.username} · {user.role === "admin" ? "监管账户" : "普通账户"}</small></td>
                <td>{user.role === "operator" ? <button className={`assignment-summary-button${selectedOperator === user.username ? " active" : ""}`} type="button" onClick={() => selectOperator(user.username)}><strong>{user.assignedTaskNames.length}</strong><span>{user.assignedTaskNames.length ? `${user.assignedTaskNames.slice(0, 2).map(displayTaskName).join("、")} · 共 ${quantityTotal(user.assignedTaskQuantities)} 个` : "选择具体任务与数量"}{user.assignedTaskNames.length > 2 ? ` 等 ${user.assignedTaskNames.length} 类` : ""}</span><ChevronRight size={15} /></button> : "—"}</td>
                <td className="supervision-number">{user.completedToday}</td>
                <td className="supervision-number">{user.totalCompleted}</td>
                <td>{formatDuration(user.averageCompletionMs)}</td>
                <td className="supervision-number">{assignedFrameTotals(user.assignedTaskNames, taskCatalog)?.completed.toLocaleString("zh-CN") ?? "—"}</td>
                <td className="supervision-number">{assignedFrameTotals(user.assignedTaskNames, taskCatalog)?.total.toLocaleString("zh-CN") ?? "—"}</td>
              </tr>)}
            </tbody></table></div>
          </section>

          {selectedOperator ? (() => {
            const operators = data.users.filter((user) => user.role === "operator");
            const availableTasks = [...new Map([
              ...(taskCatalog?.tasks.map((task) => task.task) ?? []),
              ...importedTaskNames,
            ].map((task) => [task.toLowerCase(), task])).values()];
            const activeUser = operators.find((user) => user.username === selectedOperator) ?? operators[0];
            const selected = activeUser ? assignmentDrafts[activeUser.username] ?? {} : {};
            const persisted = activeUser?.assignedTaskQuantities ?? {};
            const dirty = !sameAssignmentQuantities(selected, persisted);
            const filteredTasks = availableTasks.filter((task) => `${task} ${displayTaskName(task)} ${taskDetail(data, task)?.detail ?? ""}`.toLowerCase().includes(taskSearch.trim().toLowerCase()));
            return <section className="supervision-section assignment-workbench">
              <div className="supervision-section-heading"><div><span className="section-kicker">TASK ASSIGNMENT</span><h2>具体任务分配</h2><small>任务来自当前导入的 JSON 或读取到的任务目录</small></div><button className="icon-button" type="button" onClick={() => selectOperator(null)} title="关闭任务分配" aria-label="关闭任务分配"><X size={16} /></button></div>
              <div className="assignment-layout">
                <aside className="operator-list"><header><Users size={15} /><strong>操作员</strong><span>{operators.length}</span></header>{operators.map((user) => <button key={user.username} className={activeUser?.username === user.username ? "active" : ""} type="button" onClick={() => selectOperator(user.username)}><span><strong>{user.displayName}</strong><small>@{user.username}</small></span><b>{Object.keys(assignmentDrafts[user.username] ?? {}).length}</b></button>)}</aside>
                <div className="assignment-task-picker">
                  {activeUser ? <>
                    <header className="assignment-picker-header"><div><strong>为 {activeUser.displayName} 分配任务</strong><span>已选择 {Object.keys(selected).length} / {availableTasks.length} 类，共 {quantityTotal(selected)} 个</span></div><button className="button button-primary" type="button" disabled={!dirty || savingUser === activeUser.username} onClick={() => void saveAssignment(activeUser.username)}>{savingUser === activeUser.username ? "保存中" : "保存分配"}</button></header>
                    {assignmentError ? <div className="auth-error assignment-feedback" role="alert">{assignmentError}</div> : null}
                    {assignmentNotice ? <div className="supervision-notice assignment-feedback" role="status"><Check size={15} />{assignmentNotice}</div> : null}
                    <div className="assignment-toolbar"><label><Search size={14} /><input value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="搜索任务名称或详情" /></label><button type="button" onClick={() => selectAllFolderData(activeUser.username, taskCatalog, importedTaskNames)} disabled={!taskCatalog?.tasks.length}>全选当前文件夹</button><button type="button" onClick={() => { setAssignmentError(""); setAssignmentNotice(""); setAssignmentDrafts((current) => ({ ...current, [activeUser.username]: Object.fromEntries(filteredTasks.map((task) => [task, current[activeUser.username]?.[task] ?? 1])) })); }}>选择当前结果</button><button type="button" onClick={() => { setAssignmentError(""); setAssignmentNotice(""); setAssignmentDrafts((current) => ({ ...current, [activeUser.username]: {} })); }}>清空</button></div>
                    {filteredTasks.length ? <div className="assignment-task-grid">{filteredTasks.map((task) => {
                      const selectedKey = Object.keys(selected).find((item) => item.toLowerCase() === task.toLowerCase());
                      const checked = selectedKey !== undefined;
                      const quantity = selectedKey ? selected[selectedKey] : 1;
                      const summary = taskCatalog?.tasks.find((item) => item.task.toLowerCase() === task.toLowerCase());
                      const detail = taskDetail(data, task);
                      const others = operators.filter((user) => user.username !== activeUser.username && user.assignedTaskNames.some((item) => item.toLowerCase() === task.toLowerCase()));
                      return <div key={task} className={`assignment-task-card${checked ? " selected" : ""}`}><button type="button" onClick={() => toggleTaskAssignment(activeUser.username, task)} aria-pressed={checked}>{checked ? <CheckSquare size={17} /> : <Square size={17} />}<span><strong>{displayTaskName(task)}</strong><small>{task}</small>{detail ? <em>{detail.detail}</em> : null}</span></button><div className="task-card-meta">{summary ? <><b>{summary.completed}/{summary.total} 完成</b><small>文件夹内共 {summary.total} 条数据</small></> : <b>已导入</b>}{others.length ? <small>另分配给 {others.map((user) => user.displayName).join("、")}</small> : null}{checked ? <label>分配数量<div className="quantity-control"><input type="number" min={1} max={summary?.total ?? 1_000_000} value={quantity} onClick={(event) => event.stopPropagation()} onChange={(event) => setTaskQuantity(activeUser.username, task, Number(event.target.value), summary?.total ?? null)} /><button type="button" onClick={(event) => { event.stopPropagation(); if (summary) setTaskQuantity(activeUser.username, task, summary.total, summary.total); }}>全部</button></div><span>{summary ? `/ ${summary.total}` : "个"}</span></label> : null}</div></div>;
                    })}</div> : <div className="assignment-empty"><FolderOpen size={20} /><strong>暂无可分配任务</strong><span>请选择任务 JSON 或任务目录，读取到的任务会自动出现在这里。</span></div>}
                  </> : <div className="assignment-empty"><Users size={20} /><strong>暂无普通账户</strong><span>请先在用户中心创建操作员账户。</span></div>}
                </div>
              </div>
            </section>;
          })() : null}

          <section className="supervision-section supervision-annotation-module">
            <div className="supervision-section-heading task-catalog-heading">
              <div><span className="section-kicker">ANNOTATION JSON</span><h2>标注人员明细</h2>{annotationCatalog ? <small>{annotationCatalog.sourceName}</small> : null}</div>
              <button className="button button-secondary" type="button" onClick={() => void importAnnotations()} disabled={importingAnnotations}>
                {importingAnnotations ? <LoaderCircle className="spin" size={16} /> : <FileJson size={16} />}{importingAnnotations ? "读取中" : "导入标注 JSON"}
              </button>
            </div>
            {annotationCatalog ? <div className="supervision-table-wrap"><table className="supervision-annotation-table"><thead><tr><th>标注人</th><th>轨迹</th><th>片段</th><th>覆盖帧</th><th>标注任务</th></tr></thead><tbody>
              {annotationCatalog.users.map((user) => {
                const expanded = expandedAnnotator === user.username;
                return <Fragment key={user.username}><tr>
                  <td><button className="annotation-user-button" type="button" onClick={() => setExpandedAnnotator(expanded ? null : user.username)} aria-expanded={expanded}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>{user.displayName}</strong><small>@{user.username}</small></span></button></td>
                  <td className="supervision-number">{formatCount(user.trajectoryCount)}</td>
                  <td className="supervision-number">{formatCount(user.segmentCount)}</td>
                  <td className="supervision-number">{formatCount(user.annotatedFrameCount)}</td>
                  <td><div className="annotation-task-list">{user.tasks.map((task) => <span key={task.taskId}><strong>{displayTaskName(task.taskId)}</strong><small>{formatCount(task.trajectoryCount)} 条 · {formatCount(task.segmentCount)} 段 · {formatCount(task.annotatedFrameCount)} 帧</small></span>)}</div></td>
                </tr>{expanded ? <tr className="annotation-entry-row"><td colSpan={5}><div className="supervision-table-wrap"><table><thead><tr><th>任务</th><th>轨迹码</th><th>片段</th><th>覆盖帧</th><th>修订</th><th>最近更新</th></tr></thead><tbody>{user.entries.map((entry) => <tr key={`${entry.trajectoryCode}-${entry.revision}`}><td>{displayTaskName(entry.taskId)}</td><td><code>{entry.trajectoryCode}</code></td><td>{formatCount(entry.segmentCount)}</td><td>{formatCount(entry.annotatedFrameCount)}</td><td>r{entry.revision}</td><td>{formatAnnotationTime(entry.updatedAtMs)}</td></tr>)}</tbody></table></div></td></tr> : null}</Fragment>;
              })}
            </tbody></table></div> : <div className="task-catalog-empty"><FileJson size={22} /><strong>尚未导入标注 JSON</strong></div>}
          </section>

          <section className="supervision-section supervision-secondary-module">
            <div className="supervision-section-heading task-catalog-heading">
              <div><span className="section-kicker">TASK CATALOG</span><h2>任务完成概览</h2>{taskCatalog ? <small title={taskCatalog.sourcePath}>{taskCatalog.sourcePath}</small> : data.taskDetails.length ? <small>已导入 {data.taskDetails.length} 项任务详情；选择任务目录后显示完成数量</small> : null}</div>
              <div className="task-catalog-actions"><button className="button button-secondary" type="button" onClick={() => void importDetails()} disabled={importingDetails}><FileUp size={16} />{importingDetails ? "导入中" : "导入任务详情"}</button><button className="button button-secondary" type="button" onClick={() => void chooseTaskRoot()} disabled={scanningTasks}>
                {scanningTasks ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}{scanningTasks ? "读取中" : taskCatalog ? "更换任务目录" : "选择任务目录"}
              </button></div>
            </div>
            {catalogRows.length ? <div className="supervision-table-wrap"><table className="task-catalog-table"><thead><tr><th>任务</th><th>现已完成 / 总计数量</th></tr></thead><tbody>
              {catalogRows.map((task) => {
                const detail = taskDetail(data, task.task);
                const expanded = expandedTask === task.task;
                const editing = editingTask === task.task;
                return <Fragment key={task.task}><tr><td><button className="task-name-button" type="button" onClick={() => { setExpandedTask(expanded ? null : task.task); if (expanded) setEditingTask(null); }} aria-expanded={expanded}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>{displayTaskName(task.task)}</strong><small>{task.task}</small></span></button></td><td>{task.total === null ? <span className="task-count-pending">已读取任务，待选择目录统计数量</span> : <div className="task-completion"><strong>{task.completed} / {task.total}</strong><span><i style={{ width: `${task.total ? Math.min(100, (task.completed ?? 0) / task.total * 100) : 0}%` }} /></span></div>}</td></tr>{expanded ? <tr className="task-detail-row"><td colSpan={2}>{editing ? <div className="task-detail-edit"><header><div><strong>{detail ? "编辑任务注解" : "添加任务注解"}</strong><small>description 对应任务注解</small></div><button className="icon-button" type="button" onClick={() => setEditingTask(null)} title="取消编辑" aria-label="取消编辑"><X size={15} /></button></header><textarea autoFocus value={detailDrafts[task.task] ?? detail?.detail ?? ""} onChange={(event) => setDetailDrafts((current) => ({ ...current, [task.task]: event.target.value }))} maxLength={4000} placeholder="输入任务注解" /><footer><span>{(detailDrafts[task.task] ?? detail?.detail ?? "").length} / 4000</span><button className="button button-primary" type="button" onClick={() => void saveDetail(task.task)} disabled={savingDetail === task.task}>{savingDetail === task.task ? "保存中" : "保存注解"}</button></footer></div> : detail ? <div className="task-detail-read"><div><span className="section-kicker">任务注解</span><p>{detail.detail}</p><small>{detail.source === "imported" ? "外部导入" : "管理员编辑"} · {new Date(detail.updatedAtMs).toLocaleString("zh-CN", { hour12: false })}</small></div><button className="button button-secondary" type="button" onClick={() => setEditingTask(task.task)}><Pencil size={14} />编辑</button></div> : <div className="task-detail-empty"><div><strong>还没有任务注解</strong><span>可导入 JSON 的 description，或在这里补充。</span></div><button className="button button-secondary" type="button" onClick={() => setEditingTask(task.task)}><Plus size={14} />添加注解</button></div>}</td></tr> : null}</Fragment>;
              })}
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

function quantityTotal(quantities: Record<string, number>): number {
  return Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatAnnotationTime(value: number): string {
  return value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function taskDetail(data: SupervisionDashboardData | null, task: string) {
  return data?.taskDetails.find((detail) => detail.task.toLowerCase() === task.toLowerCase()) ?? null;
}

function mergedCatalogRows(catalog: SupervisionTaskCatalog | null, importedTaskNames: string[]) {
  const rows = new Map<string, { task: string; completed: number | null; total: number | null; completedFrames?: number; totalFrames?: number }>();
  for (const task of catalog?.tasks ?? []) rows.set(task.task.toLowerCase(), task);
  for (const task of importedTaskNames) {
    if (!rows.has(task.toLowerCase())) rows.set(task.toLowerCase(), { task, completed: null, total: null });
  }
  return [...rows.values()];
}

function assignedFrameTotals(taskNames: string[], catalog: SupervisionTaskCatalog | null) {
  if (!catalog) return null;
  const assigned = new Set(taskNames.map((task) => task.toLowerCase()));
  return catalog.tasks.reduce((result, task) => assigned.has(task.task.toLowerCase()) ? {
    completed: result.completed + task.completedFrames,
    total: result.total + task.totalFrames,
  } : result, { completed: 0, total: 0 });
}
