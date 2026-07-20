import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { frameUrl } from "../lib/backend";
import type { StreamSummary } from "../types";

interface FramePanelProps {
  root: string;
  stream: StreamSummary;
  frameId: number;
  className?: string;
}
export function FramePanel({ root, stream, frameId, className = "" }: FramePanelProps) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    frameUrl(root, stream.name, frameId)
      .then((url) => {
        if (active) setSource(url);
      })
      .catch(() => {
        if (active) {
          setSource("");
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [frameId, root, stream.name]);

  return (
    <figure className={`frame-panel ${className}`}>
      {source && !failed ? (
        <img
          src={source}
          alt={`${stream.label} frame ${frameId}`}
          onLoad={() => setLoading(false)}
          onError={() => {
            setFailed(true);
            setLoading(false);
          }}
        />
      ) : null}
      <figcaption>
        <span>{stream.label}</span>
        <span className="frame-resolution">
          {stream.width && stream.height ? `${stream.width}×${stream.height}` : "—"}
        </span>
      </figcaption>
      {loading && !failed ? <span className="frame-loading">解码中</span> : null}
      {failed ? (
        <span className="frame-error">
          <ImageOff size={18} aria-hidden="true" />
          帧不可用
        </span>
      ) : null}
    </figure>
  );
}
