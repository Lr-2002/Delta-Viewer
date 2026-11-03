import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './backend';
export type WritebackReport = {requestId:string;seq:number;state:'running'|'complete'|'partial';total:number;written:number;remaining:number;errors:string[]};
export type WritebackRequest = {id:string;sender:string;createdAtMs:number};
export type WritebackAccount = {username:string;request:WritebackRequest|null;devices:{clientId:string;version:string;lastSeenAtMs:number;pending:number;skipped:number;issue?:string}[];deliveries:{clientId:string;state:string;updatedAtMs:number;report:WritebackReport|null}[]};
export type WritebackOverview = {generatedAtMs:number;users:WritebackAccount[]};
export type WritebackPoll = {request:WritebackRequest|null;generatedAtMs:number};
export type WritebackOwner = {username:string;serviceId:string};
export async function writebackCall<T>(owner:WritebackOwner,request:object):Promise<T> {
  if (!isTauriRuntime()) throw Error('统一写回需要桌面端及支持此功能的用户中心');
  return invoke('source_writeback_management',{...owner,request});
}
export const writebackErrors:Record<string,string>={storage_full:'NAS 空间不足',storage_unavailable:'共享目录不可用或响应超时',conflict:'共享结果已变化，需人工核对',invalid_result:'片段范围等结果内容不合法，需核对',changed:'本机结果已改变，原指令未覆盖',local_storage:'本机队列读写失败',unknown:'原因未知，请在原电脑查看待写结果'};
export function writebackState(account:WritebackAccount|undefined,now=Date.now()):string {
  if(!account?.request)return '尚未下发';
  if(!account.deliveries.length)return '等待客户端上线 / 升级至 1.5.8';
  const states=account.deliveries.map(d=>{
    const device=account.devices.find(x=>x.clientId===d.clientId);
    if(d.state==='complete')return '完成';
    if(d.state==='partial')return '异常';
    if(!device || now-device.lastSeenAtMs>90_000)return '等待上线';
    if(device.issue)return '本机队列异常';
    return d.state==='busy'?'等待空闲':d.state==='running'?'正在写回':'待执行';
  });
  return [...new Set(states)].map(s=>`${s} ${states.filter(x=>x===s).length} 台`).join(' · ');
}
