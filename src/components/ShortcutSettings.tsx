import {useEffect,useRef,useState} from "react";
import {RotateCcw,X} from "lucide-react";
import {t,useLanguage} from "../lib/i18n";
import {DEFAULT_SHORTCUTS,SHORTCUTS,formatShortcut,shortcutChord,shortcutConflicts,validShortcut,type ShortcutBindings} from "../lib/shortcuts";
import "./shortcuts.css";

export function ShortcutSettings({bindings,onSave,onClose}:{bindings:ShortcutBindings;onSave:(next:ShortcutBindings)=>void;onClose:()=>void}){
  useLanguage();
  const ref=useRef<HTMLDialogElement>(null);
  const [draft,setDraft]=useState(()=>({...bindings})),[recording,setRecording]=useState<string|null>(null),[error,setError]=useState(""),[query,setQuery]=useState("");
  const [section,setSection]=useState<"local"|"outbound">("local");
  const shortcuts=SHORTCUTS.filter(item=>item.scopes.includes("outbound")===(section==="outbound"));
  const conflicts=shortcutConflicts(draft),invalid=new Set(conflicts.flat());
  const label=(id:string)=>id.startsWith("label")?t("常用标签 {0}",[Number(id.slice(5))]):t(SHORTCUTS.find(s=>s.id===id)!.label);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();previous?.focus();};},[]);
  useEffect(()=>{
    if(!recording)return;
    const capture=(event:KeyboardEvent)=>{
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==="Escape"){setRecording(null);setError("");return;}
      if(event.repeat||event.isComposing||event.keyCode===229)return;
      const chord=shortcutChord(event);if(!chord)return;
      if(!validShortcut(chord)){setError(t("此组合键由系统或窗口使用，请选择其他按键。"));return;}
      setDraft(value=>({...value,[recording]:chord}));setError("");setRecording(null);
    };
    window.addEventListener("keydown",capture,true);return()=>window.removeEventListener("keydown",capture,true);
  },[recording]);
  function save(){try{onSave(draft);onClose();}catch{setError(t("无法保存快捷键，请重试。"));}}
  return <dialog ref={ref} className="shortcut-settings" aria-label={t("快捷键设置")} onCancel={event=>{event.preventDefault();if(recording)setRecording(null);else onClose();}}>
    <header><div><h2>{t("快捷键设置")}</h2><p>{t("设置仅用于当前账号在此电脑上的数据工作区。")}</p></div><button type="button" className="icon-button" aria-label={t("关闭快捷键设置")} onClick={onClose}><X size={18}/></button></header>
    <p className="shortcut-help">{t("点击按键后录入新的组合键；Esc 取消录入。输入文字或弹窗打开时不触发工作区快捷键。")}</p>
    <div className="shortcut-sections" role="group" aria-label={t("快捷键分区")}>
      {(["local","outbound"] as const).map(item=><button key={item} type="button" className="button button-secondary"
        aria-pressed={section===item} onClick={()=>{setSection(item);setRecording(null);setError("");}}>
        {t(item==="local"?"本地工作区":"外发审核")}
      </button>)}
    </div>
    <label className="shortcut-search">{t("搜索快捷键")}<input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t("搜索功能名称")}/></label>
    <div className="shortcut-list" key={section}>{[...new Set(shortcuts.map(s=>s.group))].map(group=>{
      const rows=shortcuts.filter(s=>s.group===group&&(!query||label(s.id).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
      if(!rows.length)return null;
      const content=rows.map(item=><div className={`shortcut-row${invalid.has(item.id)?" has-conflict":""}`} key={item.id}>
        <span>{label(item.id)}<small>{t("默认：{0}",[item.defaultKey?formatShortcut(item.defaultKey):t("未设置")])}</small></span>
        <button type="button" className="shortcut-binding" aria-label={t("设置{0}快捷键",[label(item.id)])} aria-pressed={recording===item.id} onClick={()=>{setError("");setRecording(item.id);}}>{recording===item.id?t("请按下组合键…"):draft[item.id]?formatShortcut(draft[item.id]):t("未设置")}</button>
        <button type="button" className="button button-secondary" aria-label={t("清除{0}快捷键",[label(item.id)])} onClick={()=>{setRecording(null);setDraft(value=>({...value,[item.id]:""}));}}>{t("清除")}</button>
        <button type="button" className="icon-button" aria-label={t("恢复{0}默认快捷键",[label(item.id)])} title={t("恢复默认")} onClick={()=>{setRecording(null);setDraft(value=>({...value,[item.id]:item.defaultKey}));}}><RotateCcw size={14}/></button>
      </div>);
      return group==="常用标签序号"?<details key={group} open={query?true:undefined}><summary>{t(group)}<span>{t("数字按常用库顺序选择，多位序号连续输入。")}</span></summary>{content}</details>:<section key={group}><h3>{t(group)}</h3>{content}</section>;
    })}</div>
    {conflicts.length>0&&<p className="shortcut-error" role="alert">{t("以下功能使用了冲突的快捷键：")}{conflicts.slice(0,4).map(([a,b])=>`${t(SHORTCUTS.find(item=>item.id===a)?.scopes.includes("outbound")?"外发审核":"本地工作区")} · ${label(a)} / ${label(b)}`).join("；")}</p>}
    {error&&<p className="shortcut-error" role="alert">{error}</p>}
    <footer><button type="button" className="button button-secondary" onClick={()=>{setDraft({...DEFAULT_SHORTCUTS});setRecording(null);setError("");}}><RotateCcw size={14}/>{t("全部恢复默认")}</button><span/><button type="button" className="button button-secondary" onClick={onClose}>{t("取消")}</button><button type="button" className="button button-primary" disabled={conflicts.length>0||Boolean(recording)} onClick={save}>{t("保存快捷键")}</button></footer>
  </dialog>;
}
