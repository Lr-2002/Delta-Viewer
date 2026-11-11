import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../lib/backend';
import { AlertTriangle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { clientInstallationId } from '../lib/client-versions';
import { announceWriteback } from '../lib/writeback-coordination';
import { writebackCall, writebackErrors, writebackProgress, type WritebackOwner, type WritebackPoll, type WritebackReport } from '../lib/source-writeback';

// Account-keyed by the parent. Every native operation revalidates the original owner.
export function SourceWritebackClient({owner,disabled,onBusy,onWritten,call=writebackCall}: {
  owner:WritebackOwner;disabled:boolean;onBusy:(value:boolean)=>void;onWritten:()=>void;
  call?:typeof writebackCall;
}) {
  const [clientId]=useState(()=>{try{return clientInstallationId(localStorage,APP_VERSION);}catch{return crypto.randomUUID();}});
  const [message,setMessage]=useState('');
  const [failure,setFailure]=useState(false);
  const dismissNotice=useRef(()=>{});
  const latest=useRef({disabled,onBusy,onWritten});latest.current={disabled,onBusy,onWritten};
  useEffect(()=>{
    let alive=true,flight=false,timer:number|undefined;
    const writtenByRequest=new Map<string,number>();
    const protect=(event:BeforeUnloadEvent)=>event.preventDefault();
    let lastReport:WritebackReport|null=null,receiptPending=false;
    let transportFailed=false;
    let managedActive=false;
    let activeRequestId:string|null=null;
    const noticeKey=`delta.writeback-notices.v1:${JSON.stringify([owner.serviceId,owner.username,clientId])}`;
    const quietRequests=new Set<string>();
    try { const saved:unknown=JSON.parse(localStorage.getItem(noticeKey)??'[]');if(Array.isArray(saved))for(const id of saved.slice(-100))if(typeof id==='string')quietRequests.add(id); } catch { /* Notification history must not block publication. */ }
    function quiet(id:string){
      quietRequests.delete(id);quietRequests.add(id);
      while(quietRequests.size>100)quietRequests.delete(quietRequests.values().next().value!);
      try { localStorage.setItem(noticeKey,JSON.stringify([...quietRequests])); } catch { /* Keep suppression for this session. */ }
    }
    function notify(text:string,failed:boolean){
      if(!activeRequestId||quietRequests.has(activeRequestId))return;
      setMessage(text);setFailure(failed);
    }
    dismissNotice.current=()=>{if(activeRequestId)quiet(activeRequestId);setMessage('');};
    function coordinate(active:boolean){if(managedActive!==active){managedActive=active;announceWriteback(owner,active);}}
    const describe=(report:WritebackReport)=>report.state==='complete'?`管理员统一写回完成：${report.written} 条结果已写入 NAS。`:`${report.state==='partial'?'统一写回结束':'管理员统一写回中'}：${writebackProgress(report)}${report.errors.map(c=>writebackErrors[c]??writebackErrors.unknown).join('；')}`;
    function confirmReceipt(poll:WritebackPoll){
      const ack=poll.receipt;
      if(!lastReport || !ack || ack.requestId!==lastReport.requestId || ack.seq<lastReport.seq)return false;
      const changed=receiptPending||transportFailed;
      lastReport=ack;receiptPending=false;transportFailed=false;
      if(changed)notify(describe(ack),ack.state==='partial'||ack.errors.length>0);
      if(ack.state!=='running'){quiet(ack.requestId);messageStarted=false;}
      return true;
    }
    async function tick(){
      if(!alive || flight)return;flight=true;
      const blocked=()=>latest.current.disabled || Boolean(document.querySelector('dialog[open]')) || Date.now()-lastInteraction<2000;
      let holding=false;
      try {
        const poll=await call<WritebackPoll>(owner,{kind:'poll',clientId,busy:blocked()});
        if(!alive)return;
        // An automatic local recovery prompt must not require a second person
        // to confirm an already-authorized manager request. Manual dialogs stay.
        coordinate(Boolean(poll.request));
        const confirmed=confirmReceipt(poll);
        if(receiptPending && lastReport && !confirmed){
          notify(`${describe(lastReport)} 执行回执等待用户中心确认。`,lastReport.state==='partial'||lastReport.errors.length>0);
        }
        if(transportFailed && !receiptPending && !confirmed){
          transportFailed=false;
          notify(lastReport?describe(lastReport):'',Boolean(lastReport&&(lastReport.state==='partial'||lastReport.errors.length>0)));
        }
        if(!poll.request)return;
        if(activeRequestId!==poll.request.id){
          activeRequestId=poll.request.id;lastReport=null;receiptPending=false;transportFailed=false;
          setMessage('');setFailure(false);
        }
        messageStarted=true;
        if(blocked()){notify(`${lastReport?describe(lastReport)+' ':''}管理员已安排统一写回，等待当前操作结束后执行。`,Boolean(lastReport?.errors.length));return;}
        holding=true;latest.current.onBusy(true);window.addEventListener("beforeunload",protect);
        if(!alive)return;
        const report=await call<WritebackReport>(owner,{kind:'step',clientId,requestId:poll.request.id});
        if(!alive)return;
        if(report.written>(writtenByRequest.get(report.requestId)??0))latest.current.onWritten();
        writtenByRequest.set(report.requestId,report.written);
        window.dispatchEvent(new Event('source-review-pending'));
        lastReport=report;receiptPending=true;
        notify(`${describe(report)} 执行回执等待用户中心确认。`,report.state==='partial'||report.errors.length>0);
        // Send the durable receipt now, including when this was the last item.
        confirmReceipt(await call<WritebackPoll>(owner,{kind:'poll',clientId,busy:true}));
        if(report.state==='running')nextDelay=250;
      } catch(error){
        // An unrelated normal heartbeat must not erase a persistent writeback failure.
        if(alive && messageStarted){transportFailed=true;notify(`${receiptPending?'本机写回已有结果，执行回执待用户中心确认':lastReport?.state==='complete'?'本次写回已确认完成；当前用户中心连接异常':lastReport?.errors.length?describe(lastReport)+' 当前用户中心连接异常':'写回指令连接异常，本机待写结果保留'}：${String(error)}`,true);}
      } finally {
        if(holding){window.removeEventListener("beforeunload",protect);latest.current.onBusy(false);}
        flight=false;
        if(alive){timer=window.setTimeout(()=>void tick(),nextDelay);nextDelay=15_000;}
      }
    }
    let lastInteraction=Date.now(),nextDelay=15_000,messageStarted=false;
    const interact=()=>{lastInteraction=Date.now();};
    // Polling itself never counts as reviewer activity.
    const wake=()=>{if(alive&&!flight){clearTimeout(timer);void tick();}};
    window.addEventListener('pointerdown',interact);window.addEventListener('keydown',interact);
    window.addEventListener('online',wake);
    void tick();
    return()=>{alive=false;dismissNotice.current=()=>{};coordinate(false);clearTimeout(timer);window.removeEventListener('pointerdown',interact);window.removeEventListener('keydown',interact);window.removeEventListener('online',wake);};
  },[owner.username,owner.serviceId,clientId,call]);
  const waiting=message.includes('等待当前操作结束');
  const complete=message.includes('统一写回完成');
  const title=failure?'NAS 写回异常':waiting?'等待安全时机':complete?'NAS 写回完成':'正在写回 NAS';
  const Icon=failure?AlertTriangle:complete?CheckCircle2:LoaderCircle;
  return message?<aside className={`update-notice writeback-toast ${failure?'writeback-toast-error':''}`} role={failure?'alert':'status'} aria-live={failure?'assertive':'polite'} aria-atomic="true">
    <header><span className="update-notice-icon writeback-toast-icon" aria-hidden="true"><Icon size={17} className={complete||failure?'':'writeback-toast-spinning'}/></span><strong>{title}</strong>
      <button type="button" className="icon-button" aria-label="收起写回通知" title="收起写回通知" onClick={()=>dismissNotice.current()}><X size={16}/></button>
    </header>
    <p>{message}</p>
  </aside>:null;
}
