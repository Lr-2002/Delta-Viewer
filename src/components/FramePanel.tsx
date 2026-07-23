import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl } from "../lib/backend";
import {
  FRAME_READ_AHEAD_FRAMES,
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
  className?: string;
}

const frameCache = new FrameCache(async (request) => {
  const source = await frameUrl(request.root, request.stream, request.frameId);
  await decodeFrame(source);
  return source;
});

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

export function FramePanel({ root, stream, frameId, playing = false, className = "" }: FramePanelProps) {
  const requestKey = frameRequestKey({ root, stream: stream.name, frameId });
  const streamKey = frameStreamKey(root, stream.name);
  const [displayedFrame, setDisplayedFrame] = useState<CachedFrame | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const displayed = displayedFrame?.streamKey === streamKey ? displayedFrame : null;

  useEffect(() => {
    let active = true;
    setStatus("loading");
    frameCache.request({ root, stream: stream.name, frameId })
      .then((frame) => {
        if (active) {
          setDisplayedFrame(frame);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          // A failed requested frame must not leave an older frame looking current.
          setDisplayedFrame((current) => current?.streamKey === streamKey ? null : current);
          setStatus("failed");
        }
      });
    if (playing) {
      const lastFrame = stream.lastFrame ?? frameId;
      const readAheadEnd = Math.min(lastFrame, frameId + FRAME_READ_AHEAD_FRAMES);
      for (let nextFrame = frameId + 1; nextFrame <= readAheadEnd; nextFrame += 1) {
        frameCache.prefetch({ root, stream: stream.name, frameId: nextFrame });
      }
    }
    return () => {
      active = false;
    };
  }, [frameId, playing, root, stream.lastFrame, stream.name, streamKey]);

  return (
    <figure className={`frame-panel ${className}`}>
      {displayed ? (
        <img
          src={displayed.source}
          alt={`${stream.label} frame ${displayed.frameId}`}
          onError={() => {
            if (displayed.key !== requestKey) return;
            setDisplayedFrame(null);
            setStatus("failed");
          }}
        />
      ) : null}
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
