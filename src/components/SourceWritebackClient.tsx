import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../lib/backend';
import { clientInstallationId } from '../lib/client-versions';
import { writebackCall, writebackErrors, type WritebackOwner, type WritebackPoll, type WritebackReport } from '../lib/source-writeback';

// Account-keyed by the parent. Every native operation revalidates the original owner.
export function SourceWritebackClient({owner,disabled,onBusy,onWritten,call=writebackCall}: {
  owner:WritebackOwner;disabled:boolean;onBusy:(value:boolean)=>void;onWritten:()=>void;
  call?:typeof writebackCall;
}) {
  const [clientId]=useState(()=>{try{return clientInstallationId(localStorage,APP_VERSION);}catch{return crypto.randomUUID();}});
  const [message,setMessage]=useState('');
  const [failure,setFailure]=useState(false);
  const latest=useRef({disabled,onBusy,onWritten});latest.current={disabled,onBusy,onWritten};
  useEffect(()=>{
    let alive=true,flight=false,timer:number|undefined;
    const writtenByRequest=new Map<string,number>();
    const protect=(event:BeforeUnloadEvent)=>event.preventDefault();
    let lastReport:WritebackReport|null=null,receiptPending=false;
    const describe=(report:WritebackReport)=>report.state==='complete'?`管理员统一写回完成：${report.written} 条结果已写入 NAS。`:report.state==='partial'?`统一写回：${report.written} 条已写入，${report.remaining} 条保留本机。${report.errors.map(c=>writebackErrors[c]??writebackErrors.unknown).join('；')}`:`管理员统一写回中：${report.written} / ${report.total} 条。`;
    async function tick(){
      if(!alive || flight)return;flight=true;
      const blocked=()=>latest.current.disabled || Boolean(document.querySelector('dialog[open]')) || Date.now()-lastInteraction<2000;
      let holding=false;
      try {
        const poll=await call<WritebackPoll>(owner,{kind:'poll',clientId,busy:blocked()});
        if(!alive)return;
        if(receiptPending && lastReport && !poll.request){
          receiptPending=false;setMessage(describe(lastReport));setFailure(lastReport.state==='partial');
        }
        if(!poll.request)return;
        messageStarted=true;
        if(blocked()){setMessage('管理员已安排统一写回，等待当前操作结束后执行。');setFailure(false);return;}
        holding=true;latest.current.onBusy(true);window.addEventListener("beforeunload",protect);
        if(!alive)return;
        const report=await call<WritebackReport>(owner,{kind:'step',clientId,requestId:poll.request.id});
        if(!alive)return;
        if(report.written>(writtenByRequest.get(report.requestId)??0))latest.current.onWritten();
        writtenByRequest.set(report.requestId,report.written);
        window.dispatchEvent(new Event('source-review-pending'));
        lastReport=report;receiptPending=true;
        setFailure(report.state==='partial');
        setMessage(describe(report));
        // Send the durable receipt now, including when this was the last item.
        await call<WritebackPoll>(owner,{kind:'poll',clientId,busy:true});receiptPending=false;
        if(report.state==='running')nextDelay=250;
      } catch(error){
        // An unrelated normal heartbeat must not erase a persistent writeback failure.
        if(alive && messageStarted){setFailure(true);setMessage(`${lastReport?.state==='complete'?'结果已写入 NAS，执行回执待确认':lastReport?describe(lastReport)+' 执行回执待确认':'统一写回暂未确认，本机待写结果保留'}：${String(error)}`);}
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
    return()=>{alive=false;clearTimeout(timer);window.removeEventListener('pointerdown',interact);window.removeEventListener('keydown',interact);window.removeEventListener('online',wake);};
  },[owner.username,owner.serviceId,clientId,call]);
  return message?<div className={`source-review-notice writeback-client ${failure?'writeback-client-error':''}`} role={failure?'alert':'status'}><span>{message}</span><button className="button button-secondary" onClick={()=>setMessage('')}>收起提示</button></div>:null;
}
