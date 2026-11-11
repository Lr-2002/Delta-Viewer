import type {DevicePage, DeviceResultStatus} from "../lib/d1";
import {cameraLabel, deviceStateLabel, deviceText} from "../lib/d1-presentation";
import {ArrowRight, HardDrive, Lightbulb, Radio, Video, Wifi} from "lucide-react";

const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const list=(v:unknown):Record<string,unknown>[]=>Array.isArray(v)?v.map(object):[];
const text=(v:unknown)=>typeof v==="string"||typeof v==="number"?String(v):"未提供";
const number=(v:unknown,unit="",digits=1)=>typeof v==="number"&&Number.isFinite(v)?`${v.toFixed(digits)}${unit}`:"未提供";
const size=(v:unknown)=>typeof v==="number"?`${(v/1024**3).toFixed(1)} GiB`:"未提供";
const state=(v:unknown)=>deviceStateLabel(typeof v==="string"?v:null);
const labels:Record<string,string>={white:"白色",yellow:"黄色",red:"红色",green:"绿色",blue:"蓝色",off:"熄灭",steady:"常亮",blink:"闪烁",blinking:"闪烁",pulse:"呼吸",SYNCHRONIZED:"已同步",warning:"预警",critical:"严重",info:"提示",camera_runtime:"相机服务",monitor:"状态监控",recording_writer:"采集写入",camera_watchdog:"相机守护",gpio:"按键服务",status_led:"状态灯服务",system:"系统服务",temperature:"温度监控",web:"设备网页"};
const translated=(v:unknown)=>labels[text(v)]??deviceText(text(v));
export interface RuntimeReading {id:string;name:string;status:DeviceResultStatus;values:[string,string][];note?:string}
export function runtimeReadings(s:Record<string,unknown>,cameraPortLimited=false):RuntimeReading[] {
  const fresh=s.heartbeat_stale===false;
  const outcome=(normal:boolean|undefined):DeviceResultStatus=>!fresh?"indeterminate":normal===true?"normal":normal===false?"abnormal":"indeterminate";
  const storage=object(s.storage),emmc=object(s.emmc_storage),recording=object(s.recording),qc=object(s.qc),stress=object(s.stress_test);
  const checks:RuntimeReading[]=[
    {id:"sd",name:"采集存储卡",status:outcome(storage.mounted===false||storage.writable===false||storage.usage_warning===true?false:storage.mounted===true&&storage.writable===true&&storage.usage_warning===false?true:undefined),values:[["状态",storage.writable===true?"可写":storage.writable===false?"不可写":"未提供"],["已用",number(storage.used_percent,"%")],["剩余",size(storage.free_bytes)],["总容量",size(storage.total_bytes)],["文件系统",text(storage.filesystem_type)]]},
    {id:"emmc",name:"设备内置存储",status:outcome(emmc.usage_warning===true?false:emmc.usage_warning===false?true:undefined),values:[["已用",number(emmc.used_percent,"%")],["剩余",size(emmc.free_bytes)],["总容量",size(emmc.total_bytes)]]},
    {id:"recording",name:"采集与写入",status:outcome(recording.writer_alive===false||["FAILED","DEGRADED"].includes(text(recording.quality))?false:recording.writer_alive===true&&recording.quality==="OK"?true:undefined),values:[["采集状态",recording.session_active===true?"正在采集":recording.session_active===false?"未采集":"未提供"],["写入服务",recording.writer_alive===true?"运行中":recording.writer_alive===false?"已停止":"未提供"],["采集质量",state(recording.quality)],["丢弃批次",text(recording.dropped_batches)],["写入队列",`${text(recording.queue_depth)} / ${text(recording.queue_capacity)}`]]},
  ];
  for(const camera of list(object(s.cameras).items))checks.push({id:`camera:${text(camera.role)}`,name:cameraLabel(text(camera.role)),status:cameraPortLimited&&camera.role==="stereo_extension"?"not_run":!fresh?"indeterminate":camera.enabled===false?"not_run":outcome(camera.state==="STREAMING"&&camera.fresh===true?true:["FAULT","FAILED"].includes(text(camera.state))?false:undefined),values:[["状态",state(camera.state)],["画面",camera.fresh===true?"实时":camera.fresh===false?"已过期":"未提供"],["距最近画面",number(camera.last_frame_age_seconds," 秒",3)],["重连次数",text(camera.reconnect_count)]]});
  for(const [id,name,item] of [["qc","设备已有自检",qc],["stress","设备已有压力测试",stress]] as const)checks.push({id,name,status:!s[id==="qc"?"qc":"stress_test"]?"indeterminate":item.phase==="IDLE"&&item.result==null?"not_run":"indeterminate",values:[["阶段",state(item.phase)],["已有结果",state(item.result)],["进度",number(item.progress_percent,"%")],["已用时间",number(item.elapsed_seconds," 秒",0)]],note:"只展示设备已有结果；本次读取不会启动测试，也不代表当前硬件已通过自检。"});
  for(const [id,name] of [["status","状态灯"],["battery","电池灯"]]){const led=object(object(s.indicators)[id]);checks.push({id:`led:${id}`,name,status:outcome(led.write_state==="SYNCHRONIZED"?true:undefined),values:[["颜色",translated(led.color_name)],["灯效",translated(led.pattern)],["显示同步",translated(led.write_state)],["触发原因",translated(led.trigger)]],note:"灯色与设备报告一致；同步正常不表示没有告警。"});}
  for(const component of list(s.components))checks.push({id:`component:${text(component.name)}`,name:translated(component.name),status:outcome(typeof component.healthy==="boolean"?component.healthy:undefined),values:[["状态",state(component.state)]]});
  return checks;
}
const statusLabels:Record<DeviceResultStatus,string>={normal:"正常",abnormal:"异常",indeterminate:"无法判断",unsupported:"不支持",not_run:"未执行"};
type OverviewTone="normal"|"attention"|"warning"|"info";
function healthTone(s:Record<string,unknown>,error:string,connectionLimitedOnly:boolean):OverviewTone {
  if(error||s.heartbeat_stale!==false||connectionLimitedOnly)return "info";
  switch(text(s.health).toUpperCase()) {
    case "OK":return "normal";
    case "DEGRADED":return "attention";
    case "FAILED":case "FAULT":return "warning";
    default:return "info";
  }
}
function phaseTone(s:Record<string,unknown>,error:string):OverviewTone {
  if(error||s.heartbeat_stale!==false)return "info";
  const phase=text(s.phase).toUpperCase();
  if(["FAILED","FAULT","ERROR"].includes(phase))return "warning";
  if(["DEGRADED","RECOVERING","STARTING"].includes(phase))return "attention";
  return "info";
}
function telemetryTone(s:Record<string,unknown>,alerts:Record<string,unknown>,terms:RegExp,error:string):OverviewTone {
  if(error||s.heartbeat_stale!==false)return "info";
  const related=list(alerts.items).filter(alert=>terms.test(`${text(alert.code)} ${text(alert.component)}`));
  if(related.some(alert=>text(alert.severity).toLowerCase()==="critical"))return "warning";
  if(related.some(alert=>text(alert.severity).toLowerCase()==="warning"))return "attention";
  return "info";
}
type SummaryGroup={id:string;name:string;icon:typeof HardDrive;status:DeviceResultStatus;readings:RuntimeReading[]};
function summaryGroups(readings:RuntimeReading[]):SummaryGroup[] {
  const get=(id:string)=>readings.find(item=>item.id===id);
  const cameras=readings.filter(item=>item.id.startsWith("camera:"));
  const indicators=readings.filter(item=>item.id.startsWith("led:"));
  const tests=[get("qc"),get("stress")].filter((item):item is RuntimeReading=>Boolean(item));
  const combine=(items:RuntimeReading[]):DeviceResultStatus=>{
    const statuses=items.map(item=>item.status);
    if(statuses.includes("abnormal"))return "abnormal";
    if(statuses.includes("indeterminate"))return "indeterminate";
    if(statuses.length&&statuses.every(value=>value==="normal"))return "normal";
    if(statuses.includes("unsupported"))return "unsupported";
    return "not_run";
  };
  const groups:SummaryGroup[]=[];
  const storage=[get("sd"),get("emmc")].filter((item):item is RuntimeReading=>Boolean(item));
  if(storage.length)groups.push({id:"storage",name:"存储",icon:HardDrive,status:combine(storage),readings:storage});
  const recording=get("recording");
  if(recording)groups.push({id:"capture",name:"采集与写入",icon:Video,status:recording.status,readings:[recording]});
  if(cameras.length)groups.push({id:"cameras",name:"相机",icon:Radio,status:combine(cameras),readings:cameras});
  if(indicators.length)groups.push({id:"indicators",name:"指示灯",icon:Lightbulb,status:combine(indicators),readings:indicators});
  if(tests.length)groups.push({id:"tests",name:"设备测试",icon:Wifi,status:combine(tests),readings:tests});
  return groups;
}

function SummaryCard({group,onOpen}:{group:SummaryGroup;onOpen?:()=>void}) {
  const Icon=group.icon;
  return <article className={`manager-check manager-summary-card manager-summary-${group.id}`}>
    <header><h3><Icon size={18}/>{group.name}</h3><span className={`manager-result result-${group.status}`}>{statusLabels[group.status]}</span></header>
    <div className="manager-summary-lines">{group.readings.map(reading=><section key={reading.id}>
      {group.readings.length>1&&<strong>{reading.name}</strong>}
      {reading.values.slice(0,group.id==="cameras"?2:group.id==="indicators"?2:3).map(([label,value])=><p key={label}><span>{label}</span><b>{value}</b></p>)}
    </section>)}</div>
    {onOpen&&<button className="button button-secondary" type="button" onClick={onOpen}>完整检测结果<ArrowRight size={15}/></button>}
  </article>;
}

export function DeviceRuntimePanel({page,diagnostics=false,error,refresh,onConfigure,onNavigate,cameraPortLimited=false,connectionLimitedOnly=false}:{cameraPortLimited?:boolean;connectionLimitedOnly?:boolean;page:DevicePage|null;diagnostics?:boolean;error:string;refresh:()=>void;onConfigure?:()=>void;onNavigate?:()=>void}) {
  if(!page?.status)return <section className="manager-card" role="status"><h2>设备运行状态</h2><p>{error||"正在读取设备运行状态…"}</p><button className="button button-secondary" onClick={refresh}>重新读取状态</button></section>;
  const s=page.status,d=object(s.device),telemetry=object(s.telemetry),alerts=object(s.alerts),items=list(alerts.items);
  const readings=runtimeReadings(s,cameraPortLimited).map(reading=>error?{...reading,status:"indeterminate" as const}:reading);
  const tones={health:healthTone(s,error,connectionLimitedOnly),phase:phaseTone(s,error),voltage:telemetryTone(s,alerts,/voltage|battery|power/i,error),temperature:telemetryTone(s,alerts,/temp|thermal/i,error)};
  return <section className="manager-runtime" aria-label="设备实时运行状态">
    <header className="manager-runtime-heading"><div><h2>{diagnostics?"设备状态检查":"设备运行状态"}</h2><small>来自设备状态页 · {new Date(page.observedAtMs).toLocaleTimeString("zh-CN",{hour12:false})} · 应用 {text(d.workspace_version)}</small></div><div className="manager-actions"><button className="button button-secondary" onClick={refresh}>刷新状态</button>{onConfigure&&<button className="button button-secondary" onClick={onConfigure}>打开设备配置</button>}</div></header>
    {error&&<p className="manager-error" role="status">{error} · 下方为上次读取结果，当前状态无法判断。</p>}
    <div className="manager-runtime-overview"><div className={`overview-health tone-${tones.health}`}><span>设备总体状态</span><strong>{error||s.heartbeat_stale!==false?"无法判断":connectionLimitedOnly?"连接受限":state(s.health)}</strong></div><div className={`overview-phase tone-${tones.phase}`}><span>运行阶段</span><strong>{state(s.phase)}</strong></div><div className={`overview-voltage tone-${tones.voltage}`}><span>电压</span><strong>{number(telemetry.vcc_voltage," V",2)}</strong></div><div className={`overview-temperature tone-${tones.temperature}`}><span>芯片温度</span><strong>{number(telemetry.chip_temp," °C")}</strong></div></div>
    {!diagnostics&&<dl className="manager-metadata manager-card"><div><dt>连接 IP</dt><dd>{page.address}</dd></div><div><dt>设备标识</dt><dd>{text(d.device_id)}</dd></div><div><dt>应用版本</dt><dd>{text(d.workspace_version)}</dd></div><div><dt>板端版本</dt><dd>{text(d.firmware_version)}</dd></div><div><dt>运行时间</dt><dd>{number(object(s.runtime).uptime_seconds," 秒",0)}</dd></div><div><dt>心跳间隔</dt><dd>{number(s.heartbeat_age_seconds," 秒",3)}</dd></div></dl>}
    {!diagnostics?<>
      {cameraPortLimited&&<p className="manager-port-note">Type-C 当前用于连接电脑，扩展双目相机未检查；设备原始告警和灯色保留。</p>}
      <div className="manager-summary-grid">{summaryGroups(readings).map(group=><SummaryCard key={group.id} group={group} onOpen={onNavigate}/>)}</div>
      {onNavigate&&<button className="button button-secondary manager-runtime-details" type="button" onClick={onNavigate}>查看完整检测结果<ArrowRight size={16}/></button>}
    </>:<>
      {cameraPortLimited&&<p className="manager-port-note">Type-C 当前用于连接电脑，扩展双目相机未检查；设备原始告警和灯色保留。</p>}
      <div className="manager-runtime-alerts" role="status">{items.length?items.map((alert,index)=><article key={index}><strong>{translated(alert.severity)} · {deviceText(text(alert.code))}</strong><p>{deviceText(text(alert.message))}</p><p>{deviceText(text(alert.action))}</p><details><summary>设备原始证据</summary><pre>{JSON.stringify(alert,null,2)}</pre></details></article>):<p>{alerts.total===0?"设备未报告活动告警":"告警状态未提供"}</p>}</div>
      <div className="manager-checks">{readings.map(reading=><article className={`manager-check check-${error?"indeterminate":reading.status}`} key={reading.id}><header><h3>{reading.name}</h3><span className={`manager-result result-${error?"indeterminate":reading.status}`}>{statusLabels[error?"indeterminate":reading.status]}</span></header><dl className="manager-runtime-values">{reading.values.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{reading.note&&<small>{reading.note}</small>}</article>)}</div>
      <p className="manager-observed">所有项目均来自设备已有报告。观测时间和设备版本如上；缺少字段保持未知。</p>
    </>}
  </section>;
}
