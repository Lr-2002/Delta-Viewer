import { localeTag, t, tr, useLanguage } from "../lib/i18n";
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
const time=(value:string|null)=>value?new Date(value).toLocaleString(localeTag(),{hour12:false}):"未提供";

export function DeviceOtaPanel({request,connected,busy,beginOperation,onError}:Props){
  useLanguage();
  const [service,setService]=useState<OtaServiceStatus|null>(null);
  const [serviceError,setServiceError]=useState("");
  const [preview,setPreview]=useState<OtaPreview|null>(null);
  const [device,setDevice]=useState<DeviceOtaStatus|null>(null);
  const [deviceError,setDeviceError]=useState("");
  const [observedAt,setObservedAt]=useState<string|null>(null);
  const [working,setWorking]=useState<"preview"|"submit"|"status"|null>(null);
  const [notice,setNotice]=useState<OtaSubmitResult|null>(null);
  const [checkError,setCheckError]=useState("");
  const [checkStage,setCheckStage]=useState<"source"|"device">("source");
  const [history,setHistory]=useState<OtaLogRecord[]>([]);
  const [historyError,setHistoryError]=useState("");
  const [selectedLog,setSelectedLog]=useState<string|null>(null);
  const operation=useRef<Operation|null>(null);
  const submittedOperation=useRef<string|null>(null);
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
    submittedOperation.current=null;
    setDevice(null);setDeviceError("");setObservedAt(null);setPreview(null);setNotice(null);setCheckError("");
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
    if(busy||working||operation.current)return;
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    const current=generation.current;
    operation.current=owner;setWorking(kind);
    try{return await task(owner);}
    catch(cause){if(current===generation.current){const message=String(cause instanceof Error?cause.message:cause);if(kind==="preview")setCheckError(message);else onError(message);}return;}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }

  async function checkRelease(){
    const current=generation.current;
    setNotice(null);setCheckError("");setPreview(null);setCheckStage("source");
    if(!request){onError("请先在设备信息页连接设备。");return;}
    await run("preview",async owner=>{
      const value=await previewOtaRelease(owner.id);
      if(current!==generation.current)return;
      statusRevision.current++;setCheckStage("device");
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
    if(result&&current===generation.current){submittedOperation.current=result.operationId;setNotice(result);}
  }

  const enabled=service?.enabled??false;
  const awaitingOperation=!!notice?.operationId&&device?.operationId!==notice.operationId;
  const canUpgrade=enabled&&connected&&!!request&&device?.available===true&&!device.active&&device.state!=="UNKNOWN"&&!awaitingOperation;
  const upToDate=!!device?.finalState&&device.state==="UP_TO_DATE"&&device.result==="UP_TO_DATE"&&!!preview&&device.releaseTarget===preview.releaseId&&device.currentVersion===preview.version&&device.currentReleaseId===preview.releaseId;
  const currentVersion=device?.currentVersion??device?.releaseBefore;
  const failed=!awaitingOperation&&device?.finalState&&(device.state==="FAILED"||device.state==="ROLLBACK_FAILED");
  const priorFailure=failed&&(device.previousResult||!submittedOperation.current||device.operationId!==submittedOperation.current);
  const stateLabel=awaitingOperation?"等待设备开始升级":priorFailure?"上次升级失败":device?.state==="UP_TO_DATE"?(upToDate?"已是最新":preview?"有新版本":"上次检查无需升级"):device?.state?(otaStateLabels[device.state]??device.state):null;
  const checkSummary=checkError.split("\n",1)[0].replace(/^[A-Z][A-Z0-9_]+:\s*/,"");
  const submissionFinished=!!notice?.operationId&&device?.operationId===notice.operationId&&device.finalState;

  return <section className="manager-ota" aria-label={t("DOHC 应用升级")}>
    <header className="manager-ota-heading">
      <ShieldCheck size={20}/>
      <div><h2>{t("DOHC 应用升级")}</h2><p>{tr(serviceError) || tr((service?enabled?"连接设备后检查最新版本。":"升级服务暂不可用。":"正在读取升级服务…"))}</p></div>
      <span className={`manager-chip${canUpgrade?" is-ready":""}`}>{working==="preview" ? t("正在检查") : upToDate ? t("已是最新") : device?.active||awaitingOperation ? t("升级中") : canUpgrade ? preview ? t("可升级") : t("已连接") : t("暂不可升级")}</span>
    </header>
    <aside className="manager-ota-caution" aria-label={t("升级注意事项")}><AlertCircle size={18}/><div><strong>{t("升级前请确认")}</strong><ul><li>{t("停止录制、自检和压力测试，保持设备连接。")}</li><li>{t("保持稳定供电，升级过程中请勿关机或断电。")}</li><li>{t("设备默认要求电压 ≥ 7.3V、温度低于 75℃；实际要求以设备提示为准。")}</li></ul></div></aside>
    {!connected&&<p className="manager-ota-note">{t("请先连接设备，再检查最新版本。")}</p>}
    {connected&&!request&&<p className="manager-ota-note">{t("尚未取得设备网络地址，请回到首页重新连接。")}</p>}
    {connected&&request&&<div className="manager-ota-status" role="status">
      <div><span>{t("设备状态")}</span><strong>{tr(stateLabel) ?? tr((deviceError?"读取失败":"读取中…"))}</strong></div>
      <div><span>{t("当前版本")}</span><strong>{tr(currentVersion) ?? t("未提供")}</strong></div>
      <div><span>{t("升级操作")}</span><strong>{tr((notice?.operationId??device?.operationId)?.slice(0,12)) || t("无")}</strong></div>
    </div>}
    {tr(deviceError&&connected&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>{tr(deviceError)}</p>)}
    {checkError&&<div className="manager-ota-failure" role="alert">
      <p className="manager-ota-error"><AlertCircle size={17}/><strong>{t("未能完成版本检查")}</strong></p>
      <p>{checkError.startsWith("OTA_DOWNLOAD_TIMEOUT:") ? t("OTA 源站连接或响应超时。请稍后重试；若持续出现，请联系管理员检查升级服务。") : tr(checkSummary)}</p>
      <details><summary>{t("技术详情")}</summary>{checkError.split("\n").map((line,index)=><p key={index}>{tr(line)}</p>)}</details>
    </div>}
    {working==="preview"&&<p className="manager-ota-note" role="status">{checkStage==="source" ? t("正在读取最新版本…") : t("正在核对设备版本…")}</p>}
    {tr(device?.logError&&<p className="manager-ota-error" role="alert">{tr(device.logError)}</p>)}
    {tr(device?.guidance&&!failed&&!awaitingOperation&&device.state!=="UP_TO_DATE"&&<p className="manager-ota-note">{tr(device.guidance)}</p>)}
    {enabled&&<>
      <div className="manager-actions">
        <button className="button button-secondary" disabled={busy||working!==null||!canUpgrade} onClick={()=>void checkRelease()}>
          {working==="preview" ? <LoaderCircle size={17} className="spin"/> : <RefreshCw size={17}/>}{t("检查最新版本")}</button>
        {preview&&!upToDate&&<button className="button button-primary" disabled={busy||working!==null||!canUpgrade} onClick={()=>void submit()}>
          {working==="submit" ? <LoaderCircle size={17} className="spin"/> : <UploadCloud size={17}/>}{t("开始升级")}</button>}
      </div>
      {preview&&<div className="manager-ota-release" aria-label={t("升级包内容")}>
        <header><strong>{t("最新版本") + " "}{preview.version}</strong><span>{t("安装包") + " "}{tr(bytes(preview.artifactBytes))}</span></header>
      </div>}
    </>}
    {!enabled&&!serviceError&&<p className="manager-ota-note">{t("升级服务暂不可用，请稍后重试。")}</p>}
    {upToDate&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>{t("当前已是最新版本") + " "}{preview.version}{t("，无需升级。")}</p>}
    {upToDate&&device?.guidance?.includes("语音提示未播放")&&<p className="manager-ota-note">{t("设备语音提示未播放，请以页面状态为准。")}</p>}
    {notice&&!submissionFinished&&!upToDate&&<p className="manager-ota-note" role="status"><Info size={17}/>{tr(notice.message)}</p>}
    {!awaitingOperation&&device?.finalState&&device.state==="SUCCESS"&&device.result==="PASS"&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>{t("设备报告升级成功。")}{device.releaseTarget ? t("目标版本 {0}。", [tr(device.targetVersion) ?? tr(device.releaseTarget)]) : ""}</p>}
    {failed&&<div className="manager-ota-failure" role="alert">
      <p className="manager-ota-error"><AlertCircle size={17}/><strong>{priorFailure ? t("上次升级失败") : t("升级失败")}</strong></p>
      <p>{tr(device.guidance) || tr(device.detail)}</p>
      {tr((device.failureCodes?.length>0||device.reason)&&<details><summary>{t("技术详情")}</summary>
        {device.failureCodes?.length>0&&<p>{tr(device.failureCodes.join("、"))}</p>}
        {tr(device.reason&&<p>{tr(device.reason)}</p>)}
      </details>)}
    </div>}
    {device&&<p className="manager-observed">{t("状态更新于") + " "}{tr(time(observedAt))}</p>}
    <details className="manager-ota-history"><summary>{t("升级日志与售后上传（")}{history.length}）</summary>
      {tr(historyError&&<p className="manager-ota-error" role="alert">{tr(historyError)}</p>)}
      {!history.length&&!historyError&&<p>{t("尚无升级记录。设备返回的每次升级状态会保存在本机，安装后的完整日志保留在设备。")}</p>}
      {history.map(record=><article className="manager-ota-release" key={record.id}>
        <header><strong>{tr(record.targetVersion) ?? tr(record.releaseTarget) ?? t("升级记录")} · {tr(otaStateLabels[record.state]) ?? tr(record.state)}</strong><span>{tr(new Date(record.updatedAtMs).toLocaleString(localeTag()))}</span></header>
        <p>{t("设备") + " "}{tr(record.deviceId) ?? t("未取得身份")} · {record.events.length}{" " + t("条日志")}{record.truncated ? t("（保留最后 200 条）") : ""}</p>
        <details><summary>{t("查看本次日志")}</summary>{record.events.map((entry,index)=><p key={index}>{tr(new Date(entry.atMs).toLocaleTimeString(localeTag()))} · {tr(entry.message)}</p>)}</details>
        <button className="button button-secondary" disabled={busy||working!==null} onClick={()=>setSelectedLog(record.id)}>{t("上传本次升级日志到售后")}</button>
        {record.receipt&&<p className="manager-ota-success">{t("售后已接收：")}{tr(record.receipt.reportId)}</p>}
      </article>)}
      {tr(selectedLog&&<DiagnosticLogPanel key={selectedLog} otaRecordId={selectedLog} busy={busy||working!==null} beginOperation={beginOperation} onError={onError}/>)}
    </details>
  </section>;
}
