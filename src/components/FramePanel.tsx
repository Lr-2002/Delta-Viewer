import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl, videoSource } from "../lib/backend";
import {
  FrameCache,
  frameRequestKey,
  frameStreamKey,
  type CachedFrame,
} from "../lib/frame-cache";
import { sourceAlignedTimelineFrame } from "../lib/playback-clock";
import type { StreamSummary, VideoSource } from "../types";

interface FramePanelProps {
  root: string;
  stream: StreamSummary;
  frameId: number;
  playing?: boolean;
  nativePlaybackEnabled?: boolean;
  readAheadEnabled?: boolean;
  readAheadFrames?: number;
  readAheadStride?: number;
  playbackEndFrame: number;
  playbackFps?: number;
  speed?: number;
  className?: string;
  onFrameSettled?: (stream: string, frameId: number) => void;
  onFrameUnavailable?: (stream: string, frameId: number) => void;
  onSourceFpsChange?: (stream: string, fps: number | null) => void;
}

const frameCache = new FrameCache(async (request) => {
  const source = await frameUrl(request.root, request.stream, request.frameId);
  await decodeFrame(source);
  return source;
});

type FrameSlot = CachedFrame | null;
type FrameSlots = [FrameSlot, FrameSlot];
type FrameSlotIndex = 0 | 1;

function alternateSlot(slot: FrameSlotIndex): FrameSlotIndex {
  return slot === 0 ? 1 : 0;
}

function decodeFrame(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      // `decode()` lets the visible image swap only after pixels are ready.
      void image.decode().then(resolve, resolve);
    };
    image.onerror = () => reject(new Error("Unable to decode frame image"));
    image.src = source;
  });
}

export const FramePanel = memo(function FramePanel({
  root,
  stream,
  frameId,
  playing = false,
  nativePlaybackEnabled = playing,
  readAheadEnabled = playing,
  readAheadFrames,
  readAheadStride = 1,
  playbackEndFrame,
  playbackFps = 30,
  speed = 1,
  className = "",
  onFrameSettled,
  onFrameUnavailable,
  onSourceFpsChange,
}: FramePanelProps) {
  const streamKey = frameStreamKey(root, stream.name);
  const [frames, setFrames] = useState<FrameSlots>([null, null]);
  const [visibleSlot, setVisibleSlot] = useState<FrameSlotIndex>(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const framesRef = useRef<FrameSlots>([null, null]);
  const imageRefs = useRef<[HTMLImageElement | null, HTMLImageElement | null]>([null, null]);
  const stagedSlotRef = useRef<FrameSlotIndex | null>(null);
  const visibleSlotRef = useRef<FrameSlotIndex>(0);
  const unavailableFrameRef = useRef<string | null>(null);
  const lastRequestedFrameRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const requestedVideoTimeRef = useRef(0);
  const [nativeVideo, setNativeVideo] = useState<VideoSource | null>(null);
  const [videoSourceChecked, setVideoSourceChecked] = useState(false);
  const [nativeVideoFailed, setNativeVideoFailed] = useState(false);
  const [videoStatus, setVideoStatus] = useState<"loading" | "ready" | "playing" | "buffering" | "fallback">("loading");

  useEffect(() => {
    let active = true;
    setNativeVideo(null);
    setVideoSourceChecked(false);
    setNativeVideoFailed(false);
    void videoSource(root, stream.name).then((source) => {
      if (active) {
        setNativeVideo(source);
        setNativeVideoFailed(false);
        setVideoSourceChecked(true);
        setVideoStatus(source ? "loading" : "fallback");
      }
    });
    return () => { active = false; };
  }, [root, stream.name]);

  useEffect(() => {
    onSourceFpsChange?.(stream.name, nativeVideo?.fps ?? null);
  }, [nativeVideo?.fps, onSourceFpsChange, stream.name]);

  const nativeVideoActive = nativeVideo !== null && !nativeVideoFailed;
  const alignFallbackFrame = (candidateFrameId: number) => nativeVideo && nativeVideoFailed
    ? sourceAlignedTimelineFrame(
      candidateFrameId,
      nativeVideo.startFrame,
      playbackFps,
      nativeVideo.fps,
    )
    : candidateFrameId;
  const fallbackFrameId = alignFallbackFrame(frameId);
  const fallbackFrameStride = nativeVideo && nativeVideoFailed
    ? Math.max(1, Math.round(playbackFps / nativeVideo.fps))
    : Math.max(1, Math.round(readAheadStride));
  const requestKey = frameRequestKey({ root, stream: stream.name, frameId: fallbackFrameId });
  const requestedKeyRef = useRef(requestKey);
  const timelineSeconds = Math.max(0, frameId - (nativeVideo?.startFrame ?? 0))
    / Math.max(playbackFps, 1);
  const videoSegmentIndex = nativeVideo
    ? Math.min(nativeVideo.paths.length - 1, Math.floor(timelineSeconds / nativeVideo.segmentSeconds))
    : 0;
  const mediaClockRatio = nativeVideo
    ? nativeVideo.fps / Math.max(nativeVideo.mediaFps, 1)
    : 1;
  const videoLocalSeconds = nativeVideo
    ? (timelineSeconds - videoSegmentIndex * nativeVideo.segmentSeconds) * mediaClockRatio
    : 0;
  requestedVideoTimeRef.current = Math.max(0, videoLocalSeconds);

  useEffect(() => {
    const video = videoRef.current;
    if (!nativeVideoActive || !video) return;
    video.playbackRate = speed * mediaClockRatio;
    if (nativePlaybackEnabled) {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        video.currentTime = requestedVideoTimeRef.current;
      }
      void video.play().catch(() => setVideoStatus("ready"));
    } else {
      video.pause();
      setVideoStatus("ready");
    }
  }, [mediaClockRatio, nativePlaybackEnabled, nativeVideoActive, speed, videoSegmentIndex]);

  useEffect(() => {
    const video = videoRef.current;
    if (!nativeVideoActive || !video) return;
    // Native segments have independent decoder clocks. Correct only meaningful
    // drift while playing to keep all camera timelines aligned without seeking
    // on every React frame; paused seeks remain frame-accurate.
    const tolerance = playing ? 0.08 : 0.001;
    if (Math.abs(video.currentTime - videoLocalSeconds) > tolerance) {
      video.currentTime = Math.max(0, videoLocalSeconds);
    }
  }, [frameId, nativeVideoActive, playing, videoLocalSeconds, videoSegmentIndex]);

  useEffect(() => {
    if (nativeVideoActive) onFrameSettled?.(stream.name, frameId);
  }, [frameId, nativeVideoActive, onFrameSettled, stream.name]);

  useEffect(() => {
    if (nativeVideoActive || !videoSourceChecked) return;
    const visible = framesRef.current[visibleSlotRef.current];
    if (visible?.key === requestKey) onFrameSettled?.(stream.name, frameId);
  }, [frameId, nativeVideoActive, onFrameSettled, requestKey, stream.name]);

  function resumeSecondaryNativePlayback() {
    if (stream.name === "cam0" || !nativePlaybackEnabled || !nativeVideoActive) return;
    const video = videoRef.current;
    if (!video || !video.paused) return;
    video.playbackRate = speed * mediaClockRatio;
    void video.play().catch(() => {
      if (nativePlaybackEnabled) setVideoStatus("ready");
    });
  }

  function reportFrameUnavailable(frame: CachedFrame | { frameId: number }) {
    const key = `${streamKey}:${frame.frameId}`;
    if (unavailableFrameRef.current === key) return;
    unavailableFrameRef.current = key;
    onFrameUnavailable?.(stream.name, frame.frameId);
  }
  function stageFrame(frame: CachedFrame, presentImmediately = false) {
    const current = framesRef.current[visibleSlotRef.current];
    if (current?.streamKey === frame.streamKey && current.key === frame.key) {
      setStatus("ready");
      onFrameSettled?.(stream.name, frameId);
      return;
    }

    const targetSlot = current?.streamKey === frame.streamKey
      ? alternateSlot(visibleSlotRef.current)
      : visibleSlotRef.current;
    const nextFrames = [...framesRef.current] as FrameSlots;
    nextFrames[targetSlot] = frame;
    framesRef.current = nextFrames;
    stagedSlotRef.current = presentImmediately ? null : targetSlot;
    setFrames(nextFrames);
    if (presentImmediately) {
      visibleSlotRef.current = targetSlot;
      setVisibleSlot(targetSlot);
      setStatus("ready");
      onFrameSettled?.(stream.name, frameId);
    }
  }

  function showStagedFrame(slot: FrameSlotIndex, frame: CachedFrame) {
    if (
      stagedSlotRef.current !== slot
      || requestedKeyRef.current !== frame.key
      || framesRef.current[slot]?.key !== frame.key
    ) return;

    visibleSlotRef.current = slot;
    stagedSlotRef.current = null;
    setVisibleSlot(slot);
    setStatus("ready");
    onFrameSettled?.(stream.name, frameId);
  }

  function clearCurrentStreamFrames() {
    const nextFrames = framesRef.current.map((frame) => (
      frame?.streamKey === streamKey ? null : frame
    )) as FrameSlots;
    framesRef.current = nextFrames;
    stagedSlotRef.current = null;
    setFrames(nextFrames);
  }

  function handleFrameError(slot: FrameSlotIndex, frame: CachedFrame) {
    if (requestedKeyRef.current !== frame.key || framesRef.current[slot]?.key !== frame.key) return;

    // A failed replacement must not leave the previous frame visible as the current one.
    clearCurrentStreamFrames();
    setStatus("failed");
    onFrameSettled?.(stream.name, frameId);
    reportFrameUnavailable(frame);
  }

  useEffect(() => {
    if (nativeVideoActive) return;
    const slot = stagedSlotRef.current;
    if (slot === null) return;
    const frame = frames[slot];
    const image = imageRefs.current[slot];
    if (frame && image?.complete && image.naturalWidth > 0) showStagedFrame(slot, frame);
  }, [frames]);

  useLayoutEffect(() => {
    requestedKeyRef.current = requestKey;
  }, [requestKey]);

  useEffect(() => {
    if (nativeVideoActive) return;
    let active = true;
    const effectRequestKey = requestKey;
    const previousFrame = lastRequestedFrameRef.current;
    const retainsSequentialReadAhead = playing
      && (previousFrame === fallbackFrameId || previousFrame === fallbackFrameId - fallbackFrameStride);
    lastRequestedFrameRef.current = fallbackFrameId;
    if (requestedKeyRef.current === effectRequestKey) setStatus("loading");
    frameCache.requestCurrent(
      { root, stream: stream.name, frameId: fallbackFrameId },
      { preserveReadAhead: retainsSequentialReadAhead },
    )
      .then((frame) => {
        if (
          !active
          || requestedKeyRef.current !== effectRequestKey
          || frame.key !== effectRequestKey
        ) return;
        // Read-ahead already decoded this source before the real-time clock
        // started. Waiting for another DOM image load event can take an extra
        // display refresh and make a 60 FPS clock continually supersede its
        // own frames, leaving the old tile visible.
        stageFrame(frame, playing && nativePlaybackEnabled);
      })
      .catch(() => {
        if (!active || requestedKeyRef.current !== effectRequestKey) return;
        clearCurrentStreamFrames();
        setStatus("failed");
        onFrameSettled?.(stream.name, frameId);
        reportFrameUnavailable({ frameId: fallbackFrameId });
      });
    if (playing && readAheadEnabled && (!nativeVideo || nativeVideoFailed)) {
      const streamEnd = stream.lastFrame ?? playbackEndFrame;
      frameCache.scheduleReadAhead({
        root,
        stream: stream.name,
        frameId: fallbackFrameId,
        endFrame: Math.min(playbackEndFrame, streamEnd),
      }, alignFallbackFrame, readAheadFrames, fallbackFrameStride);
    }
    return () => {
      active = false;
    };
  }, [fallbackFrameId, fallbackFrameStride, nativePlaybackEnabled, nativeVideo, nativeVideoActive, nativeVideoFailed, playbackEndFrame, playbackFps, playing, readAheadEnabled, readAheadFrames, root, stream.lastFrame, stream.name, streamKey, videoSourceChecked]);

  useEffect(() => {
    if (!playing || !readAheadEnabled || (nativeVideo !== null && !nativeVideoFailed)) {
      frameCache.discardReadAhead(root, stream.name);
    }
    return () => frameCache.discardReadAhead(root, stream.name);
  }, [nativeVideo, nativeVideoFailed, playing, readAheadEnabled, root, stream.name]);

  return (
    <figure className={`frame-panel ${className}`}>
      {nativeVideoActive && nativeVideo ? (
        <video
          key={nativeVideo.paths[videoSegmentIndex]}
          ref={videoRef}
          className="frame-image"
          src={nativeVideo.paths[videoSegmentIndex]}
          muted
          playsInline
          preload="auto"
          autoPlay={nativePlaybackEnabled}
          onLoadedMetadata={() => {
            if (videoRef.current) {
              videoRef.current.currentTime = requestedVideoTimeRef.current;
            }
          }}
          onLoadedData={() => {
            setVideoStatus("ready");
            onFrameSettled?.(stream.name, frameId);
            if (nativePlaybackEnabled && videoRef.current) void videoRef.current.play();
          }}
          onPlaying={() => setVideoStatus("playing")}
          onCanPlay={resumeSecondaryNativePlayback}
          onSeeked={resumeSecondaryNativePlayback}
          onWaiting={() => setVideoStatus("buffering")}
          onStalled={() => setVideoStatus("buffering")}
          onPause={() => { if (!nativePlaybackEnabled) setVideoStatus("ready"); }}
          onError={() => {
            setVideoStatus("fallback");
            setNativeVideoFailed(true);
          }}
        />
      ) : null}
      {!nativeVideoActive ? frames.map((frame, slot) => {
        const slotIndex = slot as FrameSlotIndex;
        if (!frame || frame.streamKey !== streamKey) return null;
        const isVisible = slotIndex === visibleSlot;
        return (
          <img
            key={`frame-slot-${slot}`}
            ref={(image) => { imageRefs.current[slotIndex] = image; }}
            className="frame-image"
            src={frame.source}
            alt={`${stream.label} frame ${frame.frameId}`}
            aria-hidden={!isVisible}
            onLoad={() => showStagedFrame(slotIndex, frame)}
            onError={() => handleFrameError(slotIndex, frame)}
          />
        );
      }) : null}
      <figcaption>
        <span>{stream.label}</span>
        <span className="frame-resolution">
          {stream.width && stream.height ? `${stream.width}×${stream.height}` : "—"}
        </span>
        {nativeVideo ? (
          <span className="video-playback-status">
            {nativeVideoFailed || videoStatus === "fallback" ? "逐帧回退" : videoStatus === "playing" ? "原生播放" : videoStatus === "buffering" ? "缓冲中" : "原生就绪"}
          </span>
        ) : null}
      </figcaption>
      {!nativeVideoActive && status === "loading" && !playing ? <span className="frame-loading">解码中</span> : null}
      {!nativeVideoActive && status === "failed" ? (
        <span className="frame-error">
          <ImageOff size={18} aria-hidden="true" />
          帧不可用
        </span>
      ) : null}
    </figure>
  );
});
