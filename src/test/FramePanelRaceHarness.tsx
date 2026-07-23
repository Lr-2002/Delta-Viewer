import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FramePanel } from "../components/FramePanel";
import type { StreamSummary } from "../types";
import "../styles.css";

declare global {
  interface Window {
    __framePanelRace?: { seek: (frameId: number) => void };
    __framePanelRaceRelease?: () => void;
  }
}

const streamMetadata: Array<[name: string, label: string, width: number, height: number]> = [
  ["cam0", "Camera 0", 1920, 1080],
  ["cam1", "Camera 1", 1280, 720],
  ["cam2", "Camera 2", 1280, 720],
  ["t265_left", "T265 Left", 848, 800],
  ["t265_right", "T265 Right", 848, 800],
];

const streams: StreamSummary[] = streamMetadata.map(([name, label, width, height]) => ({
  name,
  label,
  frameCount: 9,
  firstFrame: 0,
  lastFrame: 8,
  missingFrames: [],
  missingFrameCount: 0,
  totalBytes: 1,
  width,
  height,
  channels: 3,
}));

function ReleaseSupersededFailure({ frameId }: { frameId: number }) {
  useLayoutEffect(() => {
    if (frameId === 5) window.__framePanelRaceRelease?.();
  }, [frameId]);

  return null;
}

function FramePanelRaceHarness() {
  const [frameId, setFrameId] = useState(3);

  useEffect(() => {
    window.__framePanelRace = { seek: setFrameId };
    return () => {
      delete window.__framePanelRace;
    };
  }, []);

  return (
    <main>
      <span className="race-frame-counter">Frame {frameId}</span>
      <div className="camera-grid race-grid">
        {streams.map((stream, index) => (
          <FramePanel
            key={stream.name}
            root="/frame-panel-race"
            stream={stream}
            frameId={frameId}
            playbackEndFrame={8}
            className={`camera-${index}`}
          />
        ))}
        <ReleaseSupersededFailure frameId={frameId} />
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("FramePanel race harness root is missing");

createRoot(container).render(<FramePanelRaceHarness />);
