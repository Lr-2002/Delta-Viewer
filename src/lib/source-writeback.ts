import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './backend';
export type WritebackReport = {requestId:string;seq:number;state:'running'|'complete'|'partial';total:number;written:number;remaining:number;attempted?:number;failed?:number;unattempted?:number;errors:string[]};
export type WritebackRequest = {id:string;sender:string;createdAtMs:number};
export type WritebackAccount = {username:string;request:WritebackRequest|null;devices:{clientId:string;version:string;lastSeenAtMs:number;pending:number;skipped:number;issue?:string;online?:boolean}[];deliveries:{clientId:string;state:string;updatedAtMs:number;report:WritebackReport|null}[]};
export type WritebackOverview = {generatedAtMs:number;users:WritebackAccount[]};
export type WritebackPoll = {request:WritebackRequest|null;generatedAtMs:number;receipt?:WritebackReport|null};
export type WritebackOwner = {username:string;serviceId:string};
export async function writebackCall<T>(owner:WritebackOwner,request:object):Promise<T> {
  if (!isTauriRuntime()) throw Error('统一写回需要桌面端及支持此功能的用户中心');
  return invoke('source_writeback_management',{...owner,request});
}
export const writebackErrors:Record<string,string>={storage_full:'NAS 空间不足',storage_unavailable:'共享目录拒绝写入或不可访问，请检查账号权限、目录路径和连接',source_missing:'此条目录不存在或无法访问，请核对路径与共享连接',storage_timeout:'共享目录检查超时（连续三条超时后暂停本次写回）',conflict:'共享结果已变化，需人工核对',invalid_result:'片段范围等结果内容不合法，需核对',changed:'本机结果已改变，原指令未覆盖',local_storage:'本机队列读写失败',unknown:'原因未知，请在原电脑查看待写结果'};
export function writebackState(account:WritebackAccount|undefined,now=Date.now()):string {
  if(!account?.request)return '尚未下发';
  if(!account.deliveries.length)return '等待客户端上线 / 升级至 1.5.8';
  const states=account.deliveries.map(d=>{
    const device=account.devices.find(x=>x.clientId===d.clientId);
    if(d.state==='complete')return '完成';
    if(d.state==='partial')return '异常';
    if(!device || device.online===false || now-device.lastSeenAtMs>=90_000)return '等待上线';
    if(device.issue)return '本机队列异常';
    return d.state==='busy'?'等待空闲':d.state==='running'?(d.report?.errors.length?'处理中，已有异常':'正在写回'):'待执行';
  });
  return [...new Set(states)].map(s=>`${s} ${states.filter(x=>x===s).length} 台`).join(' · ');
}

export function writebackCounts(account:WritebackAccount|undefined,now=Date.now(),failed=false):string {
  if(!account?.devices.length)return '尚无设备待写上报';
  const fresh=account.devices.filter(d=>!d.issue&&d.online!==false&&now-d.lastSeenAtMs<90_000);
  if(failed)return '连接未恢复，当前待写数量待确认';
  const waiting=account.devices.length-fresh.length;
  if(!fresh.length)return account.devices.some(d=>d.issue)?'本机队列异常，待写数量待确认':'设备已离线，待写数量待更新';
  const count=fresh.reduce((sum,d)=>sum+d.pending,0);
  return `${count} 条待写（在线设备）${waiting?` · ${waiting} 台待更新`:''}`;
}

export function writebackProgress(report:WritebackReport):string {
  const checked=report.attempted!==undefined&&report.failed!==undefined&&report.unattempted!==undefined;
  return `本次积压 ${report.total} 条：已写入 ${report.written} 条，${checked?`已检查 ${report.attempted} 条，失败 ${report.failed} 条，尚未处理 ${report.unattempted} 条`:'旧版未上报逐条处理数量'}；仍在本机 ${report.remaining} 条。`;
}
