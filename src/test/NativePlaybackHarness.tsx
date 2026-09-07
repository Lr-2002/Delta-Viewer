import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FramePanel } from "../components/FramePanel";
import type { StreamSummary } from "../types";
import "../styles.css";

declare global {
  interface Window {
    __nativePlayback: {
      seek: (frame: number) => void;
      play: (playing: boolean) => void;
      speed: (speed: number) => void;
    };
    __nativeStreams: StreamSummary[];
    __nativeEnd: number;
  }
}

function NativePlaybackHarness() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [buffering, setBuffering] = useState(false);
  const clockActive = useRef(false);
  const presented = useCallback((_stream: string, next: number) => {
    setFrame(Math.min(next, window.__nativeEnd));
    if (next >= window.__nativeEnd) setPlaying(false);
  }, []);
  const clockChanged = useCallback((_stream: string, active: boolean) => { clockActive.current = active; }, []);
  const bufferingChanged = useCallback((stream: string, value: boolean) => {
    if (stream === "cam0") setBuffering(value);
  }, []);
  useEffect(() => {
    window.__nativePlayback = {
      seek: (next) => { setPlaying(false); setFrame(next); },
      play: setPlaying,
      speed: setSpeed,
    };
  }, []);
  // Also exercises older FramePanel builds driven by the external UI clock.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (!clockActive.current) setFrame((current) => Math.min(window.__nativeEnd, current + 1));
    }, 1000 / (30 * speed));
    return () => clearInterval(timer);
  }, [playing, speed]);
  return <main>
    <output id="position" data-playing={playing}>{frame}</output>
    <div className="camera-grid">
      {window.__nativeStreams.map((stream, index) => <FramePanel
        key={stream.name} root="/native-playback-fixture" stream={stream}
        isPrimary={index === 0} frameId={frame} playing={playing}
        nativePlaybackEnabled={playing && (index === 0 || !buffering)} playbackFps={30} playbackEndFrame={window.__nativeEnd}
        speed={speed} className={`camera-${index}`} onFramePresented={presented}
        onNativeClockChange={clockChanged}
        onBufferingChange={bufferingChanged}
      />)}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<NativePlaybackHarness />);
