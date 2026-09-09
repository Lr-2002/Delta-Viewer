import React from "react";
import { createRoot } from "react-dom/client";
import { MachineAnnotationPanel } from "../../src/components/MachineAnnotationPanel";
import { createDemoSkeleton } from "../../src/lib/demoFixture";
import "../../src/styles.css";

if ((window as any).__proofSkeleton) {
  const skeleton = createDemoSkeleton({ episode: { stateCount: 90 } } as Parameters<typeof createDemoSkeleton>[0]);
  skeleton.usesTimelineFrameIds = true;
  skeleton.frames = skeleton.frames.map((frame) => ({ ...frame, frameId: frame.frameId * 2 }));
  (window as any).__proofData.skeleton = skeleton;
}

createRoot(document.getElementById("root")!).render(<MachineAnnotationPanel
  data={(window as any).__proofData} busy={false}
  onComplete={(status) => { (window as any).__proofCompletion = status; }} />);
