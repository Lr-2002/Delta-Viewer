import type { ReactNode } from "react";

interface TrimControlsProps {
  children?: ReactNode;
}

export function TrimControls({ children }: TrimControlsProps) {
  return <section className="trim-editor" aria-label="片段时间线">{children}</section>;
}
