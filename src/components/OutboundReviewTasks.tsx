import { localeTag, t, tr, useLanguage } from "../lib/i18n";
import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type VideoHTMLAttributes} from "react";
import {ArrowLeft,AlertTriangle,Check,CheckCircle2,ChevronRight,Expand,Film,LoaderCircle,Minimize,Pause,Play,RefreshCw,Save,Video,Volume2,VolumeX,X,XCircle} from "lucide-react";
import type {UserIdentity} from "../types";
import {changeOutboundBatch,fetchOutboundVideo,releaseOutboundVideos,outboundMediaFailure,listOutboundBatches,OUTBOUND_INVALID_REASONS,OUTBOUND_ANOMALOUS_REASONS,outboundError,outboundResultUncertain,outboundVideoParts,outboundTimeline,fetchOutboundMetadata,saveOutboundReasonOption,type OutboundBatch,type OutboundRecording,type OutboundProtocol,type OutboundDecisionValue} from "../lib/outbound-review";
import {OutboundVideoLoader} from "../lib/outbound-video-loader";
import {OutboundPlayback} from "../lib/outbound-playback";
import "./outbound-review.css";

interface Props {currentUser:UserIdentity;workspaceBusy?:boolean;view?:"tasks"|"workspace";initialBatch?:OutboundBatch;onOpenReview?:(batch:OutboundBatch,isCurrent?:()=>boolean)=>Promise<void>;onReturnToTasks?:()=>void;suspended?:boolean}
type TaskAction="claim"|"release"|"open"|"verify";
type TaskFeedback={error:boolean;message:string};
type TimelineState={recordingId:string;source?:OutboundRecording["videos"];durations:Record<number,number>;failed:Record<number,string>};
type TicketResult={url:string;duration?:number};
type VideoState={recordingId:string;part:number;urls:Record<number,string>;ready:number[];failed:Record<number,string>};

// Playback publishes its clock frequently. The recording queue only changes
// when selection, authority or a saved decision changes.
const RecordingList=memo(function RecordingList({recordings,selectedId,disabled,onSelect}:{recordings:OutboundRecording[];selectedId:string;disabled:boolean;onSelect:(id:string)=>void}){
  useLanguage();
  return <nav className="outbound-recordings" aria-label={t("录制列表")}>{recordings.map((item,index)=><button type="button" key={item.id} className={item.id===selectedId?"selected":""} aria-label={t("{0} {1}", [item.name || t("录制 {0}", [index+1]), item.decision?.value==="valid" ? t("有效") : item.decision?.value==="invalid" ? t("无效") : item.decision?.value==="anomalous" ? t("异常") : t("待审")])} aria-pressed={item.id===selectedId} disabled={disabled} onClick={()=>onSelect(item.id)}><span className="outbound-recording-number">{tr(String(index+1).padStart(2,"0"))}</span><span className="outbound-recording-label" title={item.name}>{item.name || t("录制 {0}", [index+1])}</span><strong className={item.decision?.value??""}>{item.decision?.value==="valid" ? <><CheckCircle2 size={12}/>{t("有效")}</> : item.decision?.value==="invalid" ? <><XCircle size={12}/>{t("无效")}</> : item.decision?.value==="anomalous" ? <><AlertTriangle size={12}/>{t("异常")}</> : t("待审")}</strong><ChevronRight className="outbound-recording-arrow" size={14}/></button>)}</nav>;
});

// A detached media element can keep its network loader and decoder alive until
// WebView2 collects it. Release them at the actual element lifetime boundary.
function ReviewVideo({segment,onAttach,src,...props}:VideoHTMLAttributes<HTMLVideoElement>&{segment:number;onAttach:(segment:number,player:HTMLVideoElement|null)=>void}){
  const element=useRef<HTMLVideoElement>(null);
  useLayoutEffect(()=>{
    const player=element.current!;
    if(src){player.src=src;onAttach(segment,player);player.load();}
    return()=>{
      onAttach(segment,null);
      player.pause();
      player.removeAttribute("src");
      player.load();
    };
  },[segment,src,onAttach]);
  return <video ref={element} {...props}/>;
}

export function OutboundReviewTasks(props:Props){
  useLanguage();
  const {currentUser,view="tasks"}=props;
  return <OutboundReviewSession key={`${currentUser.username}:${currentUser.role}:${Boolean(currentUser.canManage)}:${view}`} {...props}/>;
}

function OutboundReviewSession({currentUser,workspaceBusy=false,view="tasks",initialBatch,onOpenReview,onReturnToTasks,suspended=false}:Props){
  useLanguage();
  const [batches,setBatches]=useState<OutboundBatch[]>(initialBatch?[initialBatch]:[]);
  const [anomalousReasonOptions,setAnomalousReasonOptions]=useState<string[]>(initialBatch?.anomalousReasonOptions??[]);
  const [reasonOptions,setReasonOptions]=useState<string[]>(initialBatch?.reasonOptions??[]);
  const [batchId,setBatchId]=useState(initialBatch?.id??"");
  const [recordingId,setRecordingId]=useState(initialBatch?.recordings.find(item=>!item.decision)?.id??initialBatch?.recordings[0]?.id??"");
  const [videoState,setVideoState]=useState<VideoState|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const protocol=useMemo<OutboundProtocol>(()=>({}),[currentUser.username,currentUser.role,currentUser.canManage]);
  const [pendingTasks,setPendingTasks]=useState<Record<string,TaskAction>>({});
  const [taskFeedback,setTaskFeedback]=useState<Record<string,TaskFeedback>>({});
  const pendingTaskIds=useRef(new Set<string>());
  const taskEpoch=useRef(0),openIntent=useRef(0);
  useEffect(()=>{const ids=pendingTaskIds.current;taskEpoch.current++;return()=>{taskEpoch.current++;openIntent.current++;ids.clear();};},[view,currentUser.username]);
  const listGeneration=useRef(0);
  const listActive=useRef(false);
  const [lastUpdated,setLastUpdated]=useState<number|null>(null);
  const [opening,setOpening]=useState(false);
  const [partIndex,setPartIndex]=useState(0);
  const [timelineState,setTimelineState]=useState<TimelineState>({recordingId:"",durations:{},failed:{}});
  const pendingStart=useRef<{part:number;position:number;resume:boolean}|null>(null);
  const ended=useRef(()=>{});
  const [playing,setPlaying]=useState(false);
  const [transitionIntent,setTransitionIntent]=useState(false);
  const [position,setPosition]=useState(0);

  const [speed,setSpeed]=useState(1);
  const [buffering,setBuffering]=useState(false);
  const [muted,setMuted]=useState(true);
  const [primaryFilled,setPrimaryFilled]=useState(true);
  const [fullscreenCamera,setFullscreenCamera]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [reasonDialog,setReasonDialog]=useState<"invalid"|"anomalous"|null>(null);
  const [selectedReason,setSelectedReason]=useState("");
  const [customReason,setCustomReason]=useState("");
  const [notice,setNotice]=useState("");
  const [unconfirmed,setUnconfirmed]=useState<Record<string,"claim"|"release">>({});
  const [workspaceUnconfirmed,setWorkspaceUnconfirmed]=useState(false);
  const players=useRef(new Map<number,HTMLVideoElement>());
  const retryPositions=useRef(new Map<number,number>());
  const playback=useRef<OutboundPlayback|null>(null);
  const requestGeneration=useRef(0);
  const ticketLoader=useMemo(()=>new OutboundVideoLoader<(typeof partVideos)[number],TicketResult>(result=>{void releaseOutboundVideos([result.url]);}),[]);
  const mediaUrls=useRef(new Set<string>());
  const releaseVideos=useCallback(()=>{ticketLoader.cancel();void releaseOutboundVideos([...mediaUrls.current]);mediaUrls.current.clear();},[ticketLoader]);
  const batch=batches.find(value=>value.id===batchId)??null;
  const recording=batch?.recordings.find(value=>value.id===recordingId)??batch?.recordings[0]??null;
  const isOwner=batch?.claim===currentUser.username;
  const grouped=useMemo(()=>outboundVideoParts(recording?.videos??[]),[recording?.videos]);
  const partVideos=grouped.parts[partIndex]??[];
  const measured=timelineState.recordingId===recording?.id&&timelineState.source===recording?.videos?timelineState.durations:{};
  const sourceFailures=timelineState.recordingId===recording?.id&&timelineState.source===recording?.videos?timelineState.failed:{};
  const timeline=useMemo(()=>outboundTimeline(grouped.parts,measured),[grouped,measured]);
  const partOffset=timeline.spans[partIndex]?.offset??0;
  const fullPosition=partOffset+position;
  const fullDuration=timeline.complete?timeline.duration:0;
  const missingSequence=grouped.partNumbers.some((part,index)=>part!==grouped.partNumbers[0]+index);
  const missingSource=missingSequence||grouped.parts.some(files=>grouped.cameras.some(camera=>!files.some(file=>file.camera===camera)));
  const playbackReady=Boolean(recording&&videoState?.recordingId===recording.id&&videoState.part===partIndex&&!Object.keys(videoState.failed).length&&partVideos.length>0&&partVideos.every(video=>videoState.urls[video.segment]&&videoState.ready.includes(video.segment)));
  const hasVideoFailures=Boolean(Object.keys(sourceFailures).length||videoState&&Object.keys(videoState.failed).length);
  const videosReady=playbackReady&&!missingSource&&timeline.complete&&!Object.keys(sourceFailures).length;
  const availableReasons=useMemo(()=>[...new Set(reasonDialog==="anomalous"?[...OUTBOUND_ANOMALOUS_REASONS,...anomalousReasonOptions]:[...OUTBOUND_INVALID_REASONS,...reasonOptions])],[reasonDialog,reasonOptions,anomalousReasonOptions]);
  const attachPlayer=useCallback((segment:number,element:HTMLVideoElement|null)=>{
    if(element)players.current.set(segment,element);else players.current.delete(segment);
    playback.current?.attach(segment,element);
  },[]);
  useEffect(()=>{
    const changed=()=>setFullscreenCamera(document.fullscreenElement?.getAttribute("data-outbound-camera")??null);
    document.addEventListener("fullscreenchange",changed);
    return()=>document.removeEventListener("fullscreenchange",changed);
  },[]);
  useEffect(()=>{
    const transport=new OutboundPlayback(state=>{
      setPlaying(state.playing);setBuffering(state.buffering);setPosition(state.position);
    },()=>setError("视频播放失败，请重新打开。"),()=>ended.current());
    playback.current=transport;
    for(const [id,player] of players.current)transport.attach(id,player);
    return()=>{transport.dispose();playback.current=null;};
  },[]);


  async function load(background=false){
    if(listActive.current||busyRef.current||pendingTaskIds.current.size||background&&(document.hidden||workspaceBusy))return;
    listActive.current=true;
    const generation=++listGeneration.current;
    if(!background)setLoading(true);
    try{
      const value=await listOutboundBatches(view==="workspace"?batchId:undefined,protocol);
      if(generation!==listGeneration.current)return;
      setBatches(value.batches);
      setReasonOptions(value.reasonOptions??[]);
      setAnomalousReasonOptions(value.anomalousReasonOptions??[]);
      setUnconfirmed(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!value.batches.some(item=>item.id===id))));
      setBatchId(previous=>value.batches.some(item=>item.id===previous)?previous:value.batches[0]?.id??"");
      setLastUpdated(Date.now());setError("");
      setWorkspaceUnconfirmed(false);
    }catch(cause){if(generation===listGeneration.current)setError(outboundError(cause));}
    finally{listActive.current=false;if(generation===listGeneration.current)setLoading(false);}
  }
  const loadLatest=useRef(load);loadLatest.current=load;
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){await loadLatest.current(true);if(active)timer=setTimeout(()=>void refresh(),5000);}
    const focus=()=>{if(!document.hidden)void loadLatest.current(true);};
    if(view==="tasks"){
      void loadLatest.current().finally(()=>{if(active)timer=setTimeout(()=>void refresh(),5000);});
      document.addEventListener("visibilitychange",focus);window.addEventListener("focus",focus);
    }else setLoading(false);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener("visibilitychange",focus);window.removeEventListener("focus",focus);requestGeneration.current++;listGeneration.current++;};
  },[view]);
  useEffect(()=>{
    if(!batch){setRecordingId("");setVideoState(null);return;}
    setRecordingId(previous=>batch.recordings.some(item=>item.id===previous)?previous:batch.recordings[0]?.id??"");
    requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(null);
  },[batch?.id]);
  useEffect(()=>{requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);pendingStart.current=null;setTransitionIntent(false);setTimelineState({recordingId,source:recording?.videos,durations:{},failed:{}});setReasonDialog(null);setError("");},[recordingId,recording?.videos]);

  useEffect(()=>{
    if(view==="workspace"&&recording&&isOwner&&!suspended)void openVideos(0);
    return()=>{requestGeneration.current++;ticketLoader.cancel();playback.current?.pause();releaseVideos();};
  },[view,batch?.id,recording?.id,recording?.videos,isOwner,suspended]);
  useEffect(()=>{if(suspended)playback.current?.pause();},[suspended]);
  useEffect(()=>{playback.current?.setMaster(partVideos.find(video=>video.camera===grouped.primaryCamera)?.segment??null);},[partVideos,grouped.primaryCamera]);
  ended.current=()=>{if(partIndex+1<grouped.parts.length)void openVideos(partIndex+1,0,true);};
  useEffect(()=>{
    const pending=pendingStart.current;
    if(!pending||pending.part!==partIndex||!playbackReady)return;
    pendingStart.current=null;setTransitionIntent(false);
    playback.current?.seek(pending.position);
    if(pending.resume&&!suspended)playback.current?.play();
  },[partIndex,playbackReady,suspended]);
  function rememberDuration(segment:number,value:number){
    if(!recording||!Number.isFinite(value)||value<=0)return;
    setTimelineState(previous=>{
      const base=previous.recordingId===recording.id&&previous.source===recording.videos?previous:{recordingId:recording.id,source:recording.videos,durations:{},failed:{}};
      const failed={...base.failed};delete failed[segment];
      return {...base,durations:{...base.durations,[segment]:value},failed};
    });
  }


  function updateBatch(next:OutboundBatch){
    setBatches(previous=>previous.map(value=>value.id===next.id?next:value));
  }
  function chooseReason(value:"invalid"|"anomalous"){
    const options=value==="anomalous"?[...OUTBOUND_ANOMALOUS_REASONS,...anomalousReasonOptions]:[...OUTBOUND_INVALID_REASONS,...reasonOptions];
    const previous=recording?.decision?.value===value?recording.decision.reason??"":"";
    setSelectedReason(options.includes(previous)?previous:"");
    setCustomReason("");setReasonDialog(value);
  }
  async function act(action:"claim"|"release"|"decide",value?:OutboundDecisionValue,reason?:string){
    if(!batch||busyRef.current||workspaceUnconfirmed)return;
    if(action==="decide"&&(!recording||!isOwner||!videosReady))return;
    if(action==="decide"&&recording?.decision&&recording.decision.value===value&&(value==="valid"||recording.decision.reason===reason))return;
    busyRef.current=true;setBusy(true);setError("");setNotice("");
    try{
      const result=await changeOutboundBatch(batch,action,action==="decide"?recording?.id:undefined,value,reason,protocol);
      updateBatch(result.batch);
      if(action==="claim"){setNotice("已领取批次。");if(onOpenReview)await onOpenReview(result.batch);}
      if(action==="release"){setNotice("已释放批次。");if(view==="workspace")onReturnToTasks?.();}
      if(action==="decide"){
        const revising=Boolean(recording?.decision);
        setReasonDialog(null);setSelectedReason("");setCustomReason("");setNotice(revising?"审核结论修改已保存。":"审核结论已保存。");
        const next=result.batch.recordings.find(item=>!item.decision);
        if(next&&!recording?.decision)setRecordingId(next.id);
      }
    }catch(cause){
      if(outboundResultUncertain(cause)){
        setWorkspaceUnconfirmed(true);
        setNotice("提交结果尚未确认，正在核对当前批次…");
        try{
          const fresh=(await listOutboundBatches(batch.id,protocol)).batches.find(item=>item.id===batch.id);
          if(!fresh)throw new Error("OUTBOUND_BATCH_NOT_FOUND");
          updateBatch(fresh);
          setWorkspaceUnconfirmed(false);
          const saved=fresh.recordings.find(item=>item.id===recording?.id)?.decision;
          if(action==="decide"&&saved&&saved.value===value&&saved.actor===currentUser.username&&(value==="valid"||saved.reason===reason)){
            setReasonDialog(null);setSelectedReason("");setCustomReason("");setNotice("已核对：审核结论已保存。");
            const next=fresh.recordings.find(item=>!item.decision);
            if(next&&!recording?.decision)setRecordingId(next.id);
            return;
          }
          if(action==="release"&&!fresh.claim){setNotice("已核对：批次已释放。");onReturnToTasks?.();return;}
        }catch{/* Do not replay a mutation whose result is unknown. */}
        setNotice("");setError("提交结果尚未确认，请刷新当前批次核对后再操作。"+outboundError(cause));
      }else setError(outboundError(cause));
    }
    finally{busyRef.current=false;setBusy(false);}
  }
  async function openVideos(nextPart=partIndex,target=0,resume=false){
    if(!batch||!recording||!isOwner)return;
    const generation=++requestGeneration.current;retryPositions.current.clear();
    const files=grouped.parts[nextPart]??[];
    playback.current?.pause();setPosition(target);
    pendingStart.current={part:nextPart,position:target,resume};setTransitionIntent(resume);
    setPartIndex(nextPart);setVideoState({recordingId:recording.id,part:nextPart,urls:{},ready:[],failed:{}});setOpening(Boolean(files.length));setError("");setNotice("");
    releaseVideos();
    const active=new Set(files.map(file=>file.segment));let remaining=files.length;
    // Current cameras get tickets first. Other parts only read their MP4 clock,
    // in the same four-request budget, with no hidden video/decoder per file.
    const probes=grouped.parts.flat().filter(file=>!active.has(file.segment)&&(!measured[file.segment]||sourceFailures[file.segment]));
    const settled=(file:typeof files[number])=>{if(active.has(file.segment)&&--remaining===0)setOpening(false);};
    ticketLoader.replace([...files,...probes],async video=>{
      const url=await fetchOutboundVideo(batch,recording,video.segment);
      if(generation!==requestGeneration.current){void releaseOutboundVideos([url]);throw new Error("OUTBOUND_CANCELLED");}
      mediaUrls.current.add(url);
      if(active.has(video.segment))return {url};
      try{return {url,duration:(await fetchOutboundMetadata(url)).duration};}
      catch(error){mediaUrls.current.delete(url);void releaseOutboundVideos([url]);throw error;}
    },(video,result)=>{
      if(active.has(video.segment)){
        mediaUrls.current.add(result.url);
        setVideoState(previous=>previous?{...previous,urls:{...previous.urls,[video.segment]:result.url}}:previous);
      }else{rememberDuration(video.segment,result.duration!);mediaUrls.current.delete(result.url);void releaseOutboundVideos([result.url]);}
      settled(video);
    },(video,cause)=>{
      const message=outboundError(cause);
      if(active.has(video.segment))setVideoState(previous=>previous?{...previous,failed:{...previous.failed,[video.segment]:message}}:previous);
      setTimelineState(previous=>({...previous,recordingId:recording.id,source:recording.videos,failed:{...previous.failed,[video.segment]:message}}));
      settled(video);
    },()=>{if(generation===requestGeneration.current)setOpening(false);});
  }

  function mediaFailed(segment:number,label:string,player:HTMLVideoElement){
    if(players.current.get(segment)!==player)return;
    // Abort is expected when the user changes recordings or parts.
    if(player.error?.code===1)return;
    const reason=player.error?.code===2?"网络读取中断":player.error?.code===3?"视频解码失败":player.error?.code===4?"视频格式不受支持或服务响应异常":"视频资源加载失败";
    pendingStart.current=null;setTransitionIntent(false);playback.current?.pause();
    setTimelineState(previous=>({...previous,failed:{...previous.failed,[segment]:reason}}));
    setVideoState(previous=>previous?{...previous,ready:previous.ready.filter(id=>id!==segment),failed:{...previous.failed,[segment]:`${label}：${reason}，可重试失败视频。`}}:previous);
    const generation=requestGeneration.current,source=player.getAttribute("src");
    if(source)void outboundMediaFailure(source).then(message=>{
      if(!message||generation!==requestGeneration.current||players.current.get(segment)!==player||player.getAttribute("src")!==source||!player.error)return;
      setVideoState(previous=>previous&&previous.failed[segment]?{...previous,failed:{...previous.failed,[segment]:`${label}：${message}`}}:previous);
    });
  }
  async function retryFailedVideos(){
    if(!batch||!recording||!videoState||opening||!isOwner)return;
    const generation=++requestGeneration.current;
    const failed=new Set(Object.keys(videoState.failed).map(Number));
    const target=players.current.get(partVideos.find(video=>video.camera===grouped.primaryCamera)?.segment??-1)?.currentTime??position;
    pendingStart.current=null;setTransitionIntent(false);playback.current?.pause();setOpening(true);
    ticketLoader.cancel();
    const live=new Set(Object.values(videoState.urls));
    const retired=[...mediaUrls.current].filter(url=>!live.has(url));
    for(const url of retired)mediaUrls.current.delete(url);
    void releaseOutboundVideos(retired);
    const files=partVideos.filter(video=>failed.has(video.segment));
    const current=new Set(partVideos.map(video=>video.segment));
    const probes=grouped.parts.flat().filter(video=>!current.has(video.segment)&&(!measured[video.segment]||sourceFailures[video.segment]));
    ticketLoader.replace([...files,...probes],async video=>{
      const url=await fetchOutboundVideo(batch,recording,video.segment);
      if(generation!==requestGeneration.current){void releaseOutboundVideos([url]);throw new Error("OUTBOUND_CANCELLED");}
      mediaUrls.current.add(url);
      if(current.has(video.segment))return {url};
      try{return {url,duration:(await fetchOutboundMetadata(url)).duration};}
      catch(error){mediaUrls.current.delete(url);void releaseOutboundVideos([url]);throw error;}
    },(video,result)=>{
      if(current.has(video.segment)){
        const old=videoState.urls[video.segment];if(old&&old!==result.url){mediaUrls.current.delete(old);void releaseOutboundVideos([old]);}
        retryPositions.current.set(video.segment,target);
        setVideoState(previous=>previous?{...previous,urls:{...previous.urls,[video.segment]:result.url}}:previous);
        requestAnimationFrame(()=>{if(generation===requestGeneration.current)players.current.get(video.segment)?.load();});
      }else{rememberDuration(video.segment,result.duration!);mediaUrls.current.delete(result.url);void releaseOutboundVideos([result.url]);}
    },(video,cause)=>{
      const message=outboundError(cause);
      if(current.has(video.segment))setVideoState(previous=>previous?{...previous,failed:{...previous.failed,[video.segment]:message}}:previous);
      setTimelineState(previous=>({...previous,failed:{...previous.failed,[video.segment]:message}}));
    },()=>{if(generation===requestGeneration.current)setOpening(false);});
  }
  function updateClock(){playback.current?.refresh();}
  function seek(value:number){
    if(!timeline.complete)return;
    const target=Math.max(0,Math.min(value,timeline.duration));
    const index=timeline.spans.findIndex((span,i)=>target<span.offset+span.duration||i===timeline.spans.length-1);
    const local=target-timeline.spans[index].offset;
    if(index===partIndex){pendingStart.current=null;playback.current?.seek(local);}
    else void openVideos(index,local,playing||transitionIntent);
  }
  function togglePlayback(){
    if(playing||transitionIntent){if(pendingStart.current)pendingStart.current.resume=false;setTransitionIntent(false);playback.current?.pause();}
    else if(fullDuration>0&&fullPosition>=fullDuration-.05)void openVideos(0,0,true);
    else playback.current?.play();
  }
  function markReady(segment:number){
    const player=players.current.get(segment);if(player&&!player.error&&player.readyState>=3)rememberDuration(segment,player.duration);
    updateClock();
    setVideoState(previous=>{
      if(!previous||previous.recordingId!==recording?.id||previous.part!==partIndex)return previous;
      const player=players.current.get(segment);if(!player||player.error||player.readyState<3)return previous;
      const failed={...previous.failed};delete failed[segment];
      return {...previous,failed,ready:previous.ready.includes(segment)?previous.ready:[...previous.ready,segment]};
    });
  }
  async function taskAction(item:OutboundBatch,action:TaskAction){
    if(pendingTaskIds.current.has(item.id)||workspaceBusy)return;
    const original=action==="verify"?unconfirmed[item.id]:action;
    if(!original)return;
    const epoch=taskEpoch.current;
    const intent=original==="claim"||original==="open"?++openIntent.current:0;
    const current=()=>epoch===taskEpoch.current;
    const feedback=(message:string,error=false)=>{if(current())setTaskFeedback(previous=>({...previous,[item.id]:{message,error}}));};
    const canOpen=()=>current()&&intent===openIntent.current;
    const open=async(detail:OutboundBatch)=>{if(canOpen())await onOpenReview?.({...detail,reasonOptions,anomalousReasonOptions},canOpen);};
    pendingTaskIds.current.add(item.id);++listGeneration.current;setLoading(false);
    setPendingTasks(previous=>({...previous,[item.id]:action}));
    setTaskFeedback(previous=>{const next={...previous};delete next[item.id];return next;});
    try{
      if(action==="verify"){await verifyTaskResult(item,original as "claim"|"release",current,feedback,open);return;}
      if(action==="open"){
        const detail=item.recordings.length?item:(await listOutboundBatches(item.id,protocol)).batches.find(value=>value.id===item.id);
        if(!detail)throw new Error("OUTBOUND_BATCH_NOT_FOUND");
        await open(detail);return;
      }
      const result=await changeOutboundBatch(item,action,undefined,undefined,undefined,protocol);
      if(!current())return;
      updateBatch(result.batch);feedback(action==="claim"?"已领取，可打开审核。":"已释放批次。");
      if(action==="claim")await open(result.batch);
    }catch(cause){
      if(!current())return;
      if(action!=="open"&&action!=="verify"&&outboundResultUncertain(cause)){
        setUnconfirmed(previous=>({...previous,[item.id]:action}));
        await verifyTaskResult(item,action,current,feedback,open);
      }else feedback(outboundError(cause),true);
    }
    finally{if(current()){pendingTaskIds.current.delete(item.id);setPendingTasks(previous=>{const next={...previous};delete next[item.id];return next;});}}
  }
  async function verifyTaskResult(item:OutboundBatch,action:"claim"|"release",current:()=>boolean,feedback:(message:string,error?:boolean)=>void,open:(batch:OutboundBatch)=>Promise<void>){
    feedback("提交结果尚未确认，正在核对当前批次…");setPendingTasks(previous=>({...previous,[item.id]:"verify"}));
    let fresh:OutboundBatch|undefined;
    try{fresh=(await listOutboundBatches(item.id,protocol)).batches.find(value=>value.id===item.id);if(!fresh)throw new Error("OUTBOUND_BATCH_NOT_FOUND");}
    catch(cause){feedback("批次操作结果尚未确认，请点击“核对结果”后再操作。"+outboundError(cause),true);return;}
    if(!current())return;
    updateBatch(fresh);setUnconfirmed(previous=>{const next={...previous};delete next[item.id];return next;});
    if(action==="claim"&&fresh.claim===currentUser.username){
      feedback("已核对：批次已由你领取。");
      try{await open(fresh);}catch(cause){feedback("批次已领取，打开审核失败。"+outboundError(cause),true);}
    }else if(action==="release"&&!fresh.claim)feedback("已核对：批次已释放。");
    else feedback(fresh.claim?"已核对：批次当前由其他审核员领取，请刷新查看。":"已核对：批次尚未领取，可以重新领取。",true);
  }
  async function addReason(){
    const value=customReason.trim();
    if(!value||!reasonDialog||busyRef.current)return;
    busyRef.current=true;setBusy(true);setError("");
    try{
      const result=await saveOutboundReasonOption(value,reasonDialog);
      if(reasonDialog==="anomalous")setAnomalousReasonOptions(result.reasonOptions);else setReasonOptions(result.reasonOptions);
      setSelectedReason(value);setCustomReason("");setNotice("已保存为常用审核原因。");
    }catch(cause){setError(outboundError(cause));}
    finally{busyRef.current=false;setBusy(false);}
  }

  const recordingList=batch?<RecordingList recordings={batch.recordings} selectedId={recording?.id??""} disabled={busy||workspaceBusy} onSelect={setRecordingId}/>:null;
  if(view==="tasks")return <section className="outbound-review" aria-label={t("外发审核任务")}>
    <div className="outbound-toolbar"><strong>{t("外发审核")}</strong><span>{lastUpdated ? t("自动同步 · {0}", [tr(new Date(lastUpdated).toLocaleTimeString(localeTag(),{hour12:false}))]) : t("按交付批次领取任务")}</span><button className="button button-secondary" type="button" aria-label={t("刷新外发批次")} disabled={loading||Object.keys(pendingTasks).length>0||workspaceBusy} onClick={()=>void load()}><RefreshCw size={16}/></button></div>
    {tr(error&&<div className="outbound-error" role="alert">{tr(error)}</div>)}
    {tr(notice&&<div className="outbound-notice" role="status">{tr(notice)}</div>)}
    {loading&&!batches.length ? <div className="outbound-empty">{t("正在读取交付批次…")}</div> : !batches.length ? <div className="outbound-empty">{error ? t("批次读取失败，将自动重试，也可点击刷新。") : t("暂无可审核的星炬批次")}</div> : <div className="outbound-task-list">{batches.map(item=><article key={item.id} aria-busy={Boolean(pendingTasks[item.id])}><div><strong>{item.name}</strong><p>{t("已审") + " "}{item.reviewed}/{item.total}{" " + t("· 有效") + " "}{item.valid}{" " + t("· 无效") + " "}{item.invalid}{" · " + t("异常") + " "}{item.anomalous??0}{item.rate===null ? "" : t(" · 合格率 {0}%", [Math.round(item.rate*100)])}</p><small>{item.claim ? t("由 {0} 领取", [item.claim]) : t("未领取")}</small>{taskFeedback[item.id]&&<p className={taskFeedback[item.id].error?"outbound-task-error":"outbound-task-feedback"} role={taskFeedback[item.id].error?"alert":"status"}>{tr(taskFeedback[item.id].message)}</p>}</div><div className="outbound-task-actions">{unconfirmed[item.id] ? <button className="button button-secondary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy} onClick={()=>void taskAction(item,"verify")}>{pendingTasks[item.id]==="verify" ? <LoaderCircle size={16} className="spin"/> : null}{t("核对结果")}</button> : item.claim===currentUser.username ? <><button className="button button-secondary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy} onClick={()=>void taskAction(item,"release")}>{pendingTasks[item.id]==="release" ? <LoaderCircle size={16} className="spin"/> : null}{t("释放批次")}</button><button className="button button-primary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"open")}>{pendingTasks[item.id]==="open" ? <LoaderCircle size={16} className="spin"/> : null}{t("打开审核")}</button></> : <button className="button button-primary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy||Boolean(item.claim)||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"claim")}>{pendingTasks[item.id]==="claim" ? <LoaderCircle size={16} className="spin"/> : null}{item.claim ? t("审核员处理中") : t("领取并打开")}</button>}</div></article>)}</div>}
  </section>;
  return <section className="outbound-review is-workspace" aria-label={t("外发审核工作区")}>
    <div className="outbound-toolbar"><strong><Film size={17}/>{t("外发审核")}</strong><div className="outbound-progress"><span>{t("已审") + " "}<b>{batch?.reviewed ?? 0}</b> / {batch?.total ?? 0}</span><progress aria-label={t("批次审核进度")} max={batch?.total||1} value={batch?.reviewed??0}/><span>{t("有效") + " "}{batch?.valid ?? 0}{" " + t("· 无效") + " "}{batch?.invalid ?? 0}{" · " + t("异常") + " "}{batch?.anomalous??0}</span></div><button className="button button-secondary" type="button" aria-label={t("刷新外发批次")} title={t("刷新外发批次")} disabled={loading||busy||workspaceBusy} onClick={()=>void load()}>{loading ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>}</button></div>
    {tr(error&&<div className="outbound-error" role="alert">{tr(error)}</div>)}{videoState&&Object.keys(videoState.failed).length>0&&<div className="outbound-error" role="alert">{[...new Set(Object.values(videoState.failed))].map(localizedVideoFailure).join("；")}</div>}{tr(notice&&<div className="outbound-notice" role="status">{tr(notice)}</div>)}
    {loading&&!batches.length ? <div className="outbound-empty"><LoaderCircle size={18} className="spin"/>{t("正在读取交付批次…")}</div> : !batches.length ? <div className="outbound-empty">{error ? t("批次读取失败，将自动重试，也可点击刷新。") : t("暂无可审核的星炬批次")}</div> : <div className="outbound-layout">
      <aside className="outbound-recording-sidebar"><header><strong>{t("录制列表")}</strong><span>{batch?.total ?? 0}{" " + t("条")}</span></header>{recordingList}<button className="button button-secondary" disabled={busy||workspaceBusy} onClick={onReturnToTasks}><ArrowLeft size={15}/>{t("返回任务中心")}</button></aside>
      {batch&&<div className="outbound-detail">
        <header><div><h3>{batch.name}</h3><p>{t("合格率") + " "}{batch.rate===null ? t("待统计") : t("{0}%", [Math.round(batch.rate*100)])} · {batch.reviewed}/{batch.total}{" " + t("条")}</p></div>
          {isOwner ? <button className="button button-secondary" type="button" disabled={busy||workspaceBusy||workspaceUnconfirmed} onClick={()=>void act("release")} title={t("释放后其他审核员可领取")}>{t("释放批次")}</button> : <button className="button button-primary" type="button" disabled={busy||workspaceBusy||Boolean(batch.claim)} onClick={()=>void act("claim")}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{batch.claim ? t("审核员处理中") : t("领取批次")}</button>}
        </header>
        {batch.recordings.length>0 ? <>

          {recording&&<section className="outbound-player" aria-label={t("原始视频审核")}>
            <div className="outbound-player-heading"><div><strong>{recording.name}</strong><span>{grouped.cameraCount}{" " + t("路原始视频")}{grouped.parts.length>1 ? t(" · 共 {0} 段", [grouped.parts.length]) : ""}</span></div>
              {isOwner&&(!videoState||hasVideoFailures)&&<button className="button button-secondary" type="button" disabled={opening||workspaceBusy||!recording.videos.length} onClick={()=>void (videoState&&hasVideoFailures?retryFailedVideos():openVideos(partIndex,position))}>{opening ? <LoaderCircle size={16} className="spin"/> : <Play size={16}/>}{videoState&&hasVideoFailures ? t("重试失败视频") : t("打开原始视频")}</button>}
            </div>
            {missingSource&&<p className="outbound-error" role="alert">{t("录制存在缺失相机或分段，不能提交审核。仍可查看已有视频。")}{missingSequence&&t("分段序号不连续，缺失区间的时长未知。")}</p>}
            {Object.keys(sourceFailures).length>0&&<div className="outbound-source-issues" role="alert">{t("以下视频读取失败，请重试或查看对应位置：")}{grouped.parts.map((files,index)=>files.some(file=>sourceFailures[file.segment])&&<button type="button" key={index} disabled={opening||busy||workspaceBusy} onClick={()=>void openVideos(index)}>{t("查看第 {0} 段",[grouped.partNumbers[index]+1])}</button>)}</div>}
            <div className={`outbound-video-grid cameras-${grouped.cameraCount}`} style={{"--outbound-camera-columns":`minmax(0,3.2fr) repeat(${Math.ceil((grouped.cameraCount-1)/2)},minmax(0,1fr))`} as CSSProperties}>{grouped.cameras.map((camera,cameraIndex)=>{
              const video=partVideos.find(item=>item.camera===camera);
              const primary=camera===grouped.primaryCamera;
              const state=videoState?.recordingId===recording.id&&videoState.part===partIndex?videoState:null;
              const ready=Boolean(video&&state?.ready.includes(video.segment));
              const failure=video&&(state?.failed[video.segment]||sourceFailures[video.segment]);
              const otherIssue=grouped.parts.some(files=>!files.some(file=>file.camera===camera)||files.some(file=>file.camera===camera&&sourceFailures[file.segment]));
              return <article className={`outbound-video-item${!video?" is-missing":""}${failure?" is-failed":""}${primary?` is-primary${primaryFilled?" is-filled":""}`:""}`} data-outbound-camera={camera} key={`${recording.id}:${camera}`}>
              <header><strong><Video size={13}/>{tr(cameraName(camera))}</strong><span>{!video ? t("源文件缺失") : failure ? t("读取失败") : ready ? t("已就绪") : t("加载中")}</span>{primary&&<button type="button" className="outbound-fit" aria-label={primaryFilled ? t("主相机显示完整画面") : t("主相机铺满画面")} title={primaryFilled ? t("当前铺满显示，边缘可能裁切；切换为完整画面") : t("当前显示完整画面；切换为铺满显示")} onClick={()=>setPrimaryFilled(value=>!value)}>{primaryFilled ? t("完整画面") : t("铺满画面")}</button>}<button type="button" className="outbound-expand" title={fullscreenCamera===camera ? t("退出全屏") : t("放大视频")} aria-label={fullscreenCamera===camera ? t("退出{0}全屏", [tr(cameraName(camera))]) : t("放大{0}", [tr(cameraName(camera))])} disabled={!video||!state?.urls[video.segment]} onClick={event=>{const item=event.currentTarget.closest("article");const change=document.fullscreenElement===item?document.exitFullscreen():item?.requestFullscreen();void change?.catch(()=>setError("无法切换全屏，请重试。"));}}>{fullscreenCamera===camera ? <Minimize size={14}/> : <Expand size={14}/>}</button></header>
              <div className="outbound-video-stage"><ReviewVideo segment={video?.segment??-cameraIndex-1} onAttach={attachPlayer} src={video?state?.urls[video.segment]:undefined} aria-label={tr(cameraName(camera))} playsInline muted={!primary||muted} preload="auto" onCanPlay={()=>{if(video)markReady(video.segment);}} onLoadedMetadata={event=>{
                if(!video)return;
                const player=event.currentTarget,target=retryPositions.current.get(video.segment);
                if(target!==undefined){player.currentTime=target;retryPositions.current.delete(video.segment);}
                rememberDuration(video.segment,player.duration);updateClock();
              }} onError={event=>{if(video&&state?.urls[video.segment])mediaFailed(video.segment,video.label,event.currentTarget);}}/>{(!ready||failure)&&<div className="outbound-video-loading">{!video ? <span>{t("此相机没有本段源文件")}</span> : failure ? <span>{tr(failure)}</span> : <><LoaderCircle size={20} className="spin"/><span>{state?.urls[video.segment] ? t("正在缓冲") : t("正在连接")}</span></>}</div>}{video&&ready&&!failure&&otherIssue&&<div className="outbound-camera-issue">{t("其他分段缺失或读取失败")}</div>}</div>
            </article>;})}</div>
            <div className="outbound-transport" aria-label={t("回放控制")}><button className="button outbound-play-button" type="button" aria-label={playing||transitionIntent ? t("暂停") : t("全局播放")} disabled={(!playbackReady&&!transitionIntent)||busy||workspaceBusy||suspended} onClick={togglePlayback}>{playing||transitionIntent ? <Pause size={18}/> : <Play size={18}/>}</button><span className="outbound-time">{tr(formatTime(fullPosition))}<span> / {fullDuration ? tr(formatTime(fullDuration)) : t("时长待确认")}</span></span><input type="range" aria-label={t("视频播放位置")} min={0} max={fullDuration||1} step={0.01} value={Math.min(fullPosition,fullDuration||1)} disabled={!timeline.complete||suspended||busy||workspaceBusy} onChange={event=>seek(Number(event.target.value))}/><span className="outbound-playback-status" role="status">{buffering ? <><LoaderCircle size={13} className="spin"/>{t("正在缓冲")}</> : opening ? t("已就绪 {0}/{1}", [videoState?.ready.length ?? 0, partVideos.length]) : !timeline.complete&&!Object.keys(sourceFailures).length ? t("正在读取总时长") : playbackReady ? t("同步回放") : t("等待视频")}</span><button className="icon-button" type="button" title={muted ? t("开启主相机声音") : t("静音")} aria-label={muted ? t("开启主相机声音") : t("静音")} onClick={()=>setMuted(value=>!value)}>{muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button><select aria-label={t("播放速度")} value={speed} onChange={event=>{const rate=Number(event.target.value);setSpeed(rate);playback.current?.setSpeed(rate);}}>{[.25,.5,.75,1,1.25,1.5,1.75,2,2.5,3,4,6,8].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></div>
            <div className="outbound-decision"><span>{recording.decision ? t("已由 {0} 于 {1} 判为{2}{3}", [recording.decision.actor, tr(new Date(recording.decision.at).toLocaleString(localeTag(),{hour12:false})), recording.decision.value==="valid" ? t("有效") : recording.decision.value==="anomalous" ? t("异常") : t("无效"), recording.decision.reason ? t(" · {0}", [reasonLabel(recording.decision.reason)]) : ""]) +" "+t("可重新选择结论或修改原因，保存后更新统计。") : videosReady ? t("请根据完整原始视频判断数据有效性") : t("视频全部就绪后可提交结论")}</span>
              <button className="button button-primary outbound-valid-button" type="button" disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady||recording.decision?.value==="valid"} aria-pressed={recording.decision?.value==="valid"} title={recording.decision ? t("将当前结论修改为有效") : undefined} onClick={()=>void act("decide","valid")}><CheckCircle2 size={16}/>{t("有效数据")}</button>
              <button className="button button-secondary outbound-anomalous-button" type="button" title={batch.decisionValues?.includes("anomalous") ? t("本条录制同时包含有效与无效内容") : t("交付服务尚不支持异常结论，请联系管理员更新服务")} disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady||!batch.decisionValues?.includes("anomalous")} aria-pressed={recording.decision?.value==="anomalous"} onClick={()=>chooseReason("anomalous")}><AlertTriangle size={16}/>{t("异常数据")}</button>
              <button className="button button-secondary outbound-invalid-button" type="button" disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady} aria-pressed={recording.decision?.value==="invalid"} onClick={()=>chooseReason("invalid")}><XCircle size={16}/>{t("无效数据")}</button>
            </div>
          </section>}
        </> : <div className="outbound-empty">{t("此批次没有可审核录制")}</div>}
      </div>}
    </div>}
    {reasonDialog&&<div className="outbound-dialog-backdrop" role="presentation"><section key={reasonDialog} className={`outbound-reason-dialog outbound-${reasonDialog}-reasons`} role="dialog" aria-modal="true" aria-labelledby={`outbound-${reasonDialog}-reason-title`}><header><div><h3 id={`outbound-${reasonDialog}-reason-title`}>{reasonDialog==="anomalous" ? t("选择异常原因") : t("选择无效原因")}</h3><p>{reasonDialog==="anomalous" ? t("异常原因仅用于异常数据，常用项独立保存。") : t("无效原因仅用于无效数据，常用项独立保存。")}</p></div><button className="icon-button" type="button" aria-label={reasonDialog==="anomalous" ? t("关闭异常原因") : t("关闭无效原因")} onClick={()=>setReasonDialog(null)}><X size={18}/></button></header><div className="outbound-reason-options">{availableReasons.map(reason=><button type="button" key={reason} aria-pressed={selectedReason===reason} onClick={()=>setSelectedReason(reason)}>{selectedReason===reason ? <Check size={15}/> : null}{reasonLabel(reason)}</button>)}</div><form onSubmit={event=>{event.preventDefault();void addReason();}}><label htmlFor={`outbound-${reasonDialog}-custom-reason`}>{reasonDialog==="anomalous" ? t("新增常用异常原因") : t("新增常用无效原因")}</label><div><input id={`outbound-${reasonDialog}-custom-reason`} maxLength={80} value={customReason} disabled={busy} onChange={event=>setCustomReason(event.target.value)} placeholder={t("输入原因并保存")}/><button className="button button-secondary" type="submit" disabled={busy||!customReason.trim()}><Save size={15}/>{t("保存常用项")}</button></div></form><footer><button className="button button-secondary" type="button" disabled={busy} onClick={()=>setReasonDialog(null)}>{t("取消")}</button><button className="button button-primary" type="button" disabled={busy||!selectedReason||!videosReady||(recording?.decision?.value===reasonDialog&&recording.decision.reason===selectedReason)} onClick={()=>void act("decide",reasonDialog,selectedReason)}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{recording?.decision ? t("保存修改") : reasonDialog==="anomalous" ? t("确认异常") : t("确认无效")}</button></footer></section></div>}
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

function reasonLabel(reason:string) { return ([...OUTBOUND_INVALID_REASONS,...OUTBOUND_ANOMALOUS_REASONS] as readonly string[]).includes(reason) ? t(reason) : reason; }

function localizedVideoFailure(message:string){
  const colon=message.indexOf("：");
  return colon<0?tr(message):t("{0}：{1}",[message.slice(0,colon),tr(message.slice(colon+1))]);
}
