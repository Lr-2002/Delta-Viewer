import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Download, FolderOpen, Plus, RefreshCw, Save, Search, Square, Trash2, Undo2, X } from "lucide-react";
import { applyDescriptionCorrections, cancelTask, chooseDirectory, confirmAction, correctionHistory, exportSupervisionReport, getTextPolicy, isTauriRuntime, onTaskProgress, revealOutput, saveTextPolicy, scanDescriptionIssues, undoCorrection, type CorrectionHistory, type CorrectionResult, type DescriptionRow, type DescriptionScan, type TextPolicyResult } from "../lib/backend";
import { defaultTextPolicy, inspectDescription, replaceDescription, type TextPolicy } from "../lib/text-quality";
import "./text-quality.css";

const keyOf = (row: DescriptionRow) => `${row.filePath}:${row.segmentIndex}`;
export function TextCorrectionsPanel() {
  const [root, setRoot] = useState("");
  const [tab, setTab] = useState("scan");
  const [scan, setScan] = useState<DescriptionScan | null>(null);
  const [policyResult, setPolicyResult] = useState<TextPolicyResult | null>(null);
  const [policy, setPolicy] = useState<TextPolicy>(structuredClone(defaultTextPolicy));
  const [history, setHistory] = useState<CorrectionHistory[]>([]);
  const [results, setResults] = useState<CorrectionResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [whole, setWhole] = useState(false);
  const [reviewer, setReviewer] = useState(""); const [batch, setBatch] = useState(""); const [date, setDate] = useState("");
  const [page, setPage] = useState(0); const [reason, setReason] = useState(""); const [mode, setMode] = useState("typo");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState(""); const operation = useRef<number | null>(null);
  const [ruleFrom, setRuleFrom] = useState(""); const [ruleTo, setRuleTo] = useState(""); const [white, setWhite] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<DescriptionRow | null>(null);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void onTaskProgress(value => { if (value.operationId === operation.current) setProgress(value.currentPath); }).then(fn => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); if (operation.current) void cancelTask(operation.current); };
  }, []);
  async function run(job: () => Promise<void>) {
    if (operation.current) return;
    operation.current = Date.now(); setBusy(true); setError(""); setNotice("");
    try { await job(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); operation.current = null; setProgress(""); }
  }
  function invalidate() { setScan(null); setSelected(new Set()); setOverrides({}); setResults([]); setPage(0); }
  async function loadPolicy() { const value = await getTextPolicy(root.trim() || undefined); setPolicyResult(value); setPolicy(value.policy); }
  async function startScan() {
    await run(async () => {
      invalidate(); await loadPolicy();
      const value = await scanDescriptionIssues(root.trim(), operation.current!); setScan(value);
      setNotice(`已扫描 ${value.sessions} 条数据，${value.rows.length} 个片段，${value.errors.length} 项异常`);
    });
  }
  const rows = useMemo(() => (scan?.rows ?? []).filter(row => (!reviewer || row.reviewer.includes(reviewer)) && (!batch || row.relativePath.includes(batch)) && (!date || row.reviewedAt.slice(0,10) === date)).map(row => {
    const issues = inspectDescription(row.description, policy);
    let suggestion = row.description;
    if (from) suggestion = replaceDescription(suggestion, from, to, whole);
    else for (const issue of issues) suggestion = suggestion.split(issue.original).join(issue.suggestion);
    return {row, issues, replacement: overrides[keyOf(row)] ?? suggestion};
  }).filter(({row, replacement}) => row.description !== replacement), [scan, reviewer, batch, date, from, to, whole, policy, overrides]);
  const chosen = rows.filter(({row}) => selected.has(keyOf(row)));
  function resetSelection() { setSelected(new Set()); setOverrides({}); setPage(0); }
  async function apply() {
    const pending = chosen.map(({row, replacement}) => ({filePath:row.filePath, fileHash:row.fileHash, sessionHash:row.sessionHash, segmentIndex:row.segmentIndex, original:row.description, replacement}));
    setConfirming(false);
    await run(async () => {
      const value = await applyDescriptionCorrections(root.trim(), pending, mode, reason, operation.current!); setResults(value);
      const succeeded = new Set(value.filter(r => !r.error).map(r => r.filePath));
      setScan(current => current ? {...current, rows: current.rows.filter(row => !succeeded.has(row.filePath))} : current);
      setSelected(new Set());setOverrides({});setHistory(await correctionHistory());
      setNotice(`已修改 ${succeeded.size} 个文件，${value.filter(r => r.error).length} 个未修改。已改文件需重新扫描后再次处理。`);
    });
  }
  async function exportList() {
    const items = history.filter(item => item.needsReexport);
    const cell = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"','""')}"`;
    const content = "\uFEFF" + [["文件", "勘误编号", "状态", "时间", "需核对旧导出包"], ...items.map(item => [item.filePath,item.id,item.status,new Date(item.atMs).toLocaleString(),"是"])].map(row => row.map(cell).join(",")).join("\r\n");
    const destination = await chooseDirectory("导出需更新清单"); if (!destination) return;
    const result = await exportSupervisionReport(destination,"daily","csv",new Date().toISOString().slice(0,10),Date.now(),content);
    setNotice(`清单已导出：${result.outputPath}`);
  }
  return <section className="text-corrections">
    <nav aria-label="文字勘误视图">{[["scan","历史排查"],["policy","术语与白名单"],["history","修改记录"]].map(([id,label]) => <button key={id} disabled={busy} className={tab===id?"active":""} onClick={() => {setTab(id); if(id==="policy") void run(loadPolicy); if(id==="history") void run(async()=>setHistory(await correctionHistory()));}}>{label}</button>)}</nav>
    <div className="text-quality-toolbar"><label className="text-quality-root">数据根目录<input aria-label="文字勘误数据根目录" value={root} disabled={busy} onChange={e=>{setRoot(e.target.value);invalidate();setPolicyResult(null);}} /></label><button className="icon-button" title="选择数据根目录" aria-label="选择数据根目录" disabled={busy} onClick={()=>void run(async()=>{const value=await chooseDirectory("选择文字勘误数据目录");if(value){setRoot(value);invalidate();setPolicyResult(null);}})}><FolderOpen size={18}/></button>
      {tab==="scan" && <button className="button button-primary" disabled={busy||!root.trim()} onClick={()=>void startScan()}><Search size={16}/>扫描描述</button>}
      {busy && <button className="icon-button" title="取消" aria-label="取消勘误操作" onClick={()=>{if(operation.current)void cancelTask(operation.current);}}><Square size={16}/></button>}
    </div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{progress && <p className="text-quality-path" role="status">{progress}</p>}
    {tab==="scan" && <>
      <div className="text-quality-toolbar"><label>批次 / 路径<input value={batch} disabled={busy} onChange={e=>{setBatch(e.target.value);resetSelection();}}/></label><label>审核人<input value={reviewer} disabled={busy} onChange={e=>{setReviewer(e.target.value);resetSelection();}}/></label><label>审核日期<input type="date" value={date} disabled={busy} onChange={e=>{setDate(e.target.value);resetSelection();}}/></label></div>
      <div className="text-quality-toolbar"><label>查找<input aria-label="查找文字" value={from} disabled={busy} onChange={e=>{setFrom(e.target.value);resetSelection();}}/></label><label>替换为<input aria-label="替换文字" value={to} disabled={busy} onChange={e=>{setTo(e.target.value);resetSelection();}}/></label><label className="text-quality-check"><input type="checkbox" checked={whole} disabled={busy} onChange={e=>{setWhole(e.target.checked);resetSelection();}}/>整词匹配</label></div>
      {scan?.errors.length ? <details><summary>扫描异常 {scan.errors.length} 项，结果不完整</summary>{scan.errors.map((e,i)=><p key={i}>{e}</p>)}</details>:null}
      {scan && <><p>{rows.length} 个待核对片段 · 已选 {chosen.length} 个</p><div className="review-table-wrap"><table aria-label="文字勘误预览"><thead><tr><th><input type="checkbox" aria-label="全选匹配片段" disabled={busy||!rows.length} checked={!!rows.length&&chosen.length===rows.length} onChange={e=>setSelected(e.target.checked?new Set(rows.map(({row})=>keyOf(row))):new Set())}/></th><th>数据 / 片段</th><th>原文</th><th>替换预览</th><th>审核信息</th></tr></thead><tbody>{rows.slice(page*40,page*40+40).map(({row,issues,replacement})=><tr key={keyOf(row)}><td><input type="checkbox" aria-label={`选择片段 ${row.segmentIndex+1} ${row.relativePath}`} checked={selected.has(keyOf(row))} disabled={busy} onChange={e=>setSelected(current=>{const next=new Set(current);if(e.target.checked)next.add(keyOf(row));else next.delete(keyOf(row));return next;})}/></td><td><button className="review-user-link" disabled={busy} onClick={()=>setPreview(row)}>{row.relativePath}</button><small>片段 {row.segmentIndex+1} · 帧 [{row.startFrame}, {row.endFrame+1})</small></td><td>{row.description}<small>{issues.map(i=>i.reason).join("、")}</small></td><td><textarea aria-label={`片段 ${row.segmentIndex+1} 替换预览`} value={replacement} maxLength={4000} disabled={busy} onChange={e=>setOverrides(current=>({...current,[keyOf(row)]:e.target.value}))}/></td><td>{row.reviewer||"--"}<small>{row.qc||"待审核"} · {row.reviewedAt||"--"}</small></td></tr>)}</tbody></table></div><div className="text-quality-toolbar"><button className="icon-button" title="上一页" aria-label="上一页勘误" disabled={!page} onClick={()=>setPage(page-1)}><ChevronLeft/></button><span>{page+1} / {Math.max(1,Math.ceil(rows.length/40))}</span><button className="icon-button" title="下一页" aria-label="下一页勘误" disabled={(page+1)*40>=rows.length} onClick={()=>setPage(page+1)}><ChevronRight/></button></div></>}
      {!scan && !busy && <p>尚未扫描</p>}
      <div className="text-quality-toolbar"><label>修改性质<select aria-label="修改性质" value={mode} disabled={busy} onChange={e=>setMode(e.target.value)}><option value="typo">文字勘误 · 保留审核结论</option><option value="semantic">含义变更 · 恢复待复审</option></select></label><label className="text-quality-root">原因<input aria-label="勘误原因" value={reason} maxLength={1000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><button className="button button-primary" disabled={busy||!chosen.length||chosen.some(r=>!r.replacement.trim())||!reason.trim()} onClick={()=>setConfirming(true)}><Check size={16}/>应用选中修正</button></div>
      {results.map(r=><p key={r.filePath} role={r.error?"alert":"status"}>{r.filePath}：{r.error||"已保存"}</p>)}
    </>}
    {tab==="policy" && <>
      {policyResult && <p className="text-quality-path">术语库：{policyResult.location}</p>}
      <div className="text-quality-toolbar"><label>原词<input aria-label="术语原词" value={ruleFrom} disabled={busy} onChange={e=>setRuleFrom(e.target.value)}/></label><label>规范词<input aria-label="术语规范词" value={ruleTo} disabled={busy} onChange={e=>setRuleTo(e.target.value)}/></label><button className="icon-button" title="添加规则" aria-label="添加规则" disabled={busy||!ruleFrom.trim()||!ruleTo.trim()||ruleFrom.trim()===ruleTo.trim()} onClick={()=>{setPolicy(p=>({...p,rules:[...p.rules.filter(r=>r.from!==ruleFrom.trim()),{from:ruleFrom.trim(),to:ruleTo.trim()}]}));setRuleFrom("");setRuleTo("");}}><Plus/></button></div>
      <ul className="text-quality-rules">{policy.rules.map((r,i)=><li key={`${r.from}:${i}`}><span>{r.from} → {r.to}</span><button className="icon-button" title="删除规则" aria-label={`删除规则 ${r.from}`} disabled={busy} onClick={()=>setPolicy(p=>({...p,rules:p.rules.filter((_,n)=>n!==i)}))}><Trash2 size={16}/></button></li>)}</ul>
      <div className="text-quality-toolbar"><label>白名单词<input aria-label="白名单词" value={white} disabled={busy} onChange={e=>setWhite(e.target.value)}/></label><button className="icon-button" title="加入白名单" aria-label="加入白名单" disabled={busy||!white.trim()} onClick={()=>{setPolicy(p=>({...p,whitelist:[...new Set([...p.whitelist,white.trim()])]}));setWhite("");}}><Plus/></button></div>
      <ul className="text-quality-rules">{policy.whitelist.map(word=><li key={word}>{word}<button className="icon-button" title="移出白名单" aria-label={`移出白名单 ${word}`} disabled={busy} onClick={()=>setPolicy(p=>({...p,whitelist:p.whitelist.filter(w=>w!==word)}))}><Trash2 size={16}/></button></li>)}</ul>
      <div className="text-quality-toolbar"><button className="button button-primary" disabled={busy||!policyResult} onClick={()=>void run(async()=>{const value=await saveTextPolicy(root.trim()||undefined,policy,policyResult!.revision);setPolicyResult(value);setPolicy(value.policy);setNotice("术语库已保存");})}><Save size={16}/>保存术语库</button><button className="icon-button" title="重新读取术语库" aria-label="重新读取术语库" disabled={busy} onClick={()=>void run(loadPolicy)}><RefreshCw size={16}/></button></div>
    </>}
    {tab==="history" && <><div className="text-quality-toolbar"><h2>本机勘误记录</h2><button className="button button-secondary" disabled={busy||!history.length} onClick={()=>void run(exportList)}><Download size={16}/>导出需更新清单</button></div><div className="review-table-wrap"><table aria-label="勘误历史"><thead><tr><th>文件 / 时间</th><th>修改</th><th>操作者 / 原因</th><th>状态</th><th>操作</th></tr></thead><tbody>{history.map(item=><tr key={item.id}><td>{item.filePath}<small>{new Date(item.atMs).toLocaleString()}</small></td><td>{item.changes.map(c=><div key={c.segmentIndex}>{c.original} → {c.replacement}</div>)}</td><td>{item.reviewer}<small>{item.reason}</small></td><td>{item.status==="committed"?"已提交":item.status==="undone"?"已撤销":"待核对提交结果"}<small>{item.mode==="semantic"?"待复审":"文字勘误"} · 旧导出包需核对</small></td><td><button className="icon-button" title="撤销勘误" aria-label={`撤销勘误 ${item.id}`} disabled={busy||item.status==="undone"} onClick={()=>void run(async()=>{if(!await confirmAction("撤销本次文字修改。含义变更仍保持待复审；后续已修改的文件不会被覆盖。","撤销勘误"))return;await undoCorrection(item.id,operation.current!);setHistory(await correctionHistory());setNotice("已撤销");})}><Undo2 size={16}/></button></td></tr>)}</tbody></table></div>{!history.length&&<p>暂无勘误记录</p>}</>}
    {confirming && <dialog className="text-quality-dialog" aria-label="确认文字勘误" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={()=>setConfirming(false)}><h2>确认文字勘误</h2><p>{chosen.length} 个片段，{new Set(chosen.map(r=>r.row.filePath)).size} 个文件。</p><p>{mode==="typo"?"请确认所有修改仅为文字勘误，原审核结论将保留。":"含义发生变化，相关数据将恢复为待复审。"}</p><p>已导出的副本不会自动更新。本次修改将进入需核对清单。</p><footer><button className="button button-secondary" autoFocus onClick={()=>setConfirming(false)}>取消</button><button className="button button-primary" onClick={()=>void apply()}><Check size={16}/>确认修正</button></footer></dialog>}
    {preview && <dialog className="text-quality-dialog" aria-label="片段详情" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={()=>setPreview(null)}><header><h2>片段 {preview.segmentIndex+1}</h2><button className="icon-button" title="关闭" aria-label="关闭片段详情" onClick={()=>setPreview(null)}><X/></button></header><p className="text-quality-path">{preview.filePath}</p><p>帧 [{preview.startFrame}, {preview.endFrame+1})</p><p>{preview.description}</p><button className="button button-secondary" disabled={!isTauriRuntime()} onClick={()=>void run(async()=>revealOutput(preview.filePath))}><FolderOpen size={16}/>打开所在目录</button></dialog>}
  </section>;
}
