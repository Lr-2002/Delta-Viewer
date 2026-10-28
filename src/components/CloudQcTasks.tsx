import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, Download, Folder, LoaderCircle, RefreshCw, Settings2, UserRound } from "lucide-react";
import { cloudBatchName, cloudBatchNumber, cloudQcCall, cancelCloudQc, configureCloudQc, fetchCloudQc, syncCloudQc, type CloudPlan, type CloudPolicy, type CloudOperationHandle } from "../lib/cloud-qc";
import type { UserIdentity } from "../types";

const planStates: Record<string, string> = { sampling: "抽检中", sample_passed: "抽检通过", blocked: "审核不通过", full_review: "全量审查中", full_review_complete: "全量审查通过", invalidated: "标注已变化 · 暂停" };
const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "时间未提供";

export function CloudQcTasks({ currentUser, onOpen, workspaceBusy = false, beginOperation }: { currentUser: UserIdentity; onOpen?: (directory: string) => Promise<void>; workspaceBusy?: boolean; beginOperation?: () => CloudOperationHandle | null }) {
  const [admin, setAdmin] = useState(false);
  const [plans, setPlans] = useState<CloudPlan[]>([]);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState("");
  const [policy, setPolicy] = useState<{ version: number; policy: CloudPolicy } | null>(null);
  const [draft, setDraft] = useState<CloudPolicy | null>(null);
  const [reason, setReason] = useState("");
  const [directories, setDirectories] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<number | null>(null);
  const operationRef = useRef<number | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const refreshing = useRef(false);
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    if (alive.current) setFetching(true);
    try {
      const identity = await cloudQcCall<{ account_id: string; role: string }>("identity");
      if (identity.account_id !== currentUser.username) throw Error("CLOUD_QC_ACCOUNT_MISMATCH");
      const isAdmin = identity.role === "admin";
      if (alive.current) setAdmin(isAdmin);
      const result = await cloudQcCall<{ plans: CloudPlan[] }>("tasks");
      if (alive.current) { setPlans(result.plans); setRefreshError(""); setCheckedAt(Date.now()); }
      if (isAdmin) {
        const value = await cloudQcCall<{ version: number; policy: CloudPolicy }>("policy");
        if (alive.current) { setPolicy(value); setDraft(previous => previous ?? value.policy); }
      }
    } catch (reason) { if (alive.current) setRefreshError(String(reason)); }
    finally { refreshing.current = false; if (alive.current) setFetching(false); }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = window.setInterval(() => { if (!locked.current && !document.hidden) void refresh(); }, 5000);
    return () => { alive.current = false; window.clearInterval(timer); if (operationRef.current) void cancelCloudQc(operationRef.current); };
  }, [currentUser.username]);
  async function download(jobId: string, recordingId: string, beforeDownload?: () => Promise<void>) {
    // Reserve the same synchronous owner used by login restore/load/export before
    // claiming or starting native IO. A React busy render alone is too late.
    const owner = beginOperation?.();
    if (beginOperation && !owner) throw Error("正在恢复或处理数据，请等待完成后再打开云端任务。");
    const operationId = owner?.id ?? Date.now();
    operationRef.current = operationId; setOperation(operationId);
    let path: string;
    try {
      await beforeDownload?.();
      if (!alive.current) throw Error("CLOUD_QC_CANCELLED");
      path = await fetchCloudQc(jobId, recordingId, operationId);
    } finally {
      owner?.finish();
      operationRef.current = null; if (alive.current) setOperation(null);
    }
    if (!alive.current) return;
    setDirectories(previous => ({ ...previous, [recordingId]: path }));
    if (onOpen) await onOpen(path); else setNotice(`数据已核验下载至：${path}`);
  }
  async function run(key: string, action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(key); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (reason) { if (alive.current) setError(String(reason)); }
    finally { locked.current = false; if (alive.current) setBusy(""); }
  }
  return <div className="cloud-qc-tasks" aria-label="云端任务">
    <div className="cloud-qc-toolbar">
      <div className="cloud-qc-toolbar-copy"><Cloud size={17} /><span><strong>云端审核任务</strong><small>独立下载副本 · {admin ? "管理员审查" : "批次抽检"}</small></span></div>
      <div className="cloud-qc-toolbar-actions">
        <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void run("configure", async () => { await configureCloudQc(); })}><Settings2 size={14} />连接设置</button>
        <button type="button" className="button button-secondary" disabled={Boolean(busy) || fetching} onClick={() => void run("refresh", refresh)}><RefreshCw size={14} className={fetching ? "spin" : ""} />刷新云端任务</button>
      </div>
    </div>
    <div className="cloud-qc-sync-line"><span>{plans.length} 个批次</span><span>{checkedAt ? `已同步 ${new Date(checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "正在连接"} · 每 5 秒自动刷新</span></div>
    {workspaceBusy && !busy && <p role="status" className="cloud-qc-notice">正在恢复或处理数据，完成后可打开云端任务。</p>}
    {busy && operation && <div className="cloud-qc-notice" role="status"><LoaderCircle size={15} className="spin" /><span>正在下载并核验文件，完成后自动打开…</span><button className="button button-secondary" type="button" onClick={() => void cancelCloudQc(operation!)}>取消下载</button></div>}
    {(error || refreshError) && <div role="alert" className="cloud-qc-notice cloud-qc-error">{error && <span>{error}</span>}{refreshError && <span>任务刷新失败{checkedAt ? "，保留上次结果" : ""}：{refreshError}</span>}</div>}
    {notice && <p role="status" className="cloud-qc-notice"><Check size={15} />{notice}</p>}
    <div className="cloud-qc-list" aria-label="云端批次列表" aria-busy={Boolean(busy) || (!checkedAt && fetching)}>
    {admin && draft && policy && <form className="cloud-qc-policy" onSubmit={event => { event.preventDefault(); void run("policy", async () => {
      const result = await cloudQcCall<{ version: number; policy: CloudPolicy }>("set_policy", { base_version: policy.version, policy: draft, reason });
      setPolicy(result); setDraft(result.policy); setReason(""); setNotice("策略已保存，仅对后续新订单生效；已有批次的名单保持固定。");
    }); }}>
      <strong>公司抽样策略</strong>
      <label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />新订单启用抽检</label>
      <label>比例 <span className="cloud-qc-percent"><input type="number" min="1" max="100" value={draft.sample_percent} onChange={event => setDraft({ ...draft, sample_percent: Number(event.target.value) })} /><span>%</span></span></label>
      <label>批次 <select value={draft.batch_scope} onChange={event => setDraft({ ...draft, batch_scope: event.target.value as CloudPolicy["batch_scope"] })}><option value="sealed_order">一次封存订单</option><option value="recording_parent">每个录制父文件夹</option></select></label>
      <label>通过后 <select value={draft.release_mode} onChange={event => setDraft({ ...draft, release_mode: event.target.value as CloudPolicy["release_mode"] })}><option value="batch_on_sample_pass">抽检通过后放行整批</option><option value="sampled_only">仅交付逐条通过的数据</option></select></label>
      <label>不通过时 <select value={draft.failure_action} onChange={event => setDraft({ ...draft, failure_action: event.target.value as CloudPolicy["failure_action"] })}><option value="hold">阻断并等待管理员决定</option><option value="full_review">转管理员全量审查</option></select></label>
      <label>变更原因 <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required /></label>
      <button className="button button-primary" disabled={Boolean(busy) || !reason.trim()}>保存策略</button>
    </form>}
    {!plans.length && !error && !refreshError && <p className="task-empty">{fetching ? "正在读取云端批次…" : "暂无已完成处理和标注的云端 QC 批次。"}</p>}
    {[...plans].sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0)).map(plan => <section className="cloud-qc-plan" key={plan.id} aria-label={`${cloudBatchName(plan)} · ${cloudBatchNumber(plan)}`}>
      <header>
        <div className="cloud-qc-plan-title"><Folder size={17} /><div><h3>{cloudBatchName(plan)}</h3><small>{!plan.batch_path?.trim() ? "抽检目录 · " : ""}创建 {dateLabel(plan.created_at)} · #{cloudBatchNumber(plan)}</small></div></div>
        <span className={`cloud-qc-badge cloud-qc-state-${plan.state}`}>{planStates[plan.state] ?? plan.state}</span>
        {admin && !plan.full_review && <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => {
          const cause=window.prompt("升级该批次全量审查的原因"); if (!cause?.trim()) return;
          void run(plan.id, async () => { await cloudQcCall("full_review", { job_id: plan.job_id, plan_id: plan.id, body: { base_version: plan.version, reason: cause.trim() } }); });
        }}>转全量审查</button>}
      </header>
      <div className="cloud-qc-plan-summary"><span>抽检 <b>{plan.sample_count}</b> / {plan.population_count}</span><span>通过 <b>{plan.sample_approved}</b></span><span>不通过 <b>{plan.sample_rejected}</b></span><details className="cloud-qc-details"><summary>批次详情<ChevronDown size={13} /></summary><dl><dt>名称依据</dt><dd>{plan.batch_path?.trim() ? "服务端批次目录" : "已抽中数据的共同父目录，不代表整批全部目录"}</dd><dt>完整订单号</dt><dd>{plan.external_order_id}</dd><dt>上传版本</dt><dd>{plan.source_revision}</dd><dt>任务编号</dt><dd>{plan.job_id}</dd><dt>创建时间（北京时间）</dt><dd>{plan.created_at && Number.isFinite(Date.parse(plan.created_at)) ? new Date(plan.created_at).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai",hour12:false}) : "未提供"}</dd></dl></details></div>
      <div className="cloud-qc-scroll">{plan.tasks.map(task => {
        const directory = directories[task.recording_id];
        const mine = task.assignee === currentUser.username;
        return <div className="cloud-qc-row" key={task.recording_id}>
          <div className="cloud-qc-recording"><strong title={task.path}>{task.path.split("/").at(-1) || task.path}</strong><small title={task.path}>{task.path}</small><div className="cloud-qc-recording-meta"><span className={`cloud-qc-decision-${task.qc.decision}`}>{task.qc.decision === "approved" ? "通过" : task.qc.decision === "rejected" ? "不通过" : "待审核"}</span><span><UserRound size={12} />{task.assignee ? (mine ? `我 · ${task.assignee}` : task.assignee) : "未领取"}</span></div>{task.qc.reason && <small className="cloud-qc-rejection">{task.qc.reason}</small>}</div>
          <div className="cloud-qc-row-actions"><button className="button button-primary" type="button" disabled={workspaceBusy || Boolean(busy) || Boolean(task.assignee && !mine)} onClick={() => void run(task.recording_id, () => download(plan.job_id, task.recording_id, async () => {
            if (!mine) await cloudQcCall("claim", { job_id: plan.job_id, plan_id: plan.id, body: { base_version: plan.version, action: "claim", recording_ids: [task.recording_id], reason: "Viewer 任务中心领取" } });
          }))}>{busy === task.recording_id ? "正在获取数据" : mine ? "打开审核" : "领取并打开"}</button>
          <button className="button button-secondary" type="button" disabled={workspaceBusy || Boolean(busy)} onClick={() => void run(`preview:${task.recording_id}`, () => download(plan.job_id, task.recording_id))}><Download size={14} />下载预览</button>
          {directory && mine && <button className="button button-secondary" type="button" disabled={Boolean(busy)} onClick={() => void run("sync", async () => { await syncCloudQc(directory); setNotice("已同步 Viewer 保存的真实审核结论。"); })}>同步已保存的结论</button>}
          </div>
        </div>;
      })}</div>
    </section>)}</div>
  </div>;
}
