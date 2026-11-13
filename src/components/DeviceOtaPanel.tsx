import {useEffect,useRef,useState} from "react";
import {AlertCircle,CheckCircle2,Info,LoaderCircle,RefreshCw,ShieldCheck,UploadCloud} from "lucide-react";
import {getOtaServiceStatus,previewOtaRelease,submitOtaToDevice,readDeviceOtaStatus,checkDeviceOtaRelease,readOtaHistory,confirmDeviceOtaUpgrade} from "../lib/backend";
import {otaStateLabels,type DeviceOtaStatus,type OtaPreview,type OtaServiceStatus,type DeviceUpgradeRequest,type OtaLogRecord,type OtaSubmitResult} from "../lib/d1";
import {DiagnosticLogPanel} from "./DiagnosticLogPanel";

type Operation={id:number;finish:()=>void};
interface Props {
  request:DeviceUpgradeRequest|null;
  connected:boolean;
  busy:boolean;
  beginOperation:()=>Operation|null;
  onError:(message:string)=>void;
}
const bytes=(value:number)=>value>=1024*1024?`${(value/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.round(value/1024))} KiB`;
const time=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"未提供";

export function DeviceOtaPanel({request,connected,busy,beginOperation,onError}:Props){
  const [service,setService]=useState<OtaServiceStatus|null>(null);
  const [serviceError,setServiceError]=useState("");
  const [preview,setPreview]=useState<OtaPreview|null>(null);
  const [device,setDevice]=useState<DeviceOtaStatus|null>(null);
  const [deviceError,setDeviceError]=useState("");
  const [observedAt,setObservedAt]=useState<string|null>(null);
  const [working,setWorking]=useState<"preview"|"submit"|"status"|null>(null);
  const [notice,setNotice]=useState<OtaSubmitResult|null>(null);
  const [history,setHistory]=useState<OtaLogRecord[]>([]);
  const [historyError,setHistoryError]=useState("");
  const [selectedLog,setSelectedLog]=useState<string|null>(null);
  const operation=useRef<Operation|null>(null);
  const generation=useRef(0);
  const confirming=useRef(false);
  const statusRevision=useRef(0);

  useEffect(()=>{let active=true;readOtaHistory().then(value=>{if(active){setHistory(value);setHistoryError("");}}).catch(cause=>{if(active)setHistoryError(String(cause));});return()=>{active=false;};},[device?.operationId,device?.state,device?.result,working]);

  useEffect(()=>{
    let active=true;
    getOtaServiceStatus().then(value=>{if(active)setService(value);}).catch(cause=>{if(active)setServiceError(String(cause instanceof Error?cause.message:cause));});
    return()=>{active=false;};
  },[]);

  useEffect(()=>{
    generation.current++;
    setDevice(null);setDeviceError("");setObservedAt(null);setPreview(null);setNotice(null);
    if(!request||!connected||!service?.enabled)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      const revision=statusRevision.current;
      try{
        const value=await readDeviceOtaStatus(request as DeviceUpgradeRequest);
        if(active&&revision===statusRevision.current){setDevice(value);setObservedAt(new Date().toISOString());setDeviceError("");}
      }catch(cause){if(active&&revision===statusRevision.current){setDevice(null);setObservedAt(null);setDeviceError(String(cause instanceof Error?cause.message:cause));}}
      finally{if(active)timer=setTimeout(()=>void refresh(),3000);}
    }
    void refresh();
    return()=>{generation.current++;active=false;clearTimeout(timer);};
  },[request,connected,service?.enabled]);

  async function run<T>(kind:"preview"|"submit",task:(owner:Operation)=>Promise<T>):Promise<T|undefined>{
    if(busy||working)return;
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking(kind);
    try{return await task(owner);}
    catch(cause){onError(String(cause instanceof Error?cause.message:cause));return;}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }

  async function checkRelease(){
    const current=generation.current;
    setNotice(null);
    if(!request){onError("请先在设备信息页连接设备。");return;}
    await run("preview",async owner=>{
      const value=await previewOtaRelease(owner.id);
      if(current!==generation.current)return;
      statusRevision.current++;
      const status=await checkDeviceOtaRelease(request,value.previewId,owner.id);
      if(current===generation.current){statusRevision.current++;setPreview(value);setDevice(status);setObservedAt(new Date().toISOString());setDeviceError("");}
    });
  }

  async function submit(){
    if(!request){onError("请先在设备信息页连接设备。");return;}
    if(!preview||!device?.available||device.active||device.state==="UNKNOWN"||confirming.current)return;
    const current=generation.current;
    if(upToDate)return;
    const version=preview.version?` ${preview.version}`:"";
    confirming.current=true;
    try{if(!await confirmDeviceOtaUpgrade(version)||current!==generation.current)return;}
    finally{confirming.current=false;}
    setNotice(null);
    const result=await run("submit",async owner=>submitOtaToDevice(request,owner.id,preview.previewId));
    if(result&&current===generation.current){setNotice(result);}
  }

  const enabled=service?.enabled??false;
  const awaitingOperation=!!notice?.operationId&&device?.operationId!==notice.operationId;
  const canUpgrade=enabled&&connected&&!!request&&device?.available===true&&!device.active&&device.state!=="UNKNOWN"&&!awaitingOperation;
  const upToDate=!!device?.finalState&&device.state==="UP_TO_DATE"&&device.result==="UP_TO_DATE"&&!!preview&&device.releaseTarget===preview.releaseId&&device.currentVersion===preview.version&&device.currentReleaseId===preview.releaseId;
  const currentVersion=device?.currentVersion??device?.releaseBefore;
  const stateLabel=awaitingOperation?"等待设备开始升级":device?.state==="UP_TO_DATE"?(upToDate?"已是最新":preview?"有新版本":"上次检查无需升级"):device?.state?(otaStateLabels[device.state]??device.state):null;
  const failed=!awaitingOperation&&device?.finalState&&(device.state==="FAILED"||device.state==="ROLLBACK_FAILED");
  const submissionFinished=!!notice?.operationId&&device?.operationId===notice.operationId&&device.finalState;

  return <section className="manager-ota" aria-label="DOHC 应用升级">
    <header className="manager-ota-heading">
      <ShieldCheck size={20}/>
      <div><h2>DOHC 应用升级</h2><p>{serviceError||(service?enabled?"连接设备后检查最新版本。":"升级服务暂不可用。":"正在读取升级服务…")}</p></div>
      <span className={`manager-chip${canUpgrade?" is-ready":""}`}>{upToDate?"已是最新":canUpgrade?"可升级":device?.active||awaitingOperation?"升级中":"暂不可升级"}</span>
    </header>
    <aside className="manager-ota-caution" aria-label="升级注意事项"><AlertCircle size={18}/><div><strong>升级前请确认</strong><ul><li>停止录制、自检和压力测试，保持设备连接。</li><li>保持稳定供电，升级过程中请勿关机或断电。</li><li>设备默认要求电压 ≥ 7.3V、温度低于 75℃；实际要求以设备提示为准。</li></ul></div></aside>
    {!connected&&<p className="manager-ota-note">请先连接设备，再检查最新版本。</p>}
    {connected&&!request&&<p className="manager-ota-note">尚未取得设备网络地址，请回到首页重新连接。</p>}
    {connected&&request&&<div className="manager-ota-status" role="status">
      <div><span>设备状态</span><strong>{stateLabel??(deviceError?"读取失败":"读取中…")}</strong></div>
      <div><span>当前版本</span><strong>{currentVersion??"未提供"}</strong></div>
      <div><span>升级操作</span><strong>{(notice?.operationId??device?.operationId)?.slice(0,12)||"无"}</strong></div>
    </div>}
    {deviceError&&connected&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>{deviceError}</p>}
    {device?.logError&&<p className="manager-ota-error" role="alert">{device.logError}</p>}
    {device?.guidance&&!failed&&!awaitingOperation&&device.state!=="UP_TO_DATE"&&<p className="manager-ota-note">{device.guidance}</p>}
    {enabled&&<>
      <div className="manager-actions">
        <button className="button button-secondary" disabled={busy||working!==null||!canUpgrade} onClick={()=>void checkRelease()}>
          {working==="preview"?<LoaderCircle size={17} className="spin"/>:<RefreshCw size={17}/>}检查最新版本
        </button>
        {preview&&!upToDate&&<button className="button button-primary" disabled={busy||working!==null||!canUpgrade} onClick={()=>void submit()}>
          {working==="submit"?<LoaderCircle size={17} className="spin"/>:<UploadCloud size={17}/>}开始升级
        </button>}
      </div>
      {preview&&<div className="manager-ota-release" aria-label="升级包内容">
        <header><strong>最新版本 {preview.version}</strong><span>安装包 {bytes(preview.artifactBytes)}</span></header>
      </div>}
    </>}
    {!enabled&&!serviceError&&<p className="manager-ota-note">升级服务暂不可用，请稍后重试。</p>}
    {upToDate&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>当前已是最新版本 {preview.version}，无需升级。</p>}
    {upToDate&&device?.guidance?.includes("语音提示未播放")&&<p className="manager-ota-note">设备语音提示未播放，请以页面状态为准。</p>}
    {notice&&!submissionFinished&&!upToDate&&<p className="manager-ota-note" role="status"><Info size={17}/>{notice.message}</p>}
    {!awaitingOperation&&device?.finalState&&device.state==="SUCCESS"&&device.result==="PASS"&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>设备报告升级成功。{device.releaseTarget?`目标版本 ${device.targetVersion??device.releaseTarget}。`:""}</p>}
    {failed&&<div className="manager-ota-failure" role="alert">
      <p className="manager-ota-error"><AlertCircle size={17}/><strong>{device.previousResult?"上次升级失败":"升级失败"}</strong></p>
      <p>{device.guidance||device.detail}</p>
      {(device.failureCodes?.length>0||device.reason)&&<details><summary>技术详情</summary>
        {device.failureCodes?.length>0&&<p>{device.failureCodes.join("、")}</p>}
        {device.reason&&<p>{device.reason}</p>}
      </details>}
    </div>}
    {device&&<p className="manager-observed">状态更新于 {time(observedAt)}</p>}
    <details className="manager-ota-history"><summary>升级日志与售后上传（{history.length}）</summary>
      {historyError&&<p className="manager-ota-error" role="alert">{historyError}</p>}
      {!history.length&&!historyError&&<p>尚无升级记录。设备返回的每次升级状态会保存在本机，安装后的完整日志保留在设备。</p>}
      {history.map(record=><article className="manager-ota-release" key={record.id}>
        <header><strong>{record.targetVersion??record.releaseTarget??"升级记录"} · {otaStateLabels[record.state]??record.state}</strong><span>{new Date(record.updatedAtMs).toLocaleString("zh-CN")}</span></header>
        <p>设备 {record.deviceId??"未取得身份"} · {record.events.length} 条日志{record.truncated?"（保留最后 200 条）":""}</p>
        <details><summary>查看本次日志</summary>{record.events.map((entry,index)=><p key={index}>{new Date(entry.atMs).toLocaleTimeString("zh-CN")} · {entry.message}</p>)}</details>
        <button className="button button-secondary" disabled={busy||working!==null} onClick={()=>setSelectedLog(record.id)}>上传本次升级日志到售后</button>
        {record.receipt&&<p className="manager-ota-success">售后已接收：{record.receipt.reportId}</p>}
      </article>)}
      {selectedLog&&<DiagnosticLogPanel key={selectedLog} otaRecordId={selectedLog} busy={busy||working!==null} beginOperation={beginOperation} onError={onError}/>}
    </details>
  </section>;
}
