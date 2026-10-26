import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";

export function UpdateToast({ title, message, primaryLabel, secondaryLabel, onPrimary, onDismiss, autoDismiss = true, className = "", ariaLabel = "版本更新提示" }: {
  title: string; message: string; primaryLabel: string; secondaryLabel: string;
  onPrimary: () => void; onDismiss: () => void; autoDismiss?: boolean; className?: string; ariaLabel?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [closing, setClosing] = useState(false);
  const remaining = useRef(10_000);
  const afterClose = useRef<(() => void) | null>(null);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;

  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!autoDismiss || hovered || focused || hidden || closing) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setClosing(true), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [autoDismiss, hovered, focused, hidden, closing]);
  useEffect(() => {
    if (!closing) return;
    // Keep exit completion reliable even when animations are reduced or disabled.
    const timer = window.setTimeout(() => { dismiss.current(); afterClose.current?.(); }, 180);
    return () => window.clearTimeout(timer);
  }, [closing]);
  function close(action?: () => void) {
    if (closing) return;
    afterClose.current = action ?? null;
    setClosing(true);
  }
  return <aside className={`update-notice ${className}${closing ? " update-notice-closing" : ""}`} aria-label={ariaLabel} role="status" aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <header><span className="update-notice-icon" aria-hidden="true"><Bell size={17} /></span><strong>{title}</strong>
      <button type="button" className="icon-button" aria-label="关闭更新提示" title="关闭更新提示" onClick={() => close()}><X size={16} /></button>
    </header>
    <p>{message}</p>
    <div className="update-actions">
      <button type="button" className="text-button" onClick={() => close(onPrimary)}>{primaryLabel}</button>
      <button type="button" className="text-button" onClick={() => close()}>{secondaryLabel}</button>
    </div>
  </aside>;
}
