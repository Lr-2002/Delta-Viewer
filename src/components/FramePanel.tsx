import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl } from "../lib/backend";
import type { StreamSummary } from "../types";

interface FramePanelProps {
  root: string;
  stream: StreamSummary;
  frameId: number;
  playing?: boolean;
  className?: string;
}
export function FramePanel({ root, stream, frameId, playing = false, className = "" }: FramePanelProps) {
  const requestKey = `${root}\0${stream.name}\0${frameId}`;
  const [frame, setFrame] = useState<{
    key: string;
    source: string;
    status: "loading" | "ready" | "failed";
  }>(() => ({ key: requestKey, source: "", status: "loading" }));
  const current = frame.key === requestKey
    ? frame
    : { key: requestKey, source: "", status: "loading" as const };

  useEffect(() => {
    let active = true;
    const key = `${root}\0${stream.name}\0${frameId}`;
    setFrame({ key, source: "", status: "loading" });
    frameUrl(root, stream.name, frameId)
      .then((url) => {
        if (active) setFrame({ key, source: url, status: "loading" });
      })
      .catch(() => {
        if (active) setFrame({ key, source: "", status: "failed" });
      });
    return () => {
      active = false;
    };
  }, [frameId, root, stream.name]);

  return (
    <figure className={`frame-panel ${className}`}>
      {current.source && current.status !== "failed" ? (
        <img
          src={current.source}
          alt={`${stream.label} frame ${frameId}`}
          onLoad={() => setFrame((value) => value.key === requestKey
            ? { ...value, status: "ready" }
            : value)}
          onError={() => setFrame((value) => value.key === requestKey
            ? { key: requestKey, source: "", status: "failed" }
            : value)}
        />
      ) : null}
      <figcaption>
        <span>{stream.label}</span>
        <span className="frame-resolution">
          {stream.width && stream.height ? `${stream.width}×${stream.height}` : "—"}
        </span>
      </figcaption>
      {current.status === "loading" && !playing ? <span className="frame-loading">解码中</span> : null}
      {current.status === "failed" ? (
        <span className="frame-error">
          <ImageOff size={18} aria-hidden="true" />
          帧不可用
        </span>
      ) : null}
    </figure>
  );
}
