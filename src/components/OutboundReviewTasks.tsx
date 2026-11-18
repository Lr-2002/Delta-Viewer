import { localeTag, t, tr, useLanguage } from "../lib/i18n";
import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type VideoHTMLAttributes} from "react";
import {ArrowLeft,AlertTriangle,Check,CheckCircle2,ChevronRight,Expand,Film,LoaderCircle,Minimize,Pause,Play,RefreshCw,Save,Video,Volume2,VolumeX,X,XCircle} from "lucide-react";
import type {UserIdentity} from "../types";
import {changeOutboundBatch,fetchOutboundVideo,releaseOutboundVideos,listOutboundBatches,OUTBOUND_INVALID_REASONS,outboundError,outboundResultUncertain,outboundVideoParts,saveOutboundReasonOption,type OutboundBatch,type OutboundRecording,type OutboundProtocol,type OutboundDecisionValue} from "../lib/outbound-review";
import {OutboundVideoLoader} from "../lib/outbound-video-loader";
import {OutboundPlayback} from "../lib/outbound-playback";
import "./outbound-review.css";

interface Props {currentUser:UserIdentity;workspaceBusy?:boolean;view?:"tasks"|"workspace";initialBatch?:OutboundBatch;onOpenReview?:(batch:OutboundBatch,isCurrent?:()=>boolean)=>Promise<void>;onReturnToTasks?:()=>void;suspended?:boolean}
type TaskAction="claim"|"release"|"open"|"verify";
type TaskFeedback={error:boolean;message:string};
type VideoState={recordingId:string;part:number;urls:Record<number,string>;ready:number[];failed:Record<number,string>};

// Playback publishes its clock frequently. The recording queue only changes
// when selection, authority or a saved decision changes.
const RecordingList=memo(function RecordingList({recordings,selectedId,disabled,onSelect}:{recordings:OutboundRecording[];selectedId:string;disabled:boolean;onSelect:(id:string)=>void}){
  useLanguage();
  return <nav className="outbound-recordings" aria-label={t("录制列表")}>{recordings.map((item,index)=><button type="button" key={item.id} className={item.id===selectedId?"selected":""} aria-label={t("{0} {1}", [item.name || t("录制 {0}", [index+1]), item.decision?.value==="valid" ? t("有效") : item.decision?.value==="invalid" ? t("无效") : item.decision?.value==="anomalous" ? t("异常") : t("待审")])} aria-pressed={item.id===selectedId} disabled={disabled} onClick={()=>onSelect(item.id)}><span className="outbound-recording-number">{tr(String(index+1).padStart(2,"0"))}</span><span className="outbound-recording-label" title={item.name}>{item.name || t("录制 {0}", [index+1])}</span><strong className={item.decision?.value??""}>{item.decision?.value==="valid" ? <><CheckCircle2 size={12}/>{t("有效")}</> : item.decision?.value==="invalid" ? <><XCircle size={12}/>{t("无效")}</> : item.decision?.value==="anomalous" ? <><AlertTriangle size={12}/>{t("异常")}</> : t("待审")}</strong><ChevronRight className="outbound-recording-arrow" size={14}/></button>)}</nav>;
});

// A detached media element can keep its network loader and decoder alive until
// WebView2 collects it. Release them at the actual element lifetime boundary.
function ReviewVideo({segment,onAttach,...props}:VideoHTMLAttributes<HTMLVideoElement>&{segment:number;onAttach:(segment:number,player:HTMLVideoElement|null)=>void}){
  const element=useRef<HTMLVideoElement>(null);
  useLayoutEffect(()=>{
    const player=element.current!;
    onAttach(segment,player);
    return()=>{
      onAttach(segment,null);
      player.pause();
      player.removeAttribute("src");
      player.load();
    };
  },[segment,onAttach]);
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
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
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
  const ticketLoader=useMemo(()=>new OutboundVideoLoader<(typeof partVideos)[number]>(url=>{void releaseOutboundVideos([url]);}),[]);
  const mediaUrls=useRef(new Set<string>());
  const releaseVideos=useCallback(()=>{ticketLoader.cancel();void releaseOutboundVideos([...mediaUrls.current]);mediaUrls.current.clear();},[ticketLoader]);
  const batch=batches.find(value=>value.id===batchId)??null;
  const recording=batch?.recordings.find(value=>value.id===recordingId)??batch?.recordings[0]??null;
  const isOwner=batch?.claim===currentUser.username;
  const grouped=useMemo(()=>outboundVideoParts(recording?.videos??[]),[recording?.videos]);
  const partVideos=grouped.parts[partIndex]??[];
  const missingCameras=grouped.cameras.filter(camera=>!partVideos.some(video=>video.camera===camera));
  const videosReady=Boolean(recording&&videoState?.recordingId===recording.id&&videoState.part===partIndex&&!Object.keys(videoState.failed).length&&partVideos.length>0&&!missingCameras.length&&partVideos.every(video=>videoState.urls[video.segment]&&videoState.ready.includes(video.segment)));
  const availableReasons=useMemo(()=>[...new Set([...OUTBOUND_INVALID_REASONS,...reasonOptions])],[reasonOptions]);
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
      setPlaying(state.playing);setBuffering(state.buffering);setPosition(state.position);setDuration(state.duration);
    },()=>setError("视频播放失败，请重新打开。"));
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
  useEffect(()=>{requestGeneration.current++;setVideoState(null);setOpening(false);setPartIndex(0);setReasonDialog(null);setError("");},[recordingId]);

  useEffect(()=>{
    if(view==="workspace"&&recording&&isOwner&&!suspended)void openVideos(0);
    return()=>{requestGeneration.current++;ticketLoader.cancel();playback.current?.pause();releaseVideos();};
  },[view,batch?.id,recording?.id,isOwner,suspended]);
  useEffect(()=>{if(suspended)playback.current?.pause();},[suspended]);
  useEffect(()=>{playback.current?.setMaster(partVideos.find(video=>video.camera===grouped.primaryCamera)?.segment??null);},[partVideos,grouped.primaryCamera]);

  function updateBatch(next:OutboundBatch){
    setBatches(previous=>previous.map(value=>value.id===next.id?next:value));
  }
  async function act(action:"claim"|"release"|"decide",value?:OutboundDecisionValue,reason?:string){
    if(!batch||busyRef.current||workspaceUnconfirmed)return;
    busyRef.current=true;setBusy(true);setError("");setNotice("");
    try{
      const result=await changeOutboundBatch(batch,action,action==="decide"?recording?.id:undefined,value,reason,protocol);
      updateBatch(result.batch);
      if(action==="claim"){setNotice("已领取批次。");if(onOpenReview)await onOpenReview(result.batch);}
      if(action==="release"){setNotice("已释放批次。");if(view==="workspace")onReturnToTasks?.();}
      if(action==="decide"){
        setReasonDialog(null);setSelectedReason("");setCustomReason("");setNotice("审核结论已保存。");
        const next=result.batch.recordings.find(item=>!item.decision);
        if(next)setRecordingId(next.id);
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
            if(next)setRecordingId(next.id);
            return;
          }
          if(action==="release"&&!fresh.claim){setNotice("已核对：批次已释放。");onReturnToTasks?.();return;}
        }catch{/* Do not replay a mutation whose result is unknown. */}
        setNotice("");setError("提交结果尚未确认，请刷新当前批次核对后再操作。"+outboundError(cause));
      }else setError(outboundError(cause));
    }
    finally{busyRef.current=false;setBusy(false);}
  }
  async function openVideos(nextPart=partIndex){
    if(!batch||!recording||!isOwner)return;
    const generation=++requestGeneration.current;retryPositions.current.clear();
    const files=grouped.parts[nextPart]??[];
    if(!files.length)return;
    playback.current?.pause();setPosition(0);setDuration(0);
    setPartIndex(nextPart);setVideoState({recordingId:recording.id,part:nextPart,urls:{},ready:[],failed:{}});setOpening(true);setError("");setNotice("");
    releaseVideos();
    ticketLoader.replace(files,
      video=>fetchOutboundVideo(batch,recording,video.segment),
      (video,url)=>{
        mediaUrls.current.add(url);
        setVideoState(previous=>previous?{...previous,urls:{...previous.urls,[video.segment]:url}}:previous);
      },
      (video,cause)=>setVideoState(previous=>previous?{...previous,failed:{...previous.failed,[video.segment]:outboundError(cause)}}:previous),
      ()=>{if(generation===requestGeneration.current)setOpening(false);});
  }

  function mediaFailed(segment:number,label:string,player:HTMLVideoElement){
    if(players.current.get(segment)!==player)return;
    // Abort is expected when the user changes recordings or parts.
    if(player.error?.code===1)return;
    const reason=player.error?.code===2?"网络读取中断":player.error?.code===3?"视频解码失败":player.error?.code===4?"视频格式不受支持或服务响应异常":"视频资源加载失败";
    playback.current?.pause();
    setVideoState(previous=>previous?{...previous,ready:previous.ready.filter(id=>id!==segment),failed:{...previous.failed,[segment]:`${label}：${reason}，可重试失败视频。`}}:previous);
  }
  async function retryFailedVideos(){
    if(!batch||!recording||!videoState||opening||!isOwner)return;
    const generation=requestGeneration.current,failed=Object.keys(videoState.failed).map(Number);
    const target=players.current.get(partVideos.find(video=>video.camera===grouped.primaryCamera)?.segment??-1)?.currentTime??position;
    playback.current?.pause();setOpening(true);
    await Promise.all(failed.map(async segment=>{
      const video=partVideos.find(video=>video.segment===segment);if(!video)return;
      try{
        const url=await fetchOutboundVideo(batch,recording,segment);if(generation!==requestGeneration.current){void releaseOutboundVideos([url]);return;}
        const old=videoState.urls[segment];if(old){mediaUrls.current.delete(old);void releaseOutboundVideos([old]);}mediaUrls.current.add(url);
        retryPositions.current.set(segment,target);
        setVideoState(previous=>previous?{...previous,urls:{...previous.urls,[segment]:url}}:previous);
        // A fixture or a relay may return the same URL; explicitly reload only
        // the failed player, preserving all other camera buffers and position.
        requestAnimationFrame(()=>{if(generation===requestGeneration.current)players.current.get(segment)?.load();});
      }catch(cause){if(generation===requestGeneration.current)setVideoState(previous=>previous?{...previous,failed:{...previous.failed,[segment]:`${video.label}：${outboundError(cause)}`}}:previous);}
    }));
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
    const open=async(detail:OutboundBatch)=>{if(canOpen())await onOpenReview?.({...detail,reasonOptions},canOpen);};
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
    if(!value||busyRef.current)return;
    busyRef.current=true;setBusy(true);setError("");
    try{
      const result=await saveOutboundReasonOption(value);
      setReasonOptions(result.reasonOptions);
      setSelectedReason(value);setCustomReason("");setNotice("已保存为常用审核原因。");
    }catch(cause){setError(outboundError(cause));}
    finally{busyRef.current=false;setBusy(false);}
  }

  const recordingList=batch?<RecordingList recordings={batch.recordings} selectedId={recording?.id??""} disabled={busy||workspaceBusy} onSelect={setRecordingId}/>:null;
  if(view==="tasks")return <section className="outbound-review" aria-label={t("外发审核任务")}>
    <div className="outbound-toolbar"><strong>{t("外发审核")}</strong><span>{lastUpdated ? t("自动同步 · {0}", [tr(new Date(lastUpdated).toLocaleTimeString(localeTag(),{hour12:false}))]) : t("按交付批次领取任务")}</span><button className="button button-secondary" type="button" aria-label={t("刷新外发批次")} disabled={loading||Object.keys(pendingTasks).length>0||workspaceBusy} onClick={()=>void load()}><RefreshCw size={16}/></button></div>
    {tr(error&&<div className="outbound-error" role="alert">{tr(error)}</div>)}
    {tr(notice&&<div className="outbound-notice" role="status">{tr(notice)}</div>)}
    {loading&&!batches.length ? <div className="outbound-empty">{t("正在读取交付批次…")}</div> : !batches.length ? <div className="outbound-empty">{t("暂无可审核的星炬批次")}</div> : <div className="outbound-task-list">{batches.map(item=><article key={item.id} aria-busy={Boolean(pendingTasks[item.id])}><div><strong>{item.name}</strong><p>{t("已审") + " "}{item.reviewed}/{item.total}{" " + t("· 有效") + " "}{item.valid}{" " + t("· 无效") + " "}{item.invalid}{" · " + t("异常") + " "}{item.anomalous??0}{item.rate===null ? "" : t(" · 合格率 {0}%", [Math.round(item.rate*100)])}</p><small>{item.claim ? t("由 {0} 领取", [item.claim]) : t("未领取")}</small>{taskFeedback[item.id]&&<p className={taskFeedback[item.id].error?"outbound-task-error":"outbound-task-feedback"} role={taskFeedback[item.id].error?"alert":"status"}>{tr(taskFeedback[item.id].message)}</p>}</div><div className="outbound-task-actions">{unconfirmed[item.id] ? <button className="button button-secondary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy} onClick={()=>void taskAction(item,"verify")}>{pendingTasks[item.id]==="verify" ? <LoaderCircle size={16} className="spin"/> : null}{t("核对结果")}</button> : item.claim===currentUser.username ? <><button className="button button-secondary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy} onClick={()=>void taskAction(item,"release")}>{pendingTasks[item.id]==="release" ? <LoaderCircle size={16} className="spin"/> : null}{t("释放批次")}</button><button className="button button-primary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"open")}>{pendingTasks[item.id]==="open" ? <LoaderCircle size={16} className="spin"/> : null}{t("打开审核")}</button></> : <button className="button button-primary" disabled={Boolean(pendingTasks[item.id])||workspaceBusy||Boolean(item.claim)||!onOpenReview||!item.total} onClick={()=>void taskAction(item,"claim")}>{pendingTasks[item.id]==="claim" ? <LoaderCircle size={16} className="spin"/> : null}{item.claim ? t("审核员处理中") : t("领取并打开")}</button>}</div></article>)}</div>}
  </section>;
  return <section className="outbound-review is-workspace" aria-label={t("外发审核工作区")}>
    <div className="outbound-toolbar"><strong><Film size={17}/>{t("外发审核")}</strong><div className="outbound-progress"><span>{t("已审") + " "}<b>{batch?.reviewed ?? 0}</b> / {batch?.total ?? 0}</span><progress aria-label={t("批次审核进度")} max={batch?.total||1} value={batch?.reviewed??0}/><span>{t("有效") + " "}{batch?.valid ?? 0}{" " + t("· 无效") + " "}{batch?.invalid ?? 0}{" · " + t("异常") + " "}{batch?.anomalous??0}</span></div><button className="button button-secondary" type="button" aria-label={t("刷新外发批次")} title={t("刷新外发批次")} disabled={loading||busy||workspaceBusy} onClick={()=>void load()}>{loading ? <LoaderCircle size={16} className="spin"/> : <RefreshCw size={16}/>}</button></div>
    {tr(error&&<div className="outbound-error" role="alert">{tr(error)}</div>)}{videoState&&Object.keys(videoState.failed).length>0&&<div className="outbound-error" role="alert">{tr([...new Set(Object.values(videoState.failed))].join("；"))}</div>}{tr(notice&&<div className="outbound-notice" role="status">{tr(notice)}</div>)}
    {loading&&!batches.length ? <div className="outbound-empty"><LoaderCircle size={18} className="spin"/>{t("正在读取交付批次…")}</div> : !batches.length ? <div className="outbound-empty">{t("暂无可审核的星炬批次")}</div> : <div className="outbound-layout">
      <aside className="outbound-recording-sidebar"><header><strong>{t("录制列表")}</strong><span>{batch?.total ?? 0}{" " + t("条")}</span></header>{recordingList}<button className="button button-secondary" disabled={busy||workspaceBusy} onClick={onReturnToTasks}><ArrowLeft size={15}/>{t("返回任务中心")}</button></aside>
      {batch&&<div className="outbound-detail">
        <header><div><h3>{batch.name}</h3><p>{t("合格率") + " "}{batch.rate===null ? t("待统计") : t("{0}%", [Math.round(batch.rate*100)])} · {batch.reviewed}/{batch.total}{" " + t("条")}</p></div>
          {isOwner ? <button className="button button-secondary" type="button" disabled={busy||workspaceBusy||workspaceUnconfirmed} onClick={()=>void act("release")} title={t("释放后其他审核员可领取")}>{t("释放批次")}</button> : <button className="button button-primary" type="button" disabled={busy||workspaceBusy||Boolean(batch.claim)} onClick={()=>void act("claim")}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{batch.claim ? t("审核员处理中") : t("领取批次")}</button>}
        </header>
        {batch.recordings.length>0 ? <>

          {recording&&<section className="outbound-player" aria-label={t("原始视频审核")}>
            <div className="outbound-player-heading"><div><strong>{recording.name}</strong><span>{grouped.cameraCount}{" " + t("路原始视频")}{grouped.parts.length>1 ? t(" · 共 {0} 段", [grouped.parts.length]) : ""}</span></div>
              {isOwner&&(!videoState||Object.keys(videoState.failed).length>0)&&<button className="button button-secondary" type="button" disabled={opening||workspaceBusy||!recording.videos.length} onClick={()=>void (videoState&&Object.keys(videoState.failed).length?retryFailedVideos():openVideos())}>{opening ? <LoaderCircle size={16} className="spin"/> : <Play size={16}/>}{videoState&&Object.keys(videoState.failed).length ? t("重试失败视频") : t("打开原始视频")}</button>}
            </div>
            {grouped.parts.length>1&&<nav className="outbound-video-tabs" aria-label={t("视频分段")}>{grouped.parts.map((_,index)=><button key={index} type="button" aria-pressed={index===partIndex} disabled={!isOwner||opening||busy||workspaceBusy} onClick={()=>void openVideos(index)}>{t("第 {0} 段", [grouped.partNumbers[index]+1])}</button>)}</nav>}
            {missingCameras.length>0&&<p className="outbound-error" role="alert">{t("本段缺少") + " "}{missingCameras.map(camera => tr(cameraName(camera))).join(", ")}{" " + t("的源文件，不能提交审核。其他分段仍可查看。")}</p>}
            {videoState?.recordingId===recording.id&&videoState.part===partIndex ? <div className={`outbound-video-grid cameras-${grouped.cameraCount}`} style={{"--outbound-camera-columns":grouped.cameraCount>1?`minmax(0,3.2fr) repeat(${Math.ceil((grouped.cameraCount-1)/2)},minmax(0,1fr))`:"minmax(0,1fr)"} as CSSProperties}>{grouped.cameras.map(camera=>{
              const video=partVideos.find(item=>item.camera===camera);
              const primary=camera===grouped.primaryCamera;
              if(!video)return <article className={`outbound-video-item is-missing${primary?" is-primary":""}`} key={`${recording.id}:${camera}:missing`}><header><strong><Video size={13}/>{tr(cameraName(camera))}</strong><span>{t("本段缺失")}</span></header><div className="outbound-video-stage"><div className="outbound-video-loading">{t("此相机没有本段源文件")}</div></div></article>;
              return <article className={`outbound-video-item${primary?` is-primary${primaryFilled?" is-filled":""}`:""}`} data-outbound-camera={camera} key={`${recording.id}:${video.segment}`}>
              <header><strong><Video size={13}/>{tr(cameraName(video.camera))}</strong><span>{videoState.failed[video.segment] ? t("读取失败") : videoState.ready.includes(video.segment) ? t("已就绪") : t("加载中")}</span>{primary&&<button type="button" className="outbound-fit" aria-label={primaryFilled ? t("主相机显示完整画面") : t("主相机铺满画面")} title={primaryFilled ? t("当前铺满显示，边缘可能裁切；切换为完整画面") : t("当前显示完整画面；切换为铺满显示")} onClick={()=>setPrimaryFilled(value=>!value)}>{primaryFilled ? t("完整画面") : t("铺满画面")}</button>}<button type="button" className="outbound-expand" title={fullscreenCamera===camera ? t("退出全屏") : t("放大视频")} aria-label={fullscreenCamera===camera ? t("退出{0}全屏", [tr(cameraName(video.camera))]) : t("放大{0}", [tr(cameraName(video.camera))])} disabled={!videoState.urls[video.segment]} onClick={event=>{const item=event.currentTarget.closest("article");const change=document.fullscreenElement===item?document.exitFullscreen():item?.requestFullscreen();void change?.catch(()=>setError("无法切换全屏，请重试。"));}}>{fullscreenCamera===camera ? <Minimize size={14}/> : <Expand size={14}/>}</button></header>
              <div className="outbound-video-stage"><ReviewVideo segment={video.segment} onAttach={attachPlayer} src={videoState.urls[video.segment]} aria-label={tr(cameraName(video.camera))} playsInline muted={!primary||muted} preload="auto" onCanPlay={()=>markReady(video.segment)} onLoadedMetadata={()=>{const player=players.current.get(video.segment),target=retryPositions.current.get(video.segment);if(player&&target!==undefined){player.currentTime=target;retryPositions.current.delete(video.segment);}updateClock();}} onError={event=>mediaFailed(video.segment,video.label,event.currentTarget)}/>{!videoState.ready.includes(video.segment)&&<div className="outbound-video-loading">{videoState.failed[video.segment] ? <span>{t("读取失败，请重试失败视频")}</span> : <><LoaderCircle size={20} className="spin"/><span>{videoState.urls[video.segment] ? t("正在缓冲") : t("正在连接")}</span></>}</div>}</div>
            </article>;})}</div> : <div className="outbound-video-placeholder"><Video size={22}/><span>{opening ? t("正在读取原始视频…") : isOwner ? t("打开后将并列读取本条录制的全部相机") : t("领取批次后查看原始视频")}</span></div>}
            <div className="outbound-transport" aria-label={t("回放控制")}><button className="button outbound-play-button" type="button" aria-label={playing ? t("暂停") : t("全局播放")} disabled={!videosReady||busy||workspaceBusy||suspended} onClick={togglePlayback}>{playing ? <Pause size={18}/> : <Play size={18}/>}</button><span className="outbound-time">{tr(formatTime(position))}<span> / {tr(formatTime(duration))}</span></span><input type="range" aria-label={t("视频播放位置")} min={0} max={duration||1} step={0.01} value={Math.min(position,duration||1)} disabled={!videosReady||suspended} onChange={event=>seek(Number(event.target.value))}/><span className="outbound-playback-status" role="status">{buffering ? <><LoaderCircle size={13} className="spin"/>{t("正在缓冲")}</> : opening ? t("已就绪 {0}/{1}", [videoState?.ready.length ?? 0, partVideos.length]) : videosReady ? t("同步回放") : t("等待视频")}</span><button className="icon-button" type="button" title={muted ? t("开启主相机声音") : t("静音")} aria-label={muted ? t("开启主相机声音") : t("静音")} onClick={()=>setMuted(value=>!value)}>{muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button><select aria-label={t("播放速度")} value={speed} onChange={event=>{const rate=Number(event.target.value);setSpeed(rate);playback.current?.setSpeed(rate);}}>{[.25,.5,1,2].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></div>
            <div className="outbound-decision"><span>{recording.decision ? t("已由 {0} 于 {1} 判为{2}{3}", [recording.decision.actor, tr(new Date(recording.decision.at).toLocaleString(localeTag(),{hour12:false})), recording.decision.value==="valid" ? t("有效") : recording.decision.value==="anomalous" ? t("异常") : t("无效"), recording.decision.reason ? t(" · {0}", [reasonLabel(recording.decision.reason)]) : ""]) : videosReady ? t("请根据完整原始视频判断数据有效性") : t("视频全部就绪后可提交结论")}</span>
              <button className="button button-primary outbound-valid-button" type="button" disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady||Boolean(recording.decision)} onClick={()=>void act("decide","valid")}><CheckCircle2 size={16}/>{t("有效数据")}</button>
              <button className="button button-secondary outbound-anomalous-button" type="button" title={batch.decisionValues?.includes("anomalous") ? t("本条录制同时包含有效与无效内容") : t("交付服务尚不支持异常结论，请联系管理员更新服务")} disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady||Boolean(recording.decision)||!batch.decisionValues?.includes("anomalous")} onClick={()=>setReasonDialog("anomalous")}><AlertTriangle size={16}/>{t("异常数据")}</button>
              <button className="button button-secondary outbound-invalid-button" type="button" disabled={!isOwner||busy||workspaceBusy||workspaceUnconfirmed||!videosReady||Boolean(recording.decision)} onClick={()=>setReasonDialog("invalid")}><XCircle size={16}/>{t("无效数据")}</button>
            </div>
          </section>}
        </> : <div className="outbound-empty">{t("此批次没有可审核录制")}</div>}
      </div>}
    </div>}
    {reasonDialog&&<div className="outbound-dialog-backdrop" role="presentation"><section className="outbound-reason-dialog" role="dialog" aria-modal="true" aria-labelledby="outbound-reason-title"><header><div><h3 id="outbound-reason-title">{reasonDialog==="anomalous" ? t("选择异常原因") : t("选择无效原因")}</h3><p>{t("原因将写入本条审核结论，供交付平台统计。")}</p></div><button className="icon-button" type="button" aria-label={reasonDialog==="anomalous" ? t("关闭异常原因") : t("关闭无效原因")} onClick={()=>setReasonDialog(null)}><X size={18}/></button></header><div className="outbound-reason-options">{availableReasons.map(reason=><button type="button" key={reason} aria-pressed={selectedReason===reason} onClick={()=>setSelectedReason(reason)}>{selectedReason===reason ? <Check size={15}/> : null}{reasonLabel(reason)}</button>)}</div><form onSubmit={event=>{event.preventDefault();void addReason();}}><label htmlFor="outbound-custom-reason">{t("新增常用原因")}</label><div><input id="outbound-custom-reason" maxLength={80} value={customReason} disabled={busy} onChange={event=>setCustomReason(event.target.value)} placeholder={t("输入原因并保存")}/><button className="button button-secondary" type="submit" disabled={busy||!customReason.trim()}><Save size={15}/>{t("保存常用项")}</button></div></form><footer><button className="button button-secondary" type="button" disabled={busy} onClick={()=>setReasonDialog(null)}>{t("取消")}</button><button className="button button-primary" type="button" disabled={busy||!selectedReason} onClick={()=>void act("decide",reasonDialog,selectedReason)}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{reasonDialog==="anomalous" ? t("确认异常") : t("确认无效")}</button></footer></section></div>}
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

function reasonLabel(reason:string) { return (OUTBOUND_INVALID_REASONS as readonly string[]).includes(reason) ? t(reason) : reason; }
