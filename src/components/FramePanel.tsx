import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl, videoSource } from "../lib/backend";
import {
  FrameCache,
  frameRequestKey,
  frameStreamKey,
  type CachedFrame,
} from "../lib/frame-cache";
import {
  clampStreamFrame,
  nativeVideoTimelinePosition,
  secondaryPlaybackFrame,
  sourceAlignedTimelineFrame,
} from "../lib/playback-clock";
import type { StreamSummary, VideoSource } from "../types";

interface FramePanelProps {
  root: string;
  stream: StreamSummary;
  frameId: number;
  isPrimary?: boolean;
  playing?: boolean;
  nativePlaybackEnabled?: boolean;
  readAheadEnabled?: boolean;
  readAheadFrames?: number;
  readAheadStride?: number;
  playbackEndFrame: number;
  playbackFps?: number;
  exactFrameSeek?: boolean;
  speed?: number;
  className?: string;
  onFrameSettled?: (stream: string, frameId: number) => void;
  onFrameUnavailable?: (stream: string, frameId: number) => void;
  onSourceFpsChange?: (stream: string, fps: number | null) => void;
  onNativeClockChange?: (stream: string, active: boolean) => void;
  onFramePresented?: (stream: string, frameId: number, timelinePosition: number) => void;
  onBufferingChange?: (stream: string, buffering: boolean) => void;
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
  isPrimary = false,
  playing = false,
  nativePlaybackEnabled = playing,
  readAheadEnabled = playing,
  readAheadFrames,
  readAheadStride = 1,
  playbackEndFrame,
  playbackFps = 30,
  exactFrameSeek = false,
  speed = 1,
  className = "",
  onFrameSettled,
  onFrameUnavailable,
  onSourceFpsChange,
  onNativeClockChange,
  onFramePresented,
  onBufferingChange,
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
  const lastNativeCorrectionRef = useRef(0);
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

  useEffect(() => {
    if (!isPrimary) return undefined;
    const supportsNativeClock = nativePlaybackEnabled
      && nativeVideoActive
      && videoRef.current !== null;
    onNativeClockChange?.(stream.name, supportsNativeClock);
    return () => onNativeClockChange?.(stream.name, false);
  }, [isPrimary, nativePlaybackEnabled, nativeVideoActive, onNativeClockChange, stream.name]);
  const alignFallbackFrame = (candidateFrameId: number) => nativeVideo && nativeVideoFailed
    ? sourceAlignedTimelineFrame(
      candidateFrameId,
      nativeVideo.startFrame,
      playbackFps,
      nativeVideo.fps,
    )
    : candidateFrameId;
  const fallbackPlaybackFrameId = playing && !isPrimary && !nativeVideo
    ? secondaryPlaybackFrame(
      frameId,
      0,
      playbackFps,
      playbackFps / Math.max(1, readAheadStride),
    )
    : frameId;
  const fallbackFrameId = clampStreamFrame(
    alignFallbackFrame(fallbackPlaybackFrameId),
    stream.firstFrame,
    stream.lastFrame,
  );
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
      // Seeking on a rounded PTS boundary can display the preceding frame.
      + (exactFrameSeek ? 0.5 / Math.max(nativeVideo.mediaFps, 1) : 0)
    : 0;
  requestedVideoTimeRef.current = Math.max(0, videoLocalSeconds);

  useEffect(() => {
    const video = videoRef.current;
    if (!nativeVideoActive || !video) return;
    video.playbackRate = speed * mediaClockRatio;
  }, [mediaClockRatio, nativeVideoActive, speed, videoSegmentIndex]);

  useEffect(() => {
    const video = videoRef.current;
    if (!nativeVideoActive || !video) return;
    if (!nativePlaybackEnabled) {
      video.pause();
      setVideoStatus("ready");
      onBufferingChange?.(stream.name, false);
      return;
    }
    let active = true;
    const resume = () => {
      if (!active || !video.paused || video.seeking || video.ended
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (exactFrameSeek && Math.abs(video.currentTime - requestedVideoTimeRef.current) > 0.03) {
        video.currentTime = requestedVideoTimeRef.current;
        return;
      }
      const remaining = Math.max(0, video.duration - video.currentTime);
      const runway = Math.min(1.5 * video.playbackRate, remaining);
      const buffered = Array.from({ length: video.buffered.length }, (_, index) => index)
        .some((index) => video.buffered.start(index) <= video.currentTime + 0.01
          && video.buffered.end(index) - video.currentTime >= runway - 0.02);
      if (isPrimary && !buffered) {
        setVideoStatus("buffering");
        onBufferingChange?.(stream.name, true);
        return;
      }
      void video.play().catch(() => { if (active) setVideoStatus("ready"); });
    };
    const waitForRunway = () => {
      if (!active || !isPrimary || video.ended) return;
      video.pause();
      setVideoStatus("buffering");
      onBufferingChange?.(stream.name, true);
    };
    // Browser buffers stay in memory. Resume only after a short runway, so
    // bursty NAS reads do not repeatedly start and stop the primary decoder.
    video.addEventListener("waiting", waitForRunway);
    video.addEventListener("progress", resume);
    video.addEventListener("canplay", resume);
    video.addEventListener("seeked", resume);
    const timer = window.setInterval(resume, 100);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA
      && Math.abs(video.currentTime - requestedVideoTimeRef.current) > 0.03) {
      video.currentTime = requestedVideoTimeRef.current;
    }
    resume();
    return () => {
      active = false;
      window.clearInterval(timer);
      video.removeEventListener("waiting", waitForRunway);
      video.removeEventListener("progress", resume);
      video.removeEventListener("canplay", resume);
      video.removeEventListener("seeked", resume);
    };
  }, [exactFrameSeek, isPrimary, nativePlaybackEnabled, nativeVideoActive, onBufferingChange, stream.name, videoSegmentIndex]);

  useEffect(() => {
    const video = videoRef.current;
    if (!nativeVideoActive || !video) return;
    // Native MP4 clocks are authoritative during continuous playback.
    // Re-seeking them from every React timeline tick causes visible stalls,
    // especially when a NAS-backed secondary stream is delayed. Paused seeks
    // and MP4 segment changes remain frame-accurate.
    if (playing) {
      if (isPrimary || video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      const now = performance.now();
      if (now - lastNativeCorrectionRef.current < 1000) return;
      const drift = videoLocalSeconds - video.currentTime;
      // Correct a recovered secondary stream only inside buffered media. This
      // avoids turning small decoder jitter into repeated NAS Range requests.
      const targetBuffered = Array.from({ length: video.buffered.length }, (_, index) => index)
        .some((index) => video.buffered.start(index) <= videoLocalSeconds
          && video.buffered.end(index) >= videoLocalSeconds + 0.1);
      if (Math.abs(drift) > 0.35 && targetBuffered) {
        lastNativeCorrectionRef.current = now;
        video.currentTime = Math.max(0, videoLocalSeconds);
      }
      return;
    }
    if (exactFrameSeek) {
      // Coalesce scrub events while decoding a seek; only the newest target survives.
      const seekLatest = () => {
        if (!video.seeking && Math.abs(video.currentTime - requestedVideoTimeRef.current) > 0.001) {
          video.currentTime = requestedVideoTimeRef.current;
        }
      };
      seekLatest();
      video.addEventListener("seeked", seekLatest);
      return () => video.removeEventListener("seeked", seekLatest);
    }
    if (Math.abs(video.currentTime - videoLocalSeconds) > 0.001) {
      video.currentTime = Math.max(0, videoLocalSeconds);
    }
  }, [exactFrameSeek, frameId, isPrimary, nativeVideoActive, playing, videoLocalSeconds, videoSegmentIndex]);

  useEffect(() => {
    if (!nativeVideoActive) return;
    const video = videoRef.current;
    if (!playing || !video || typeof video.requestVideoFrameCallback !== "function") {
      onFrameSettled?.(stream.name, frameId);
      return;
    }
    // The persistent primary presentation callback below already owns the
    // native playback clock. Avoid registering a second callback per frame.
    if (isPrimary && nativePlaybackEnabled) return;

    let active = true;
    let callbackId = 0;
    const targetTime = requestedVideoTimeRef.current;
    const settleWhenPresented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!active) return;
      // The callback can report the frame immediately before the requested
      // timeline position. Keep waiting until the decoder has presented the
      // requested time (or has moved beyond it by normal playback cadence).
      if (metadata.mediaTime + 0.002 < targetTime) {
        callbackId = video.requestVideoFrameCallback(settleWhenPresented);
        return;
      }
      onFrameSettled?.(stream.name, frameId);
    };
    callbackId = video.requestVideoFrameCallback(settleWhenPresented);
    return () => {
      active = false;
      if (callbackId && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
    };
  }, [frameId, isPrimary, nativePlaybackEnabled, nativeVideoActive, onFrameSettled, playing, stream.name]);

  useEffect(() => {
    if (!isPrimary || !nativePlaybackEnabled || !nativeVideoActive || !nativeVideo) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    let active = true;
    let callbackId = 0;
    const reportMediaTime = (mediaTime: number) => {
      if (!active) return;
      const timelinePosition = nativeVideoTimelinePosition(
        mediaTime,
        videoSegmentIndex,
        nativeVideo.segmentSeconds,
        nativeVideo.startFrame,
        playbackFps,
        nativeVideo.fps,
        nativeVideo.mediaFps,
      );
      onFramePresented?.(stream.name, Math.round(timelinePosition), timelinePosition);
    };
    if (typeof video.requestVideoFrameCallback !== "function") {
      // Older WebViews still follow media time, including when buffering stops
      // it. An independent UI timer would run ahead of a stalled decoder.
      const tick = () => {
        if (!active) return;
        callbackId = window.requestAnimationFrame(tick);
        if (!video.seeking) reportMediaTime(video.currentTime);
      };
      callbackId = window.requestAnimationFrame(tick);
      return () => {
        active = false;
        window.cancelAnimationFrame(callbackId);
      };
    }
    const reportPresentedFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!active) return;
      callbackId = video.requestVideoFrameCallback(reportPresentedFrame);
      reportMediaTime(metadata.mediaTime);
    };
    callbackId = video.requestVideoFrameCallback(reportPresentedFrame);
    return () => {
      active = false;
      if (callbackId && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
    };
  }, [
    isPrimary,
    nativePlaybackEnabled,
    nativeVideo,
    nativeVideoActive,
    onFramePresented,
    playbackFps,
    stream.name,
    videoSegmentIndex,
  ]);

  useEffect(() => {
    if (nativeVideoActive || !videoSourceChecked) return;
    const visible = framesRef.current[visibleSlotRef.current];
    if (visible?.key === requestKey) onFrameSettled?.(stream.name, frameId);
  }, [frameId, nativeVideoActive, onFrameSettled, requestKey, stream.name]);

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

  function discardFailedFrame(slot: FrameSlotIndex) {
    const nextFrames = [...framesRef.current] as FrameSlots;
    nextFrames[slot] = null;
    framesRef.current = nextFrames;
    if (stagedSlotRef.current === slot) stagedSlotRef.current = null;
    setFrames(nextFrames);
  }

  function settleFrameFailure(unavailableFrameId: number, failedSlot?: FrameSlotIndex) {
    if (!isPrimary) {
      // Keep the last visible secondary frame if its replacement fails. A
      // staged replacement can be discarded safely; removing the visible
      // slot would turn a transient NAS read into a blank tile.
      if (failedSlot !== undefined && failedSlot !== visibleSlotRef.current) {
        discardFailedFrame(failedSlot);
      }
      const visible = framesRef.current[visibleSlotRef.current];
      setStatus(visible?.streamKey === streamKey ? "ready" : "failed");
      onFrameSettled?.(stream.name, frameId);
      return;
    }

    clearCurrentStreamFrames();
    setStatus("failed");
    onFrameSettled?.(stream.name, frameId);
    reportFrameUnavailable({ frameId: unavailableFrameId });
  }

  function handleFrameError(slot: FrameSlotIndex, frame: CachedFrame) {
    if (requestedKeyRef.current !== frame.key || framesRef.current[slot]?.key !== frame.key) return;

    settleFrameFailure(frame.frameId, slot);
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
    if (nativeVideoActive || !videoSourceChecked) return;
    let active = true;
    const effectRequestKey = requestKey;
    const previousFrame = lastRequestedFrameRef.current;
    const retainsSequentialReadAhead = playing
      && previousFrame !== null
      && fallbackFrameId >= previousFrame
      && fallbackFrameId - previousFrame <= Math.max(1, fallbackFrameStride);
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
        settleFrameFailure(fallbackFrameId);
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
  }, [fallbackFrameId, fallbackFrameStride, isPrimary, nativePlaybackEnabled, nativeVideo, nativeVideoActive, nativeVideoFailed, playbackEndFrame, playbackFps, playing, readAheadEnabled, readAheadFrames, root, stream.lastFrame, stream.name, streamKey, videoSourceChecked]);

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
          onLoadedMetadata={() => {
            if (videoRef.current && Math.abs(videoRef.current.currentTime - requestedVideoTimeRef.current) > 0.001) {
              videoRef.current.currentTime = requestedVideoTimeRef.current;
            }
          }}
          onLoadedData={() => {
            setVideoStatus("ready");
            if (!nativePlaybackEnabled) onFrameSettled?.(stream.name, frameId);
          }}
          onPlaying={() => {
            setVideoStatus("playing");
            onBufferingChange?.(stream.name, false);
          }}
          onWaiting={() => setVideoStatus("buffering")}
          onStalled={() => setVideoStatus("buffering")}
          onEnded={() => {
            if (!isPrimary || !nativePlaybackEnabled || !videoRef.current) return;
            const position = nativeVideoTimelinePosition(
              videoRef.current.duration, videoSegmentIndex, nativeVideo.segmentSeconds,
              nativeVideo.startFrame, playbackFps, nativeVideo.fps, nativeVideo.mediaFps,
            );
            onFramePresented?.(stream.name, Math.round(position), position);
          }}
          onPause={() => { if (!nativePlaybackEnabled) setVideoStatus("ready"); }}
          onError={() => {
            setVideoStatus("fallback");
            setNativeVideoFailed(true);
            onBufferingChange?.(stream.name, false);
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
