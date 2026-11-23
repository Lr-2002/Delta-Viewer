import { localeTag, t, tr, useLanguage } from "../lib/i18n";
import {useEffect, useMemo, useRef, useState} from "react";
import {AlertCircle, ArrowRight, Cable, CheckCircle2, CircleDashed, ClipboardList, Download, FileArchive, KeyRound, LoaderCircle, MinusCircle, RefreshCw, Settings2, Info, ShieldCheck, Wifi, X, XCircle} from "lucide-react";
import {cancelTask, chooseDirectory, exportDeviceBundle, getDeviceAvailability, isTauriRuntime, getWifiInventory, connectDeviceWifi, readDevicePage, requestDevicePageApi, previewDeviceBundle, revealOutput, runDeviceDiagnostics, renewUsbDeviceAddress} from "../lib/backend";
import {deviceResultLabels, deviceTaskLabels, type DevicePage, type DevicePageRequest, type WifiSnapshot, type DeviceConnectionMode, type DeviceCheck, type DeviceResultStatus, type DeviceAvailability, type DeviceBundlePreview, type DeviceRun, type HealthSnapshot, type ManagerSection} from "../lib/d1";
import {linkSummary} from "./DeviceLinkPanel";
import {cameraLabel, checkLabel, checkObservation, deviceStateLabel, deviceText, resultOrder} from "../lib/d1-presentation";
import "./manager-workspace.css";
import {DeviceRuntimePanel} from "./DeviceRuntimePanel";
import {DevicePageView} from "./DevicePageView";
import {DeviceOtaPanel} from "./DeviceOtaPanel";
import {DiagnosticLogPanel} from "./DiagnosticLogPanel";

type Operation={id:number;finish:()=>void};
interface Props {section:ManagerSection;navigationRevision?:number;busy:boolean;beginOperation:()=>Operation|null;onNavigate:(section:ManagerSection)=>void}
const time=(ms:number|null)=>ms===null?"未观测":new Date(ms).toLocaleString(localeTag(),{hour12:false});
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const healthLabel=(value:string|null)=>value==="OK"?"状态正常":value==="FAILED"?"存在异常":value==="DEGRADED"?"需要检查":"状态待确认";
const resultIcons = {normal:CheckCircle2, abnormal:XCircle, indeterminate:AlertCircle, unsupported:MinusCircle, not_run:CircleDashed};
function ManagerErrorToast({message,onDismiss}:{message:string;onDismiss:()=>void}) {
  useLanguage();
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
    <AlertCircle size={19} aria-hidden="true"/><span>{tr(message)}</span>
    <button type="button" className="icon-button" aria-label={t("关闭提示")} title={t("关闭提示")} onClick={close}><X size={16}/></button>
  </aside>;
}
function ResultBadge({status,label}:{status:DeviceResultStatus;label?:string}) {
  useLanguage();
  const Icon=resultIcons[status];
  return <span className={`manager-result result-${status}`}><Icon size={16}/>{tr(label) ?? tr(deviceResultLabels[status])}</span>;
}
function ConnectionBadge({connected,pageOnly}:{connected:boolean;pageOnly:boolean}) {
  useLanguage();
  return <span className={`manager-connection ${connected?"is-connected":pageOnly?"is-reachable":"is-disconnected"}`}><span aria-hidden="true"/>{connected ? t("已连接 D1") : pageOnly ? t("地址可达 · 报告不可用") : t("设备未就绪")}</span>;
}
function DiagnosticCard({check,snapshot}:{check:DeviceCheck;snapshot:HealthSnapshot|null}) {
  useLanguage();
  return <article className={`manager-check check-${check.status}`}>
    <header><h2>{tr(checkLabel(check))}</h2><ResultBadge status={check.status}/></header>
    <p className="manager-check-observation">{tr(checkObservation(check,snapshot))}</p>
    <details className="manager-check-details"><summary>{t("证据与建议")}</summary><dl>
      <div><dt>{t("观测证据")}</dt><dd>{tr(deviceText(check.evidence))}</dd></div>
      <div><dt>{t("观测时间")}</dt><dd>{tr(time(check.observedAtMs))}</dd></div>
      <div><dt>{t("处理建议")}</dt><dd>{tr(deviceText(check.suggestion))}</dd></div>
      <div><dt>{t("适用版本")}</dt><dd>{tr(snapshot?.device.applicationVersion) ?? t("本次未取得设备版本")}</dd></div>
    </dl><details className="manager-raw-details"><summary>{t("原始记录与规则")}</summary><dl>
      <div><dt>{t("原始证据")}</dt><dd>{tr(check.evidence)}</dd></div>
      <div><dt>{t("原始建议")}</dt><dd>{tr(check.suggestion)}</dd></div>
      <div><dt>{t("判断依据")}</dt><dd>{tr(check.ruleVersion)} · {tr(check.applicableFirmware)}</dd></div>
    </dl></details></details>
  </article>;
}
function DeviceSummary({snapshot,onOpenDiagnostics}:{snapshot:HealthSnapshot;onOpenDiagnostics:()=>void}) {
  useLanguage();
  const device=snapshot.device;
  return <section className="manager-card manager-device-card" aria-label={t("真实 D1 设备")}>
    <header className="manager-device-heading"><h2>{t("设备信息")}</h2><ResultBadge status={snapshot.heartbeatStale!==false?"indeterminate":snapshot.connectionLimitedOnly?"indeterminate":snapshot.health==="OK"?"normal":["FAILED","DEGRADED"].includes(snapshot.health??"")?"abnormal":"indeterminate"} label={snapshot.heartbeatStale!==false ? t("状态时效待确认") : snapshot.connectionLimitedOnly ? t("相机连接受限") : tr(healthLabel(snapshot.health))}/><button className="button button-secondary" type="button" onClick={onOpenDiagnostics}>{t("完整检测结果")}<ArrowRight size={15}/></button></header>
    <dl className="manager-metadata manager-device-metadata">
      <div><dt>{t("联网 IP")}</dt><dd className="manager-unavailable">{t("暂未获取")}</dd></div>
      <div><dt>{snapshot.connectionMode==="type_c" ? "Type-C IP" : snapshot.connectionMode==="ap" ? t("热点 IP") : t("连接 IP")}</dt><dd>{tr(snapshot.connectionAddress) ?? t("暂未获取")}</dd></div>
      <div><dt>{t("设备标识")}</dt><dd>{device.id}</dd></div><div><dt>{t("应用版本")}</dt><dd>{tr(device.applicationVersion) ?? t("设备未提供")}</dd></div>
      <div><dt>{t("板端版本")}</dt><dd>{tr(device.firmware) ?? t("设备未提供")}</dd></div><div><dt>{t("硬件")}</dt><dd>{tr([device.hardwareProfile,device.architecture].filter(Boolean).join(" · ")) || t("设备未提供")}</dd></div>
      <div><dt>{t("发布版本")}</dt><dd>{tr(device.releaseId) ?? t("设备未提供")}</dd></div><div><dt>{t("通道")}</dt><dd>{device.channel==="factory" ? t("出厂通道") : tr(device.channel) ?? t("设备未提供")}</dd></div>
    </dl>
    <div className="manager-device-readings"><span>{t("设备状态") + " "}<strong>{tr(deviceStateLabel(snapshot.phase))}</strong></span><span>{t("电压") + " "}<strong>{snapshot.voltage===null ? t("未提供") : t("{0} V", [tr(snapshot.voltage.toFixed(2))])}</strong></span><span>{t("温度") + " "}<strong>{snapshot.temperature===null ? t("未提供") : t("{0} °C", [tr(snapshot.temperature.toFixed(1))])}</strong></span></div>
    <p className="manager-observed">{t("观测于") + " "}{tr(time(snapshot.observedAtMs))}{" " + t("· 设备自报信息，尚未配对认证")}</p>
  </section>;
}
export function ManagerWorkspace({section,navigationRevision=0,busy,beginOperation,onNavigate}:Props) {
  useLanguage();
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
  const [pageRequest,setPageRequest]=useState<DevicePageRequest|null>(null);
  const [confirmedPage,setConfirmedPage]=useState<DevicePage|null>(null);
  const [run,setRun]=useState<DeviceRun|null>(null);
  const [preview,setPreview]=useState<DeviceBundlePreview|null>(null);
  const [output,setOutput]=useState("");
  const [error,setError]=useState("");
  const [working,setWorking]=useState<"diagnostics"|"preview"|"export"|"wifi"|"page"|"usb"|null>(null);
  const [cancelling,setCancelling]=useState(false);
  const operation=useRef<Operation|null>(null);
  const beginPageOperation=useRef(beginOperation);beginPageOperation.current=beginOperation;
  const wifiRefreshInFlight=useRef(false);
  const requestGeneration=useRef(0);
  const usbRenewals=useRef(new Set<string>());
  const runtimeTarget=useRef(pageRequest);runtimeTarget.current=pageRequest;
  const observation=availability?.observation??null;
  const target=availability?.selectedInterfaceId??null;
  const upgradeRequest=useMemo(()=>pageRequest??(target&&connectionMode==="type_c"?{interfaceId:target,connectionMode:"type_c" as const}:null),[pageRequest,target,connectionMode]);
  const statusPage=runtimePage??(observation?.statusSummary?{address:observation.connectionAddress??"",html:"",status:observation.statusSummary,observedAtMs:observation.observedAtMs}:null);
  const apConfiguration=connectionMode==="ap"&&!statusPage?.status;
  const disabled=busy||working!==null;
  const connected=!runtimeError&&((availability?.connection==="connected"&&observation!==null)||!!runtimePage?.status);
  const pageOnly=availability?.error?.code==="D1_HEALTH_PAGE_ONLY";
  const connectionLabel=connected?"已连接 D1":availability?.error?.message??linkSummary(availability?.linkDiscovery??null);
  useEffect(()=>{setPageView(null);},[section,navigationRevision]);
  useEffect(()=>{
    if(section==="data"||pageView||working!==null||apConfiguration||(connectionMode!=="type_c"&&!pageRequest))return;
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
  },[section,interfaceId,working,connectionMode,apAddress,pageView,pageRequest,runtimeRevision,apConfiguration]);
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
  useEffect(()=>()=>{requestGeneration.current++;if(operation.current)void cancelTask(operation.current.id);},[]);
  function selectInterface(value:string){requestGeneration.current++;setInterfaceId(value||undefined);setAvailability(null);setRun(null);setPreview(null);setOutput("");setError("");setRuntimePage(null);setRuntimeError("");setPageRequest(null);setConfirmedPage(null);}
  async function detect(){
    if(disabled||!target||apConfiguration)return;
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
    selectInterface("");setApAddress(value);await openPage({interfaceId:"",apAddress:value,connectionMode:"lan"},false);
  }
  async function openPage(request:DevicePageRequest,show=true) {
    if(disabled)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    const generation=++requestGeneration.current;
    operation.current=owner;setWorking("page");setError("");setPageRequest(request);
    try{const result=await readDevicePage(request,owner.id);if(generation!==requestGeneration.current)return;setRuntimeError("");setPageRequest(request);setConfirmedPage(result);if(show)setPageView(result);setRuntimePage(result.status?result:null);}
    catch(cause){if(generation===requestGeneration.current){setError(errorText(cause));setRuntimeError(errorText(cause));setConfirmedPage(null);setRuntimePage(null);setAvailability(null);}}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }
  async function refreshWifi() {
    if(disabled||wifiLoading||wifiRefreshInFlight.current)return;wifiRefreshInFlight.current=true;setWifiLoading(true);setWifiError("");
    try{const value=await getWifiInventory(true);setWifi(value);setWifiSelection(previous=>value.networks.some(n=>`${n.interfaceId}:${n.ssid}`===previous)?previous:(()=>{const n=value.networks.find(n=>n.recommended);return n?`${n.interfaceId}:${n.ssid}`:"";})());}catch(cause){setWifi(null);setWifiError(errorText(cause));}finally{wifiRefreshInFlight.current=false;setWifiLoading(false);}
  }
  const selectedWifi=wifi?.networks.find(n=>`${n.interfaceId}:${n.ssid}`===wifiSelection&&n.recommended);
  async function connectWifi() {
    if(disabled||!selectedWifi)return;
    const owner=beginOperation();if(!owner){setError("请先完成当前任务。");return;}
    const generation=++requestGeneration.current;
    setConfirmedPage(null);setRuntimePage(null);setAvailability(null);setPageRequest(null);
    operation.current=owner;setWorking("wifi");setError("");
    try{
      const network=await connectDeviceWifi({interfaceId:selectedWifi.interfaceId,ssid:selectedWifi.ssid,password:manualWifiPassword?wifiPassword:""},owner.id);
      if(generation!==requestGeneration.current)return;
      setWifiPassword("");setWorking("page");
      const request={interfaceId:network.interfaceId,connectionMode:"ap" as const};
      setPageRequest(request);
      const result=await readDevicePage(request,owner.id);if(generation!==requestGeneration.current)return;setRuntimeError("");setConfirmedPage(result);setPageRequest(request);setRuntimePage(result.status?result:null);
    }catch(cause){setError(errorText(cause));}finally{setWifiPassword("");operation.current=null;owner.finish();setWorking(null);}
  }
  useEffect(()=>{
    if(!pageRequest||pageView||section==="data"||working||apConfiguration)return;
    const request=pageRequest;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      try{
        const owner=beginPageOperation.current();
        if(!owner)return;
        let reply;
        try {reply=await requestDevicePageApi(request,{path:"/status",method:"GET"},owner.id);}
        finally {owner.finish();}
        if(!active)return;
        if(reply.status!==200&&reply.status!==503)throw new Error("设备状态读取失败，请检查设备连接。");
        const status=JSON.parse(reply.body);
        if(status.schema!=="dohc.device.status-summary.v2")throw new Error("当前连接暂未提供运行状态。");
        setRuntimePage({address:runtimeTarget.current?.apAddress??runtimePage?.address??"",html:"",status,observedAtMs:Date.now()});setRuntimeError("");
      }catch(cause){if(active)setRuntimeError(errorText(cause));}
      finally{if(active)timer=setTimeout(()=>void refresh(),5000);}
    }
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[pageRequest,pageView,section,working,runtimeRevision,apConfiguration]);
  if(section==="data")return null;
  if(pageView&&(section==="home"||section==="device"))return <><DevicePageView page={pageView} busy={working!==null} showConnectionMode={section==="device"||apConfiguration} connectionModeLabel={apConfiguration?"热点配置模式 · 配网与应用升级":connectionMode==="ap"?"设备热点（AP）":connectionMode==="type_c"?"Type-C 连接":"局域网 IP"} onBack={()=>{requestGeneration.current++;setPageView(null);onNavigate(apConfiguration?"home":"device");}} onRefresh={()=>{if(pageRequest)void openPage(pageRequest);}} otaPanel={<DeviceOtaPanel request={pageRequest} connected={true} busy={disabled} beginOperation={beginOperation} onError={setError}/>}/>{tr(error&&<ManagerErrorToast message={tr(error)} onDismiss={()=>setError("")}/>)}</>;
  const limited=observation?.cameraPortLimited??false;
  const counts=Object.fromEntries(resultOrder.map(status=>[status,run?.checks.filter(check=>check.status===status).length??0]));
  const connectionHelp=connectionMode==="ap"?"长按录制键，听到进入 AP 的语音后，连接设备标签对应的热点。":connectionMode==="lan"?"输入设备联网后语音播报的 IP，电脑需与设备处于同一网段。":"通过 Type-C 数据线连接已开机的 D1。";
  const connectionModeLabel=connectionMode==="ap"?"设备热点（AP）":connectionMode==="lan"?"局域网 IP":"Type-C 连接";
  const connectionControls=<section className="manager-connection-area" aria-label={t("设备连接方式")}>
    <div className="manager-connect-bar">
      <div className="manager-segmented" role="group" aria-label={t("连接方式")}>
        <button type="button" aria-pressed={connectionMode==="type_c"} disabled={disabled} onClick={()=>changeConnection("type_c")}><Cable size={17}/>{t("Type-C 连接")}</button>
        <button type="button" aria-pressed={connectionMode==="ap"} disabled={disabled} onClick={()=>changeConnection("ap")}><Wifi size={17}/>{t("设备热点（AP）")}</button>
        <button type="button" aria-pressed={connectionMode==="lan"} disabled={disabled} onClick={()=>changeConnection("lan")}><Wifi size={17}/>{t("局域网 IP")}</button>
      </div>
      {connectionMode==="ap" ? <button className="button button-secondary" disabled={disabled||!isTauriRuntime()} onClick={()=>void openPage({interfaceId:selectedWifi?.connected?selectedWifi.interfaceId:interfaceId??"",connectionMode:"ap"},false)}>{t("连接设备")}</button> : connectionMode==="lan" ? <form className="manager-ap-form" onSubmit={event=>{event.preventDefault();void connectLan();}}><label htmlFor="d1-lan-ip">{t("设备 IP")}</label><input id="d1-lan-ip" value={addressInput} inputMode="decimal" placeholder={t("输入语音播报的 IP")} disabled={disabled} onChange={event=>setAddressInput(event.target.value)}/><button className="button button-secondary" disabled={disabled||!isTauriRuntime()||!addressInput.trim()} type="submit">{t("连接设备")}</button></form> : <span className="manager-connect-hint" role="status">{working==="usb" ? <><LoaderCircle size={15} className="spin"/>{t("正在获取 USB 网络地址…")}</> : t("自动识别 · 只读设备状态")}</span>}
      {(availability?.linkDiscovery.candidates.length??0)>1&&<label className="manager-device-select">{connectionMode==="ap" ? t("Wi-Fi 网卡") : t("连接网卡")}<select aria-label={t("选择设备连接")} value={interfaceId??target??""} disabled={disabled} onChange={event=>selectInterface(event.target.value)}><option value="">{t("请选择连接")}</option>{availability?.linkDiscovery.candidates.map(link=><option key={link.interfaceId} value={link.interfaceId}>{link.name}</option>)}</select></label>}
    </div>
    {connectionMode==="ap"&&<section className="manager-wifi" aria-label={t("可用 Wi-Fi")}>
      <header><strong>{t("可用 Wi-Fi")}</strong><button className="button button-secondary manager-wifi-header-refresh" disabled={disabled||wifiLoading||!isTauriRuntime()} onClick={()=>void refreshWifi()}>{wifiLoading ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}{t("刷新 Wi-Fi")}</button></header>
      {tr(wifiError&&<p role="status">{tr(wifiError)}</p>)}{tr(wifi?.message&&<p>{tr(wifi.message)}</p>)}
      {wifi?.supported&&<><div className="manager-wifi-list">{wifi.networks.length===0&&!wifiLoading ? <p>{t("暂未发现可用 Wi-Fi，请确认电脑无线网卡已开启。")}</p> : wifi.networks.map(n=><button key={`${n.interfaceId}:${n.ssid}`} aria-pressed={wifiSelection===`${n.interfaceId}:${n.ssid}`} disabled={disabled||!n.recommended||(!n.connectable&&!n.connected)} onClick={()=>{setWifiSelection(`${n.interfaceId}:${n.ssid}`);setWifiPassword("");setManualWifiPassword(false);}}><Wifi size={17}/><strong>{n.ssid}</strong>{n.recommended&&<span className="manager-wifi-recommend">{t("设备热点 · 推荐")}</span>}<span className="manager-wifi-signal">{t("信号质量") + " "}{n.signal}%</span>{n.connected&&<span className="manager-wifi-connected">{t("已连接")}</span>}</button>)}</div>
      <small className="manager-wifi-observed">{t("列表更新于") + " "}{tr(new Date(wifi.observedAtMs).toLocaleTimeString(localeTag(),{hour12:false}))}</small>
      {!wifi.networks.some(n=>n.recommended)&&!wifiLoading&&<p>{t("未发现 D1 热点。请确认设备已进入 AP 模式后刷新。")}</p>}
      {selectedWifi&&<form className="manager-wifi-form" onSubmit={event=>{event.preventDefault();void connectWifi();}}>{!selectedWifi.connected&&<><button type="button" className="button button-secondary manager-wifi-password-toggle" onClick={()=>{setManualWifiPassword(v=>!v);setWifiPassword("");}}><KeyRound size={15}/>{manualWifiPassword ? t("使用默认密码") : t("手动输入密码")}</button>{manualWifiPassword&&<><label htmlFor="d1-wifi-password">{t("热点密码")}</label><input id="d1-wifi-password" type="password" autoComplete="off" maxLength={63} value={wifiPassword} disabled={disabled} onChange={event=>setWifiPassword(event.target.value)}/></>}</>}<button className="button button-primary" type="submit" disabled={disabled||(!selectedWifi.connected&&manualWifiPassword&&!wifiPassword)}>{working==="wifi" ? t("正在连接…") : working==="page" ? t("正在核对连接…") : selectedWifi.connected ? t("确认设备连接") : t("连接热点")}</button><small>{t("连接热点会切换电脑 Wi-Fi；密码仅用于本次连接。")}</small></form>}</>}
    </section>}
    <aside className="manager-connection-guide" aria-label={connectionMode==="ap" ? t("热点连接教程") : connectionMode==="lan" ? t("局域网连接教程") : t("Type-C 连接提示")}>
      <strong>{connectionMode==="ap" ? t("如何连接设备热点") : connectionMode==="lan" ? t("如何获取设备 IP") : t("Type-C 连接提示")}</strong>
      {connectionMode==="type_c" ? <><p>{t("请使用支持数据传输的 USB-A 转 Type-C 数据线，将电脑 A 口连接到 D1 的 Type-C 口。")}</p><p>{t("D1 唯一的 Type-C 口连接电脑期间，扩展相机将暂时断开；需要检测相机时，请改用局域网连接。")}</p></> : connectionMode==="ap" ? <><p>{t("设备未在采集时，长按录制键，等待语音确认进入 AP 模式。")}</p><p>{t("选择设备标签对应的") + " "}<b>Delta-D1-***</b>{" " + t("热点；热点无需联网，默认密码自动填写。")}</p><p>{t("热点配置模式用于配网和应用升级。查看完整设备信息、检测相机，请配网后使用局域网 IP，或切换 Type-C。")}</p></> : <><p>{t("先按设备操作手册完成配网，确认设备已联网。")}</p><p>{t("长按录制键后接短按，等待设备语音播报本机 IP。")}</p><p>{t("输入播报的 IP 后连接，成功后使用下方按钮进入所需功能。")}</p></>}
    </aside>
    <div className="manager-device-access">
      <header className="manager-access-heading">
        <div><h2>{t("设备工作区")}</h2><p>{connected||confirmedPage&&!runtimeError ? apConfiguration ? t("热点已连接，可进入设备管理。") : t("连接已就绪，选择需要的功能。") : t("连接设备后，即可使用以下功能。")}</p></div>
        {(connected||confirmedPage)&&!runtimeError&&<span className="manager-connection-success" role="status"><span className="manager-status-dot"/>{t("连接成功")}<span className="manager-connected-address">{confirmedPage?.address ?? tr(observation?.connectionAddress) ?? runtimePage?.address}</span></span>}
      </header>
      <nav className="manager-connected-actions" aria-label={t("已连接设备操作")}>
        <button className="manager-access-card" aria-label={t("设备管理")} disabled={disabled||!(connected||confirmedPage&&!runtimeError)} onClick={()=>{const request=pageRequest??(target?{interfaceId:target,connectionMode}:null);if(confirmedPage&&!runtimeError)setPageView(confirmedPage);else if(request)void openPage(request);}}><span className="manager-access-icon"><Settings2 size={22}/></span><span className="manager-access-copy"><strong>{t("设备管理")}</strong><small>{t("设备配置与应用升级")}</small></span><ArrowRight className="manager-access-arrow" size={18}/></button>
        <button className="manager-access-card" aria-label={t("设备信息")} disabled={disabled||!connected||apConfiguration} title={apConfiguration ? t("当前设备热点尚未提供运行报告，请使用局域网 IP 或 Type-C 查看") : undefined} onClick={()=>onNavigate("device")}><span className="manager-access-icon"><Info size={22}/></span><span className="manager-access-copy"><strong>{t("设备信息")}</strong><small>{t("查看版本、相机与存储")}</small></span><ArrowRight className="manager-access-arrow" size={18}/></button>
        <button className="manager-access-card" aria-label={t("检测排障")} disabled={disabled||!connected||apConfiguration} title={apConfiguration ? t("当前热点未提供检测接口，请使用局域网 IP 或 Type-C 检测") : undefined} onClick={()=>onNavigate("diagnostics")}><span className="manager-access-icon"><ShieldCheck size={22}/></span><span className="manager-access-copy"><strong>{t("检测排障")}</strong><small>{t("运行检测与查看告警")}</small></span><ArrowRight className="manager-access-arrow" size={18}/></button>
      </nav>
      {observation&&<p className="manager-access-observation">{t("应用") + " "}{tr(observation.device.applicationVersion) ?? t("版本未提供")} · {observation.connectionLimitedOnly ? t("相机连接受限") : tr(healthLabel(observation.health))}</p>}
      {!connected&&availability?.error&&<p className="manager-access-observation">{tr(availability.error.message)}</p>}
    </div>
  </section>;
  return <main className={`manager-workspace manager-section-${section}`} aria-label={t("D1 设备工作区")}>
    {tr(error&&<ManagerErrorToast message={tr(error)} onDismiss={()=>setError("")}/>)}
    <header className="manager-page-heading"><h1>{section==="home" ? t("D1 设备工作台") : section==="device" ? t("设备信息") : section==="diagnostics" ? t("检测排障") : t("日志与支持")}</h1><ConnectionBadge connected={connected} pageOnly={pageOnly}/></header>
    {section==="home"&&connectionControls}
    {section==="device"&&connected&&<p className="manager-actual-connection" role="status"><span>{t("实际连接方式")}</span><strong>{tr(connectionModeLabel)}</strong></p>}
    {(section==="device"||section==="diagnostics")&&apConfiguration&&<section className="manager-empty compact" aria-label={t("热点配置模式")}><Wifi size={30}/><h2>{t("热点配置模式")}</h2><p>{t("已连接设备热点，但当前固件没有提供可用的运行报告。可在设备页面配网与升级，或切换连接方式查看设备信息。")}</p><p>{t("配网后使用局域网 IP，或切换 Type-C 查看设备信息与检测。")}</p><button className="button button-primary" disabled={disabled||!pageRequest} onClick={()=>{if(pageRequest)void openPage(pageRequest);}}>{t("打开配置与升级")}</button><button className="button button-secondary" onClick={()=>onNavigate("home")}>{t("选择其他连接方式")}</button></section>}
    {section==="device"&&!apConfiguration&&<>
      {(pageRequest||statusPage) ? <DeviceRuntimePanel cameraPortLimited={!runtimePage&&observation?.cameraPortLimited} connectionLimitedOnly={!runtimePage&&observation?.connectionLimitedOnly} page={statusPage} error={runtimeError} refresh={()=>setRuntimeRevision(n=>n+1)} onConfigure={pageRequest?()=>void openPage(pageRequest):undefined} onNavigate={()=>onNavigate("diagnostics")}/> : observation ? <><div className="manager-device-layout"><DeviceSummary snapshot={observation} onOpenDiagnostics={()=>onNavigate("diagnostics")}/><section className="manager-card manager-current-status"><header className="manager-device-heading"><h2>{t("相机与存储")}</h2><button className="button button-secondary" type="button" disabled={disabled} onClick={()=>onNavigate("diagnostics")}>{t("完整检测结果")}<ArrowRight size={15}/></button></header><div className="manager-camera-grid">{observation.cameras.map(camera=><div key={camera.role}><strong>{tr(cameraLabel(camera.role))}</strong><ResultBadge status={limited&&camera.role==="stereo_extension"?"not_run":camera.enabled===false?"not_run":observation.heartbeatStale!==false?"indeterminate":camera.state==="STREAMING"&&camera.fresh?"normal":["FAULT","FAILED"].includes(camera.state??"")&&camera.fresh===false?"abnormal":"indeterminate"} label={limited&&camera.role==="stereo_extension" ? t("未检查") : tr(deviceStateLabel(camera.state))}/><small>{camera.effectiveFps===null ? t("帧率未提供") : t("{0} 帧/秒", [tr(camera.effectiveFps.toFixed(1))])}</small></div>)}</div><p>{t("采集存储：")}{observation.storage?.writable===true ? t("可写") : observation.storage?.writable===false ? t("不可写") : t("状态未提供")}</p>{limited&&<p className="manager-port-note">{t("Type-C 当前用于连接电脑，扩展双目相机不参与本次检测；设备可能仍亮红灯。")}</p>}<p className="manager-observed">{t("完整告警和检测证据位于“检测排障”。")}</p></section></div></> : <><section className="manager-empty compact"><Cable size={32}/><h2>{pageOnly ? t("暂不能读取设备报告") : availability?.error ? t("设备报告暂不可用") : t("等待 D1 连接")}</h2>{tr(availability?.attemptedAddress&&<dl className="manager-metadata"><div><dt>{connectionMode==="ap" ? t("热点 IP") : t("连接 IP")}</dt><dd>{tr(availability.attemptedAddress)}</dd></div></dl>)}<p>{connectionMode!=="type_c" ? tr(connectionHelp) : tr(connectionLabel)}</p></section></>}
    </>}
    {section==="device"&&<DeviceOtaPanel request={upgradeRequest} connected={!!upgradeRequest} busy={disabled} beginOperation={beginOperation} onError={setError}/>}
    {section==="diagnostics"&&!apConfiguration&&<>
      <section className="manager-diagnostic-controls" aria-label={t("设备检测操作")}><div><strong>{connected ? t("D1 · 应用 {0}", [tr(observation?.device.applicationVersion) ?? tr(String(runtimePage?.status?.device&&typeof runtimePage.status.device==="object"?(runtimePage.status.device as Record<string,unknown>).workspace_version??"版本未提供":"版本未提供"))]) : t("等待设备连接")}</strong><p>{limited ? t("Type-C 占用相机接口，扩展双目相机不参与本次检测。") : t("只读检查，不启动录制或修改设备。")}</p></div><div className="manager-actions"><button className="button button-primary" disabled={disabled||!target} onClick={()=>void detect()}>{working==="diagnostics" ? <LoaderCircle size={17} className="spin"/> : <ShieldCheck size={17}/>}{t("运行设备检测")}</button>{working==="diagnostics"&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling ? t("正在取消") : t("取消检测")}</button>}<button className="button button-secondary" disabled={disabled||!run} onClick={()=>onNavigate("support")}><FileArchive size={17}/>{t("查看诊断包")}</button></div></section>
      {statusPage&&<DeviceRuntimePanel cameraPortLimited={!runtimePage&&observation?.cameraPortLimited} connectionLimitedOnly={!runtimePage&&observation?.connectionLimitedOnly} page={statusPage} diagnostics error={runtimeError} refresh={()=>setRuntimeRevision(n=>n+1)} onConfigure={pageRequest?()=>{onNavigate("device");void openPage(pageRequest);}:undefined}/>}
      {working==="diagnostics"&&<p className="manager-running" role="status">{t("正在读取 D1 健康报告…")}</p>}
      {run ? <><div className="manager-run-summary" role="status"><strong>{tr(deviceTaskLabels[run.status])}</strong><span>{tr(time(run.finishedAtMs))}{!connected ? t(" · 当前未取得设备报告") : ""}</span><div className="manager-result-counts" aria-label={t("检测结果统计")}>{resultOrder.filter(status=>counts[status]>0).map(status=><ResultBadge key={status} status={status} label={t("{0} {1}", [tr(deviceResultLabels[status]), counts[status]])}/>)}</div></div><div className="manager-checks" hidden={!!statusPage}>{[...run.checks].sort((a,b)=>resultOrder.indexOf(a.status)-resultOrder.indexOf(b.status)).map(check=><DiagnosticCard check={check} snapshot={run.observation} key={check.id}/>)}</div></> : !working&&!statusPage&&<section className="manager-empty compact"><ClipboardList size={30}/><h2>{t("尚未运行检测")}</h2><p>{connected ? t("运行设备检测，读取当前状态和告警。") : tr(connectionLabel)}</p>{!connected&&<button className="button button-secondary" onClick={()=>onNavigate("device")}>{t("前往连接设备")}</button>}</section>}
    </>}
    {section==="support"&&<div className="manager-support-layout"><section className="manager-card"><header className="manager-device-heading"><h2>{t("本地诊断包")}</h2><FileArchive size={21}/></header><p>{t("包含本次设备健康观测与检测摘要，暂不包含原始设备日志。")}</p>{run ? <>
      <dl className="manager-metadata"><div><dt>{t("设备标识")}</dt><dd>{run.device?.id ?? t("本次未能读取")}</dd></div><div><dt>{t("应用版本")}</dt><dd>{tr(run.device?.applicationVersion) ?? t("本次未能读取")}</dd></div><div><dt>{t("观测范围")}</dt><dd>{tr(time(run.startedAtMs))} — {tr(time(run.finishedAtMs))}</dd></div></dl>
      <div className="manager-actions"><button className="button button-secondary" disabled={disabled||!isTauriRuntime()} onClick={()=>void prepare()}><ClipboardList size={17}/>{t("预览检测包")}</button>{preview&&<button className="button button-primary" disabled={disabled} onClick={()=>void exportBundle()}><Download size={17}/>{t("导出到本机")}</button>}{working==="export"&&operation.current&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>{t("取消导出")}</button>}</div>
      {!isTauriRuntime()&&<p>{t("请在桌面客户端预览并导出诊断包。")}</p>}
      {preview&&<div className="manager-package-preview" aria-label={t("诊断包预览")}><p>{tr(preview.privacy)}</p>{preview.files.map(file=><article key={file.name}><strong>{file.name}</strong><span>{file.bytes}{" " + t("字节")}</span><code>SHA-256 {tr(file.sha256)}</code></article>)}</div>}
      {tr(output&&<div className="manager-export-success" role="status"><CheckCircle2 size={18}/><span>{t("已导出：")}{tr(output)}</span><button className="text-button" onClick={()=>void revealOutput(output).catch(cause=>setError(errorText(cause)))}>{t("打开所在位置")}</button></div>)}
    </> : <div className="manager-empty compact"><FileArchive size={30}/><h2>{t("还没有检测记录")}</h2><p>{t("完成设备检测后，即可预览和导出。")}</p><button className="button button-secondary" onClick={()=>onNavigate("diagnostics")}>{t("前往检测")}</button></div>}</section><DiagnosticLogPanel run={run} busy={disabled} beginOperation={beginOperation} onError={setError}/></div>}
  </main>;
}
