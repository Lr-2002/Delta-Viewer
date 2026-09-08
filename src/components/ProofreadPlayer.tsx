import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { FramePanel } from "./FramePanel";
import type { StreamSummary } from "../types";

interface Props {
  root: string;
  stream: StreamSummary;
  offset: number;
  step: number;
  frameCount: number;
  frame: number;
  start: number;
  end: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
}

export function ProofreadPlayer({ root, stream, offset, step, frameCount, frame, start, end, playing, onFrame, onPlaying }: Props) {
  const [fps, setFps] = useState(30);
  const nativeClock = useRef(false);
  const settled = useRef(-1);
  const latest = useRef({ frame, start, end, playing, onFrame, onPlaying });
  latest.current = { frame, start, end, playing, onFrame, onPlaying };
  const sourceFps = useCallback((_name: string, value: number | null) => { if (value) setFps(value); }, []);
  const clockChanged = useCallback((_name: string, enabled: boolean) => { nativeClock.current = enabled; }, []);
  const frameSettled = useCallback((_name: string, value: number) => { settled.current = value; }, []);
  const framePresented = useCallback((_name: string, _value: number, position: number) => {
    const current = latest.current;
    if (!current.playing) return;
    const next = Math.min(current.end, Math.max(current.start, Math.floor((position - offset) / step + 1e-4)));
    current.onFrame(next);
    if (next >= current.end) current.onPlaying(false);
  }, [offset, step]);
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const current = latest.current;
      if (!nativeClock.current && settled.current === offset + current.frame * step && now - previous >= 1000 / fps) {
        previous = now;
        if (current.frame >= end) current.onPlaying(false);
        else current.onFrame(Math.min(end, current.frame + 1));
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, fps, offset, step, end]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]") || (event.target as HTMLElement | null)?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      const current = latest.current;
      if (event.code === "Space") {
        event.preventDefault();
        if (!current.playing && (current.frame < current.start || current.frame >= current.end)) current.onFrame(current.start);
        current.onPlaying(!current.playing);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); current.onPlaying(false);
        current.onFrame(Math.max(0, Math.min(frameCount - 1, current.frame + (event.key === "ArrowLeft" ? -1 : 1))));
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [frameCount]);
  const seek = (next: number) => { onPlaying(false); onFrame(Math.max(0, Math.min(frameCount - 1, next))); };
  return <>
    <div className="replay-visual-row"><div className="camera-grid stream-count-1">
      <FramePanel root={root} stream={stream} frameId={offset + frame * step} isPrimary playing={playing} exactFrameSeek
        nativePlaybackEnabled={playing} playbackFps={fps * step} playbackEndFrame={offset + end * step}
        readAheadEnabled={playing} readAheadStride={step} readAheadFrames={12} className="camera-0"
        onSourceFpsChange={sourceFps} onNativeClockChange={clockChanged}
        onFrameSettled={frameSettled} onFramePresented={framePresented} />
    </div></div>
    <div className="proofreading-transport">
      <button className="icon-button" title="上一帧" aria-label="上一帧" onClick={() => seek(frame - 1)}><SkipBack size={17} /></button>
      <button className="play-button" title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"} onClick={() => { if (!playing && (frame < start || frame >= end)) onFrame(start); onPlaying(!playing); }}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <button className="icon-button" title="下一帧" aria-label="下一帧" onClick={() => seek(frame + 1)}><SkipForward size={17} /></button>
      <input type="range" min={0} max={frameCount - 1} step={1} value={frame} aria-label="校对播放帧" onChange={(event) => seek(event.currentTarget.valueAsNumber)} />
      <input className="proofread-frame-input" aria-label="当前视频帧" type="number" min={0} max={frameCount - 1} value={frame} onChange={(event) => { if (Number.isInteger(event.currentTarget.valueAsNumber)) seek(event.currentTarget.valueAsNumber); }} />
      <span>/ {frameCount - 1}</span>
    </div>
  </>;
}
