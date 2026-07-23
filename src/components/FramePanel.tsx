import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl } from "../lib/backend";
import {
  FrameCache,
  frameRequestKey,
  frameStreamKey,
  type CachedFrame,
} from "../lib/frame-cache";
import type { StreamSummary } from "../types";

interface FramePanelProps {
  root: string;
  stream: StreamSummary;
  frameId: number;
  playing?: boolean;
  playbackEndFrame: number;
  className?: string;
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

export function FramePanel({
  root,
  stream,
  frameId,
  playing = false,
  playbackEndFrame,
  className = "",
}: FramePanelProps) {
  const requestKey = frameRequestKey({ root, stream: stream.name, frameId });
  const streamKey = frameStreamKey(root, stream.name);
  const [frames, setFrames] = useState<FrameSlots>([null, null]);
  const [visibleSlot, setVisibleSlot] = useState<FrameSlotIndex>(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const framesRef = useRef<FrameSlots>([null, null]);
  const imageRefs = useRef<[HTMLImageElement | null, HTMLImageElement | null]>([null, null]);
  const requestedKeyRef = useRef(requestKey);
  const stagedSlotRef = useRef<FrameSlotIndex | null>(null);
  const visibleSlotRef = useRef<FrameSlotIndex>(0);
  function stageFrame(frame: CachedFrame) {
    const current = framesRef.current[visibleSlotRef.current];
    if (current?.streamKey === frame.streamKey && current.key === frame.key) {
      setStatus("ready");
      return;
    }

    const targetSlot = current?.streamKey === frame.streamKey
      ? alternateSlot(visibleSlotRef.current)
      : visibleSlotRef.current;
    const nextFrames = [...framesRef.current] as FrameSlots;
    nextFrames[targetSlot] = frame;
    framesRef.current = nextFrames;
    stagedSlotRef.current = targetSlot;
    setFrames(nextFrames);
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
  }

  useEffect(() => {
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
    let active = true;
    const effectRequestKey = requestKey;
    if (requestedKeyRef.current === effectRequestKey) setStatus("loading");
    frameCache.requestCurrent({ root, stream: stream.name, frameId })
      .then((frame) => {
        if (
          !active
          || requestedKeyRef.current !== effectRequestKey
          || frame.key !== effectRequestKey
        ) return;
        stageFrame(frame);
      })
      .catch(() => {
        if (!active || requestedKeyRef.current !== effectRequestKey) return;
        clearCurrentStreamFrames();
        setStatus("failed");
      });
    if (playing) {
      const streamEnd = stream.lastFrame ?? playbackEndFrame;
      frameCache.scheduleReadAhead({
        root,
        stream: stream.name,
        frameId,
        endFrame: Math.min(playbackEndFrame, streamEnd),
      });
    } else {
      frameCache.discardReadAhead(root, stream.name);
    }
    return () => {
      active = false;
      frameCache.discardReadAhead(root, stream.name);
    };
  }, [frameId, playbackEndFrame, playing, root, stream.lastFrame, stream.name, streamKey]);

  return (
    <figure className={`frame-panel ${className}`}>
      {frames.map((frame, slot) => {
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
      })}
      <figcaption>
        <span>{stream.label}</span>
        <span className="frame-resolution">
          {stream.width && stream.height ? `${stream.width}×${stream.height}` : "—"}
        </span>
      </figcaption>
      {status === "loading" && !playing ? <span className="frame-loading">解码中</span> : null}
      {status === "failed" ? (
        <span className="frame-error">
          <ImageOff size={18} aria-hidden="true" />
          帧不可用
        </span>
      ) : null}
    </figure>
  );
}
