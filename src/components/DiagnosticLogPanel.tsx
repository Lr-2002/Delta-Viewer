import {useEffect,useRef,useState} from "react";
import {AlertCircle,CheckCircle2,FileSearch,LoaderCircle,Upload} from "lucide-react";
import {chooseSessionDirectory,getDiagnosticServiceStatus,previewDiagnosticLogs,uploadDiagnosticLogs} from "../lib/backend";
import type {DiagnosticServiceStatus,LogPreview,LogUploadReceipt} from "../lib/d1";

type Operation={id:number;finish:()=>void};
interface Props {busy:boolean;beginOperation:()=>Operation|null;onError:(message:string)=>void}

function reportId(){const now=new Date();const stamp=now.toISOString().replace(/[-:]/g,"").replace(/\.\d+Z$/,"Z");const nonce=Math.random().toString(36).slice(2,8);return `host-log-${stamp}-${nonce}`;}
function idempotencyKey(report:string){return `diag-${report}`.slice(0,200);}

export function DiagnosticLogPanel({busy,beginOperation,onError}:Props){
  const [service,setService]=useState<DiagnosticServiceStatus|null>(null);
  const [source,setSource]=useState("");
  const [preview,setPreview]=useState<LogPreview|null>(null);
  const [receipt,setReceipt]=useState<LogUploadReceipt|null>(null);
  const [working,setWorking]=useState<"preview"|"upload"|null>(null);
  const operation=useRef<Operation|null>(null);
  const pendingReport=useRef<{reportId:string;idempotencyKey:string}|null>(null);

  useEffect(()=>{let active=true;getDiagnosticServiceStatus().then(value=>{if(active)setService(value);}).catch(()=>{});return()=>{active=false;};},[]);

  async function pick(){
    if(busy||working)return;
    const selection=await chooseSessionDirectory("选择一条采集会话目录（含 session.json）");
    if(!selection)return;
    setSource(selection);setPreview(null);setReceipt(null);pendingReport.current=null;
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("preview");
    try{setPreview(await previewDiagnosticLogs(selection));}
    catch(cause){onError(String(cause instanceof Error?cause.message:cause));setSource("");}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }

  async function upload(){
    if(!preview||busy||working)return;
    const frozen=pendingReport.current??{reportId:reportId(),idempotencyKey:""};
    if(!frozen.idempotencyKey)frozen.idempotencyKey=idempotencyKey(frozen.reportId);
    pendingReport.current=frozen;
    setReceipt(null);
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("upload");
    try{
      const value=await uploadDiagnosticLogs(source,frozen.reportId,frozen.idempotencyKey,owner.id);
      setReceipt(value);pendingReport.current=null;
    }catch(cause){
      // Keep the frozen report id and key so a retry stays idempotent.
      onError(String(cause instanceof Error?cause.message:cause));
    }finally{operation.current=null;owner.finish();setWorking(null);}
  }

  const enabled=service?.enabled??false;
  return <section className="manager-card manager-support-upload" aria-label="上传诊断日志">
    <Upload size={26}/>
    <h2>上传诊断日志</h2>
    <p>选择设备采集会话目录，读取 session.json 与 session 日志，上传最近 200 条到设备档案，协助售后定位问题。</p>
    <div className="manager-actions">
      <button className="button button-secondary" disabled={busy||working!==null||!enabled} onClick={()=>void pick()}>
        {working==="preview"?<LoaderCircle size={17} className="spin"/>:<FileSearch size={17}/>}预览包内容
      </button>
      {preview&&<button className="button button-primary" disabled={busy||working!==null||!enabled} onClick={()=>void upload()}>{working==="upload"?<LoaderCircle size={17} className="spin"/>:<Upload size={17}/>}上传诊断包</button>}
    </div>
    {source&&<p className="manager-upload-state" title={source}>来源：{source.split(/[\\/]/).filter(Boolean).pop()}</p>}
    {preview&&<div className="manager-log-preview" aria-label="日志预览">
      <dl className="manager-metadata">
        <div><dt>设备标识</dt><dd>{preview.deviceId??"未提供"}</dd></div>
        <div><dt>应用版本</dt><dd>{preview.workspaceVersion??"未提供"}</dd></div>
        <div><dt>事件总数</dt><dd>{preview.totalEntries}</dd></div>
        <div><dt>将上传</dt><dd>{preview.selectedEntries} 条{preview.truncated?"（已裁剪较早内容）":""}</dd></div>
      </dl>
      <p className="manager-log-levels">
        <span>错误 {preview.levels.error}</span><span>警告 {preview.levels.warning}</span>
        <span>信息 {preview.levels.info}</span>{preview.levels.debug>0&&<span>调试 {preview.levels.debug}</span>}
      </p>
      {!preview.hasCid&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>该会话未记录设备 CID，无法关联已登记设备。</p>}
    </div>}
    {!enabled&&<span className="manager-upload-state">上传服务待接入{service?.detail?`：${service.detail}`:""}</span>}
    {enabled&&<span className="manager-upload-state">{service?.origin??""} · 仅在主动点击后上传一次，不含图像或原始文件</span>}
    {receipt&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>{receipt.message}（{receipt.entryCount} 条，报告 {receipt.reportId}）</p>}
    <p className="manager-privacy">原始日志保留在本机；上传内容为脱敏后的结构化日志，不含源文件。</p>
  </section>;
}
