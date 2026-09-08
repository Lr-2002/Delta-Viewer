import React from "react";
import { createRoot } from "react-dom/client";
import { MachineAnnotationPanel } from "../../src/components/MachineAnnotationPanel";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<MachineAnnotationPanel
  data={(window as any).__proofData} annotation={null} busy={false}
  currentFrame={0} previewing={false} onPreview={() => {}} onExitPreview={() => {}} />);
