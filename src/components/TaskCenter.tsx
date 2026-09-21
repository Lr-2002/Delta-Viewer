import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Database, UserCheck, UserMinus, ListFilter, X } from "lucide-react";
import { chooseDirectory, confirmAction, readTaskIndex, rebuildTaskIndex } from "../lib/backend";
import { cacheTaskCatalog, getCachedTaskCatalog, getTaskCenterRoot, mergeIndexedNode, setTaskCenterRoot, lookupClaims, mutateClaim, type BatchClaim, type TaskCatalog, type TaskNode, type TaskIndexStatus } from "../lib/task-center";
import type { UserIdentity } from "../types";
import "./task-center.css";
import { BatchRejectionDialog, type RejectionTarget } from "./BatchRejectionDialog";

interface Props {
  currentUser: UserIdentity;
  sourceRoot?: string | null;
  onSourceChange?: (root: string) => void;
  onOpen?: (root: string) => Promise<void>;
  onClose?: () => void;
  onBeforeReject?: () => void;
  onReviewsSaved?: (paths: string[]) => void;
}

export function TaskCenter({ currentUser, sourceRoot, onSourceChange, onOpen, onClose, onBeforeReject, onReviewsSaved }: Props) {
  const [root, setRoot] = useState(sourceRoot ?? "");
  const [catalog, setCatalog] = useState<TaskCatalog | null>(null);
  const [claims, setClaims] = useState<Record<string, BatchClaim>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [pendingOnlyBatch, setPendingOnlyBatch] = useState("");
  const [pendingResults, setPendingResults] = useState<{ path: string; nodes: TaskNode[]; loading: boolean; error: string }>({ path: "", nodes: [], loading: false, error: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claimActionError, setClaimActionError] = useState("");
  const [openError, setOpenError] = useState("");
  const [claimsReady, setClaimsReady] = useState(false);
  const [pending, setPending] = useState("");
  const [opening, setOpening] = useState(false);
  const [revision, setRevision] = useState(0);
  const [claimRevision, setClaimRevision] = useState(0);
  const [server, setServer] = useState<TaskIndexStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestNotice, setRequestNotice] = useState("");
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [transferKey, setTransferKey] = useState("");
  const [transferUser, setTransferUser] = useState("");
  const alive = useRef(true);
  const actionActive = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const rootRef = useRef(root); rootRef.current = root;
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const catalogRef = useRef(catalog); catalogRef.current = catalog;
  const admin = currentUser.role === "admin";
  const [rejectionSelection, setRejectionSelection] = useState<Record<string, RejectionTarget>>({});
  const [rejection, setRejection] = useState<{ folder?: string; selected?: RejectionTarget[] } | null>(null);
  const rejectedPaths = useRef<string[]>([]);
  function rejectBatch(folder?: string) {
    if (pending || rejection) return;
    try {
      onBeforeReject?.();
      rejectedPaths.current = [];
      setRejection(folder ? {folder} : {selected: Object.values(rejectionSelection)});
    } catch (reason) { setClaimActionError(String(reason)); }
  }
  function reviewSaved(path: string) {
    setRejectionSelection(previous => { const next = {...previous}; delete next[path]; return next; });
    rejectedPaths.current.push(path);
  }
  useEffect(() => {
    if (!pendingOnlyBatch) return;
    let active = true;
    let timer: number;
    async function query() {
      setPendingResults({ path: pendingOnlyBatch, nodes: [], loading: true, error: "" });
      const queue = [pendingOnlyBatch];
      const nodes: TaskNode[] = [];
      try {
        // Read only directory index shards in this batch, with bounded NAS concurrency.
        while (queue.length && active) {
          const results = await Promise.all(queue.splice(0, 4).map((path) => readTaskIndex(root, path)));
          if (!active) return;
          for (const result of results) {
            const node = result.catalog?.tree;
            if (!node || node.incomplete || node.scanning) throw new Error("批次索引不完整，请刷新后重试");
            for (const child of node.children) {
              if (child.session) {
                if (child.status === "pending") nodes.push(child);
              } else if (child.incomplete || child.scanning || child.total > child.reviewed + child.errors) queue.push(child.relativePath);
            }
          }
        }
        if (active) setPendingResults({ path: pendingOnlyBatch, nodes, loading: false, error: "" });
      } catch (reason) {
        if (active) setPendingResults({ path: pendingOnlyBatch, nodes: [], loading: false, error: String(reason) });
      } finally { if (active) timer = window.setTimeout(query, 15000); }
    }
    void query();
    return () => { active = false; window.clearTimeout(timer); };
  }, [root, pendingOnlyBatch, revision]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!onClose) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest(".batch-rejection-dialog")) return;
      if (event.key !== "Tab") return;
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [Boolean(onClose)]);
  useEffect(() => {
    if (root) return;
    let active = true;
    void getTaskCenterRoot().then((value) => { if (active && value) setRoot(value); }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [root]);
  useEffect(() => {
    const cached = getCachedTaskCatalog(currentUser.username, root);
    setCatalog(cached?.catalog ?? null); setServer(null); setLoadingNodes(new Set()); setRequestNotice("");
    setRejectionSelection({});
    setClaims({}); setClaimsReady(false); setExpanded(new Set([""])); setPendingOnlyBatch(""); setError(""); setClaimError(""); setClaimActionError(""); setOpenError("");
  }, [root, currentUser.username]);
  useEffect(() => {
    if (!root) return;
    let active = true;
    let timer: number;
    async function refresh() {
      if (!active) return;
      if (document.hidden) { timer = window.setTimeout(refresh, 60000); return; }
      setLoading(true);
      try {
        const next = await readTaskIndex(root);
        if (!active) return;
        setServer(next.server); setError("");
        if (next.server.running) setRequestNotice("");
        if (next.catalog) {
          cacheTaskCatalog(currentUser.username, root, next.catalog);
          let current = catalogRef.current ? { ...next.catalog, tree: mergeIndexedNode(catalogRef.current.tree, next.catalog.tree) } : next.catalog;
          setCatalog(current);
          // Only expanded directories are fetched; a refresh never scans source QC.
          for (const path of [...expandedRef.current].filter(Boolean).sort((a, b) => a.length - b.length)) {
            const contains = (node: TaskNode): boolean => node.relativePath === path || node.children.some(contains);
            if (!contains(current.tree)) continue;
            const detail = await readTaskIndex(root, path);
            if (!active) return;
            if (detail.catalog) {
              current = { ...current, tree: mergeIndexedNode(current.tree, detail.catalog.tree) };
              setCatalog((previous) => previous ? { ...previous, tree: mergeIndexedNode(previous.tree, detail.catalog!.tree) } : previous);
            }
          }
        }
      } catch (reason) { if (active) setError(String(reason)); }
      finally { if (active) { setLoading(false); timer = window.setTimeout(refresh, 15000); } }
    }
    void refresh();
    return () => {
      active = false; window.clearTimeout(timer);
    };
  }, [root, revision, currentUser.username]);
  const claimKeys = JSON.stringify(catalog ? catalog.tree.session ? [catalog.tree.batchKey] : catalog.tree.children.map((node) => node.batchKey) : []);
  useEffect(() => {
    const keys: string[] = JSON.parse(claimKeys);
    if (!keys.length) return;
    let active = true, running = false;
    async function refreshClaims() {
      if (running) return;
      running = true;
      try {
        const values = await lookupClaims(keys);
        if (!active) return;
        setClaims(Object.fromEntries(values.map((claim) => [claim.batchKey, claim]))); setClaimError(""); setClaimsReady(true);
      } catch (reason) { if (active) { setClaimError(String(reason)); setClaimsReady(false); } }
      finally { running = false; }
    }
    void refreshClaims();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshClaims(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [claimKeys, claimRevision, root, currentUser.username]);
  async function rebuild() {
    if (!admin || requesting) return;
    setRequesting(true);
    try {
      if (!await confirmAction("立即启动服务器完整统计？现有统计结果仍可使用。", "服务器统计")) return;
      await rebuildTaskIndex(root);
      setRequestNotice("已请求服务器统计"); setRevision((value) => value + 1);
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setRequesting(false); }
  }
  async function chooseRoot() {
    try {
      const chosen = await chooseDirectory("选择任务数据根目录");
      if (!chosen || !alive.current) return;
      const saved = await setTaskCenterRoot(chosen);
      if (!alive.current) return;
      setRoot(saved); onSourceChange?.(saved);
    } catch (reason) { if (alive.current) setError(String(reason)); }
  }
  async function changeClaim(action: "claim" | "release" | "transfer", node: TaskNode) {
    if (actionActive.current || !claimsReady) return;
    actionActive.current = true;
    const currentRoot = root;
    setPending(node.batchKey); setClaimActionError(""); setOpenError("");
    try {
      if (action === "release" && !await confirmAction(`释放 ${node.name} 的领取归属？已有审核结果和进度将保留，其他审核员可以重新领取。`, "释放批次")) return;
      const result = await mutateClaim(action, node.batchKey, action === "transfer" ? transferUser.trim() : undefined);
      if (!alive.current || rootRef.current !== currentRoot) return;
      setClaims((previous) => { const next = { ...previous }; if (result.claim) next[node.batchKey] = result.claim; else delete next[node.batchKey]; return next; });
      setTransferKey(""); setTransferUser("");
      if (action === "claim" && result.claim?.username === currentUser.username) await enterNode(node, currentRoot);
    } catch (reason) {
      if (alive.current && rootRef.current === currentRoot) setClaimActionError(String(reason));
    } finally { actionActive.current = false; if (alive.current) { setPending(""); setClaimRevision((value) => value + 1); } }
  }
  async function enterNode(node: TaskNode, selectedRoot: string) {
    if (!onOpen || !alive.current || rootRef.current !== selectedRoot) return;
    setOpening(true); setOpenError("");
    try {
      await onOpen(`${catalog?.sourceRoot ?? root}/${node.relativePath}`);
      if (alive.current && rootRef.current === selectedRoot) onClose?.();
    } catch (reason) {
      if (alive.current && rootRef.current === selectedRoot) setOpenError(`数据加载失败：${String(reason)}`);
    } finally { if (alive.current) setOpening(false); }
  }
  async function openNode(node: TaskNode) {
    if (!onOpen || actionActive.current || error) return;
    actionActive.current = true;
    setPending(node.batchKey);
    try { await enterNode(node, root); }
    finally { actionActive.current = false; if (alive.current) setPending(""); }
  }
  async function loadChildren(node: TaskNode) {
    const path = node.relativePath;
    if (node.childrenLoaded !== false || loadingNodes.has(path)) return;
    const selectedRoot = root;
    setLoadingNodes((previous) => new Set(previous).add(path));
    try {
      const next = await readTaskIndex(root, path);
      if (alive.current && rootRef.current === selectedRoot && next.catalog) {
        setCatalog((previous) => previous ? { ...previous, tree: mergeIndexedNode(previous.tree, next.catalog!.tree) } : previous);
      }
    } catch (reason) { if (alive.current && rootRef.current === selectedRoot) setError(String(reason)); }
    finally { if (alive.current && rootRef.current === selectedRoot) setLoadingNodes((previous) => { const next = new Set(previous); next.delete(path); return next; }); }
  }
  async function toggle(node: TaskNode) {
    const path = node.relativePath;
    const opening = !expanded.has(path);
    setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    if (opening) await loadChildren(node);
  }
  async function togglePendingOnly(node: TaskNode) {
    if (pendingOnlyBatch === node.relativePath) {
      setPendingOnlyBatch("");
      await loadChildren(node);
      return;
    }
    setPendingOnlyBatch(node.relativePath);
    setExpanded((previous) => new Set(previous).add(node.relativePath));
  }
  function row(node: TaskNode, depth: number): React.ReactNode {
    const isRoot = depth === 0;
    const isBatch = depth === 1 || (isRoot && node.session);
    const open = expanded.has(node.relativePath);
    const claim = claims[node.batchKey];
    const filteringThisBatch = Boolean(pendingOnlyBatch) && pendingOnlyBatch === node.relativePath;
    const filterLoading = filteringThisBatch && (pendingResults.path !== pendingOnlyBatch || pendingResults.loading);
    const children = filteringThisBatch ? filterLoading ? [] : pendingResults.nodes : node.children;
    const percent = node.total && !node.incomplete && !node.scanning ? Math.floor(node.reviewed * 100 / node.total) : null;
    return <div key={node.relativePath} className="task-tree-node">
      <div className={`task-tree-row${isRoot ? " task-tree-root" : ""}${node.session ? " task-tree-session" : ""}`} style={{ "--tree-depth": depth } as React.CSSProperties}>
        {!admin && node.session && node.status === "pending" && <input type="checkbox" className="task-rejection-select" aria-label={`选择 ${node.name}`} checked={Boolean(rejectionSelection[`${catalog?.sourceRoot ?? root}/${node.relativePath}`])} disabled={Boolean(pending)} onChange={event => {
          const path = `${catalog?.sourceRoot ?? root}/${node.relativePath}`;
          const checked = event.target.checked;
          setRejectionSelection(previous => { const next = {...previous}; if (checked) next[path] = {path, name:node.name}; else delete next[path]; return next; });
        }} />}
        <button className="task-node-name" type="button" title={isRoot ? root : node.name} aria-expanded={node.session ? undefined : open}
          disabled={node.session && (!onOpen || Boolean(pending) || Boolean(error))}
          onClick={() => node.session ? void openNode(node) : void toggle(node)}>
          {node.session ? <span className="task-chevron-spacer" /> : open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {open && !node.session ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span>{isRoot ? root : node.name}</span>
        </button>
        {node.session ? <span className={`task-qc task-qc-${node.status}`} title={node.error}>{node.status === "approved" ? "已审核 · 通过" : node.status === "rejected" ? "已审核 · 不通过" : node.status === "error" ? "QC 异常" : "未审核"}</span>
          : <><span className="task-owner">{isBatch ? `领取人：${claim ? `${claim.displayName} (@${claim.username})` : claimsReady ? "暂无" : "--"}` : ""}</span>
            <span className={`task-progress${percent === 100 ? " complete" : ""}`} title={node.error || `已审核 ${node.reviewed}/${node.total}；通过 ${node.approved}；不通过 ${node.rejected}；异常 ${node.errors}`}>
              <b>{percent === null ? "--" : `${percent}%`}</b><small>{node.scanning ? loading ? "统计中" : "未完成" : `${node.reviewed}/${node.total}`}{node.errors ? ` · ${node.errors} 异常` : ""}</small>
            </span></>}
        {isBatch && <div className="task-claim-actions">
          {!admin && !node.session && <button type="button" className="button button-secondary" disabled={Boolean(pending) || Boolean(error)} onClick={() => rejectBatch(`${catalog?.sourceRoot ?? root}/${node.relativePath}`)}><X size={14} />文件夹不通过</button>}
          {!node.session && <button type="button" className="button button-secondary task-pending-filter" aria-pressed={filteringThisBatch} disabled={Boolean(pending)} onClick={() => void togglePendingOnly(node)}>
            <ListFilter size={14} />{filteringThisBatch ? "显示全部" : "仅未审核"}
          </button>}
          {claim && (admin || claim.username === currentUser.username) && <button type="button" className="button button-secondary" title="释放批次" disabled={Boolean(pending) || !claimsReady} onClick={() => void changeClaim("release", node)}><UserMinus size={14} />释放</button>}
          {admin ? claim ? <button type="button" className="button button-secondary" disabled={Boolean(pending) || !claimsReady} onClick={() => { setTransferKey(node.batchKey); setTransferUser(""); }}>转交</button> : <span>未领取</span>
            : <button type="button" className="button button-secondary" disabled={Boolean(claim && claim.username !== currentUser.username) || Boolean(pending) || Boolean(error) || !claimsReady || !onOpen || !node.total || node.incomplete || node.scanning} onClick={() => claim?.username === currentUser.username ? void openNode(node) : void changeClaim("claim", node)}>
              {claim?.username === currentUser.username ? <FolderOpen size={14} /> : claim ? <Check size={14} /> : <UserCheck size={14} />}{pending === node.batchKey ? opening ? "正在加载" : "提交中" : claim?.username === currentUser.username ? "进入审核" : claim ? "已被领取" : "领取"}
            </button>}
        </div>}
      </div>
      {transferKey === node.batchKey && isBatch && <form className="task-transfer" onSubmit={(event) => { event.preventDefault(); void changeClaim("transfer", node); }}>
        <label>审核账号<input value={transferUser} onChange={(event) => setTransferUser(event.target.value)} autoFocus /></label>
        <button type="submit" className="button button-primary" disabled={!transferUser.trim() || Boolean(pending)}>确认转交</button>
        <button type="button" className="button" onClick={() => setTransferKey("")}>取消</button>
      </form>}
      {open && !node.session && children.map((child) => row(filteringThisBatch ? { ...child, name: child.relativePath.slice(node.relativePath.length + 1) } : child, depth + 1))}
      {open && filteringThisBatch && (filterLoading ? <p className="task-empty" role="status">正在查询未审核数据…</p> : pendingResults.error ? <p className="task-center-error" role="alert">{pendingResults.error}</p> : <p className="task-empty" role="status">{children.length ? `未审核 ${children.length} 条` : "当前批次没有未审核数据"}</p>)}
      {open && loadingNodes.has(node.relativePath) && <p className="task-empty">正在读取目录明细…</p>}
    </div>;
  }
  return <section ref={panelRef} className="task-center" role={onClose ? "dialog" : undefined} aria-modal={onClose ? true : undefined} aria-label="任务中心" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && !pending && !rejection) onClose?.(); }}>
    <header><h2>任务中心</h2><div>{admin && <button className="button button-secondary" disabled={requesting || server?.running} onClick={() => void rebuild()}><Database size={16} />立即统计</button>}<button className="icon-button" aria-label="刷新任务进度" title="刷新任务进度" disabled={loading || Boolean(pending)} onClick={() => { setRevision((value) => value + 1); setClaimRevision((value) => value + 1); }}><RefreshCw size={17} className={loading ? "spin" : ""} /></button>{onClose && <button className="icon-button" aria-label="关闭任务中心" title="关闭任务中心" onClick={onClose}><X size={18} /></button>}</div></header>
    <div className="task-root-setting"><span title={root}>默认根目录：{root || "未找到已挂载的数据目录"}</span><button type="button" className="button button-secondary" disabled={Boolean(pending)} onClick={() => void chooseRoot()}><FolderOpen size={16} />更改目录</button></div>
    {(error || claimError || claimActionError || openError) && <p role="alert" className="task-center-error">{error || claimError || claimActionError || openError}</p>}
    <div className="task-scan-status" role="status">
      <span>服务器最近统计完成：{server?.completedAtMs ? new Date(server.completedAtMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚无完整统计"}（北京时间）</span>
      <span>每日 23:00 自动统计</span>
      {server?.updatedAtMs && server.updatedAtMs !== server.completedAtMs ? <span>进度更新：{new Date(server.updatedAtMs).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span> : null}
      {server && Date.now() - server.heartbeatAtMs > 90000 ? <span className="task-center-error">统计服务未响应，显示上次结果</span> : server?.running ? <span>服务器正在统计 · 已统计 {server.sessions} 条 · 显示上次结果</span> : null}
      {server?.error && <span role="alert" className="task-center-error">{server.error}；保留上次成功结果</span>}
      {requestNotice && <span>{requestNotice}</span>}
    </div>
    {!admin && <div className="task-batch-rejection-toolbar"><span>已选择 {Object.keys(rejectionSelection).length} 条</span><button type="button" className="button button-secondary" disabled={!Object.keys(rejectionSelection).length || Boolean(pending)} onClick={() => rejectBatch()}><X size={14} />批量不通过</button><button type="button" className="button button-secondary" disabled={!Object.keys(rejectionSelection).length || Boolean(pending)} onClick={() => setRejectionSelection({})}>清空选择</button></div>}
    <div className="task-tree" aria-busy={loading}>{catalog ? row(catalog.tree, 0) : <p className="task-empty">{loading ? "正在读取服务器统计…" : error ? "统计读取失败" : "等待服务器首次统计完成"}</p>}</div>
    {rejection && <BatchRejectionDialog {...rejection} onSaved={reviewSaved} onClose={() => { if (rejectedPaths.current.length) onReviewsSaved?.(rejectedPaths.current); setRejection(null); setRevision(value => value + 1); }} />}
  </section>;
}
