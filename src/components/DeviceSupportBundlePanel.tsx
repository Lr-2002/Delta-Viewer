import {localeTag,t,tr,useLanguage} from "../lib/i18n";
import {useEffect,useRef,useState} from "react";
import {AlertCircle,CheckCircle2,Download,FileArchive,LoaderCircle,RefreshCw} from "lucide-react";
import {cancelTask,chooseDirectory,collectDeviceSupportBundle,confirmSupportBundleCollection,exportDeviceSupportBundle,isTauriRuntime,readDeviceOtaStatus,readSupportBundleInventory,revealOutput} from "../lib/backend";
import type {DeviceSupportBundleInventory,DeviceSupportBundleReceipt,DeviceUpgradeRequest} from "../lib/d1";

type Operation={id:number;finish:()=>void};
interface Props {request:DeviceUpgradeRequest|null;busy:boolean;beginOperation:()=>Operation|null;onError:(message:string)=>void}
const errorText=(cause:unknown)=>tr(String(cause instanceof Error?cause.message:cause));

export function DeviceSupportBundlePanel({request,busy,beginOperation,onError}:Props){
  useLanguage();
  const [working,setWorking]=useState<"confirm"|"collect"|"export"|null>(null);
  const [inventory,setInventory]=useState<DeviceSupportBundleInventory|null>(null);
  const [receipt,setReceipt]=useState<DeviceSupportBundleReceipt|null>(null);
  const [error,setError]=useState("");
  const [cancelling,setCancelling]=useState(false);
  const operation=useRef<Operation|null>(null);
  const generation=useRef(0);
  const requestKey=JSON.stringify(request);
  useEffect(()=>{generation.current++;setReceipt(null);setError("");return()=>{generation.current++;};},[requestKey]);
  useEffect(()=>{let active=true;readSupportBundleInventory().then(value=>{if(active)setInventory(value);}).catch(cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[]);

  async function collect(){
    if(!request||busy||working||!inventory)return;
    const current=generation.current;
    setError("");setReceipt(null);setWorking("confirm");
    let owner:Operation|null=null;
    try{
      owner=beginOperation();
      if(!owner){onError(t("请先完成当前任务。"));return;}
      operation.current=owner;
      const identity=await readDeviceOtaStatus(request);
      if(current!==generation.current)return;
      if(!identity.deviceId)throw new Error(t("设备未返回有效身份，无法确认采集目标。"));
      if(!await confirmSupportBundleCollection(identity.deviceId,inventory.directory)||current!==generation.current)return;
      setWorking("collect");
      const result=await collectDeviceSupportBundle(request,identity.deviceId,owner.id);
      if(current===generation.current){setReceipt(result);setInventory(previous=>previous?{...previous,records:[result,...previous.records.filter(row=>row.bundleId!==result.bundleId)]}:previous);}
    }catch(cause){if(current===generation.current)setError(errorText(cause));}
    finally{operation.current=null;owner?.finish();setWorking(null);setCancelling(false);}
  }

  async function refresh(){
    try{setInventory(await readSupportBundleInventory());setError("");}catch(cause){setError(errorText(cause));}
  }
  async function saveAs(record:DeviceSupportBundleReceipt){
    if(busy||working)return;
    setError("");setWorking("export");let owner:Operation|null=null;
    const current=generation.current;
    try{
      const destination=await chooseDirectory(t("另存 D1 日志支持包"));
      if(!destination||current!==generation.current)return;
      owner=beginOperation();if(!owner){onError(t("请先完成当前任务。"));return;}
      const path=await exportDeviceSupportBundle(record.bundleId,destination,owner.id);
      if(current===generation.current)await revealOutput(path);
    }catch(cause){if(current===generation.current)setError(errorText(cause));}
    finally{owner?.finish();setWorking(null);}
  }
  async function cancel(){
    if(!operation.current||cancelling)return;
    setCancelling(true);
    try{await cancelTask(operation.current.id);}catch(cause){setError(errorText(cause));setCancelling(false);}
  }

  return <section className="manager-card manager-support-bundle" aria-label={t("采集 D1 设备日志")}>
    <header className="manager-device-heading"><h2>{t("D1 设备日志")}</h2><FileArchive size={21}/></header>
    <p>{t("从当前 D1 采集最近 30 分钟的 DOHC 服务日志，经设备脱敏后保存到此电脑。每个服务最多 500 行，支持包最大 4 MiB。")}</p>
    <div className="manager-actions">
      <button className="button button-primary" disabled={busy||working!==null||!request||!inventory||!isTauriRuntime()} onClick={()=>void collect()}>{working?<LoaderCircle size={17} className="spin"/>:<Download size={17}/>}{t("采集并保存到本机")}</button>
      {working==="collect"&&<button className="button button-secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?t("正在取消"):t("取消采集")}</button>}
    </div>
    {!request&&<p className="manager-upload-state">{t("请先在首页选择并连接 D1。")}</p>}
    {!isTauriRuntime()&&<p className="manager-upload-state">{t("请使用桌面客户端采集设备日志。")}</p>}
    {inventory&&<p className="manager-upload-state manager-support-path">{t("保存位置：{0}",[inventory.directory])}</p>}
    {working==="confirm"&&<p className="manager-upload-state" role="status">{t("正在确认设备身份和保存位置…")}</p>}
    {working==="collect"&&<p className="manager-upload-state" role="status">{t("正在生成、下载和校验支持包，请保持设备连接。")}</p>}
    {error&&<p className="manager-ota-error" role="alert"><AlertCircle size={15}/>{error}</p>}
    {receipt&&<div className="manager-package-preview" aria-label={t("设备日志采集结果")}>
      <p className="manager-export-success" role="status"><CheckCircle2 size={18}/>{t("支持包已保存并通过 SHA-256 校验。")}</p>
      <dl className="manager-metadata"><div><dt>{t("设备")}</dt><dd>{receipt.deviceId}</dd></div><div><dt>{t("大小")}</dt><dd>{t("{0} 字节",[receipt.bytes.toLocaleString()])}</dd></div><div><dt>{t("文件")}</dt><dd className="manager-support-path">{receipt.path}</dd></div></dl>
      <code className="manager-support-digest">SHA-256 {receipt.sha256}</code>
      <div className="manager-actions"><button className="button button-secondary" onClick={()=>void revealOutput(receipt.path).catch(cause=>setError(errorText(cause)))}>{t("打开所在位置")}</button><button className="button button-secondary" disabled={busy||working!==null} onClick={()=>void saveAs(receipt)}>{t("另存为")}</button></div>
      {receipt.cleanupWarning&&<p className="manager-ota-error" role="status"><AlertCircle size={15}/>{tr(receipt.cleanupWarning)}</p>}
    </div>}
    <details className="manager-support-history"><summary>{t("本机采集记录（{0}）",[inventory?.records.length??0])}</summary>
      <button className="button button-secondary" disabled={busy||working!==null} onClick={()=>void refresh()}><RefreshCw size={15}/>{t("刷新记录")}</button>
      {inventory?.records.slice(0,20).map(record=><article key={record.bundleId}><strong>{new Date(record.collectedAtMs).toLocaleString(localeTag(),{hour12:false})}</strong><span>{record.deviceId} · {t("{0} 字节",[record.bytes.toLocaleString()])}</span><div className="manager-actions"><button className="text-button" onClick={()=>void revealOutput(record.path).catch(cause=>setError(errorText(cause)))}>{t("打开位置")}</button><button className="text-button" disabled={busy||working!==null} onClick={()=>void saveAs(record)}>{t("另存为")}</button></div></article>)}
    </details>
    <p className="manager-privacy">{t("仅在你点击并确认后采集，不定时传输、不上传维护平台。按当前账号保存，默认保留 30 天、总量上限 1 GiB；另存的副本由你自行管理。下载或校验失败时保留设备临时包，设备重启或后续采集时清理过期包。")}</p>
  </section>;
}
