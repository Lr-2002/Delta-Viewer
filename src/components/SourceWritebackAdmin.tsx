import { useEffect, useRef, useState } from 'react';
import { Database, RefreshCw, X } from 'lucide-react';
import { writebackCall, writebackErrors, writebackState, writebackCounts, writebackProgress, type WritebackOverview, type WritebackOwner } from '../lib/source-writeback';
import type { AccountClientVersions } from '../types';

const stamp=(value:number)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
export function SourceWritebackAdmin({owner,accounts,disabled,call=writebackCall}:{owner:WritebackOwner;accounts:AccountClientVersions[];disabled:boolean;call?:typeof writebackCall}) {
  const [data,setData]=useState<WritebackOverview|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<{names:string[];all:boolean}|null>(null);
  const [details,setDetails]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null);
  const clock=useRef({server:Date.now(),received:performance.now()});
  const [elapsed,setElapsed]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setElapsed(x=>x+1),15000);return()=>clearInterval(timer);},[]);
  const now=clock.current.server+performance.now()-clock.current.received;void elapsed;
  const eligible=accounts.filter(u=>u.role==='operator'&&u.accountStatus==='active');
  const chosen=selected.filter(name=>eligible.some(u=>u.username===name));
  useEffect(()=>{
    let alive=true,flight=false;
    async function read(){if(flight)return;flight=true;try{const next=await call<WritebackOverview>(owner,{kind:'overview'});if(alive){clock.current={server:next.generatedAtMs,received:performance.now()};setData(next);setError('');}}catch(e){if(alive)setError(String(e));}finally{flight=false;}}
    void read();const timer=setInterval(()=>void read(),15_000);return()=>{alive=false;clearInterval(timer);};
  },[owner.username,owner.serviceId,refresh,call]);
  useEffect(()=>{if(confirm||details)dialog.current?.showModal();},[confirm,details]);
  async function push(){if(!confirm||busy)return;setBusy(true);setError('');try{
    const result=await call<{queued:{username:string}[]}>(owner,{kind:'push',all:confirm.all,usernames:confirm.names});
    setNotice(`已为 ${result.queued.length} 个账号安排写回。请查看各电脑回执；离线或旧版电脑需上线并升级至 1.5.8。`);setConfirm(null);setSelected([]);setRefresh(x=>x+1);
  }catch(e){setError(String(e));}finally{setBusy(false);}}
  const account=data?.users.find(u=>u.username===details);
  return <section className="writeback-admin" aria-label="统一写回 NAS">
    <header><div><Database size={20}/><h3>统一写回 NAS</h3></div><button className="button button-secondary" disabled={busy} onClick={()=>setRefresh(x=>x+1)}><RefreshCw size={14}/>刷新回执</button></header>
    <p>将各电脑已提交的本机结果写回原共享目录，保留原审核人和日期。草稿、云端 QC 和本地磁盘结果不在范围内。需原电脑启动新版并登录对应账号，等待操作空闲；服务端不持有完整结果。本次进度仅统计指令开始时的积压，不包含之后正常提交的新结果。</p>
    <div className="writeback-actions"><button className="button button-primary" disabled={disabled||busy||!eligible.length} onClick={()=>setConfirm({names:eligible.map(u=>u.username),all:true})}>全部账号写回</button><button className="button button-secondary" disabled={disabled||busy||!chosen.length} onClick={()=>setConfirm({names:chosen,all:false})}>写回选中（{chosen.length}）</button><span>{data?`回执更新于 ${stamp(data.generatedAtMs)}`:'正在读取回执…'} · 每 15 秒刷新</span></div>
    {notice&&<p role="status">{notice}</p>}{error&&<p className="version-error" role="alert">统一写回状态暂未确认，保留上次回执：{error}</p>}
    <div className="writeback-list">{eligible.map(u=>{const row=data?.users.find(x=>x.username===u.username);return <div className="writeback-row" key={u.username}>
      <label><input type="checkbox" aria-label={`选择写回 @${u.username}`} checked={chosen.includes(u.username)} onChange={e=>setSelected(old=>e.target.checked?[...new Set([...old,u.username])]:old.filter(x=>x!==u.username))}/><strong>{u.displayName}</strong><span>@{u.username}</span></label>
      <div><span>{writebackCounts(row,now,Boolean(error))}</span><small>{error?'当前状态未知':writebackState(row,now)}</small></div>
      <div className="writeback-row-actions"><button className="text-button" onClick={()=>setDetails(u.username)}>执行详情</button><button className="button button-secondary" disabled={disabled||busy} onClick={()=>setConfirm({names:[u.username],all:false})}>写回</button></div>
    </div>;})}</div>
    <small>数量为结果条数（同一数据的动作和骨架分别计）；未上报电脑、已退出账号的电脑不代表没有积压。全部完成仅指本次已登记电脑的回执，不承诺其他设备没有结果，也不代表工作台已刷新统计。</small>
    {(confirm||details)&&<dialog className="rejection-dialog writeback-dialog" ref={dialog} aria-label={confirm?'确认统一写回 NAS':'写回执行详情'} onCancel={e=>{e.preventDefault();if(!busy){setConfirm(null);setDetails(null);}}}>
      <header><h2>{confirm?'确认统一写回 NAS':`写回执行详情 · @${details}`}</h2><button className="icon-button" aria-label="关闭写回窗口" disabled={busy} onClick={()=>{setConfirm(null);setDetails(null);}}><X size={18}/></button></header>
      {confirm?<><p>将向 {confirm.names.length} 个账号下发写回指令：{confirm.names.map(n=>`@${n}`).join('、')}。</p><p>在线新版客户端空闲后写回；离线电脑下次登录后执行。NAS 不可用、共享冲突或片段异常时保留本机结果，不覆盖他人修改。此操作会更新真实共享文件。</p>{error&&<p role="alert" className="version-error">{error}</p>}<footer><button className="button button-secondary" disabled={busy} onClick={()=>setConfirm(null)}>取消</button><button className="button button-primary" disabled={busy||disabled} onClick={()=>void push()}>{busy?'正在下发…':'确认下发写回'}</button></footer></>:
      <><p>{error?'回执状态未知':writebackState(account,now)}</p>{!account?.deliveries.length&&<p>尚无设备执行回执。请在保留本机结果的电脑升级至 1.5.8、启动软件并登录该账号。</p>}{account?.deliveries.map(d=>{const device=account.devices.find(x=>x.clientId===d.clientId);return <article key={d.clientId}><strong>电脑 {d.clientId.slice(0,8)} · {device?`v${device.version}`:'待支持此功能的客户端上报'}</strong><p>状态：{d.state==='complete'?'完成':d.state==='partial'?'异常':!device||device.online===false||now-device.lastSeenAtMs>=90_000?'等待上线':device.issue?'本机队列异常':d.state==='busy'?'等待空闲':d.state==='running'?(d.report?.errors.length?'处理中，已有异常':'正在写回'):'待执行'} · 回执时间 {stamp(d.updatedAtMs)}</p>{d.report&&<p>{writebackProgress(d.report)}{d.report.errors.map(c=>writebackErrors[c]??writebackErrors.unknown).join('；')}</p>}{device?.issue&&<p className="version-error">{writebackErrors[device.issue]??writebackErrors.unknown}；待写数量未知，请在原电脑处理。</p>}{device&&!device.issue&&<small>上次上报待写 {device.pending} 条（{device.online===false||now-device.lastSeenAtMs>=90_000?'已离线，数量待更新':'最近在线上报'}）；非共享目录 / 云端工作区跳过 {device.skipped} 条 · {stamp(device.lastSeenAtMs)}</small>}</article>;})}<p>异常请在原电脑“查看待写结果”核对；处理原因后可重新下发。旧版不会自动执行，不能从用户中心取回完整审核 JSON。</p></>}
    </dialog>}
  </section>;
}
