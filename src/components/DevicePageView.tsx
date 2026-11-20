import { installDevicePageLanguage } from "../lib/device-page-language";
import { getLanguage, presentationMessages, localeTag, t, tr, useLanguage } from "../lib/i18n";
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {ArrowLeft, RefreshCw, LoaderCircle, CheckCircle2, AlertCircle} from "lucide-react";
import type {DevicePage, DevicePageApiRequest, DevicePageApiResponse} from "../lib/d1";


const deviceGuideControls: Record<string, string> = {
  "wifi-name": "form[data-d1-form=configure] [name=ssid]",
  "wifi-password": "form[data-d1-form=configure] [name=password]",
  "wifi-submit": "form[data-d1-form=configure] button[type=submit],form[data-d1-form=configure] button:not([type])",
  "display-name": "#deviceName",
  "save-name": "#saveDeviceName",
  "new-name": "#newName",
  "add-name": "#addName",
  "device-task": "#deviceTask",
  "save-task": "#saveDeviceTask",
  "new-task": "#newTask",
  "add-task": "#addTask",
  "camera-field": "#cameraRows input,#cameraConfigRows input,#cameraConfig input",
  "camera-save": "#saveCameraConfig",
  "runtime-link": "a[data-d1-route='/config']",
  "runtime-category": "#category",
  "runtime-field": "#fields select,#fields input",
  "runtime-save": "#save",
};

function bridgeScript(token:string):string {
  const script = `(function(){
const token=__TOKEN__,pending=new Map();let serial=0,ready=false,openOta=false,otaRetry;
const hello=()=>window.parent.postMessage({type:"d1-page-ready",token},"*");
const handshake=setInterval(hello,100);hello();

const guideSelectors=__GUIDE_SELECTORS__;
let guideKey="",guideTarget=null,guideStatus="";
const guideStyle=document.createElement("style");
guideStyle.textContent="[data-d1-guide-focus]{outline:3px solid #0eb9a6!important;outline-offset:4px!important;box-shadow:0 0 0 4px #e2fffa,0 0 0 150vmax #10182799!important;position:relative!important;z-index:99!important}";
document.head.append(guideStyle);
function notifyGuide(action){window.parent.postMessage({type:"d1-page-guide-action",token,selector:guideKey,action},"*")}
function updateGuide(){
  const selector=Object.hasOwn(guideSelectors,guideKey)?guideSelectors[guideKey]:null;
  const target=selector?[...document.querySelectorAll(selector)].find(el=>el.getClientRects().length&&!el.matches(":disabled,[aria-disabled=true]")):null;
  if(guideTarget!==target){guideTarget?.removeAttribute("data-d1-guide-focus");guideTarget=target;guideTarget?.setAttribute("data-d1-guide-focus","");guideTarget?.scrollIntoView({block:"nearest"})}
  const status=target?"located":"missing";if(guideKey&&status!==guideStatus){guideStatus=status;notifyGuide(status)}
}
let guideTimer;
window.addEventListener("message",event=>{
  const data=event.data;if(event.source!==window.parent||data?.token!==token||data.type!=="d1-page-guide-target")return;
  guideKey=typeof data.selector==="string"?data.selector:"";guideStatus="";clearInterval(guideTimer);
  updateGuide();if(guideKey)guideTimer=setInterval(updateGuide,160);
});
for(const action of ["click","change"])document.addEventListener(action,event=>{
  if(event.isTrusted&&guideKey&&guideTarget?.contains(event.target))notifyGuide(action);
},true);
document.addEventListener("keydown",event=>{
  if(event.isTrusted&&guideKey&&event.key==="Escape"){event.preventDefault();notifyGuide("exit")}
},true);

function sendOpenOta(){if(!openOta||!ready)return;window.parent.postMessage({type:"d1-page-open-ota",token},"*");if(!otaRetry)otaRetry=setInterval(()=>{if(openOta&&ready)window.parent.postMessage({type:"d1-page-open-ota",token},"*")},100)}
function route(value){const url=new URL(value,"http://d1.invalid/");if(url.origin!=="http://d1.invalid"||url.search||!["/","/status","/config","/configure","/api/v1/runtime-config","/api/v1/camera-config","/api/v1/device-name","/api/v1/device-task"].includes(url.pathname))throw new Error("此设备功能暂不可用");return url.pathname}
function request(path,method,headers,body,navigate=false){const id=String(++serial);return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve({status:504,contentType:"application/json",body:JSON.stringify({message:method==="GET"?"设备响应超时，请重试":"尚未确认是否保存成功，请先重新读取配置核对，勿重复提交"})})},method==="GET"?15000:75000);const message={type:"d1-page-request",token,id,path,method,headers,body,navigate};pending.set(id,{resolve,timer,message});if(ready)window.parent.postMessage(message,"*")})}
window.addEventListener("message",event=>{const data=event.data;if(event.source!==window.parent||data?.token!==token)return;if(data.type==="d1-page-host-ready"){if(ready)return;ready=true;clearInterval(handshake);for(const item of pending.values())window.parent.postMessage(item.message,"*");sendOpenOta();return}if(data.type==="d1-page-open-ota-ack"){openOta=false;clearInterval(otaRetry);otaRetry=undefined;return}if(data.type!=="d1-page-response"||!pending.has(data.id))return;const item=pending.get(data.id);pending.delete(data.id);clearTimeout(item.timer);item.resolve(data)});
window.fetch=async(input,init={})=>{try{const requestObject=input instanceof Request?input:null,raw=typeof input==="string"?input:input instanceof URL?input.href:input.url,path=route(raw),method=String(init.method??requestObject?.method??"GET").toUpperCase();if(!["GET","PUT","POST"].includes(method))throw new Error("设备页面操作不支持");const requestHeaders=new Headers(requestObject?.headers);new Headers(init.headers).forEach((value,key)=>requestHeaders.set(key,value));const headers=Object.fromEntries([...requestHeaders.entries()].filter(([key])=>["content-type","if-match"].includes(key.toLowerCase())));const sourceBody=Object.hasOwn(init,"body")?init.body:requestObject?await requestObject.clone().text():undefined;const body=method==="GET"||sourceBody===undefined?undefined:typeof sourceBody==="string"?sourceBody:await new Response(sourceBody).text();const reply=await request(path,method,headers,body);return new Response(reply.body||"",{status:reply.status,headers:{"Content-Type":reply.contentType||"text/plain"}})}catch(error){return new Response(JSON.stringify({message:error instanceof Error?error.message:"设备请求失败"}),{status:502,headers:{"Content-Type":"application/json"}})}};
document.addEventListener("click",event=>{const link=event.target instanceof Element?event.target.closest("a"):null;if(!link)return;event.preventDefault();try{const raw=link.getAttribute("data-d1-route")||link.getAttribute("href");if(!raw||raw==="#")return;void request(route(raw),"GET",{},undefined,true)}catch{}});
document.addEventListener("click",event=>{if(event.target instanceof Element&&event.target.closest("#ota-relay,#labMaint")){event.preventDefault();event.stopImmediatePropagation();openOta=true;sendOpenOta();}},true);
document.addEventListener("submit",event=>{event.preventDefault();const form=event.target;if(!(form instanceof HTMLFormElement)||form.getAttribute("data-d1-form")!=="configure")return;const fields=new FormData(form),body=JSON.stringify({ssid:fields.get("ssid"),password:fields.get("password")});const password=form.querySelector('input[name="password"]');if(password)password.value="";void request("/configure","POST",{"content-type":"application/json"},body,true)});
})()`.replace("__TOKEN__",JSON.stringify(token)).replace("__GUIDE_SELECTORS__",JSON.stringify(deviceGuideControls));
  return script;
}

export function interactiveDeviceHtml(html:string,page:DevicePage,token:string):string {
  const template=document.createElement("template");template.innerHTML=html;
  const allowed=new Set("STYLE SCRIPT DIV SECTION MAIN HEADER FOOTER NAV ARTICLE ASIDE H1 H2 H3 H4 P SPAN STRONG B EM I SMALL TABLE THEAD TBODY TFOOT TR TH TD DL DT DD UL OL LI BR HR PRE CODE LABEL INPUT SELECT OPTION BUTTON TEXTAREA FORM A DETAILS SUMMARY".split(" "));
  for(const element of template.content.querySelectorAll("*")) {
    if(!allowed.has(element.tagName)){element.remove();continue;}
    if(element.tagName==="SCRIPT"&&(element.hasAttribute("src")||/<\/script/i.test(element.textContent??"")||(element.textContent??"").includes("/ota/"))){element.remove();continue;}
    if(element.tagName==="STYLE"&&/<\/style/i.test(element.textContent??"")){element.remove();continue;}
    if(element.tagName==="A"){
      const href=element.getAttribute("href");
      try{const url=new URL(href??"","http://d1.invalid/");if(url.origin==="http://d1.invalid"&&!url.search&&["/","/config"].includes(url.pathname)){element.setAttribute("data-d1-route",url.pathname);element.setAttribute("href","#");}else element.removeAttribute("href");}catch{element.removeAttribute("href");}
    }
    if(element.tagName==="FORM"&&element.getAttribute("method")?.toLowerCase()==="post"&&element.getAttribute("action")==="/configure")element.setAttribute("data-d1-form","configure");
    for(const attribute of [...element.attributes]) {
      if(attribute.name.toLowerCase().startsWith("on"))element.removeAttribute(attribute.name);
      else if(!["class","id","style","title","colspan","rowspan","scope","type","value","selected","checked","open","disabled","required","name","min","max","step","minlength","maxlength","placeholder","autocomplete","multiple","data-key","data-category","data-d1-route","data-d1-form","href"].includes(attribute.name)&&!attribute.name.startsWith("aria-"))element.removeAttribute(attribute.name);
    }
    if(element.matches('input[type="password"]'))element.removeAttribute("value");
    // Binary relay uses the native, validated OTA flow below the sandbox. Never
    // send firmware through the text-only configuration request bridge.
    if(element.id==="ota-relay"){element.removeAttribute("disabled");element.textContent="打开应用升级";}
    if(element.matches('#ota-form,#ota-file,#ota-submit'))element.remove();
    if(element.id==="labMaint")element.textContent="应用升级";
    if(element.id==="ota-status")element.textContent="在 D1 Manager 中检查版本并升级。";
  }
  if(page?.status)fillStatus(template.content,page);
  else if(template.content.querySelector('#cameraRows')) {
    for(const id of ["identity","health","cameraSummary","alertSummary"]) {
      const item=template.content.querySelector(`#${id}`);if(item)item.textContent="暂未获取";
    }
  }
  for(const script of template.content.querySelectorAll("script"))script.textContent=script.textContent?.replaceAll("location.hostname",JSON.stringify(page.address))??"";
  if(template.content.querySelector('#viewHome')){
    const home=template.content.querySelector('#viewHome')!;
    const summary=home.querySelector('.summary');if(summary)home.prepend(summary);
    for(const id of ['cameraRows','alerts','cameraConfigRows','components'])template.content.querySelector(`#${id}`)?.closest('section')?.classList.add('d1-host-wide');
  }
  const theme=document.createElement("style");theme.textContent=`
html,body{height:100%;min-width:0}body{font:14px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;background:#f5f7fa}
body>header{order:-2;padding:18px max(24px,calc((100% - 1192px)/2));background:#fff;border-bottom:1px solid #e2e7ec}h1{font-size:21px;letter-spacing:0}.head-row{gap:14px}
body>main{width:100%;max-width:1240px;min-width:0;padding:20px 24px 28px;margin:0 auto}
body>nav.tabs{order:-1;border-top:0;border-bottom:1px solid #e2e7ec;background:#fff;padding:0 max(24px,calc((100% - 1192px)/2));gap:24px}
.tabs label{flex:0 1 auto;min-width:72px;font-size:14px;line-height:44px;cursor:pointer;border-bottom:2px solid transparent}.tabs label.tabSel{border-bottom-color:#216da8}
#labMaint{display:none}#viewHome,#viewDevice{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}#viewHome[style*="none"],#viewDevice[style*="none"]{display:none}
#viewHome>.summary,.d1-host-wide{grid-column:1/-1}.summary{gap:12px;margin:0;background:transparent;border:0}.summary>div{border:1px solid #e0e6ec!important;border-radius:8px;padding:16px;background:#fff}.summary .value{font-size:18px}
section{min-width:0;border:1px solid #e0e6ec;border-radius:8px;background:#fff;padding:18px;margin:0}section h2{font-size:14px;color:#34465a;margin:0 0 12px}.kv{gap:0 16px}.kv>div{min-width:0}.choice{gap:8px}.choice input,.choice select{min-height:38px;font-size:14px}.choice button,button{min-height:36px;font-size:14px;border-radius:6px}.badge{border-radius:5px}
#identity{overflow-wrap:anywhere}.led-row{padding:12px 0}.led-swatch{width:16px;height:16px}.config-grid input,.config-grid select{font-size:14px}.config-link{font-size:13px}
@media(max-width:760px){body>header{padding:14px 16px}body>main{padding:16px}body>nav.tabs{padding:0 16px}#viewHome,#viewDevice{grid-template-columns:minmax(0,1fr);gap:12px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary>div{padding:12px}section{padding:14px}.head-row{flex-wrap:wrap}}
`;template.content.append(theme);
  const bridge=document.createElement("script");bridge.textContent=`(${installDevicePageLanguage.toString()})(${JSON.stringify(token)});\n`+bridgeScript(token);template.content.prepend(bridge);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; img-src \'none\'; form-action \'none\'; base-uri \'none\'; frame-src \'none\'; object-src \'none\'"></head><body>'+template.innerHTML+'</body></html>';
}
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const items=(value:unknown)=>Array.isArray(value)?value:[];
const text=(value:unknown,fallback="-")=>typeof value==="string"||typeof value==="number"?String(value):fallback;
const num=(value:unknown,digits:number,suffix:string)=>typeof value==="number"&&Number.isFinite(value)?`${value.toFixed(digits)}${suffix}`:"-";
const bytes=(value:unknown)=>typeof value==="number"?`${(value/1024**3).toFixed(1)} GiB`:"-";
function fillStatus(root:DocumentFragment,page:DevicePage) {
  const s=page.status!;const d=obj(s.device),r=obj(s.runtime),c=obj(s.cameras),a=obj(s.alerts),storage=obj(s.storage),emmc=obj(s.emmc_storage),recording=obj(s.recording),t=obj(s.telemetry),qc=obj(s.qc),stress=obj(s.stress_test),updater=obj(s.updater);
  const set=(id:string,value:unknown,fallback="-")=>{const element=root.querySelector(`#${id}`);if(element)element.textContent=text(value,fallback);};
  const mapped:Record<string,unknown>={identity:[d.device_id,d.workspace_version&&`v${d.workspace_version}`,d.channel].filter(Boolean).join(" | "),health:s.health,phase:s.phase,admission:s.can_stop?"采集中，可停止":s.can_start?"允许开始":"禁止开始",cameraSummary:`${text(c.fresh)} / ${text(c.configured)} fresh`,alertSummary:`共 ${text(a.total)} / 严重 ${text(a.critical)} / 警告 ${text(a.warning)}`,deviceId:d.device_id,address:page.address,channel:d.channel,workspace:d.workspace_version,release:d.release_id,firmware:d.firmware_version,uptime:num(r.uptime_seconds,0," 秒"),heartbeat:s.heartbeat_stale?"超时":num(s.heartbeat_age_seconds,3," s"),runtimeTime:r.timestamp,reasons:items(s.reasons).map(v=>text(v,"")).join("; ")||"无",sd:`${storage.writable?"可写":"不可用"} | ${text(storage.filesystem_type)} | ${num(storage.used_percent,1,"% 已用")}`,sdFree:`${bytes(storage.free_bytes)} / ${bytes(storage.total_bytes)}`,emmc:`${num(emmc.used_percent,1,"% 已用")} | 剩余 ${bytes(emmc.free_bytes)}`,session:recording.session_active?"采集中":"无",captureDuration:recording.session_active?"设备未提供":"未采集",quality:`${text(recording.quality)} | drops ${text(recording.dropped_batches)}`,queue:`${text(recording.queue_depth)} / ${text(recording.queue_capacity)} | writer ${recording.writer_alive?"running":"stopped"}${recording.writer_busy?" / busy":""}`,voltage:num(t.vcc_voltage,3," V"),temperature:num(t.chip_temp,1," C"),sampledAt:t.sampled_at,qc:`${text(qc.phase)} / ${text(qc.result)}`,qcProgress:num(qc.progress_percent,1,"%"),qcFailures:items(qc.failures).map(v=>text(v,"")).join(", ")||"无",stress:`${text(stress.phase)} / ${text(stress.result)} | ${num(stress.elapsed_seconds,0," 秒")} | ${text(stress.sample_count)} samples`,updater:`${text(updater.state)} / ${text(updater.result)}`,updateRelease:updater.release_after,updateReason:updater.reason,schema:s.schema,updated:`更新于 ${new Date(page.observedAtMs).toLocaleTimeString(localeTag())}`};
  for(const [id,value] of Object.entries(mapped))set(id,value);
  const health=root.querySelector('#health');if(health)health.className=`badge ${s.health==="OK"?"ok":s.health==="DEGRADED"?"warn":"fail"}`;
  function row(parent:Element,kind:string,values:{kind:string;value:unknown}[]) {const div=document.createElement("div");div.className=kind;for(const field of values){const item=document.createElement("div");item.className=field.kind;item.textContent=text(field.value);div.append(item);}parent.append(div);}
  const stateClass=(state:unknown)=>["STREAMING","OK","RUNNING"].includes(text(state))?"ok":["FAILED","FAULT","CRITICAL"].includes(text(state))?"fail":"warn";
  const cameras=root.querySelector('#cameraRows');if(cameras){cameras.replaceChildren();for(const entry of items(c.items)){const camera=obj(entry);row(cameras,"camera-row",[{kind:"camera-role",value:camera.role},{kind:`state ${stateClass(camera.state)}`,value:camera.state},{kind:"camera-meta",value:`${camera.extension?"extension":camera.required?"required":"optional"} | ${camera.fresh?"fresh":"stale"} | age ${num(camera.last_frame_age_seconds,3," s")} | reconnects ${text(camera.reconnect_count)}`}]);}}
  const alerts=root.querySelector('#alerts');if(alerts){alerts.replaceChildren();if(!items(a.items).length)alerts.textContent="无活动告警";for(const entry of items(a.items)){const alert=obj(entry);row(alerts,"alert-row",[{kind:`badge ${alert.severity==="critical"?"fail":"warn"}`,value:alert.severity},{kind:"alert-head",value:[alert.component,alert.code].filter(Boolean).join(" · ")},{kind:"alert-message",value:alert.message},{kind:"alert-action",value:alert.action}]);}}
  const components=root.querySelector('#components');if(components){components.replaceChildren();for(const entry of items(s.components)){const component=obj(entry);row(components,"component-row",[{kind:"",value:component.name},{kind:`state ${stateClass(component.state)}`,value:component.state}]);}}
  const indicators=root.querySelector('#ledRows');if(indicators){indicators.replaceChildren();for(const [label,key] of [["状态灯","status"],["电池灯","battery"]]){const led=obj(obj(s.indicators)[key]);row(indicators,"led-row",[{kind:"",value:label},{kind:"",value:[led.color_name,led.mode,led.pattern,led.trigger,led.write_state].map(v=>text(v)).join(" | ")}]);}}
  const battery=obj(stress.battery);set("stressPower",`start ${num(battery.start_voltage,3," V")} | now ${num(battery.end_voltage,3," V")} | min ${num(battery.minimum_voltage,3," V")}`);
  set("stressCameras",items(stress.cameras).map(entry=>{const camera=obj(entry);return `${text(camera.stream)} ${text(camera.read)}/${text(camera.write)}/${text(camera.saved)}`;}).join(" | ")||"无");set("stressReport","只读模式不收集报告文件");
}
export function DevicePageView({page,busy,showConnectionMode,connectionModeLabel,onBack,onRefresh,onRequest,onVerifyAddress,otaPanel}:{page:DevicePage;busy:boolean;showConnectionMode:boolean;connectionModeLabel:string;onBack:()=>void;onRefresh:()=>void;onRequest:(request:DevicePageApiRequest)=>Promise<DevicePageApiResponse>;onVerifyAddress:(address:string)=>Promise<DevicePage>;otaPanel?:ReactNode}) {
  const language=useLanguage();
  const frame=useRef<HTMLIFrameElement>(null);
  const otaContainer=useRef<HTMLDivElement>(null);
  const [activePanel,setActivePanel]=useState<"device"|"upgrade">("device");
  const [navigation,setNavigation]=useState<{html:string;version:number}|null>(null);
  const [navigationError,setNavigationError]=useState("");
  const [provisioning,setProvisioning]=useState<{started:number;state:"waiting"|"failed"|"unconfirmed";message:string}|null>(null);
  const [elapsed,setElapsed]=useState(0);
  const [newAddress,setNewAddress]=useState("");
  const [verifying,setVerifying]=useState(false);
  useLayoutEffect(()=>{setNavigation(null);setNavigationError("");setProvisioning(null);setActivePanel("device");},[page]);
  const token=useMemo(()=>crypto.randomUUID(),[page,navigation]);
  const requestHandler=useRef(onRequest);requestHandler.current=onRequest;
  const html=useMemo(()=>interactiveDeviceHtml(navigation?.html??page.html,navigation?{...page,status:null}:page,token),[page,token,navigation]);
  const guideSelector=useRef("");
  const sendGuide=()=>frame.current?.contentWindow?.postMessage({type:"d1-page-guide-target",token,selector:guideSelector.current},"*");
  const sendLanguage=()=>frame.current?.contentWindow?.postMessage({type:"d1-page-language",token,language:getLanguage(),messages:presentationMessages()},"*");
  useLayoutEffect(()=>{sendLanguage();},[language,token]);
  useLayoutEffect(()=>{
    const onMessage=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow)return;
      const message=event.data;
      if(message?.type==="d1-page-ready"&&message.token===token){frame.current?.contentWindow?.postMessage({type:"d1-page-host-ready",token},"*");sendLanguage();sendGuide();return;}
      if(message?.type==="d1-page-guide-action"&&message.token===token&&message.selector===guideSelector.current&&Object.hasOwn(deviceGuideControls,message.selector)&&["located","missing","click","change","exit"].includes(message.action)){window.dispatchEvent(new CustomEvent("d1-guide-frame-action",{detail:{selector:message.selector,action:message.action}}));return;}
      if(message?.type==="d1-page-open-ota"&&message.token===token){frame.current?.contentWindow?.postMessage({type:"d1-page-open-ota-ack",token},"*");setActivePanel("upgrade");requestAnimationFrame(()=>otaContainer.current?.querySelector("button")?.focus({preventScroll:true}));return;}
      if(message?.type!=="d1-page-request"||message.token!==token||typeof message.id!=="string"||typeof message.path!=="string"||!(["GET","PUT","POST"] as string[]).includes(message.method))return;
      const request:DevicePageApiRequest={path:message.path,method:message.method,body:typeof message.body==="string"?message.body:undefined,ifMatch:typeof message.headers?.["if-match"]==="string"?message.headers["if-match"]:undefined};
      void requestHandler.current(request).then(reply=>{
        const response:{type:string;token:string;id:string;status:number;contentType:string;body:string;documentHtml?:string}={type:"d1-page-response",token,id:message.id,...reply};
        if(message.navigate){
          if(message.path==="/configure"&&reply.status===202){setProvisioning({started:Date.now(),state:"waiting",message:"配置已提交，设备正在连接所选网络。"});return;}
          if(reply.status>=200&&reply.status<300&&reply.contentType.toLowerCase().includes("text/html")){setNavigation(previous=>({html:reply.body,version:(previous?.version??0)+1}));setNavigationError("");return;}
          setNavigationError("设备页面未能打开，请检查连接后重试。");
        }
        frame.current?.contentWindow?.postMessage(response,"*");
      }).catch(()=>frame.current?.contentWindow?.postMessage({type:"d1-page-response",token,id:message.id,status:502,contentType:"application/json",body:JSON.stringify({message:"无法读取设备页面"})},"*"));
    };
    const onGuide=(event:Event)=>{const value=(event as CustomEvent<unknown>).detail;guideSelector.current=typeof value==="string"&&Object.hasOwn(deviceGuideControls,value)?value:"";sendGuide();};
    window.addEventListener("message",onMessage);window.addEventListener("d1-guide-frame-target",onGuide);
    return()=>{window.removeEventListener("message",onMessage);window.removeEventListener("d1-guide-frame-target",onGuide);};
  },[page.address,token]);
  useEffect(()=>{
    if(!provisioning||provisioning.state!=="waiting")return;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    const started=provisioning.started;
    const clock=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);
    const poll=async()=>{
      try{
        const reply=await requestHandler.current({path:"/",method:"GET"});
        if(!active)return;
        // Exact device-side failure text from wifi_provisioning.run_provisioning.
        if(reply.status===200&&reply.body.includes("无法连接该 Wi-Fi，请检查名称和密码后重试。")){
          setProvisioning({started,state:"failed",message:"配网失败：设备已返回热点，请检查 Wi-Fi 名称和密码。"});return;
        }
      }catch{/* A disappearing hotspot is expected and cannot prove success. */}
      if(!active)return;
      if(Date.now()-started>=90000){setProvisioning({started,state:"unconfirmed",message:"尚未取得配网结果。请根据设备播报，输入联网后的 IP 确认状态。"});return;}
      timer=setTimeout(()=>void poll(),3000);
    };
    timer=setTimeout(()=>void poll(),3000);
    return()=>{active=false;clearTimeout(timer);clearInterval(clock);};
  },[provisioning?.started,provisioning?.state]);
  async function verifyAddress(){
    if(verifying)return;setVerifying(true);setNavigationError("");
    try{await onVerifyAddress(newAddress.trim());}
    catch{setNavigationError("尚未读取到该设备的联网状态，请核对设备播报 IP 与电脑网络。");}
    finally{setVerifying(false);}
  }
  return <main className={`manager-device-page${otaPanel ? " has-ota-panel" : ""}`} aria-label={t("设备原生页面")}>
    <header><button className="button button-secondary" disabled={busy} onClick={onBack}><ArrowLeft size={17}/>{t("返回设备管理")}</button><div><strong>{t("设备页面 ·") + " "}{page.address}</strong><span>{t("设备端页面 ·") + " "}{tr(new Date(page.observedAtMs).toLocaleTimeString(localeTag(),{hour12:false}))}</span></div><button className="button button-secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={17} className={busy?"spin":undefined}/>{t("刷新页面")}</button></header>
    {showConnectionMode&&<p className="manager-actual-connection manager-device-page-connection" role="status"><span>{t("实际连接方式")}</span><strong>{tr(connectionModeLabel)}</strong></p>}
    {tr((navigationError||page.statusError)&&<p className="manager-error" role="status">{tr(navigationError) || tr(page.statusError)}</p>)}
    {tr(!provisioning&&otaPanel&&<nav className="manager-device-page-tabs" aria-label={t("设备页面功能")}><button type="button" aria-pressed={activePanel==="device"} onClick={()=>setActivePanel("device")}>{t("设备页面")}</button><button type="button" aria-pressed={activePanel==="upgrade"} onClick={()=>setActivePanel("upgrade")}>{t("应用升级")}</button></nav>)}
    {provisioning ? <section className={`manager-provisioning is-${provisioning.state}`} aria-label={t("设备配网进度")} aria-live="polite"><div className="manager-provisioning-symbol">{provisioning.state==="waiting" ? <LoaderCircle className="spin" size={38}/> : <AlertCircle size={38}/>}</div><h1>{provisioning.state==="waiting" ? t("设备正在配网") : provisioning.state==="failed" ? t("配网失败") : t("等待确认配网结果")}</h1><p>{tr(provisioning.message)}</p>{provisioning.state==="waiting"&&<><div className="manager-progress-indeterminate" role="progressbar" aria-label={t("等待设备配网结果")}/><span>{t("已等待") + " "}{elapsed}{" " + t("秒")}</span></>}<ol><li><CheckCircle2 size={17}/>{t("配置已提交")}</li><li>{t("设备连接 Wi-Fi · 热点可能暂时关闭")}</li><li>{t("核对设备播报，读取联网状态")}</li></ol><form onSubmit={event=>{event.preventDefault();void verifyAddress();}}><label htmlFor="d1-configured-address">{t("设备联网后的 IP")}</label><input id="d1-configured-address" placeholder={t("输入设备语音播报的 IP")} inputMode="decimal" value={newAddress} onChange={event=>setNewAddress(event.target.value)} disabled={verifying}/><button className="button button-primary" disabled={verifying||!newAddress.trim()}>{verifying ? t("正在核对…") : t("读取联网状态")}</button></form><small>{t("设备当前固件不提供配网结果查询接口；热点断开和提交成功均不能单独证明配网成功。")}</small>{provisioning.state==="failed"&&<button className="button button-secondary" onClick={()=>{setProvisioning(null);onRefresh();}}>{t("重新填写配网信息")}</button>}</section> : <iframe hidden={!!otaPanel&&activePanel!=="device"} key={token} ref={frame} title={t("D1 设备页面")} sandbox="allow-scripts allow-forms allow-modals" srcDoc={html}/>}
    {tr(!provisioning&&otaPanel&&<div hidden={activePanel!=="upgrade"} className="manager-device-ota-panel" ref={otaContainer}>{tr(otaPanel)}</div>)}
  </main>;
}
