import {useState} from "react";
import {Download,LoaderCircle,RotateCcw} from "lucide-react";
import {listHistoricalInstallers,revealOutput,type HistoricalInstaller} from "../lib/backend";

export function ReleaseDownload({version,current,busy,onDownload}:{version:string;current:boolean;busy:boolean;onDownload:(version:string,platform:string)=>Promise<string|null>}) {
  const [open,setOpen]=useState(false),[loading,setLoading]=useState(false);
  const [entries,setEntries]=useState<HistoricalInstaller[]>([]),[error,setError]=useState("");
  const [downloading,setDownloading]=useState(false),[output,setOutput]=useState("");
  async function inspect(){
    setOpen(true);setLoading(true);setError("");
    try{setEntries(await listHistoricalInstallers(version));}catch(cause){setError(String(cause).replace(/^Error:\s*/,""));}
    finally{setLoading(false);}
  }
  async function download(entry:HistoricalInstaller){
    setDownloading(true);setError("");setOutput("");
    try{setOutput(await onDownload(version,entry.key)??"");}catch(cause){setError(String(cause).replace(/^Error:\s*/,""));}
    finally{setDownloading(false);}
  }
  return <div className="release-download">
    <button className="button button-secondary" type="button" disabled={busy||loading} onClick={()=>open?setOpen(false):void inspect()} aria-expanded={open}>
      {loading?<LoaderCircle size={14} className="spin"/>:current?<Download size={14}/>:<RotateCcw size={14}/>}{current?"下载安装包":"下载 / 回退"}
    </button>
    {open&&<div className="release-download-panel">
      <p>公司内网下载 · 无需访问 GitHub</p>
      {loading?<p role="status">正在查找 v{version} 安装包…</p>:entries.map(entry=><button key={entry.key} className="button button-secondary" type="button" disabled={busy||downloading} onClick={()=>void download(entry)}><Download size={14}/>{entry.label}<small>{Math.ceil(entry.size/1024/1024)} MB</small></button>)}
      {!current&&<p>回退方式：保存当前工作并退出软件，再运行旧版安装包。旧版可能不支持新功能或新格式；回退不会转换已有数据。</p>}
      <p className="muted">安装包没有可信发布者签名（UNSIGNED），下载后核对大小与 SHA-256；不会自动安装。</p>
      {error&&<p role="alert">{error}<button className="button button-secondary" type="button" disabled={busy||downloading} onClick={()=>void inspect()}>重试</button></p>}
      {downloading&&<p role="status"><LoaderCircle size={14} className="spin"/>正在下载并校验…</p>}
      {output&&<div role="status"><p>已保存并校验：{output}</p><button className="button button-secondary" onClick={()=>void revealOutput(output).catch(cause=>setError(String(cause)))}>打开所在位置</button></div>}
    </div>}
  </div>;
}
