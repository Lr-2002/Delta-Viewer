import {useEffect, useRef, useState} from "react";
import {AlertCircle, ArrowRight, Cable, CheckCircle2, CircleDashed, ClipboardList, Download, FileArchive, KeyRound, LoaderCircle, MinusCircle, RefreshCw, ShieldCheck, Wifi, X, XCircle} from "lucide-react";
import {cancelTask, chooseDirectory, confirmDevicePageOperation, exportDeviceBundle, getDeviceAvailability, isTauriRuntime, getWifiInventory, connectDeviceWifi, readDevicePage, requestDevicePageApi, requestDevicePageBatch, previewDeviceBundle, revealOutput, runDeviceDiagnostics, renewUsbDeviceAddress} from "../lib/backend";
import {deviceResultLabels, deviceTaskLabels, type DevicePage, type DevicePageApiRequest, type DevicePageApiResponse, type WifiSnapshot, type DeviceConnectionMode, type DeviceCheck, type DeviceResultStatus, type DeviceAvailability, type DeviceBundlePreview, type DeviceRun, type HealthSnapshot, type ManagerSection} from "../lib/d1";
import {linkSummary} from "./DeviceLinkPanel";
import {cameraLabel, checkLabel, checkObservation, deviceStateLabel, deviceText, resultOrder} from "../lib/d1-presentation";
import "./manager-workspace.css";
import {DeviceRuntimePanel} from "./DeviceRuntimePanel";
import {DevicePageView} from "./DevicePageView";
import {DeviceOtaPanel} from "./DeviceOtaPanel";
import {DiagnosticLogPanel} from "./DiagnosticLogPanel";

type Operation={id:number;finish:()=>void};
interface Props {section:ManagerSection;busy:boolean;beginOperation:()=>Operation|null;onNavigate:(section:ManagerSection)=>void}
const time=(ms:number|null)=>ms===null?"未观测":new Date(ms).toLocaleString("zh-CN",{hour12:false});
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const healthLabel=(value:string|null)=>value==="OK"?"状态正常":value==="FAILED"?"存在异常":value==="DEGRADED"?"需要检查":"状态待确认";
const resultIcons = {normal:CheckCircle2, abnormal:XCircle, indeterminate:AlertCircle, unsupported:MinusCircle, not_run:CircleDashed};
function ManagerErrorToast({message,onDismiss}:{message:string;onDismiss:()=>void}) {
  const [closing,setClosing]=useState(false);
  const dismiss=useRef(onDismiss);dismiss.current=onDismiss;
  const timers=useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(()=>{
    setClosing(false);
    timers.current=[setTimeout(()=>setClosing(true),2800),setTimeout(()=>dismiss.current(),3000)];
    return()=>{timers.current.forEach(clearTimeout);timers.current=[];};
  },[message]);
  function close(){if(closing)return;setClosing(true);timers.current.push(setTimeout(()=>dismiss.current(),180));}
  return <aside className={`manager-error-toast${closing?" is-closing":""}`} role="alert" aria-live="assertive" aria-atomic="true">
    <AlertCircle size={19} aria-hidden="true"/><span>{message}</span>
    <button type="button" className="icon-button" aria-label="关闭提示" title="关闭提示" onClick={close}><X size={16}/></button>
  </aside>;
}
function ResultBadge({status,label}:{status:DeviceResultStatus;label?:string}) {
  const Icon=resultIcons[status];
  return <span className={`manager-result result-${status}`}><Icon size={16}/>{label??deviceResultLabels[status]}</span>;
}
function ConnectionBadge({connected,pageOnly}:{connected:boolean;pageOnly:boolean}) {
  return <span className={`manager-connection ${connected?"is-connected":pageOnly?"is-reachable":"is-disconnected"}`}><span aria-hidden="true"/>{connected?"已连接 D1":pageOnly?"地址可达 · 报告不可用":"设备未就绪"}</span>;
}
function DiagnosticCard({check,snapshot}:{check:DeviceCheck;snapshot:HealthSnapshot|null}) {
  return <article className={`manager-check check-${check.status}`}>
    <header><h2>{checkLabel(check)}</h2><ResultBadge status={check.status}/></header>
    <p className="manager-check-observation">{checkObservation(check,snapshot)}</p>
    <details className="manager-check-details"><summary>证据与建议</summary><dl>
      <div><dt>观测证据</dt><dd>{deviceText(check.evidence)}</dd></div>
      <div><dt>观测时间</dt><dd>{time(check.observedAtMs)}</dd></div>
      <div><dt>处理建议</dt><dd>{deviceText(check.suggestion)}</dd></div>
      <div><dt>适用版本</dt><dd>{snapshot?.device.applicationVersion??"本次未取得设备版本"}</dd></div>
    </dl><details className="manager-raw-details"><summary>原始记录与规则</summary><dl>
      <div><dt>原始证据</dt><dd>{check.evidence}</dd></div>
      <div><dt>原始建议</dt><dd>{check.suggestion}</dd></div>
      <div><dt>判断依据</dt><dd>{check.ruleVersion} · {check.applicableFirmware}</dd></div>
    </dl></details></details>
  </article>;
}
function DeviceSummary({snapshot,onOpenDiagnostics}:{snapshot:HealthSnapshot;onOpenDiagnostics:()=>void}) {
  const device=snapshot.device;
  return <section className="manager-card manager-device-card" aria-label="真实 D1 设备">
    <header className="manager-device-heading"><h2>设备信息</h2><ResultBadge status={snapshot.heartbeatStale!==false?"indeterminate":snapshot.connectionLimitedOnly?"indeterminate":snapshot.health==="OK"?"normal":["FAILED","DEGRADED"].includes(snapshot.health??"")?"abnormal":"indeterminate"} label={snapshot.heartbeatStale!==false?"状态时效待确认":snapshot.connectionLimitedOnly?"相机连接受限":healthLabel(snapshot.health)}/><button className="button button-secondary" type="button" onClick={onOpenDiagnostics}>完整检测结果<ArrowRight size={15}/></button></header>
    <dl className="manager-metadata manager-device-metadata">
      <div><dt>联网 IP</dt><dd className="manager-unavailable">暂未获取</dd></div>
      <div><dt>{snapshot.connectionMode==="type_c"?"Type-C IP":snapshot.connectionMode==="ap"?"热点 IP":"连接 IP"}</dt><dd>{snapshot.connectionAddress??"暂未获取"}</dd></div>
      <div><dt>设备标识</dt><dd>{device.id}</dd></div><div><dt>应用版本</dt><dd>{device.applicationVersion??"设备未提供"}</dd></div>
      <div><dt>板端版本</dt><dd>{device.firmware??"设备未提供"}</dd></div><div><dt>硬件</dt><dd>{[device.hardwareProfile,device.architecture].filter(Boolean).join(" · ")||"设备未提供"}</dd></div>
      <div><dt>发布版本</dt><dd>{device.releaseId??"设备未提供"}</dd></div><div><dt>通道</dt><dd>{device.channel==="factory"?"出厂通道":device.channel??"设备未提供"}</dd></div>
    </dl>
    <div className="manager-device-readings"><span>设备状态 <strong>{deviceStateLabel(snapshot.phase)}</strong></span><span>电压 <strong>{snapshot.voltage===null?"未提供":`${snapshot.voltage.toFixed(2)} V`}</strong></span><span>温度 <strong>{snapshot.temperature===null?"未提供":`${snapshot.temperature.toFixed(1)} °C`}</strong></span></div>
    <p className="manager-observed">观测于 {time(snapshot.observedAtMs)} · 设备自报信息，尚未配对认证</p>
  </section>;
}
export function ManagerWorkspace({section,busy,beginOperation,onNavigate}:Props) {
  const [availability,setAvailability]=useState<DeviceAvailability|null>(null);
  const [interfaceId,setInterfaceId]=useState<string>();
  const [connectionMode,setConnectionMode]=useState<DeviceConnectionMode>("type_c");
  const [addressInput,setAddressInput]=useState("");
  const [apAddress,setApAddress]=useState<string>();
  const [wifi,setWifi]=useState<WifiSnapshot|null>(null);
  const [wifiLoading,setWifiLoading]=useState(false);
  const [wifiError,setWifiError]=useState("");
  const [wifiSelection,setWifiSelection]=useState("");
  const [wifiPassword,setWifiPassword]=useState("");
  const [manualWifiPassword,setManualWifiPassword]=useState(false);
  const [runtimePage,setRuntimePage]=useState<DevicePage|null>(null);
  const [runtimeError,setRuntimeError]=useState("");
  const [runtimeRevision,setRuntimeRevision]=useState(0);
  const [pageView,setPageView]=useState<DevicePage|null>(null);
  const [pageRequest,setPageRequest]=useState<{interfaceId:string;apAddress?:string;connectionMode:"ap"|"lan"}|null>(null);
  const [run,setRun]=useState<DeviceRun|null>(null);
  const [preview,setPreview]=useState<DeviceBundlePreview|null>(null);
  const [output,setOutput]=useState("");
  const [error,setError]=useState("");
  const [working,setWorking]=useState<"diagnostics"|"preview"|"export"|"wifi"|"page"|"usb"|null>(null);
  const [cancelling,setCancelling]=useState(false);
  const operation=useRef<Operation|null>(null);
  const pageApiQueue=useRef(Promise.resolve());
  const pendingReads=useRef<{api:DevicePageApiRequest;resolve:(response:DevicePageApiResponse)=>void}[]>([]);
  const batchTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const beginPageOperation=useRef(beginOperation);beginPageOperation.current=beginOperation;
  const wifiRefreshInFlight=useRef(false);
  const requestGeneration=useRef(0);
  const usbRenewals=useRef(new Set<string>());
  const runtimeTarget=useRef(pageRequest);runtimeTarget.current=pageRequest;
  const observation=availability?.observation??null;
  const target=availability?.selectedInterfaceId??null;
  const statusPage=runtimePage??(observation?.statusSummary?{address:observation.connectionAddress??"",html:"",status:observation.statusSummary,observedAtMs:observation.observedAtMs}:null);
  const disabled=busy||working!==null;
  const connected=!runtimeError&&((availability?.connection==="connected"&&observation!==null)||!!runtimePage?.status);
  const pageOnly=availability?.error?.code==="D1_HEALTH_PAGE_ONLY";
  const connectionLabel=connected?"已连接 D1":availability?.error?.message??linkSummary(availability?.linkDiscovery??null);
  useEffect(()=>{setPageView(null);},[section]);
  useEffect(()=>{
    if(section==="data"||pageView||working!==null||(connectionMode!=="type_c"&&!pageRequest))return;
    let active=true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      let retry=true;
      try {
        const value=await getDeviceAvailability(pageRequest?.interfaceId??interfaceId,pageRequest?.apAddress??apAddress,connectionMode);
        if(active){
          setAvailability(value);
          if(connectionMode==="type_c")setInterfaceId(previous=>{
            const candidates=value.linkDiscovery.candidates;
            if(previous&&candidates.some(link=>link.interfaceId===previous))return previous;
            return candidates.length===1?candidates[0].interfaceId:undefined;
          });
        }
        // A USB gadget can enumerate before its health page is ready. Keep Type-C
        // discovery alive so a later response can recover without reconnecting.
        retry=connectionMode==="type_c"||!["D1_HEALTH_PAGE_ONLY","D1_PROTOCOL_UNSUPPORTED"].includes(value.error?.code??"");
      }
      catch {if(active)setAvailability(previous=>({connection:"query_failed",identity:null,observation:null,realDeviceEnabled:false,selectedInterfaceId:null,attemptedAddress:null,
        error:{code:"D1_INVENTORY_UNAVAILABLE",message:"设备状态暂不可用，正在重试。"},
        configuration:previous?.configuration??{diagnosticUpload:{enabled:false,endpoint:null,status:"waiting_interface"},schemaVersion:1,deviceOta:{reservedAddress:"",scheme:null,enabled:false,status:"waiting_interface"},productionOperations:[]},
        linkDiscovery:{status:"unavailable",platform:"unknown",observedAtMs:Date.now(),candidates:[],error:null}}));}
      finally {if(active&&retry)timer=setTimeout(()=>void refresh(),3000);}
    }
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[section,interfaceId,working,connectionMode,apAddress,pageView,pageRequest,runtimeRevision]);
  useEffect(()=>{
    if(!availability||connectionMode!=="type_c"||section==="data"||pageView||busy||working||!isTauriRuntime()||availability.linkDiscovery.platform!=="windows")return;
    const links=availability.linkDiscovery.candidates;
    for(const id of usbRenewals.current)if(!links.some(link=>link.interfaceId===id&&link.state!=="link_down"))usbRenewals.current.delete(id);
    const link=links.find(value=>value.interfaceId===(interfaceId??availability.selectedInterfaceId))??(links.length===1?links[0]:undefined);
    if(!link||link.state!=="waiting_address"||!link.localIpv4.some(ip=>ip.startsWith("169.254."))||usbRenewals.current.has(link.interfaceId))return;
    const timer=setTimeout(()=>{
      const owner=beginPageOperation.current();if(!owner)return;
      usbRenewals.current.add(link.interfaceId);operation.current=owner;setWorking("usb");
      const generation=requestGeneration.current;
      void renewUsbDeviceAddress(link.interfaceId,owner.id).catch(cause=>{if(generation===requestGeneration.current)setError(errorText(cause));}).finally(()=>{
        operation.current=null;owner.finish();setWorking(null);setRuntimeRevision(value=>value+1);
      });
    },1200);
    return()=>clearTimeout(timer);
  },[availability,connectionMode,section,pageView,busy,working,interfaceId]);
  useEffect(()=>{
    if(connectionMode!=="ap"||section==="data"||pageView||working)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const update=async(showLoading:boolean)=>{
      if(!active)return;
      if(wifiRefreshInFlight.current){timer=setTimeout(()=>void update(showLoading),250);return;}
      if(document.visibilityState==="hidden"){timer=setTimeout(()=>void update(false),2500);return;}
      wifiRefreshInFlight.current=true;if(showLoading)setWifiLoading(true);setWifiError("");
      try{const value=await getWifiInventory(showLoading);if(active){setWifi(value);setWifiSelection(previous=>value.networks.some(n=>`${n.interfaceId}:${n.ssid}`===previous)?previous:(()=>{const n=value.networks.find(n=>n.recommended);return n?`${n.interfaceId}:${n.ssid}`:"";})());}}
      catch(cause){if(active){setWifi(null);setWifiError(errorText(cause));}}
      finally{wifiRefreshInFlight.current=false;if(active){setWifiLoading(false);timer=setTimeout(()=>void update(false),2000);}}
    };
    const focus=()=>{if(timer)clearTimeout(timer);void update(false);};
    setWifiLoading(true);void update(true);window.addEventListener("focus",focus);
    return()=>{active=false;if(timer)clearTimeout(timer);window.removeEventListener("focus",focus);};
  },[connectionMode,section,pageView,working]);
  useEffect(()=>()=>{requestGeneration.current++;clearTimeout(batchTimer.current);pendingReads.current.splice(0).forEach(item=>item.resolve({status:409,contentType:"application/json",body:'{"message":"设备连接已结束"}'}));if(operation.current)void cancelTask(operation.current.id);},[]);
  function selectInterface(value:string){requestGeneration.current++;setInterfaceId(value||undefined);setAvailability(null);setRun(null);setPreview(null);setOutput("");setError("");setRuntimePage(null);setRuntimeError("");setPageRequest(null);}
  async function detect(){
    if(disabled||!target)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    const generation=requestGeneration.current;
    operation.current=owner;setWorking("diagnostics");setRun(null);setPreview(null);setOutput("");setError("");setCancelling(false);
    try {const result=await runDeviceDiagnostics(target,owner.id,apAddress,connectionMode);if(generation===requestGeneration.current)setRun(result);}
    catch(cause){if(generation===requestGeneration.current)setError(errorText(cause));}
    finally {operation.current=null;owner.finish();setWorking(null);setCancelling(false);}
  }
  async function cancel(){
    if(!operation.current||cancelling)return;setCancelling(true);
    try {if(!await cancelTask(operation.current.id))setError("任务已结束，请查看最终结果。");}
    catch(cause){setError(errorText(cause));setCancelling(false);}
  }
  const bundleRequest=run?{runId:run.id,fromMs:run.startedAtMs,toMs:run.finishedAtMs}:null;
  async function prepare(){
    if(!bundleRequest||disabled)return;setWorking("preview");setError("");setPreview(null);setOutput("");
    try {setPreview(await previewDeviceBundle(bundleRequest));}catch(cause){setError(errorText(cause));}finally{setWorking(null);}
  }
  async function exportBundle(){
    if(!bundleRequest||!preview||disabled)return;
    setWorking("export");setError("");setOutput("");setCancelling(false);let owner:Operation|null=null;
    try {owner=beginOperation();if(!owner)throw new Error("请先完成当前任务。");operation.current=owner;
      const destination=await chooseDirectory("选择诊断包保存目录");if(!destination)return;
      setOutput(await exportDeviceBundle(bundleRequest,destination,preview.planHash,owner.id));
    }catch(cause){setError(errorText(cause));}finally{operation.current=null;owner?.finish();setWorking(null);setCancelling(false);}
  }
  function changeConnection(mode:DeviceConnectionMode) {
    if(disabled||mode===connectionMode)return;
    selectInterface("");setConnectionMode(mode);setApAddress(undefined);setWifiPassword("");
  }
  async function connectLan() {
    const value=addressInput.trim();
    const parts=value.split(".");
    if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255)) {setError("请输入设备的 IPv4 地址，不含端口或路径。");return;}
    selectInterface("");setApAddress(value);await openPage({interfaceId:"",apAddress:value,connectionMode:"lan"});
  }
  async function openPage(request:{interfaceId:string;apAddress?:string;connectionMode:"ap"|"lan"}) {
    if(disabled)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("page");setError("");
    try{const result=await readDevicePage(request,owner.id);setRuntimeError("");setPageRequest(request);setPageView(result);setRuntimePage(result.status?result:null);}
    catch(cause){setError(errorText(cause));}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }
  async function refreshWifi() {
    if(disabled||wifiLoading||wifiRefreshInFlight.current)return;wifiRefreshInFlight.current=true;setWifiLoading(true);setWifiError("");
    try{const value=await getWifiInventory(true);setWifi(value);setWifiSelection(previous=>value.networks.some(n=>`${n.interfaceId}:${n.ssid}`===previous)?previous:(()=>{const n=value.networks.find(n=>n.recommended);return n?`${n.interfaceId}:${n.ssid}`:"";})());}catch(cause){setWifi(null);setWifiError(errorText(cause));}finally{wifiRefreshInFlight.current=false;setWifiLoading(false);}
  }
  function enqueuePageOperation(apis:DevicePageApiRequest[]):Promise<DevicePageApiResponse[]> {
    const request=pageRequest,generation=requestGeneration.current;
    const failed=(message:string,status=409)=>apis.map(()=>({status,contentType:"application/json",body:JSON.stringify({message})}));
    const run=pageApiQueue.current.then(async()=>{
      if(!request||generation!==requestGeneration.current)return failed("设备连接已结束，请重新连接。");
      if(apis[0].method!=="GET"&&!await confirmDevicePageOperation(apis[0].path))return failed("操作已取消");
      const owner=beginPageOperation.current();
      if(!owner)return failed("当前有其他任务正在运行，请稍后重试。");
      operation.current=owner;
      try{return apis.every(api=>api.method==="GET")?await requestDevicePageBatch(request,apis,owner.id):[await requestDevicePageApi(request,apis[0],owner.id)];}
      catch(cause){return failed(errorText(cause),502);}
      finally{operation.current=null;owner.finish();}
    });
    pageApiQueue.current=run.then(()=>undefined,()=>undefined);
    return run;
  }
  function requestPageApi(api:DevicePageApiRequest):Promise<DevicePageApiResponse>{
    if(api.method!=="GET")return enqueuePageOperation([api]).then(replies=>replies[0]);
    if(pendingReads.current.length>=20)return Promise.resolve({status:429,contentType:"application/json",body:JSON.stringify({message:"设备查询繁忙，请稍后重试。"})});
    return new Promise(resolve=>{
      pendingReads.current.push({api,resolve});
      if(batchTimer.current)return;
      batchTimer.current=setTimeout(()=>{
        batchTimer.current=undefined;
        const reads=pendingReads.current.splice(0);
        for(let offset=0;offset<reads.length;offset+=5){
          const batch=reads.slice(offset,offset+5);
          void enqueuePageOperation(batch.map(item=>item.api)).then(replies=>batch.forEach((item,index)=>item.resolve(replies[index])));
        }
      },20);
    });
  }
  const selectedWifi=wifi?.networks.find(n=>`${n.interfaceId}:${n.ssid}`===wifiSelection&&n.recommended);
  async function connectWifi() {
    if(disabled||!selectedWifi)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    operation.current=owner;setWorking("wifi");setError("");
    try{
      const network=await connectDeviceWifi({interfaceId:selectedWifi.interfaceId,ssid:selectedWifi.ssid,password:manualWifiPassword?wifiPassword:""},owner.id);
      setWifiPassword("");setWorking("page");
      const request={interfaceId:network.interfaceId,connectionMode:"ap" as const};
      const result=await readDevicePage(request,owner.id);setRuntimeError("");setPageView(result);setPageRequest(request);setRuntimePage(result.status?result:null);
    }catch(cause){setError(errorText(cause));}finally{setWifiPassword("");operation.current=null;owner.finish();setWorking(null);}
  }
  async function verifyProvisionedAddress(address:string):Promise<DevicePage> {
    const owner=beginPageOperation.current();if(!owner)throw new Error("请稍后重试。");
    try{
      const request={interfaceId:"",connectionMode:"lan" as const,apAddress:address};
      const result=await readDevicePage(request,owner.id);
      if(!result.status)throw new Error("尚未取得设备联网报告。");
      const previousId=(runtimePage?.status?.device as Record<string,unknown>|undefined)?.device_id;
      const nextId=(result.status.device as Record<string,unknown>|undefined)?.device_id;
      if(previousId&&nextId!==previousId)throw new Error("设备标识不一致。");
      setConnectionMode("lan");setApAddress(address);setAddressInput(address);setPageRequest(request);setRuntimePage(result);setPageView(result);
      return result;
    }finally{owner.finish();}
  }
  useEffect(()=>{
    if(!pageRequest||pageView||section==="data"||working)return;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      try{
        const reply=await requestPageApi({path:"/status",method:"GET"});
        if(!active)return;
        if(reply.status!==200)throw new Error("设备状态读取失败，请检查设备连接。");
        const status=JSON.parse(reply.body);
        if(status.schema!=="dohc.device.status-summary.v2")throw new Error("当前连接暂未提供运行状态。");
        setRuntimePage({address:runtimeTarget.current?.apAddress??runtimePage?.address??"",html:"",status,observedAtMs:Date.now()});setRuntimeError("");
      }catch(cause){if(active)setRuntimeError(errorText(cause));}
      finally{if(active)timer=setTimeout(()=>void refresh(),5000);}
    }
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[pageRequest,pageView,section,working,runtimeRevision]);
  if(section==="data")return null;
  if(pageView&&(section==="home"||section==="device"))return <><DevicePageView page={pageView} busy={working!==null} showConnectionMode={section==="device"} connectionModeLabel={pageRequest?.connectionMode==="ap"?"设备热点（AP）":"局域网 IP"} onBack={()=>{requestGeneration.current++;setPageView(null);onNavigate("device");}} onRefresh={()=>{if(pageRequest)void openPage(pageRequest);}} onRequest={requestPageApi} onVerifyAddress={verifyProvisionedAddress}/>{error&&<ManagerErrorToast message={error} onDismiss={()=>setError("")}/>}</>;
  const limited=observation?.cameraPortLimited??false;
  const counts=Object.fromEntries(resultOrder.map(status=>[status,run?.checks.filter(check=>check.status===status).length??0]));
  const connectionHelp=connectionMode==="ap"?"长按录制键，听到进入 AP 的语音后，连接设备标签对应的热点。":connectionMode==="lan"?"输入设备联网后语音播报的 IP，电脑需与设备处于同一网段。":"通过 Type-C 数据线连接已开机的 D1。";
  const connectionModeLabel=connectionMode==="ap"?"设备热点（AP）":connectionMode==="lan"?"局域网 IP":"Type-C 连接";
  const connectionControls=<section className="manager-connection-area" aria-label="设备连接方式">
    <aside className="manager-connection-guide" aria-label={connectionMode==="ap"?"热点连接教程":connectionMode==="lan"?"局域网连接教程":"Type-C 连接提示"}>
      <strong>{connectionMode==="ap"?"如何连接设备热点":connectionMode==="lan"?"如何获取设备 IP":"Type-C 连接提示"}</strong>
      {connectionMode==="type_c"?<><p>请使用支持数据传输的 USB-A 转 Type-C 数据线，将电脑 A 口连接到 D1 的 Type-C 口。</p><p>D1 唯一的 Type-C 口连接电脑期间，扩展相机将暂时断开；需要检测相机时，请改用设备热点或局域网连接。</p></>:connectionMode==="ap"?<><p>设备未在采集时，长按录制键，等待语音确认进入 AP 模式。</p><p>选择设备标签对应的 <b>Delta-D1-***</b> 热点，按手册输入密码后连接；热点无需联网，默认密码自动填写。</p><p>连接后在软件内打开设备页面，地址按实际热点连接获取。</p></>:<><p>先按设备操作手册完成配网，确认设备已联网。</p><p>长按录制键后接短按，等待设备语音播报本机 IP。</p><p>输入播报的 IP 后连接，在软件内打开设备状态页面。</p></>}
    </aside>
    <div className="manager-connect-bar">
      <div className="manager-segmented" role="group" aria-label="连接方式">
        <button type="button" aria-pressed={connectionMode==="type_c"} disabled={disabled} onClick={()=>changeConnection("type_c")}><Cable size={17}/>Type-C 连接</button>
        <button type="button" aria-pressed={connectionMode==="ap"} disabled={disabled} onClick={()=>changeConnection("ap")}><Wifi size={17}/>设备热点（AP）</button>
        <button type="button" aria-pressed={connectionMode==="lan"} disabled={disabled} onClick={()=>changeConnection("lan")}><Wifi size={17}/>局域网 IP</button>
      </div>
      {connectionMode==="ap"?<button className="button button-secondary" disabled={disabled||!isTauriRuntime()} onClick={()=>void openPage({interfaceId:selectedWifi?.connected?selectedWifi.interfaceId:interfaceId??"",connectionMode:"ap"})}>连接设备</button>:connectionMode==="lan"?<form className="manager-ap-form" onSubmit={event=>{event.preventDefault();void connectLan();}}><label htmlFor="d1-lan-ip">设备 IP</label><input id="d1-lan-ip" value={addressInput} inputMode="decimal" placeholder="输入语音播报的 IP" disabled={disabled} onChange={event=>setAddressInput(event.target.value)}/><button className="button button-secondary" disabled={disabled||!isTauriRuntime()||!addressInput.trim()} type="submit">连接设备</button></form>:<span className="manager-connect-hint" role="status">{working==="usb"?<><LoaderCircle size={15} className="spin"/>正在获取 USB 网络地址…</>:"自动识别 · 只读设备状态"}</span>}
      {(availability?.linkDiscovery.candidates.length??0)>1&&<label className="manager-device-select">{connectionMode==="ap"?"Wi-Fi 网卡":"连接网卡"}<select aria-label="选择设备连接" value={interfaceId??target??""} disabled={disabled} onChange={event=>selectInterface(event.target.value)}><option value="">请选择连接</option>{availability?.linkDiscovery.candidates.map(link=><option key={link.interfaceId} value={link.interfaceId}>{link.name}</option>)}</select></label>}
    </div>
    {connectionMode==="ap"&&<section className="manager-wifi" aria-label="可用 Wi-Fi">
      <header><strong>可用 Wi-Fi</strong><button className="button button-secondary manager-wifi-header-refresh" disabled={disabled||wifiLoading||!isTauriRuntime()} onClick={()=>void refreshWifi()}>{wifiLoading?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}刷新 Wi-Fi</button></header>
      {wifiError&&<p role="status">{wifiError}</p>}{wifi?.message&&<p>{wifi.message}</p>}
      {wifi?.supported&&<><div className="manager-wifi-list">{wifi.networks.length===0&&!wifiLoading?<p>暂未发现可用 Wi-Fi，请确认电脑无线网卡已开启。</p>:wifi.networks.map(n=><button key={`${n.interfaceId}:${n.ssid}`} aria-pressed={wifiSelection===`${n.interfaceId}:${n.ssid}`} disabled={disabled||!n.recommended||(!n.connectable&&!n.connected)} onClick={()=>{setWifiSelection(`${n.interfaceId}:${n.ssid}`);setWifiPassword("");setManualWifiPassword(false);}}><Wifi size={17}/><strong>{n.ssid}</strong>{n.recommended&&<span className="manager-wifi-recommend">设备热点 · 推荐</span>}<span className="manager-wifi-signal">信号质量 {n.signal}%</span>{n.connected&&<span className="manager-wifi-connected">已连接</span>}</button>)}</div>
      <small className="manager-wifi-observed">列表更新于 {new Date(wifi.observedAtMs).toLocaleTimeString("zh-CN",{hour12:false})}</small>
      {!wifi.networks.some(n=>n.recommended)&&!wifiLoading&&<p>未发现 D1 热点。请确认设备已进入 AP 模式后刷新。</p>}
      {selectedWifi&&<form className="manager-wifi-form" onSubmit={event=>{event.preventDefault();void connectWifi();}}>{!selectedWifi.connected&&<><button type="button" className="button button-secondary manager-wifi-password-toggle" onClick={()=>{setManualWifiPassword(v=>!v);setWifiPassword("");}}><KeyRound size={15}/>{manualWifiPassword?"使用默认密码":"手动输入密码"}</button>{manualWifiPassword&&<><label htmlFor="d1-wifi-password">热点密码</label><input id="d1-wifi-password" type="password" autoComplete="off" maxLength={63} value={wifiPassword} disabled={disabled} onChange={event=>setWifiPassword(event.target.value)}/></>}</>}<button className="button button-primary" type="submit" disabled={disabled||(!selectedWifi.connected&&manualWifiPassword&&!wifiPassword)}>{working==="wifi"?"正在连接…":working==="page"?"正在打开…":selectedWifi.connected?"进入设备页面":"连接热点并打开"}</button><small>连接热点会切换电脑 Wi-Fi；密码仅用于本次连接。</small></form>}</>}
    </section>}

  </section>;
  return <main className={`manager-workspace manager-section-${section}`} aria-label="D1 设备工作区">
    {error&&<ManagerErrorToast message={error} onDismiss={()=>setError("")}/>}
    <header className="manager-page-heading"><h1>{section==="home"?"D1 设备工作台":section==="device"?"设备信息":section==="diagnostics"?"检测排障":"日志与支持"}</h1><ConnectionBadge connected={connected} pageOnly={pageOnly}/></header>
    {section==="home"&&connectionControls}
    {section==="device"&&connected&&<p className="manager-actual-connection" role="status"><span>实际连接方式</span><strong>{connectionModeLabel}</strong></p>}
    {section==="home"?<>
      <section className="manager-home-device"><div><Cable size={24}/><div><h2>{connected?"D1 已连接":"连接你的 D1"}</h2>{(observation||availability?.error)&&<p>{observation?`应用 ${observation.device.applicationVersion??"版本未提供"} · ${observation.connectionLimitedOnly?"相机连接受限":healthLabel(observation.health)}`:availability?.error?.message}</p>}</div></div><div className="manager-actions"><button className="button button-primary" onClick={()=>onNavigate("diagnostics")}><ShieldCheck size={17}/>检测设备</button></div></section>

    </>:null}
    {section==="device"&&<>
      {(pageRequest||statusPage)?<DeviceRuntimePanel cameraPortLimited={!runtimePage&&observation?.cameraPortLimited} connectionLimitedOnly={!runtimePage&&observation?.connectionLimitedOnly} page={statusPage} error={runtimeError} refresh={()=>setRuntimeRevision(n=>n+1)} onConfigure={pageRequest?()=>void openPage(pageRequest):undefined} onNavigate={()=>onNavigate("diagnostics")}/>:observation?<><div className="manager-device-layout"><DeviceSummary snapshot={observation} onOpenDiagnostics={()=>onNavigate("diagnostics")}/><section className="manager-card manager-current-status"><header className="manager-device-heading"><h2>相机与存储</h2><button className="button button-secondary" type="button" disabled={disabled} onClick={()=>onNavigate("diagnostics")}>完整检测结果<ArrowRight size={15}/></button></header><div className="manager-camera-grid">{observation.cameras.map(camera=><div key={camera.role}><strong>{cameraLabel(camera.role)}</strong><ResultBadge status={limited&&camera.role==="stereo_extension"?"not_run":camera.enabled===false?"not_run":observation.heartbeatStale!==false?"indeterminate":camera.state==="STREAMING"&&camera.fresh?"normal":["FAULT","FAILED"].includes(camera.state??"")&&camera.fresh===false?"abnormal":"indeterminate"} label={limited&&camera.role==="stereo_extension"?"未检查":deviceStateLabel(camera.state)}/><small>{camera.effectiveFps===null?"帧率未提供":`${camera.effectiveFps.toFixed(1)} 帧/秒`}</small></div>)}</div><p>采集存储：{observation.storage?.writable===true?"可写":observation.storage?.writable===false?"不可写":"状态未提供"}</p>{limited&&<p className="manager-port-note">Type-C 当前用于连接电脑，扩展双目相机不参与本次检测；设备可能仍亮红灯。</p>}<p className="manager-observed">完整告警和检测证据位于“检测排障”。</p></section></div></>:<><section className="manager-empty compact"><Cable size={32}/><h2>{pageOnly?"暂不能读取设备报告":availability?.error?"设备报告暂不可用":"等待 D1 连接"}</h2>{availability?.attemptedAddress&&<dl className="manager-metadata"><div><dt>{connectionMode==="ap"?"热点 IP":"连接 IP"}</dt><dd>{availability.attemptedAddress}</dd></div></dl>}<p>{connectionMode!=="type_c"?connectionHelp:connectionLabel}</p></section></>}
      <DeviceOtaPanel request={pageRequest} connected={connected} busy={disabled} beginOperation={beginOperation} onError={setError}/>
    </>}
    {section==="diagnostics"&&<>
      {statusPage&&<DeviceRuntimePanel cameraPortLimited={!runtimePage&&observation?.cameraPortLimited} connectionLimitedOnly={!runtimePage&&observation?.connectionLimitedOnly} page={statusPage} diagnostics error={runtimeError} refresh={()=>setRuntimeRevision(n=>n+1)} onConfigure={pageRequest?()=>{onNavigate("device");void openPage(pageRequest);}:undefined}/>}
      <section className="manager-diagnostic-controls" aria-label="设备检测操作"><div><strong>{connected?`D1 · 应用 ${observation?.device.applicationVersion??String(runtimePage?.status?.device&&typeof runtimePage.status.device==="object"?(runtimePage.status.device as Record<string,unknown>).workspace_version??"版本未提供":"版本未提供")}`:"等待设备连接"}</strong><p>{limited?"Type-C 占用相机接口，扩展双目相机不参与本次检测。":"只读检查，不启动录制或修改设备。"}</p></div><div className="manager-actions"><button className="button button-primary" disabled={disabled||!target} onClick={()=>void detect()}>{working==="diagnostics"?<LoaderCircle size={17} className="spin"/>:<ShieldCheck size={17}/>}运行设备检测</button>{working==="diagnostics"&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?"正在取消":"取消检测"}</button>}<button className="button button-secondary" disabled={disabled||!run} onClick={()=>onNavigate("support")}><FileArchive size={17}/>查看诊断包</button></div></section>
      {working==="diagnostics"&&<p className="manager-running" role="status">正在读取 D1 健康报告…</p>}
      {run?<><div className="manager-run-summary" role="status"><strong>{deviceTaskLabels[run.status]}</strong><span>{time(run.finishedAtMs)}{!connected?" · 当前未取得设备报告":""}</span><div className="manager-result-counts" aria-label="检测结果统计">{resultOrder.filter(status=>counts[status]>0).map(status=><ResultBadge key={status} status={status} label={`${deviceResultLabels[status]} ${counts[status]}`}/>)}</div></div><div className="manager-checks" hidden={!!statusPage}>{[...run.checks].sort((a,b)=>resultOrder.indexOf(a.status)-resultOrder.indexOf(b.status)).map(check=><DiagnosticCard check={check} snapshot={run.observation} key={check.id}/>)}</div></>:!working&&!statusPage&&<section className="manager-empty compact"><ClipboardList size={30}/><h2>尚未运行检测</h2><p>{connected?"运行设备检测，读取当前状态和告警。":connectionLabel}</p>{!connected&&<button className="button button-secondary" onClick={()=>onNavigate("device")}>前往连接设备</button>}</section>}
    </>}
    {section==="support"&&<div className="manager-support-layout"><section className="manager-card"><header className="manager-device-heading"><h2>本地诊断包</h2><FileArchive size={21}/></header><p>包含本次设备健康观测与检测摘要，暂不包含原始设备日志。</p>{run?<>
      <dl className="manager-metadata"><div><dt>设备标识</dt><dd>{run.device?.id??"本次未能读取"}</dd></div><div><dt>应用版本</dt><dd>{run.device?.applicationVersion??"本次未能读取"}</dd></div><div><dt>观测范围</dt><dd>{time(run.startedAtMs)} — {time(run.finishedAtMs)}</dd></div></dl>
      <div className="manager-actions"><button className="button button-secondary" disabled={disabled||!isTauriRuntime()} onClick={()=>void prepare()}><ClipboardList size={17}/>预览检测包</button>{preview&&<button className="button button-primary" disabled={disabled} onClick={()=>void exportBundle()}><Download size={17}/>导出到本机</button>}{working==="export"&&operation.current&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>取消导出</button>}</div>
      {!isTauriRuntime()&&<p>请在桌面客户端预览并导出诊断包。</p>}
      {preview&&<div className="manager-package-preview" aria-label="诊断包预览"><p>{preview.privacy}</p>{preview.files.map(file=><article key={file.name}><strong>{file.name}</strong><span>{file.bytes} 字节</span><code>SHA-256 {file.sha256}</code></article>)}</div>}
      {output&&<div className="manager-export-success" role="status"><CheckCircle2 size={18}/><span>已导出：{output}</span><button className="text-button" onClick={()=>void revealOutput(output).catch(cause=>setError(errorText(cause)))}>打开所在位置</button></div>}
    </>:<div className="manager-empty compact"><FileArchive size={30}/><h2>还没有检测记录</h2><p>完成设备检测后，即可预览和导出。</p><button className="button button-secondary" onClick={()=>onNavigate("diagnostics")}>前往检测</button></div>}</section><DiagnosticLogPanel busy={disabled} beginOperation={beginOperation} onError={setError}/></div>}
  </main>;
}
