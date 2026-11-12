import {useEffect,useRef,useState} from "react";
import {AlertCircle,CheckCircle2,FileSearch,LoaderCircle,Upload} from "lucide-react";
import {chooseSessionDirectory,getDiagnosticServiceStatus,previewDiagnosticLogs,uploadDiagnosticLogs} from "../lib/backend";
import type {DeviceRun,DiagnosticServiceStatus,LogPreview,LogUploadReceipt} from "../lib/d1";

type Operation={id:number;finish:()=>void};
interface Props {run?:DeviceRun|null;busy:boolean;beginOperation:()=>Operation|null;onError:(message:string)=>void}

export function DiagnosticLogPanel({run,busy,beginOperation,onError}:Props){
  const [service,setService]=useState<DiagnosticServiceStatus|null>(null);
  const [source,setSource]=useState("");
  const [preview,setPreview]=useState<LogPreview|null>(null);
  const [receipt,setReceipt]=useState<LogUploadReceipt|null>(null);
  const [working,setWorking]=useState<"preview"|"upload"|null>(null);
  const operation=useRef<Operation|null>(null);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setPreview(null);setReceipt(null);return()=>{generation.current++;};},[run?.id]);

  useEffect(()=>{let active=true;getDiagnosticServiceStatus().then(value=>{if(active)setService(value);}).catch(()=>{});return()=>{active=false;};},[]);

  async function pick(){
    if(busy||working)return;
    const current=generation.current;
    const selection=await chooseSessionDirectory("选择一条采集会话目录（含 session.json）");
    if(!selection||current!==generation.current)return;
    setSource(selection);setPreview(null);setReceipt(null);
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("preview");
    try{const value=await previewDiagnosticLogs(selection,owner.id,run?.id);if(current===generation.current)setPreview(value);}
    catch(cause){onError(String(cause instanceof Error?cause.message:cause));setSource("");}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }

  async function upload(){
    if(!preview||busy||working)return;
    setReceipt(null);
    const current=generation.current;
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("upload");
    try{
      const value=await uploadDiagnosticLogs(preview.previewId,owner.id);
      if(current===generation.current)setReceipt(value);
    }catch(cause){
      // Keep the frozen report id and key so a retry stays idempotent.
      onError(String(cause instanceof Error?cause.message:cause));
    }finally{operation.current=null;owner.finish();setWorking(null);}
  }

  const enabled=service?.enabled??false;
  return <section className="manager-card manager-support-upload" aria-label="上传诊断日志">
    <Upload size={26}/>
    <h2>上传诊断日志</h2>
    <p>{run?"上传本次设备检测结果与最近日志到售后 Device 设备档案。请选择同一台 D1 的任意采集目录，用于核对硬件身份。":"选择设备采集目录，上传最近日志到售后 Device 设备档案。运行设备检测后，可一并上传检测结果。"}</p>
    <div className="manager-actions">
      <button className="button button-secondary" disabled={busy||working!==null||!enabled} onClick={()=>void pick()}>
        {working==="preview"?<LoaderCircle size={17} className="spin"/>:<FileSearch size={17}/>}预览检测与日志
      </button>
      <button className="button button-primary" disabled={busy||working!==null||!enabled||!preview||!!receipt} onClick={()=>void upload()}>{working==="upload"?<LoaderCircle size={17} className="spin"/>:<Upload size={17}/>}上传到售后</button>
    </div>
    {source&&<p className="manager-upload-state" title={source}>来源：{source.split(/[\\/]/).filter(Boolean).pop()}</p>}
    {preview&&<div className="manager-log-preview" aria-label="日志预览">
      <dl className="manager-metadata">
        <div><dt>设备标识</dt><dd>{preview.deviceId??"未提供"}</dd></div>
        <div><dt>应用版本</dt><dd>{preview.workspaceVersion??"未提供"}</dd></div>
        <div><dt>检测项目</dt><dd>{preview.checkCount??0} 项</dd></div>
        <div><dt>事件总数</dt><dd>{preview.totalEntries}</dd></div>
        <div><dt>将上传</dt><dd>{preview.selectedEntries} 条{preview.truncated?"（已裁剪较早内容）":""}</dd></div>
      </dl>
      <p className="manager-log-levels">
        <span>错误 {preview.levels.error}</span><span>警告 {preview.levels.warning}</span>
        <span>信息 {preview.levels.info}</span>{preview.levels.debug>0&&<span>调试 {preview.levels.debug}</span>}
      </p>
      {!preview.hasCid&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>该会话未记录设备 CID，无法关联已登记设备。</p>}
    </div>}
    {!enabled&&<span className="manager-upload-state"><span>上传服务待接入</span>{service?.detail?<small>{service.detail}</small>:null}</span>}
    {enabled&&<span className="manager-upload-state">{service?.origin??""} · 仅在主动点击后上传一次，不含图像或原始文件</span>}
    {receipt&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>{receipt.message}（{receipt.entryCount} 条，报告 {receipt.reportId}）</p>}
    <p className="manager-privacy">原始日志保留在本机；上传内容为脱敏后的结构化日志，不含源文件。</p>
  </section>;
}
