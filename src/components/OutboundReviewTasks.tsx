import {memo,useEffect,useMemo,useRef,useState,type CSSProperties} from "react";
import {ArrowLeft,Check,CheckCircle2,ChevronRight,Expand,Film,LoaderCircle,Pause,Play,RefreshCw,Save,Video,Volume2,VolumeX,X,XCircle} from "lucide-react";
import type {UserIdentity} from "../types";
import {changeOutboundBatch,fetchOutboundVideo,listOutboundBatches,OUTBOUND_INVALID_REASONS,outboundError,outboundVideoParts,saveOutboundReasonOption,type OutboundBatch,type OutboundRecording} from "../lib/outbound-review";
import {OutboundPlayback} from "../lib/outbound-playback";
import "./outbound-review.css";

interface Props {currentUser:UserIdentity;workspaceBusy?:boolean;view?:"tasks"|"workspace";initialBatch?:OutboundBatch;onOpenReview?:(batch:OutboundBatch)=>Promise<void>;onReturnToTasks?:()=>void;suspended?:boolean}
type VideoState={recordingId:string;part:number;urls:Record<number,string>;ready:number[];failed:boolean};

// Playback publishes its clock frequently. The recording queue only changes
// when selection, authority or a saved decision changes.
const RecordingList=memo(function RecordingList({recordings,selectedId,disabled,onSelect}:{recordings:OutboundRecording[];selectedId:string;disabled:boolean;onSelect:(id:string)=>void}){
  return <nav className="outbound-recordings" aria-label="录制列表">{recordings.map((item,index)=><button type="button" key={item.id} className={item.id===selectedId?"selected":""} aria-label={`${item.name||`录制 ${index+1}`} ${item.decision?.value==="valid"?"有效":item.decision?.value==="invalid"?"无效":"待审"}`} aria-pressed={item.id===selectedId} disabled={disabled} onClick={()=>onSelect(item.id)}><span className="outbound-recording-number">{String(index+1).padStart(2,"0")}</span><span className="outbound-recording-label" title={item.name}>{item.name||`录制 ${index+1}`}</span><strong className={item.decision?.value??""}>{item.decision?.value==="valid"?<><CheckCircle2 size={12}/>有效</>:item.decision?.value==="invalid"?<><XCircle size={12}/>无效</>:"待审"}</strong><ChevronRight className="outbound-recording-arrow" size={14}/></button>)}</nav>;
});

export function OutboundReviewTasks({currentUser,workspaceBusy=false,view="tasks",initialBatch,onOpenReview,onReturnToTasks,suspended=false}:Props){
  const [batches,setBatches]=useState<OutboundBatch[]>(initialBatch?[initialBatch]:[]);
  const [reasonOptions,setReasonOptions]=useState<string[]>(initialBatch?.reasonOptions??[]);
  const [batchId,setBatchId]=useState(initialBatch?.id??"");
  const [recordingId,setRecordingId]=useState(initialBatch?.recordings.find(item=>!item.decision)?.id??initialBatch?.recordings[0]?.id??"");
  const [videoState,setVideoState]=useState<VideoState|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [busyAction,setBusyAction]=useState("");
  const busyRef=useRef(false);
  const listGeneration=useRef(0);
  const [opening,setOpening]=useState(false);
  const [partIndex,setPartIndex]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
  const [speed,setSpeed]=useState(1);
  const [buffering,setBuffering]=useState(false);
  const [muted,setMuted]=useState(true);
  const [error,setError]=useState("");
  const [reasonDialog,setReasonDialog]=useState(false);
  const [selectedReason,setSelectedReason]=useState("");
  const [customReason,setCustomReason]=useState("");
  const [notice,setNotice]=useState("");
  const players=useRef(new Map<number,HTMLVideoElement>());
  const playback=useRef<OutboundPlayback|null>(null);
  const requestGeneration=useRef(0);
  const batch=batches.find(value=>value.id===batchId)??null;
  const recording=batch?.recordings.find(value=>value.id===recordingId)??batch?.recordings[0]??null;
  const isOwner=batch?.claim===currentUser.username;
  const grouped=useMemo(()=>outboundVideoParts(recording?.videos??[]),[recording?.videos]);
  const partVideos=grouped.parts[partIndex]??[];
  const missingCameras=grouped.cameras.filter(camera=>!partVideos.some(video=>video.camera===camera));
  const videosReady=Boolean(recording&&videoState?.recordingId===recording.id&&videoState.part===partIndex&&!videoState.failed&&partVideos.length>0&&!missingCameras.length&&partVideos.every(video=>videoState.urls[video.segment]&&videoState.ready.includes(video.segment)));
  const availableReasons=useMemo(()=>[...new Set([...OUTBOUND_INVALID_REASONS,...reasonOptions])],[reasonOptions]);
  const playerRefs=useMemo(()=>new Map(partVideos.map(video=>[video.segment,(element:HTMLVideoElement|null)=>{
    if(element)players.current.set(video.segment,element);else players.current.delete(video.segment);
    playback.current?.attach(video.segment,element);
  }])),[partVideos]);
  useEffect(()=>{
    const transport=new OutboundPlayback(state=>{
      setPlaying(state.playing);setBuffering(state.buffering);setPosition(state.position);setDuration(state.duration);
    },()=>setError("视频播放失败，请重新打开。"));
    playback.current=transport;
    for(const [id,player] of players.current)transport.attach(id,player);
    return()=>{transport.dispose();playback.current=null;};
  },[]);


  async function load(){
    const generation=++listGeneration.current;
    setLoading(true);setError("");
    try{
      const value=await listOutboundBatches(view==="workspace"?batchId:undefined);
      if(generation!==listGeneration.current)return;
      setBatches(value.batches);
      setReasonOptions(value.reasonOptions??[]);
      setBatchId(previous=>value.batches.some(item=>item.id===previous)?previous:value.batches[0]?.id??"");
    }catch(cause){if(generation===listGeneration.current)setError(outboundError(cause));}
    finally{if(generation===listGeneration.current)setLoading(false);}
  }
  useEffect(()=>{if(view==="tasks")void load();else setLoading(false);return()=>{requestGeneration.current++;listGeneration.current++;};},[view]);
  useEffect(()=>{
    if(!batch){setRecordingId("");setVideoState(null);return;}
    setRecordingId(previous=>batch.recordings.some(item=>item.id===previous)?previous:batch.recordings[0]?.id??"");
    requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(false);
  },[batch?.id]);
  useEffect(()=>{requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(false);setError("");},[recordingId]);

  useEffect(()=>{
    if(view==="workspace"&&recording&&isOwner&&!suspended)void openVideos(0);
    return()=>{requestGeneration.current++;playback.current?.pause();};
  },[view,batch?.id,recording?.id,isOwner,suspended]);
  useEffect(()=>{if(suspended)playback.current?.pause();},[suspended]);
  useEffect(()=>{playback.current?.setMaster(partVideos.find(video=>video.camera===grouped.primaryCamera)?.segment??null);},[partVideos,grouped.primaryCamera]);

  function updateBatch(next:OutboundBatch){
    setBatches(previous=>previous.map(value=>value.id===next.id?next:value));
  }
  async function act(action:"claim"|"release"|"decide",value?:"valid"|"invalid",reason?:string){
    if(!batch||busyRef.current)return;
    busyRef.current=true;setBusyAction(`${batch.id}:${action}`);setBusy(true);setError("");setNotice("");
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
      try{const fresh=await listOutboundBatches(view==="workspace"?batch.id:undefined);setBatches(fresh.batches);setReasonOptions(fresh.reasonOptions??[]);}catch{/* Keep the original error and saved state available for an explicit refresh. */}
      setError(message);
    }
    finally{busyRef.current=false;setBusyAction("");setBusy(false);}
  }
  async function openVideos(nextPart=partIndex){
    if(!batch||!recording||!isOwner)return;
    const generation=++requestGeneration.current;
    const files=grouped.parts[nextPart]??[];
    if(!files.length)return;
    playback.current?.pause();setPosition(0);setDuration(0);
    setPartIndex(nextPart);setVideoState({recordingId:recording.id,part:nextPart,urls:{},ready:[],failed:false});setOpening(true);setError("");setNotice("");
    let cursor=0;
    async function worker(){
      while(cursor<files.length&&generation===requestGeneration.current){
        const video=files[cursor++];
        try{
          const url=await fetchOutboundVideo(batch!,recording!,video.segment);
          if(generation!==requestGeneration.current)return;
          setVideoState(previous=>previous?{...previous,urls:{...previous.urls,[video.segment]:url}}:previous);
        }catch(cause){
          if(generation!==requestGeneration.current)return;
          setVideoState(previous=>previous?{...previous,failed:true}:previous);setError(outboundError(cause));
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(4,files.length)},worker));
    if(generation===requestGeneration.current)setOpening(false);
  }
  function updateClock(){playback.current?.refresh();}
  function seek(value:number){playback.current?.seek(value);}
  function togglePlayback(){
    if(playing)playback.current?.pause();
    else{if(duration>0&&position>=duration-.05)playback.current?.seek(0);playback.current?.play();}
  }
  function markReady(segment:number){
    updateClock();
    setVideoState(previous=>{
      if(!previous||previous.recordingId!==recording?.id||previous.part!==partIndex)return previous;
      return previous.ready.includes(segment)?previous:{...previous,ready:[...previous.ready,segment]};
    });
  }
  async function taskAction(item:OutboundBatch,action:"claim"|"release"|"open"){
    if(busyRef.current||workspaceBusy)return;
    busyRef.current=true;++listGeneration.current;setLoading(false);setBusyAction(`${item.id}:${action}`);setBusy(true);setError("");
    try{
      if(action==="open"){
        const detail=item.recordings.length?item:(await listOutboundBatches(item.id)).batches[0];
        if(!detail)throw new Error("OUTBOUND_BATCH_NOT_FOUND");
        await onOpenReview?.({...detail,reasonOptions});return;
      }
      const result=await changeOutboundBatch(item,action);updateBatch(result.batch);
      if(action==="claim")await onOpenReview?.({...result.batch,reasonOptions});
    }catch(cause){setError(outboundError(cause));}
    finally{busyRef.current=false;setBusyAction("");setBusy(false);}
  }
  async function addReason(){
    const value=customReason.trim();
    if(!value||busyRef.current)return;
    busyRef.current=true;setBusyAction("reason");setBusy(true);setError("");
    try{
      const result=await saveOutboundReasonOption(value);
      setReasonOptions(result.reasonOptions);
      setSelectedReason(value);setCustomReason("");setNotice("已保存为常用无效原因。");
    }catch(cause){setError(outboundError(cause));}
    finally{busyRef.current=false;setBusyAction("");setBusy(false);}
  }

  const recordingList=batch?<RecordingList recordings={batch.recordings} selectedId={recording?.id??""} disabled={busy||workspaceBusy} onSelect={setRecordingId}/>:null;
  if(view==="tasks")return <section className="outbound-review" aria-label="外发审核任务">
    <div className="outbound-toolbar"><strong>外发审核</strong><span>按交付批次领取任务</span><button className="button button-secondary" type="button" aria-label="刷新外发批次" disabled={loading||busy||workspaceBusy} onClick={()=>void load()}><RefreshCw size={16}/></button></div>
    {error&&<div className="outbound-error" role="alert">{error}</div>}
    {loading&&!batches.length?<div className="outbound-empty">正在读取交付批次…</div>:!batches.length?<div className="outbound-empty">暂无可审核的星炬批次</div>:<div className="outbound-task-list">{batches.map(item=><article key={item.id}><div><strong>{item.name}</strong><p>已审 {item.reviewed}/{item.total} · 有效 {item.valid} · 无效 {item.invalid}{item.rate===null?"":` · 合格率 ${Math.round(item.rate*100)}%`}</p><small>{item.claim?`由 ${item.claim} 领取`:"未领取"}</small></div><div className="outbound-task-actions">{item.claim===currentUser.username?<><button className="button button-secondary" disabled={busy||workspaceBusy} onClick={()=>void taskAction(item,"release")}>{busyAction===`${item.id}:release`?<LoaderCircle size={16} className="spin"/>:null}释放批次</button><button className="button button-primary" disabled={busy||workspaceBusy||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"open")}>{busyAction===`${item.id}:open`?<LoaderCircle size={16} className="spin"/>:null}打开审核</button></>:<button className="button button-primary" disabled={busy||workspaceBusy||Boolean(item.claim)||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"claim")}>{busyAction===`${item.id}:claim`?<LoaderCircle size={16} className="spin"/>:null}{item.claim?"审核员处理中":"领取并打开"}</button>}</div></article>)}</div>}
  </section>;
  return <section className="outbound-review is-workspace" aria-label="外发审核工作区">
    <div className="outbound-toolbar"><strong><Film size={17}/>外发审核</strong><div className="outbound-progress"><span>已审 <b>{batch?.reviewed??0}</b> / {batch?.total??0}</span><progress aria-label="批次审核进度" max={batch?.total||1} value={batch?.reviewed??0}/><span>有效 {batch?.valid??0} · 无效 {batch?.invalid??0}</span></div><button className="button button-secondary" type="button" aria-label="刷新外发批次" title="刷新外发批次" disabled={loading||busy||workspaceBusy} onClick={()=>void load()}>{loading?<LoaderCircle size={16} className="spin"/>:<RefreshCw size={16}/>}</button></div>
    {error&&<div className="outbound-error" role="alert">{error}</div>}{notice&&<div className="outbound-notice" role="status">{notice}</div>}
    {loading&&!batches.length?<div className="outbound-empty"><LoaderCircle size={18} className="spin"/>正在读取交付批次…</div>:!batches.length?<div className="outbound-empty">暂无可审核的星炬批次</div>:<div className="outbound-layout">
      <aside className="outbound-recording-sidebar"><header><strong>录制列表</strong><span>{batch?.total??0} 条</span></header>{recordingList}<button className="button button-secondary" disabled={busy||workspaceBusy} onClick={onReturnToTasks}><ArrowLeft size={15}/>返回任务中心</button></aside>
      {batch&&<div className="outbound-detail">
        <header><div><h3>{batch.name}</h3><p>合格率 {batch.rate===null?"待统计":`${Math.round(batch.rate*100)}%`} · {batch.reviewed}/{batch.total} 条</p></div>
          {isOwner?<button className="button button-secondary" type="button" disabled={busy||workspaceBusy} onClick={()=>void act("release")} title="释放后其他审核员可领取">释放批次</button>:<button className="button button-primary" type="button" disabled={busy||workspaceBusy||Boolean(batch.claim)} onClick={()=>void act("claim")}>{busy?<LoaderCircle size={16} className="spin"/>:null}{batch.claim?"审核员处理中":"领取批次"}</button>}
        </header>
        {batch.recordings.length>0?<>

          {recording&&<section className="outbound-player" aria-label="原始视频审核">
            <div className="outbound-player-heading"><div><strong>{recording.name}</strong><span>{grouped.cameraCount} 路原始视频{grouped.parts.length>1?` · 共 ${grouped.parts.length} 段`:""}</span></div>
              {isOwner&&(!videoState||videoState.failed)&&<button className="button button-secondary" type="button" disabled={opening||workspaceBusy||!recording.videos.length} onClick={()=>void openVideos()}>{opening?<LoaderCircle size={16} className="spin"/>:<Play size={16}/>}打开原始视频</button>}
            </div>
            {grouped.parts.length>1&&<nav className="outbound-video-tabs" aria-label="视频分段">{grouped.parts.map((_,index)=><button key={index} type="button" aria-pressed={index===partIndex} disabled={!isOwner||opening||busy||workspaceBusy} onClick={()=>void openVideos(index)}>第 {grouped.partNumbers[index]+1} 段</button>)}</nav>}
            {missingCameras.length>0&&<p className="outbound-error" role="alert">本段缺少 {missingCameras.map(cameraName).join("、")} 的源文件，不能提交审核。其他分段仍可查看。</p>}
            {videoState?.recordingId===recording.id&&videoState.part===partIndex?<div className={`outbound-video-grid cameras-${grouped.cameraCount}`} style={{"--outbound-camera-columns":grouped.cameraCount>1?`minmax(0,2.2fr) repeat(${Math.ceil((grouped.cameraCount-1)/2)},minmax(0,1fr))`:"minmax(0,1fr)"} as CSSProperties}>{grouped.cameras.map(camera=>{
              const video=partVideos.find(item=>item.camera===camera);
              const primary=camera===grouped.primaryCamera;
              if(!video)return <article className={`outbound-video-item is-missing${primary?" is-primary":""}`} key={`${recording.id}:${camera}:missing`}><header><strong><Video size={13}/>{cameraName(camera)}</strong><span>本段缺失</span></header><div className="outbound-video-stage"><div className="outbound-video-loading">此相机没有本段源文件</div></div></article>;
              return <article className={`outbound-video-item${primary?" is-primary":""}`} key={`${recording.id}:${video.segment}`}>
              <header><strong><Video size={13}/>{cameraName(video.camera)}</strong><span>{videoState.ready.includes(video.segment)?"已就绪":"加载中"}</span><button type="button" className="outbound-expand" title="放大视频" aria-label={`放大${cameraName(video.camera)}`} disabled={!videoState.urls[video.segment]} onClick={()=>void players.current.get(video.segment)?.requestFullscreen().catch(()=>setError("无法进入全屏，请重试。"))}><Expand size={14}/></button></header>
              <div className="outbound-video-stage"><video ref={playerRefs.get(video.segment)} src={videoState.urls[video.segment]} aria-label={cameraName(video.camera)} playsInline muted={!primary||muted} preload="auto" onCanPlay={()=>markReady(video.segment)} onLoadedMetadata={updateClock} onError={()=>{playback.current?.pause();setVideoState(previous=>previous?{...previous,failed:true}:null);setError(`原始视频读取失败：${video.label}，请重新打开。`);}}/>{!videoState.ready.includes(video.segment)&&<div className="outbound-video-loading"><LoaderCircle size={20} className="spin"/><span>{videoState.urls[video.segment]?"正在缓冲":"正在连接"}</span></div>}</div>
            </article>;})}</div>:<div className="outbound-video-placeholder"><Video size={22}/><span>{opening?"正在读取原始视频…":isOwner?"打开后将并列读取本条录制的全部相机":"领取批次后查看原始视频"}</span></div>}
            <div className="outbound-transport" aria-label="回放控制"><button className="button outbound-play-button" type="button" aria-label={playing?"暂停":"全局播放"} disabled={!videosReady||busy||workspaceBusy||suspended} onClick={togglePlayback}>{playing?<Pause size={18}/>:<Play size={18}/>}</button><span className="outbound-time">{formatTime(position)}<span> / {formatTime(duration)}</span></span><input type="range" aria-label="视频播放位置" min={0} max={duration||1} step={0.01} value={Math.min(position,duration||1)} disabled={!videosReady||suspended} onChange={event=>seek(Number(event.target.value))}/><span className="outbound-playback-status" role="status">{buffering?<><LoaderCircle size={13} className="spin"/>正在缓冲</>:opening?`已就绪 ${videoState?.ready.length??0}/${partVideos.length}`:videosReady?"同步回放":"等待视频"}</span><button className="icon-button" type="button" title={muted?"开启主相机声音":"静音"} aria-label={muted?"开启主相机声音":"静音"} onClick={()=>setMuted(value=>!value)}>{muted?<VolumeX size={16}/>:<Volume2 size={16}/>}</button><select aria-label="播放速度" value={speed} onChange={event=>{const rate=Number(event.target.value);setSpeed(rate);playback.current?.setSpeed(rate);}}>{[.25,.5,1,2].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></div>
            <div className="outbound-decision"><span>{recording.decision?`已由 ${recording.decision.actor} 于 ${new Date(recording.decision.at).toLocaleString("zh-CN",{hour12:false})} 判为${recording.decision.value==="valid"?"有效":"无效"}${recording.decision.reason?` · ${recording.decision.reason}`:""}`:videosReady?"请根据完整原始视频判断数据有效性":"视频全部就绪后可提交结论"}</span>
              <button className="button button-primary outbound-valid-button" type="button" disabled={!isOwner||busy||workspaceBusy||!videosReady||Boolean(recording.decision)} onClick={()=>void act("decide","valid")}><CheckCircle2 size={16}/>有效数据</button>
              <button className="button button-secondary outbound-invalid-button" type="button" disabled={!isOwner||busy||workspaceBusy||!videosReady||Boolean(recording.decision)} onClick={()=>setReasonDialog(true)}><XCircle size={16}/>无效数据</button>
            </div>
          </section>}
        </>:<div className="outbound-empty">此批次没有可审核录制</div>}
      </div>}
    </div>}
    {reasonDialog&&<div className="outbound-dialog-backdrop" role="presentation"><section className="outbound-reason-dialog" role="dialog" aria-modal="true" aria-labelledby="outbound-reason-title"><header><div><h3 id="outbound-reason-title">选择无效原因</h3><p>原因将写入本条审核结论，供交付平台统计。</p></div><button className="icon-button" type="button" aria-label="关闭无效原因" onClick={()=>setReasonDialog(false)}><X size={18}/></button></header><div className="outbound-reason-options">{availableReasons.map(reason=><button type="button" key={reason} aria-pressed={selectedReason===reason} onClick={()=>setSelectedReason(reason)}>{selectedReason===reason?<Check size={15}/>:null}{reason}</button>)}</div><form onSubmit={event=>{event.preventDefault();void addReason();}}><label htmlFor="outbound-custom-reason">新增常用原因</label><div><input id="outbound-custom-reason" maxLength={80} value={customReason} disabled={busy} onChange={event=>setCustomReason(event.target.value)} placeholder="输入原因并保存"/><button className="button button-secondary" type="submit" disabled={busy||!customReason.trim()}><Save size={15}/>保存常用项</button></div></form><footer><button className="button button-secondary" type="button" disabled={busy} onClick={()=>setReasonDialog(false)}>取消</button><button className="button button-primary" type="button" disabled={busy||!selectedReason} onClick={()=>void act("decide","invalid",selectedReason)}>{busy?<LoaderCircle size={16} className="spin"/>:null}确认无效</button></footer></section></div>}
  </section>;
}

function formatTime(seconds:number){
  const value=Math.max(0,Math.floor(seconds));
  return `${Math.floor(value/60).toString().padStart(2,"0")}:${(value%60).toString().padStart(2,"0")}`;
}
function cameraName(camera:string){
  const names:Record<string,string>={cam0:"主相机",cam1:"相机 1",cam2:"相机 2",t265_left:"定位相机 · 左",t265_right:"定位相机 · 右",stereo_left:"扩展相机 · 左",stereo_right:"扩展相机 · 右",extension_left:"扩展相机 · 左",extension_right:"扩展相机 · 右"};
  return names[camera]??`相机 ${camera}`;
}
