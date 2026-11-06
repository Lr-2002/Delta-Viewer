import {useEffect, useRef, useState} from "react";
import {ArrowRight, Cable, CheckCircle2, ClipboardList, Download, FileArchive, FolderOpen, HardDrive, LoaderCircle, ShieldCheck, WifiOff} from "lucide-react";
import {cancelTask, chooseDirectory, clearDeviceSimulation, exportDeviceBundle, getDeviceAvailability, isTauriRuntime, previewDeviceBundle, revealOutput, runDeviceSimulation} from "../lib/backend";
import {deviceResultLabels, deviceScenarios, deviceTaskLabels, type DeviceAvailability, type DeviceBundlePreview, type DeviceRun, type DeviceScenario, type ManagerSection} from "../lib/d1";
import "./manager-workspace.css";

type Operation = {id:number; finish:()=>void};
interface Props {section:ManagerSection; busy:boolean; beginOperation:()=>Operation|null; onNavigate:(section:ManagerSection)=>void}
const time=(ms:number|null)=>ms===null?"未观测":new Date(ms).toLocaleString("zh-CN",{hour12:false});
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
export function ManagerWorkspace({section,busy,beginOperation,onNavigate}:Props) {
  const [availability,setAvailability]=useState<DeviceAvailability|null>(null);
  const [simulation,setSimulation]=useState(false);
  const [scenario,setScenario]=useState<DeviceScenario>("success");
  const [run,setRun]=useState<DeviceRun|null>(null);
  const [preview,setPreview]=useState<DeviceBundlePreview|null>(null);
  const [range,setRange]=useState({fromMs:0,toMs:0});
  const [output,setOutput]=useState("");
  const [error,setError]=useState("");
  const [working,setWorking]=useState<"diagnostics"|"preview"|"export"|null>(null);
  const [cancelling,setCancelling]=useState(false);
  const operation=useRef<Operation|null>(null);
  const otaWaiting=availability?.configuration.deviceOta.status === "waiting_interface";
  useEffect(()=>{
    if(section==="data") return;
    let active=true;
    void getDeviceAvailability().then(value=>{if(active)setAvailability(value);}).catch(cause=>{if(active)setError(errorText(cause));});
    return()=>{active=false;};
  },[section]);
  useEffect(()=>()=>{if(operation.current) void cancelTask(operation.current.id);},[]);
  function enableSimulation(){setSimulation(true);setError("");onNavigate("diagnostics");}
  async function leaveSimulation(){if(busy||working)return;await clearDeviceSimulation();setSimulation(false);setRun(null);setPreview(null);setOutput("");setError("");}
  async function detect(){
    if(busy||working||!simulation)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("diagnostics");setRun(null);setPreview(null);setOutput("");setError("");setCancelling(false);
    try{const result=await runDeviceSimulation(scenario,owner.id);setRun(result);setRange({fromMs:result.startedAtMs,toMs:result.finishedAtMs});}
    catch(cause){setError(errorText(cause));}
    finally{operation.current=null;owner.finish();setWorking(null);setCancelling(false);}
  }
  async function cancel(){
    if(!operation.current||cancelling)return;setCancelling(true);
    try {const accepted=await cancelTask(operation.current.id);if(!accepted)setError("任务已结束或当前取消请求未被接受，请查看最终结果。");}
    catch(cause){setError(errorText(cause));setCancelling(false);}
  }
  async function prepare(){
    if(!run||busy||working)return;setWorking("preview");setError("");setPreview(null);setOutput("");
    try{setPreview(await previewDeviceBundle({runId:run.id,...range}));}catch(cause){setError(errorText(cause));}finally{setWorking(null);}
  }
  async function exportBundle(){
    if(!run||!preview||busy||working)return;
    setWorking("export");setError("");setOutput("");setCancelling(false);
    let owner:Operation|null=null;
    try{
      owner=beginOperation();if(!owner)throw new Error("请先完成当前任务。");operation.current=owner;
      const destination=await chooseDirectory("选择诊断包保存目录");if(!destination)return;
      setOutput(await exportDeviceBundle({runId:run.id,...range},destination,preview.planHash,owner.id));
    }catch(cause){setError(errorText(cause));}finally{operation.current=null;owner?.finish();setWorking(null);setCancelling(false);}
  }
  function updateRange(key:"fromMs"|"toMs",value:number){setRange(previous=>({...previous,[key]:value}));setPreview(null);setOutput("");}
  if(section==="data")return null;
  const disabled=busy||working!==null;
  return <main className="manager-workspace" aria-label="D1 设备工作区">
    {error&&<div className="manager-error" role="alert">{error}<button className="text-button" onClick={()=>setError("")}>关闭</button></div>}
    {section==="home"?<>
      <header className="manager-hero"><div><h1>D1 设备工作台</h1><p>查看设备状态、运行检测并导出诊断信息。</p><div className="manager-actions"><button className="button button-primary" onClick={()=>onNavigate("device")}><Cable size={16}/>查看设备<ArrowRight size={16}/></button><button className="button button-secondary" onClick={()=>onNavigate("data")}><FolderOpen size={16}/>打开数据工作区</button></div></div></header>
      <div className="manager-card-grid"><section className="manager-card"><WifiOff size={21}/><span className="manager-eyebrow">设备连接</span><h2>{simulation?"本地模拟已开启":"尚未连接设备"}</h2><p>{simulation?"当前使用合成场景，未连接真实 D1。":"设备连接暂未开放。可先体验本地模拟检测。"}</p><button className="text-button" disabled={disabled} onClick={simulation?()=>onNavigate("diagnostics"):enableSimulation}>{simulation?"查看模拟检测":"体验本地模拟"}<ArrowRight size={14}/></button></section><section className="manager-card"><FileArchive size={21}/><span className="manager-eyebrow">日志与支持</span><h2>带着证据排障</h2><p>查看检测依据、时间和建议，预览后将诊断包保存在本机。</p><button className="text-button" onClick={()=>onNavigate("support")}>查看诊断包<ArrowRight size={14}/></button></section><section className="manager-card"><HardDrive size={21}/><span className="manager-eyebrow">数据工作区</span><h2>录制数据与审核</h2><p>回放、骨架、标注、审核、任务、NAS 写回与导出。</p><button className="text-button" onClick={()=>onNavigate("data")}>进入数据工作区<ArrowRight size={14}/></button></section></div>
      <section className="manager-status-row"><ShieldCheck size={20}/><div><strong>设备固件更新</strong><p>{otaWaiting ? "等待接口接入" : "状态未知"}</p></div><span className="manager-chip">尚未开放</span></section>
    </>:<>
      <header className="manager-page-heading"><div><span className="manager-eyebrow">D1 MANAGER</span><h1>{section==="device"?"设备管理":section==="diagnostics"?"检测排障":"日志与支持"}</h1><p>{section==="device"?"连接状态、设备身份与固件能力。":section==="diagnostics"?"查看观测证据，区分异常与暂时无法判断。":"先检查内容，再将必要的诊断信息导出到本机。"}</p></div><span className="manager-chip">{simulation?"本地模拟":"未连接"}</span></header>
      {simulation&&<div className="manager-simulation-notice" role="status"><ClipboardList size={17}/><span><strong>本地模拟 · 未连接真实设备</strong>所有身份、版本、能力和检测结果均来自合成场景。</span><button className="text-button" disabled={disabled} onClick={()=>void leaveSimulation().catch(cause=>setError(errorText(cause)))}>退出模拟</button></div>}
      {!simulation?<section className="manager-empty"><Cable size={38} strokeWidth={1.2}/><h2>设备能力尚未接入</h2><p>真实设备连接、自检和日志收集暂未开放。</p><button className="button button-secondary" disabled={disabled} onClick={enableSimulation}>体验本地模拟</button></section>:<>
        {section==="device"&&<><section className="manager-card"><h2>D1 模拟设备</h2><dl className="manager-metadata"><div><dt>来源</dt><dd>本地合成 · 无网络连接</dd></div><div><dt>设备标识</dt><dd>simulated:local-fixture</dd></div><div><dt>固件版本</dt><dd>{run?.device.firmware??"运行检测后显示"}</dd></div><div><dt>已声明能力</dt><dd>{run?.device.capabilities.join(" / ")??"运行检测后显示"}</dd></div></dl><button className="button button-primary" onClick={()=>onNavigate("diagnostics")}>进入模拟检测<ArrowRight size={16}/></button></section><section className="manager-status-row"><ShieldCheck size={20}/><div><strong>设备固件更新</strong><p>{otaWaiting ? "等待接口接入" : "状态未知"}</p></div><span className="manager-chip">尚未开放</span></section></>}
        {section==="diagnostics"&&<>
          <section className="manager-diagnostic-controls" aria-label="模拟检测操作"><label>模拟场景<select aria-label="模拟场景" value={scenario} disabled={disabled} onChange={event=>{setScenario(event.target.value as DeviceScenario);setRun(null);setPreview(null);setOutput("");}}>{deviceScenarios.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button className="button button-primary" disabled={disabled} onClick={()=>void detect()}>{working==="diagnostics"?<LoaderCircle size={16} className="spin"/>:<ShieldCheck size={16}/>}运行模拟检测</button>{working==="diagnostics"&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?"正在取消":"取消检测"}</button>}</section>
          {working==="diagnostics"&&<p className="manager-running" role="status">正在运行本地模拟检测…</p>}
          {run?<><div className="manager-run-summary" role="status"><strong>{deviceTaskLabels[run.status]}</strong><span>{time(run.startedAtMs)} — {time(run.finishedAtMs)}</span><span>{run.device.firmware} · 本地模拟</span></div><div className="manager-checks">{run.checks.map(check=><article className="manager-check" key={check.id}><header><h2>{check.name}</h2><span className={`manager-result result-${check.status}`}>{deviceResultLabels[check.status]}</span></header><dl><div><dt>观测证据</dt><dd>{check.evidence}</dd></div><div><dt>观测时间</dt><dd>{time(check.observedAtMs)}</dd></div><div><dt>判断依据</dt><dd>{check.ruleVersion} · {check.applicableFirmware}</dd></div><div><dt>处理建议</dt><dd>{check.suggestion}</dd></div></dl></article>)}</div><button className="button button-secondary" disabled={disabled} onClick={()=>onNavigate("support")}><FileArchive size={16}/>查看诊断包</button></>:!working&&<section className="manager-empty compact"><ClipboardList size={28}/><h2>尚未运行检测</h2><p>选择合成场景，查看检测状态和对应证据。</p></section>}
          <div className="manager-result-legend" aria-label="诊断结果说明">{Object.entries(deviceResultLabels).map(([key,label])=><span key={key} className={`manager-result result-${key}`}>{label}</span>)}</div>
        </>}
        {section==="support"&&<section className="manager-card"><h2>本地诊断包</h2><p>仅包含本次模拟的检测摘要与合成日志。真实设备日志收集尚未开放。</p>{run?<>
          <dl className="manager-metadata"><div><dt>设备</dt><dd>{run.device.model} · {run.device.id}</dd></div><div><dt>运行范围</dt><dd>{time(run.startedAtMs)} — {time(run.finishedAtMs)}</dd></div></dl>
          <fieldset className="manager-time-range" disabled={disabled}><legend>收集时间范围（本次运行内）</legend><label>起始时间（毫秒）<input aria-label="诊断包起始时间" type="number" min={run.startedAtMs} max={run.finishedAtMs} value={range.fromMs} onChange={event=>updateRange("fromMs",event.target.valueAsNumber)}/></label><label>结束时间（毫秒）<input aria-label="诊断包结束时间" type="number" min={run.startedAtMs} max={run.finishedAtMs} value={range.toMs} onChange={event=>updateRange("toMs",event.target.valueAsNumber)}/></label></fieldset>
          <div className="manager-actions"><button className="button button-secondary" disabled={disabled||!isTauriRuntime()||!Number.isSafeInteger(range.fromMs)||!Number.isSafeInteger(range.toMs)||range.fromMs>range.toMs||range.fromMs<run.startedAtMs||range.toMs>run.finishedAtMs} onClick={()=>void prepare()}><ClipboardList size={16}/>预览包内容</button>{preview&&<button className="button button-primary" disabled={disabled} onClick={()=>void exportBundle()}><Download size={16}/>导出到本机</button>}{working==="export"&&operation.current&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>取消导出</button>}</div>
          {!isTauriRuntime()&&<p>请在桌面客户端预览并导出诊断包。</p>}
          {preview&&<div className="manager-package-preview" aria-label="诊断包预览"><p>{preview.privacy}</p><p>范围：{time(preview.fromMs)} — {time(preview.toMs)} · 已过滤 {preview.filteredMessages} 条敏感合成消息</p>{preview.files.map(file=><article key={file.name}><strong>{file.name}</strong><span>{file.bytes} bytes</span><code>SHA-256 {file.sha256}</code></article>)}</div>}
          {output&&<div className="manager-export-success" role="status"><CheckCircle2 size={17}/><span>已导出：{output}</span><button className="text-button" onClick={()=>void revealOutput(output).catch(cause=>setError(errorText(cause)))}>打开所在位置</button></div>}
        </>:<div className="manager-empty compact"><FileArchive size={28}/><h2>还没有检测记录</h2><p>先完成本地模拟检测，再查看可导出的内容。</p><button className="button button-secondary" onClick={()=>onNavigate("diagnostics")}>前往检测</button></div>}<p className="manager-privacy">诊断信息默认保存在本机，由你决定是否分享给售后。应用不会自动上传诊断包。</p></section>}
      </>}
    </>}
  </main>;
}
