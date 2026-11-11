import {useEffect,useRef,useState} from "react";
import {AlertCircle,CheckCircle2,Download,LoaderCircle,RefreshCw,ShieldCheck,UploadCloud} from "lucide-react";
import {getOtaServiceStatus,previewOtaRelease,submitOtaToDevice,readDeviceOtaStatus} from "../lib/backend";
import {otaStateLabels,type DeviceOtaStatus,type OtaPreview,type OtaServiceStatus,type DevicePageRequest} from "../lib/d1";

type Operation={id:number;finish:()=>void};
interface Props {
  request:DevicePageRequest|null;
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
  const [working,setWorking]=useState<"preview"|"submit"|"status"|null>(null);
  const [notice,setNotice]=useState("");
  const operation=useRef<Operation|null>(null);

  useEffect(()=>{
    let active=true;
    getOtaServiceStatus().then(value=>{if(active)setService(value);}).catch(cause=>{if(active)setServiceError(String(cause instanceof Error?cause.message:cause));});
    return()=>{active=false;};
  },[]);

  useEffect(()=>{
    if(!request||!connected)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      try{
        const value=await readDeviceOtaStatus(request as DevicePageRequest);
        if(active){setDevice(value);setDeviceError("");}
      }catch(cause){if(active)setDeviceError(String(cause instanceof Error?cause.message:cause));}
      finally{if(active)timer=setTimeout(()=>void refresh(),3000);}
    }
    void refresh();
    return()=>{active=false;clearTimeout(timer);};
  },[request,connected]);

  async function run<T>(kind:"preview"|"submit",task:(owner:Operation)=>Promise<T>):Promise<T|undefined>{
    if(busy||working)return;
    const owner=beginOperation();if(!owner){onError("请先完成当前任务。");return;}
    operation.current=owner;setWorking(kind);
    try{return await task(owner);}
    catch(cause){onError(String(cause instanceof Error?cause.message:cause));return;}
    finally{operation.current=null;owner.finish();setWorking(null);}
  }

  async function checkRelease(){
    setPreview(null);setNotice("");
    if(!request){onError("请先在设备信息页连接设备。");return;}
    await run("preview",async owner=>{const value=await previewOtaRelease(owner.id);setPreview(value);});
  }

  async function submit(){
    if(!request){onError("请先在设备信息页连接设备。");return;}
    if(!preview)return;
    const version=preview.version?` ${preview.version}`:"";
    if(!window.confirm(`将把 Factory${version} 升级包发送到设备。设备会立即校验并决定是否安装，期间不能断电。是否继续？`))return;
    setNotice("");
    const result=await run("submit",async owner=>submitOtaToDevice(request,owner.id));
    if(result){setNotice(result.message);}
  }

  const enabled=service?.enabled??false;
  const trust=device?.state&&!enabled?null:service?.trust??"device_verified";
  const stateLabel=device?.state?(otaStateLabels[device.state]??device.state):null;

  return <section className="manager-ota" aria-label="DOHC 应用升级">
    <header className="manager-ota-heading">
      <ShieldCheck size={20}/>
      <div><h2>DOHC 应用升级</h2><p>{service?.detail??serviceError??"正在读取升级服务…"}</p></div>
      <span className={`manager-chip${enabled?" is-ready":""}`}>{enabled?"可用":"不可用"}</span>
    </header>
    {!connected&&<p className="manager-ota-note">连接设备后读取升级状态。在线升级需要设备热点或局域网 IP，Type-C 不提供升级通道。</p>}
    {connected&&<div className="manager-ota-status" role="status">
      <div><span>设备状态</span><strong>{stateLabel??(deviceError?"读取失败":"读取中…")}</strong></div>
      <div><span>当前版本</span><strong>{device?.releaseBefore??"未提供"}</strong></div>
      <div><span>升级操作</span><strong>{device?.operationId?device.operationId.slice(0,12):"无"}</strong></div>
    </div>}
    {deviceError&&connected&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>{deviceError}</p>}
    {device?.guidance&&<p className="manager-ota-note">{device.guidance}</p>}
    {enabled&&<>
      <div className="manager-actions">
        <button className="button button-secondary" disabled={busy||working!==null} onClick={()=>void checkRelease()}>
          {working==="preview"?<LoaderCircle size={17} className="spin"/>:<RefreshCw size={17}/>}检查最新版本
        </button>
        {preview&&<button className="button button-primary" disabled={busy||working!==null||!connected} onClick={()=>void submit()}>
          {working==="submit"?<LoaderCircle size={17} className="spin"/>:<UploadCloud size={17}/>}下载并升级
        </button>}
      </div>
      {preview&&<div className="manager-ota-release" aria-label="升级包内容">
        <header><strong>Factory {preview.version}</strong><span>{preview.releaseId}</span></header>
        <dl>
          <div><dt>通道</dt><dd>{preview.channel==="factory"?"出厂通道":preview.channel}</dd></div>
          <div><dt>安装包</dt><dd>{bytes(preview.artifactBytes)}</dd></div>
          <div><dt>合计</dt><dd>{bytes(preview.totalBytes)}</dd></div>
          <div><dt>来源校验</dt><dd>{preview.trust==="configured"?"已配置发布公钥":"由设备独立验签"}</dd></div>
        </dl>
        <ul>{preview.files.map(file=><li key={file.name}><Download size={13}/><span>{file.name}</span><small>{bytes(file.size)}</small></li>)}</ul>
        <p className="manager-ota-note">软件只核对大小与摘要；设备 updater 会再次验签、检查兼容性与防回退后才安装，失败自动回滚。上传成功不等于升级完成。</p>
      </div>}
    </>}
    {!enabled&&!serviceError&&<p className="manager-ota-note">升级服务尚未配置。{trust==="device_verified"?"":"未设置发布公钥时，只有设备验签作为唯一信任依据。"}</p>}
    {notice&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>{notice}</p>}
    {device?.finalState&&device.state==="SUCCESS"&&<p className="manager-ota-success" role="status"><CheckCircle2 size={17}/>设备报告升级成功。{device.releaseTarget?`目标版本 ${device.targetVersion??device.releaseTarget}。`:""}</p>}
    {device?.finalState&&(device.state==="FAILED"||device.state==="ROLLBACK_FAILED")&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>{device.detail}{device.guidance?` ${device.guidance}`:""}</p>}
    {device&&<p className="manager-observed">状态更新于 {time(null)}（每 3 秒读取设备 /ota/status）</p>}
  </section>;
}
