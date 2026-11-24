import {useEffect, useMemo, useRef, useState} from "react";
import {ChevronDown, GripVertical, Plus, X} from "lucide-react";
import {t, tr, useLanguage} from "../lib/i18n";
import {listOutboundReasonHistory, OUTBOUND_ANOMALOUS_REASONS, OUTBOUND_INVALID_REASONS, outboundError} from "../lib/outbound-review";
import "./rejection-reasons.css";

type Category = "invalid" | "anomalous";
interface Props {
  category: Category; owner: string; options: string[]; value: string;
  disabled: boolean; canSubmit: boolean; revising: boolean; submissionError: string;
  onChange: (reason: string) => void; onClose: () => void; onSubmit: (reasonSource?: "one-time") => void;
  onSave: (reason: string, remove: boolean) => Promise<void>;
  onVerify?: () => Promise<void>;
}

/** Each mounted dialog has one frozen category, including its remote mutations. */
export function OutboundReasonDialog({category,owner,options,value,disabled,canSubmit,revising,submissionError,onChange,onClose,onSubmit,onSave,onVerify}:Props) {
  useLanguage();
  const presets: readonly string[] = category === "anomalous" ? OUTBOUND_ANOMALOUS_REASONS : OUTBOUND_INVALID_REASONS;
  const available = useMemo(()=>[...new Set([...presets,...options])],[presets,options]);
  const custom = available.filter(reason=>!presets.includes(reason));
  const storageKey = `delta-viewer.outbound-reason-order.v1:${encodeURIComponent(owner)}:${category}`;
  const [savedOrder,setOrder] = useState<string[]>(()=>{try{const v=JSON.parse(localStorage.getItem(storageKey)??"[]");return Array.isArray(v)?v.filter(x=>typeof x==="string"):[];}catch{return [];}});
  const order = [...new Set([...savedOrder.filter(x=>available.includes(x)),...available])];
  const [commonOpen,setCommonOpen] = useState(false);
  const [historyOpen,setHistoryOpen] = useState(false);
  const [history,setHistory] = useState<string[] | null>(null);
  const [historyError,setHistoryError] = useState("");
  const [historyRequest,setHistoryRequest] = useState(0);
  const [source,setSource] = useState<"common"|"one-time">(() => value && available.includes(value) ? "common" : "one-time");
  const [oneTime,setOneTime] = useState(() => source === "one-time" ? value : "");
  const [sorting,setSorting] = useState(false), [adding,setAdding] = useState(false);
  const [draft,setDraft] = useState(""), [error,setError] = useState("");
  const dragged = useRef<string|null>(null), saving = useRef(false);
  useEffect(() => {
    let active = true;
    void listOutboundReasonHistory(category).then(({reasons}) => {
      if (!Array.isArray(reasons)) throw Error("OUTBOUND_RESPONSE_INVALID");
      if (active) { setHistory(reasons); setHistoryError(""); }
    }).catch(cause => { if (active) setHistoryError(outboundError(cause)); });
    return () => { active = false; };
  }, [category,historyRequest]);
  function selectCommon(reason:string) {
    setSource("common");
    onChange(reason);
  }
  function selectOneTime(reason:string) {
    setSource("one-time");
    setOneTime(reason);
    onChange(reason.trim());
  }
  function saveOrder(next:string[]) {
    if(disabled)return;
    try{localStorage.setItem(storageKey,JSON.stringify(next));setOrder(next);setError("");}
    catch{setError("常用原因或排序未保存，本机存储不可用，请稍后重试。");}
  }
  function move(from:string,to:string) {
    const next=[...order],a=next.indexOf(from),b=next.indexOf(to);
    if(a>=0&&b>=0){next.splice(b,0,...next.splice(a,1));saveOrder(next);}
  }
  async function change(reason:string,remove=false) {
    if(disabled||saving.current)return;
    const text=reason.trim();
    if(!text||text.length>80||/[\u0000-\u001f\u007f]/.test(text)){setError("请输入 1–80 字的单行原因。");return;}
    if(!remove&&available.some(x=>x.toLocaleLowerCase()===text.toLocaleLowerCase())){setError("这个原因已经存在，请直接使用已有按钮。");return;}
    saving.current=true;setError("");
    try{
      await onSave(text,remove);
      if(remove){if(source==="common"&&value===text)onChange("");}
      else{selectCommon(text);setDraft("");setAdding(false);}
    }catch(cause){setError(outboundError(cause));}
    finally{saving.current=false;}
  }
  const title = category === "anomalous" ? t("选择异常原因") : t("选择无效原因");
  const validReason = value.length>0&&value.length<=80&&!/[\u0000-\u001f\u007f]/.test(value);
  return <dialog className={`rejection-dialog outbound-reason-dialog outbound-${category}-reasons`} aria-labelledby={`outbound-${category}-reason-title`}
    ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={event=>{event.preventDefault();if(!disabled)onClose();}}>
    <header><h2 id={`outbound-${category}-reason-title`}>{title}</h2><button type="button" className="icon-button" disabled={disabled} aria-label={category==="anomalous"?t("关闭异常原因"):t("关闭无效原因")} onClick={onClose}><X size={18}/></button></header>
    <div className="outbound-reason-content">
    <section className="outbound-reason-section">
    <button type="button" className="outbound-reason-toggle" aria-expanded={commonOpen}
      aria-label={t("常用原因")} onClick={()=>setCommonOpen(open=>!open)}>
      <strong>{t("常用原因")}</strong><span>{order.length}</span><ChevronDown size={16}/></button>
    {source==="common"&&value&&<p className="outbound-reason-selection">{t("已选常用原因 · {0}",[presets.includes(value)?t(value):value])}</p>}
    {commonOpen&&<>
    <div className="rejection-sort-tools">
      <button type="button" className="button button-secondary" disabled={disabled} onClick={()=>{setAdding(!adding);setError("");}}><Plus size={14}/>{t("添加常用原因")}</button>
      <button type="button" className="button button-secondary" disabled={disabled} onClick={()=>setSorting(!sorting)}>{sorting?t("完成排序"):t("调整顺序")}</button>
      {sorting&&<button type="button" className="button button-secondary" disabled={disabled} onClick={()=>saveOrder(available)}>{t("恢复默认")}</button>}
    </div>
    {adding&&<form className="rejection-custom-editor" onSubmit={event=>{event.preventDefault();void change(draft);}}><label>{category==="anomalous"?t("新增常用异常原因"):t("新增常用无效原因")}<input autoFocus maxLength={80} value={draft} disabled={disabled} onChange={event=>setDraft(event.target.value)} placeholder={t("输入原因并保存")}/></label><p className="rejection-custom-hint">{t("每类最多 30 个、每项 80 字；异常与无效分别保存，排序按账号在本机记忆。")}</p><div className="rejection-custom-actions"><button type="submit" className="button button-primary" disabled={disabled||!draft.trim()}>{t("保存常用项")}</button><button type="button" className="button button-secondary" disabled={disabled} onClick={()=>setAdding(false)}>{t("取消添加")}</button></div></form>}
    {sorting&&custom.length>0&&<ul className="rejection-custom-list" aria-label={t("管理自定义原因")}>{custom.map(reason=><li key={reason}><span>{reason}</span><button type="button" className="button button-secondary" disabled={disabled} aria-label={t("移除常用原因 {0}",[reason])} onClick={()=>void change(reason,true)}>{t("移除")}</button></li>)}</ul>}
    {error&&<p role="alert">{tr(error)}</p>}
    <div className="rejection-options" role="group" aria-label={category==="anomalous"?t("异常原因选项"):t("无效原因选项")}>
      {order.map((reason,index)=><button key={reason} type="button" className="button button-secondary" disabled={disabled} aria-pressed={source==="common"&&value===reason} draggable={sorting&&!disabled}
        title={sorting?t("拖动排序，也可使用 Alt + 方向键移动"):undefined}
        onDragStart={event=>{dragged.current=reason;event.dataTransfer.setData("text/plain",reason);}}
        onDragOver={event=>{if(sorting&&dragged.current)event.preventDefault();}}
        onDrop={event=>{event.preventDefault();if(sorting&&dragged.current)move(dragged.current,reason);dragged.current=null;}}
        onDragEnd={()=>{dragged.current=null;}}
        onKeyDown={event=>{if(!sorting||!event.altKey)return;const delta=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-2,ArrowDown:2} as Record<string,number>)[event.key];if(delta){event.preventDefault();if(order[index+delta])move(reason,order[index+delta]);}}}
        onClick={()=>{if(!sorting)selectCommon(reason);}}>{sorting&&<GripVertical size={14}/>} {presets.includes(reason)?t(reason):reason}</button>)}
    </div></>}
    </section>
    <section className="outbound-reason-section outbound-one-time">
      <label htmlFor={`outbound-${category}-one-time`}>{t("一次性原因")}</label>
      <input id={`outbound-${category}-one-time`} maxLength={80} value={oneTime} disabled={disabled}
        placeholder={t("输入原因后直接提交，无需加入常用")}
        onChange={event=>selectOneTime(event.target.value)}
        onFocus={()=>{if(oneTime&&source==="common")selectOneTime(oneTime);}}/>
      <div className="outbound-history-heading">
        <strong>{t("历史输入")}</strong>
        {history&&history.length>3&&<button type="button" className="text-button" aria-expanded={historyOpen}
          onClick={()=>setHistoryOpen(open=>!open)}>{historyOpen?t("收起历史"):t("展开历史（{0} 条）",[history.length])}</button>}
      </div>
      {historyError ? <p className="outbound-reason-history-status">{t("暂时无法读取历史输入")} <button type="button" className="text-button" onClick={()=>{setHistoryError("");setHistoryRequest(count=>count+1);}}>{t("重试")}</button></p>
        : history===null ? <p className="outbound-reason-history-status" role="status">{t("正在读取历史输入…")}</p>
        : !history.length ? <p className="outbound-reason-history-status">{t("暂无历史输入")}</p>
        : <div className="outbound-history-options" role="group" aria-label={t("历史输入")}>
          {history.slice(0,historyOpen?history.length:3).map(reason=><button type="button" key={reason}
            className="button button-secondary" disabled={disabled} title={reason}
            aria-pressed={source==="one-time"&&value===reason} onClick={()=>selectOneTime(reason)}>{reason}</button>)}
        </div>}
    </section>
    {submissionError&&<p role="alert" className="outbound-reason-submit-error">{tr(submissionError)}</p>}
    {onVerify&&<button type="button" className="button button-secondary" disabled={disabled} onClick={()=>void onVerify()}>{t("核对审核结果")}</button>}
    </div>
    <footer><button type="button" className="button button-secondary" disabled={disabled} onClick={onClose}>{t("取消")}</button><button type="button" className="button button-primary" disabled={disabled||!validReason||!canSubmit} onClick={()=>onSubmit(source==="one-time"?source:undefined)}>{revising?t("保存修改"):category==="anomalous"?t("确认异常"):t("确认无效")}</button></footer>
  </dialog>;
}
