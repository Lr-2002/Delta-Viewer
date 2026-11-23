import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Pencil, UserRound } from "lucide-react";
import { t } from "../lib/i18n";

export function DataWorkspaceMore({ account, onEdit, children }: {
  account?: { displayName: string; username: string } | null;
  onEdit?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
      aria-controls={panelId}
      aria-label={account ? t("账号菜单：{0} (@{1})", [account.displayName, account.username]) : t("工作区菜单")}
      onClick={() => setOpen(value => !value)}>
      <span className="data-account-avatar"><UserRound size={17} aria-hidden="true" /></span>
      <span className="data-account-identity">
        <strong>{account?.displayName || t("离线模式")}</strong>
        {account && <small>@{account.username}</small>}
      </span>
      <ChevronDown className="data-account-chevron" size={14} aria-hidden="true" />
    </button>
    <div id={panelId} className="data-more-panel" hidden={!open} onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest("button")) closeAndFocus();
    }}>
      {account && <div className="data-more-account">
        <span className="data-account-avatar"><UserRound size={17} aria-hidden="true" /></span>
        <span className="data-account-identity"><strong title={account.displayName}>{account.displayName}</strong><small title={`@${account.username}`}>@{account.username}</small></span>
        {onEdit && <button className="data-account-edit" type="button" onClick={onEdit} title={t("修改当前显示名称")} aria-label={t("修改当前显示名称")}><Pencil size={14} />{t("修改")}</button>}
      </div>}
      {children}
    </div>
  </div>;
}
