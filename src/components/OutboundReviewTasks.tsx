import {useEffect,useMemo,useRef,useState} from "react";
import {Check,CheckCircle2,LoaderCircle,Pause,Play,RefreshCw,Save,Video,X,XCircle} from "lucide-react";
import type {UserIdentity} from "../types";
import {changeOutboundBatch,fetchOutboundVideo,listOutboundBatches,OUTBOUND_INVALID_REASONS,outboundError,outboundVideoParts,saveOutboundReasonOption,type OutboundBatch} from "../lib/outbound-review";
import "./outbound-review.css";

interface Props {currentUser:UserIdentity;workspaceBusy?:boolean;view?:"tasks"|"workspace";initialBatch?:OutboundBatch;onOpenReview?:(batch:OutboundBatch)=>Promise<void>;onReturnToTasks?:()=>void;suspended?:boolean}
type VideoState={recordingId:string;part:number;urls:Record<number,string>;ready:number[];failed:boolean};

export function OutboundReviewTasks({currentUser,workspaceBusy=false,view="tasks",initialBatch,onOpenReview,onReturnToTasks,suspended=false}:Props){
  const [batches,setBatches]=useState<OutboundBatch[]>(initialBatch?[initialBatch]:[]);
  const [reasonOptions,setReasonOptions]=useState<string[]>([]);
  const [batchId,setBatchId]=useState(initialBatch?.id??"");
  const [recordingId,setRecordingId]=useState(initialBatch?.recordings.find(item=>!item.decision)?.id??initialBatch?.recordings[0]?.id??"");
  const [videoState,setVideoState]=useState<VideoState|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [opening,setOpening]=useState(false);
  const [partIndex,setPartIndex]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
  const [speed,setSpeed]=useState(1);
  const [error,setError]=useState("");
  const [reasonDialog,setReasonDialog]=useState(false);
  const [selectedReason,setSelectedReason]=useState("");
  const [customReason,setCustomReason]=useState("");
  const [notice,setNotice]=useState("");
  const players=useRef(new Map<number,HTMLVideoElement>());
  const syncingUntil=useRef(0);
  const requestGeneration=useRef(0);
  const batch=batches.find(value=>value.id===batchId)??null;
  const recording=batch?.recordings.find(value=>value.id===recordingId)??batch?.recordings[0]??null;
  const isOwner=batch?.claim===currentUser.username;
  const grouped=useMemo(()=>outboundVideoParts(recording?.videos??[]),[recording?.videos]);
  const partVideos=grouped.parts[partIndex]??[];
  const videosReady=Boolean(recording&&videoState?.recordingId===recording.id&&videoState.part===partIndex&&!videoState.failed&&partVideos.length>0&&partVideos.every(video=>videoState.urls[video.segment]&&videoState.ready.includes(video.segment)));
  const availableReasons=useMemo(()=>[...new Set([...OUTBOUND_INVALID_REASONS,...reasonOptions])],[reasonOptions]);

  async function load(){
    setLoading(true);setError("");
    try{
      const value=await listOutboundBatches();
      setBatches(value.batches);
      setReasonOptions(value.reasonOptions??[]);
      setBatchId(previous=>value.batches.some(item=>item.id===previous)?previous:value.batches[0]?.id??"");
    }catch(cause){setError(outboundError(cause));}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load();return()=>{requestGeneration.current++;};},[]);
  useEffect(()=>{
    if(!batch){setRecordingId("");setVideoState(null);return;}
    setRecordingId(previous=>batch.recordings.some(item=>item.id===previous)?previous:batch.recordings[0]?.id??"");
    requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(false);
  },[batch?.id]);
  useEffect(()=>{requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(false);setError("");},[recordingId]);

  useEffect(()=>{
    if(view==="workspace"&&recording&&isOwner&&!suspended)void openVideos(0);
    return()=>{requestGeneration.current++;for(const player of players.current.values())player.pause();};
  },[view,batch?.id,recording?.id,isOwner,suspended]);
  useEffect(()=>{if(suspended){for(const player of players.current.values())player.pause();setPlaying(false);}},[suspended]);

  function updateBatch(next:OutboundBatch){
    setBatches(previous=>previous.map(value=>value.id===next.id?next:value));
  }
  async function act(action:"claim"|"release"|"decide",value?:"valid"|"invalid",reason?:string){
    if(!batch)return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await changeOutboundBatch(batch,action,action==="decide"?recording?.id:undefined,value,reason);
      updateBatch(result.batch);
      if(action==="claim"){setNotice("已领取批次。");if(onOpenReview)await onOpenReview(result.batch);}
      if(action==="release"){setNotice("已释放批次。");if(view==="workspace")onReturnToTasks?.();}
      if(action==="decide"){
        setReasonDialog(false);setSelectedReason("");setCustomReason("");setNotice("审核结论已保存。");
        const next=result.batch.recordings.find(item=>!item.decision);
        if(next)setRecordingId(next.id);
      }
    }catch(cause){
      const message=outboundError(cause);
      try{const fresh=await listOutboundBatches();setBatches(fresh.batches);setReasonOptions(fresh.reasonOptions??[]);}catch{/* Keep the original error and saved state available for an explicit refresh. */}
      setError(message);
    }
    finally{setBusy(false);}
  }
  async function openVideos(nextPart=partIndex){
    if(!batch||!recording||!isOwner)return;
    const generation=++requestGeneration.current;
    const files=grouped.parts[nextPart]??[];
    if(!files.length)return;
    for(const player of players.current.values())player.pause();setPlaying(false);setPosition(0);setDuration(0);
    setPartIndex(nextPart);setVideoState(null);setOpening(true);setError("");setNotice("");
    try{
      const pairs=[];
      for(let offset=0;offset<files.length;offset+=4){
        if(generation!==requestGeneration.current)return;
        pairs.push(...await Promise.all(files.slice(offset,offset+4).map(async video=>[video.segment,await fetchOutboundVideo(batch,recording,video.segment)] as const)));
      }
      if(generation===requestGeneration.current)setVideoState({recordingId:recording.id,part:nextPart,urls:Object.fromEntries(pairs),ready:[],failed:false});
    }catch(cause){if(generation===requestGeneration.current){setVideoState(null);setError(outboundError(cause));}}
    finally{if(generation===requestGeneration.current)setOpening(false);}
  }
  function updateClock(){
    const videos=[...players.current.values()];const first=videos[0];
    if(first)setPosition(first.currentTime);
    const durations=videos.map(v=>v.duration).filter(v=>Number.isFinite(v)&&v>0);
    if(durations.length)setDuration(Math.min(...durations));
  }
  function seek(value:number){for(const player of players.current.values())if(player.readyState>=1)player.currentTime=Math.min(value,Number.isFinite(player.duration)?player.duration:value);setPosition(value);}
  function togglePlayback(){
    if(playing){for(const player of players.current.values())player.pause();setPlaying(false);}
    else{for(const player of players.current.values()){player.playbackRate=speed;void player.play().catch(()=>{setPlaying(false);setError("视频播放失败，请重新打开。");});}setPlaying(true);}
  }
  function markReady(segment:number){
    updateClock();
    setVideoState(previous=>{
      if(!previous||previous.recordingId!==recording?.id||previous.part!==partIndex)return previous;
      return {...previous,ready:previous.ready.includes(segment)?previous.ready:[...previous.ready,segment]};
    });
  }
  function syncFrom(source:HTMLVideoElement,kind:"play"|"pause"|"seek"|"time"){
    if(Date.now()<syncingUntil.current)return;
    syncingUntil.current=Date.now()+180;
    for(const video of players.current.values()){
      if(video===source)continue;
      if(kind==="play"){
        if(Math.abs(video.currentTime-source.currentTime)>0.08&&Number.isFinite(source.currentTime))video.currentTime=source.currentTime;
        void video.play().catch(()=>undefined);
      }else if(kind==="pause")video.pause();
      else if(kind==="seek"||kind==="time"){
        if(video.readyState>=1&&Math.abs(video.currentTime-source.currentTime)>0.2)video.currentTime=source.currentTime;
      }
    }
  }
  async function taskAction(item:OutboundBatch,action:"claim"|"release"|"open"){
    if(busy||workspaceBusy)return;
    setBusy(true);setError("");
    try{
      if(action==="open"){await onOpenReview?.(item);return;}
      const result=await changeOutboundBatch(item,action);updateBatch(result.batch);
      if(action==="claim")await onOpenReview?.(result.batch);
    }catch(cause){setError(outboundError(cause));}
    finally{setBusy(false);}
  }
  async function addReason(){
    const value=customReason.trim();
    if(!value)return;
    setBusy(true);setError("");
    try{
      const result=await saveOutboundReasonOption(value);
      setReasonOptions(result.reasonOptions);
      setSelectedReason(value);setCustomReason("");setNotice("已保存为常用无效原因。");
    }catch(cause){setError(outboundError(cause));}
    finally{setBusy(false);}
  }

  const recordingList=<nav className="outbound-recordings" aria-label="录制列表">{batch?.recordings.map((item,index)=><button type="button" key={item.id} className={item.id===(recording?.id??"")?"selected":""} aria-pressed={item.id===(recording?.id??"")} disabled={busy||workspaceBusy} onClick={()=>setRecordingId(item.id)}><span>{item.name||`录制 ${index+1}`}</span><strong className={item.decision?.value??""}>{item.decision?.value==="valid"?"有效":item.decision?.value==="invalid"?"无效":"待审"}</strong></button>)}</nav>;
  if(view==="tasks")return <section className="outbound-review" aria-label="外发审核任务">
    <div className="outbound-toolbar"><strong>外发审核</strong><span>按交付批次领取任务</span><button className="button button-secondary" type="button" aria-label="刷新外发批次" disabled={loading||busy||workspaceBusy} onClick={()=>void load()}><RefreshCw size={16}/></button></div>
    {error&&<div className="outbound-error" role="alert">{error}</div>}
    {loading&&!batches.length?<div className="outbound-empty">正在读取交付批次…</div>:!batches.length?<div className="outbound-empty">暂无可审核的星炬批次</div>:<div className="outbound-task-list">{batches.map(item=><article key={item.id}><div><strong>{item.name}</strong><p>已审 {item.reviewed}/{item.total} · 有效 {item.valid} · 无效 {item.invalid}{item.rate===null?"":` · 合格率 ${Math.round(item.rate*100)}%`}</p><small>{item.claim?`由 ${item.claim} 领取`:"未领取"}</small></div><div className="outbound-task-actions">{item.claim===currentUser.username?<><button className="button button-secondary" disabled={busy||workspaceBusy} onClick={()=>void taskAction(item,"release")}>释放批次</button><button className="button button-primary" disabled={busy||workspaceBusy||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"open")}>打开审核</button></>:<button className="button button-primary" disabled={busy||workspaceBusy||Boolean(item.claim)||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"claim")}>{busy?<LoaderCircle size={16} className="spin"/>:null}{item.claim?"审核员处理中":"领取并打开"}</button>}</div></article>)}</div>}
  </section>;
  return <section className="outbound-review is-workspace" aria-label="外发审核工作区">
    <div className="outbound-toolbar"><strong>外发审核</strong><span>{batch?`已审 ${batch.reviewed}/${batch.total} · 有效 ${batch.valid} · 无效 ${batch.invalid}`:"按交付批次审核原始视频"}</span><button className="button button-secondary" type="button" aria-label="刷新外发批次" title="刷新外发批次" disabled={loading||busy||workspaceBusy} onClick={()=>void load()}>{loading?<LoaderCircle size={16} className="spin"/>:<RefreshCw size={16}/>}</button></div>
    {error&&<div className="outbound-error" role="alert">{error}</div>}{notice&&<div className="outbound-notice" role="status">{notice}</div>}
    {loading&&!batches.length?<div className="outbound-empty"><LoaderCircle size={18} className="spin"/>正在读取交付批次…</div>:!batches.length?<div className="outbound-empty">暂无可审核的星炬批次</div>:<div className="outbound-layout">
      <aside className="outbound-recording-sidebar"><header><strong>记录</strong><span>{batch?.total??0} 条</span></header>{recordingList}<button className="button button-secondary" disabled={busy||workspaceBusy} onClick={onReturnToTasks}>返回任务中心</button></aside>
      {batch&&<div className="outbound-detail">
        <header><div><h3>{batch.name}</h3><p>批次 {batch.id} · 合格率 {batch.rate===null?"待统计":`${Math.round(batch.rate*100)}%`} · {batch.reviewed}/{batch.total} 条</p></div>
          {isOwner?<button className="button button-secondary" type="button" disabled={busy||workspaceBusy} onClick={()=>void act("release")}>释放批次</button>:<button className="button button-primary" type="button" disabled={busy||workspaceBusy||Boolean(batch.claim)} onClick={()=>void act("claim")}>{busy?<LoaderCircle size={16} className="spin"/>:null}{batch.claim?"审核员处理中":"领取批次"}</button>}
        </header>
        {batch.recordings.length>0?<>

          {recording&&<section className="outbound-player" aria-label="原始视频审核">
            <div className="outbound-player-heading"><div><strong>{recording.name}</strong><span>{grouped.cameraCount} 路原始视频{grouped.parts.length>1?` · 共 ${grouped.parts.length} 段`:""}</span></div>
              {isOwner&&(!videoState||videoState.failed)&&<button className="button button-secondary" type="button" disabled={opening||workspaceBusy||!recording.videos.length} onClick={()=>void openVideos()}>{opening?<LoaderCircle size={16} className="spin"/>:<Play size={16}/>}打开原始视频</button>}
            </div>
            {grouped.parts.length>1&&<nav className="outbound-video-tabs" aria-label="视频分段">{grouped.parts.map((_,index)=><button key={index} type="button" aria-pressed={index===partIndex} disabled={!isOwner||opening||busy||workspaceBusy} onClick={()=>void openVideos(index)}>第 {index+1} 段</button>)}</nav>}
            {videoState?.recordingId===recording.id&&videoState.part===partIndex?<div className="outbound-video-grid">{partVideos.map(video=><article className="outbound-video-item" key={`${recording.id}:${video.segment}`}><header><strong>{video.camera||`视频 ${video.segment+1}`}</strong><span>{(video.size/1024/1024).toFixed(1)} MB</span></header><video ref={element=>{if(element)players.current.set(video.segment,element);else players.current.delete(video.segment);}} src={videoState.urls[video.segment]} controls playsInline preload="auto" onCanPlay={()=>markReady(video.segment)} onPlay={event=>{setPlaying(true);syncFrom(event.currentTarget,"play");}} onPause={event=>{setPlaying(false);syncFrom(event.currentTarget,"pause");}} onSeeking={event=>syncFrom(event.currentTarget,"seek")} onLoadedMetadata={updateClock} onTimeUpdate={event=>{syncFrom(event.currentTarget,"time");updateClock();}} onError={()=>{setVideoState(previous=>previous?{...previous,failed:true}:null);setError(`原始视频读取失败：${video.label}，请重新打开。`);}}/></article>)}</div>:<div className="outbound-video-placeholder"><Video size={22}/><span>{opening?"正在读取原始视频…":isOwner?"打开后将并列读取本条录制的全部相机":"领取批次后查看原始视频"}</span></div>}
            <div className="outbound-transport" aria-label="回放控制"><button className="button button-secondary" type="button" aria-label={playing?"暂停":"全局播放"} disabled={!videosReady||busy||workspaceBusy||suspended} onClick={togglePlayback}>{playing?<Pause size={16}/>:<Play size={16}/>}</button><input type="range" aria-label="视频播放位置" min={0} max={duration||1} step={0.01} value={Math.min(position,duration||1)} disabled={!videosReady||suspended} onChange={event=>seek(Number(event.target.value))}/><span>{position.toFixed(1)} / {duration.toFixed(1)} 秒</span><select aria-label="播放速度" value={speed} onChange={event=>{const rate=Number(event.target.value);setSpeed(rate);for(const player of players.current.values())player.playbackRate=rate;}}>{[.25,.5,1,2].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></div>
            <div className="outbound-decision"><span>{recording.decision?`已由 ${recording.decision.actor} 于 ${new Date(recording.decision.at).toLocaleString("zh-CN",{hour12:false})} 判为${recording.decision.value==="valid"?"有效":"无效"}${recording.decision.reason?` · ${recording.decision.reason}`:""}`:videosReady?"请根据完整原始视频判断数据有效性":"视频全部就绪后可提交结论"}</span>
              <button className="button button-secondary" type="button" disabled={!isOwner||busy||workspaceBusy||!videosReady||Boolean(recording.decision)} onClick={()=>void act("decide","valid")}><CheckCircle2 size={16}/>有效数据</button>
              <button className="button button-secondary outbound-invalid-button" type="button" disabled={!isOwner||busy||workspaceBusy||!videosReady||Boolean(recording.decision)} onClick={()=>setReasonDialog(true)}><XCircle size={16}/>无效数据</button>
            </div>
          </section>}
        </>:<div className="outbound-empty">此批次没有可审核录制</div>}
      </div>}
    </div>}
    {reasonDialog&&<div className="outbound-dialog-backdrop" role="presentation"><section className="outbound-reason-dialog" role="dialog" aria-modal="true" aria-labelledby="outbound-reason-title"><header><div><h3 id="outbound-reason-title">选择无效原因</h3><p>原因将写入本条审核结论，供交付平台统计。</p></div><button className="icon-button" type="button" aria-label="关闭无效原因" onClick={()=>setReasonDialog(false)}><X size={18}/></button></header><div className="outbound-reason-options">{availableReasons.map(reason=><button type="button" key={reason} aria-pressed={selectedReason===reason} onClick={()=>setSelectedReason(reason)}>{selectedReason===reason?<Check size={15}/>:null}{reason}</button>)}</div><form onSubmit={event=>{event.preventDefault();void addReason();}}><label htmlFor="outbound-custom-reason">新增常用原因</label><div><input id="outbound-custom-reason" maxLength={80} value={customReason} disabled={busy} onChange={event=>setCustomReason(event.target.value)} placeholder="输入原因并保存"/><button className="button button-secondary" type="submit" disabled={busy||!customReason.trim()}><Save size={15}/>保存常用项</button></div></form><footer><button className="button button-secondary" type="button" disabled={busy} onClick={()=>setReasonDialog(false)}>取消</button><button className="button button-primary" type="button" disabled={busy||!selectedReason} onClick={()=>void act("decide","invalid",selectedReason)}>{busy?<LoaderCircle size={16} className="spin"/>:null}确认无效</button></footer></section></div>}
  </section>;
}
