import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { t } from "../lib/i18n";

export function DataWorkspaceMore({ errors, children }: { errors: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: Event) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

  return <div className="data-workspace-more" ref={container} onKeyDown={event => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeAndFocus();
  }}>
    <button ref={trigger} type="button" className="button button-secondary data-more-trigger" aria-expanded={open}
      aria-controls="data-workspace-more-panel"
      aria-label={errors ? t("更多，有 {0} 条操作错误", [errors]) : t("更多")}
      onClick={() => setOpen(value => !value)}>
      <Ellipsis size={17} />{t("更多")}
      {errors > 0 && <span className="data-error-count" aria-hidden="true">{errors > 99 ? "99+" : errors}</span>}
    </button>
    <div id="data-workspace-more-panel" className="data-more-panel" hidden={!open} onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest("button")) closeAndFocus();
    }}>
      {children}
    </div>
  </div>;
}
