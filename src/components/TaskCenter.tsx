import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, UserCheck, X } from "lucide-react";
import { chooseDirectory, confirmAction } from "../lib/backend";
import { getTaskCenterRoot, setTaskCenterRoot, lookupClaims, mutateClaim, scanTaskCenter, type BatchClaim, type TaskCatalog, type TaskNode } from "../lib/task-center";
import type { UserIdentity } from "../types";
import "./task-center.css";

interface Props {
  currentUser: UserIdentity;
  sourceRoot?: string | null;
  onSourceChange?: (root: string) => void;
  onOpen?: (root: string) => Promise<void>;
  onClose?: () => void;
}

export function TaskCenter({ currentUser, sourceRoot, onSourceChange, onOpen, onClose }: Props) {
  const [root, setRoot] = useState(sourceRoot ?? "");
  const [catalog, setCatalog] = useState<TaskCatalog | null>(null);
  const [claims, setClaims] = useState<Record<string, BatchClaim>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claimsReady, setClaimsReady] = useState(false);
  const [pending, setPending] = useState("");
  const [revision, setRevision] = useState(0);
  const [claimRevision, setClaimRevision] = useState(0);
  const [transferKey, setTransferKey] = useState("");
  const [transferUser, setTransferUser] = useState("");
  const alive = useRef(true);
  const panelRef = useRef<HTMLElement>(null);
  const rootRef = useRef(root); rootRef.current = root;
  const admin = currentUser.role === "admin";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!onClose) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
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
    setCatalog(null); setClaims({}); setClaimsReady(false); setExpanded(new Set([""])); setError(""); setClaimError("");
  }, [root]);
  useEffect(() => {
    if (!root) return;
    let active = true;
    let timer: number;
    async function refresh() {
      if (!active) return;
      if (document.hidden) { timer = window.setTimeout(refresh, 60000); return; }
      setLoading(true);
      try {
        const next = await scanTaskCenter(root);
        if (!active) return;
        setCatalog(next); setError("");
      } catch (reason) { if (active) { setError(String(reason)); setClaimsReady(false); } }
      finally { if (active) { setLoading(false); timer = window.setTimeout(refresh, 60000); } }
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [root, revision]);
  useEffect(() => {
    if (!catalog) return;
    let active = true, running = false;
    async function refreshClaims() {
      if (!catalog || running) return;
      running = true;
      try {
        const keys = catalog.tree.session ? [catalog.tree.batchKey] : catalog.tree.children.map((node) => node.batchKey);
        const values = await lookupClaims(keys);
        if (!active) return;
        setClaims(Object.fromEntries(values.map((claim) => [claim.batchKey, claim]))); setClaimError(""); setClaimsReady(true);
      } catch (reason) { if (active) { setClaimError(String(reason)); setClaimsReady(false); } }
      finally { running = false; }
    }
    void refreshClaims();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshClaims(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [catalog, claimRevision]);
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
    if (pending || !claimsReady) return;
    const currentRoot = root;
    setPending(node.batchKey); setClaimError("");
    try {
      if (action === "release" && !await confirmAction(`释放 ${node.name} 的领取归属？`, "释放批次")) return;
      const result = await mutateClaim(action, node.batchKey, action === "transfer" ? transferUser.trim() : undefined);
      if (!alive.current || rootRef.current !== currentRoot) return;
      setClaims((previous) => { const next = { ...previous }; if (result.claim) next[node.batchKey] = result.claim; else delete next[node.batchKey]; return next; });
      setTransferKey(""); setTransferUser("");
    } catch (reason) {
      if (alive.current && rootRef.current === currentRoot) setClaimError(String(reason));
    } finally { if (alive.current) { setPending(""); setClaimRevision((value) => value + 1); } }
  }
  async function openSession(node: TaskNode) {
    if (!onOpen || pending || error) return;
    setPending(node.relativePath);
    try {
      await onOpen(`${catalog?.sourceRoot ?? root}/${node.relativePath}`);
      if (alive.current) onClose?.();
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setPending(""); }
  }
  function toggle(path: string) { setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  function row(node: TaskNode, depth: number): React.ReactNode {
    const isRoot = depth === 0;
    const isBatch = depth === 1 || (isRoot && node.session);
    const open = expanded.has(node.relativePath);
    const claim = claims[node.batchKey];
    const percent = node.total && !node.incomplete ? Math.floor(node.reviewed * 100 / node.total) : null;
    return <div key={node.relativePath} className="task-tree-node">
      <div className={`task-tree-row${isRoot ? " task-tree-root" : ""}${node.session ? " task-tree-session" : ""}`} style={{ "--tree-depth": depth } as React.CSSProperties}>
        <button className="task-node-name" type="button" title={isRoot ? root : node.name} aria-expanded={node.session ? undefined : open}
          disabled={node.session && (!onOpen || Boolean(pending) || Boolean(error))}
          onClick={() => node.session ? void openSession(node) : toggle(node.relativePath)}>
          {node.session ? <span className="task-chevron-spacer" /> : open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {open && !node.session ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span>{isRoot ? root : node.name}</span>
        </button>
        {node.session ? <span className={`task-qc task-qc-${node.status}`} title={node.error}>{node.status === "approved" ? "已审核 · 通过" : node.status === "rejected" ? "已审核 · 不通过" : node.status === "error" ? "QC 异常" : "未审核"}</span>
          : <><span className="task-owner">{isBatch ? `领取人：${claim ? `${claim.displayName} (@${claim.username})` : claimsReady ? "暂无" : "--"}` : ""}</span>
            <span className={`task-progress${percent === 100 ? " complete" : ""}`} title={node.error || `已审核 ${node.reviewed}/${node.total}；通过 ${node.approved}；不通过 ${node.rejected}；异常 ${node.errors}`}>
              <b>{percent === null ? "--" : `${percent}%`}</b><small>{node.reviewed}/{node.total}{node.errors ? ` · ${node.errors} 异常` : ""}</small>
            </span></>}
        {isBatch && <div className="task-claim-actions">
          {admin ? claim ? <><button type="button" className="button button-secondary" disabled={Boolean(pending) || !claimsReady} onClick={() => { setTransferKey(node.batchKey); setTransferUser(""); }}>转交</button><button type="button" className="button button-secondary" disabled={Boolean(pending) || !claimsReady} onClick={() => void changeClaim("release", node)}>释放</button></> : <span>未领取</span>
            : <button type="button" className="button button-secondary" disabled={Boolean(claim) || Boolean(pending) || !claimsReady || !node.total || node.incomplete} onClick={() => void changeClaim("claim", node)}>
              {claim ? <Check size={14} /> : <UserCheck size={14} />}{pending === node.batchKey ? "提交中" : claim?.username === currentUser.username ? "已领取" : claim ? "已被领取" : "领取"}
            </button>}
        </div>}
      </div>
      {transferKey === node.batchKey && isBatch && <form className="task-transfer" onSubmit={(event) => { event.preventDefault(); void changeClaim("transfer", node); }}>
        <label>审核账号<input value={transferUser} onChange={(event) => setTransferUser(event.target.value)} autoFocus /></label>
        <button type="submit" className="button button-primary" disabled={!transferUser.trim() || Boolean(pending)}>确认转交</button>
        <button type="button" className="button" onClick={() => setTransferKey("")}>取消</button>
      </form>}
      {open && !node.session && node.children.map((child) => row(child, depth + 1))}
    </div>;
  }
  return <section ref={panelRef} className="task-center" role={onClose ? "dialog" : undefined} aria-modal={onClose ? true : undefined} aria-label="任务中心" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && !pending) onClose?.(); }}>
    <header><h2>任务中心</h2><div><button className="icon-button" aria-label="刷新任务进度" title="刷新任务进度" disabled={loading || Boolean(pending)} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={17} className={loading ? "spin" : ""} /></button>{onClose && <button className="icon-button" aria-label="关闭任务中心" title="关闭任务中心" onClick={onClose}><X size={18} /></button>}</div></header>
    <div className="task-root-setting"><span title={root}>默认根目录：{root || "未找到已挂载的数据目录"}</span><button type="button" className="button button-secondary" disabled={Boolean(pending)} onClick={() => void chooseRoot()}><FolderOpen size={16} />更改目录</button></div>
    {(error || claimError) && <p role="alert" className="task-center-error">{error || claimError}</p>}
    <div className="task-tree" aria-busy={loading}>{catalog ? row(catalog.tree, 0) : <p className="task-empty">{loading ? "正在读取任务目录…" : error ? "目录读取失败" : "暂无任务"}</p>}</div>
  </section>;
}
