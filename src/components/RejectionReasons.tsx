import { useEffect, useRef, useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { REJECTION_REASONS, normalizeCustomReasons, normalizeReasonOrder, reorderReason, customReasonError, rejectionReasonValue } from "../lib/rejection-reasons";

import "./rejection-reasons.css";

export function RejectionReasons({ username, value, onChange, disabled }: {
  username: string; value: string; onChange: (reason: string) => void; disabled: boolean;
}) {
  const legacyKey = `delta-viewer.rejection-order.v1:${encodeURIComponent(username)}`;
  const storageKey = `delta-viewer.rejection-options.v2:${encodeURIComponent(username)}`;
  function readOptions() {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw) : null;
      const custom = normalizeCustomReasons(saved?.custom);
      return { custom, order: normalizeReasonOrder(saved?.order ?? JSON.parse(localStorage.getItem(legacyKey) ?? "null"), custom) };
    } catch { return { custom: [], order: [...REJECTION_REASONS] }; }
  }
  const [options, setOptions] = useState(readOptions);
  const {order, custom} = options;
  const [sorting, setSorting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const dragged = useRef<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== storageKey) return;
      if (event instanceof CustomEvent && event.detail !== storageKey) return;
      setOptions(readOptions());
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("delta-rejection-options", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("delta-rejection-options", refresh); };
  }, [storageKey]);
  function save(next: string[], nextCustom = custom): boolean {
    try {
      const updated = {custom: nextCustom, order: normalizeReasonOrder(next, nextCustom)};
      localStorage.setItem(storageKey, JSON.stringify(updated));
      // Retain the existing order key for older versions; v2 remains atomic.
      try { localStorage.setItem(legacyKey, JSON.stringify(updated.order)); } catch { /* v2 is already durable */ }
      setOptions(updated); setError("");
      window.dispatchEvent(new CustomEvent("delta-rejection-options", {detail: storageKey}));
      return true;
    } catch { setError("常用原因或排序未保存，本机存储不可用，请稍后重试。"); return false; }
  }
  function addReason() {
    if (disabled) return;
    const current = readOptions();
    const message = customReasonError(draft, current.custom);
    if (message) { setError(message); return; }
    const reason = draft.trim();
    if (save([...current.order.filter(item => item !== "其他原因"), reason], [...current.custom, reason])) {
      setDraft(""); setAdding(false);
    }
  }
  function removeReason(reason: string) {
    if (disabled) return;
    const current = readOptions();
    if (save(current.order.filter(item => item !== reason), current.custom.filter(item => item !== reason)) && value === rejectionReasonValue(reason, current.custom)) onChange("");
  }
  return <>
    <div className="rejection-sort-tools">
      <span>{sorting ? "拖动标签调整顺序；其他原因固定右下角" : "可将常用原因排在前面"}</span>
      <button type="button" className="button button-secondary" disabled={disabled} onClick={() => { setAdding(!adding); setError(""); }}><Plus size={14} aria-hidden="true" />添加常用原因</button>
      <button type="button" className="button button-secondary" disabled={disabled} onClick={() => { setSorting(!sorting); dragged.current = null; setTarget(null); }}>{sorting ? "完成排序" : "调整顺序"}</button>
      {sorting && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => save(normalizeReasonOrder(null, custom))}>恢复默认</button>}
    </div>
    {adding && <div className="rejection-custom-editor">
      <label>常用原因名称<input autoFocus aria-label="常用原因名称" value={draft} maxLength={80} disabled={disabled} placeholder="例如：视频不同步" onChange={event => { setDraft(event.target.value); setError(""); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); addReason(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAdding(false); setError(""); }
      }} /></label>
      <p className="rejection-custom-hint">最多 40 字，可添加 20 个。仅保存在当前账号的本机，单条与批量共用。</p>
      <div className="rejection-custom-actions"><button type="button" className="button button-primary" disabled={disabled || !draft.trim()} onClick={addReason}>保存常用原因</button><button type="button" className="button button-secondary" disabled={disabled} onClick={() => { setAdding(false); setError(""); }}>取消添加</button></div>
    </div>}
    {sorting && custom.length > 0 && <ul className="rejection-custom-list" aria-label="管理自定义原因">{custom.map(reason => <li key={reason}><span>{reason}</span><button type="button" className="button button-secondary" disabled={disabled} aria-label={`移除常用原因 ${reason}`} onClick={() => removeReason(reason)}>移除</button></li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    <div className="rejection-options" role="group" aria-label="原因选项">
      {order.map((reason, index) => <button key={reason} autoFocus={index === 0} type="button"
        className={`button button-secondary${reason === "其他原因" ? " rejection-other" : ""}${target === reason ? " rejection-drop-target" : ""}`}
        aria-pressed={value === rejectionReasonValue(reason, custom)} disabled={disabled} draggable={sorting && reason !== "其他原因" && !disabled}
        title={sorting && reason !== "其他原因" ? "拖动排序，也可使用 Alt + 方向键移动" : undefined}
        onDragStart={event => { if (!sorting || disabled || reason === "其他原因") { event.preventDefault(); return; } dragged.current = reason; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", reason); }}
        onDragOver={event => { if (sorting && !disabled && dragged.current && reason !== "其他原因") { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTarget(reason); } }}
        onDrop={event => { event.preventDefault(); if (sorting && !disabled && dragged.current) save(reorderReason(order, dragged.current, reason, custom)); dragged.current = null; setTarget(null); }}
        onDragEnd={() => { dragged.current = null; setTarget(null); }}
        onKeyDown={event => {
          if (!sorting || disabled || reason === "其他原因" || !event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 } as Record<string, number>)[event.key];
          const next = order[index + step];
          if (next) save(reorderReason(order, reason, next, custom));
        }}
        onClick={() => { if (!sorting && !dragged.current) onChange(rejectionReasonValue(reason, custom)); }}>
        {sorting && reason !== "其他原因" && <GripVertical size={14} aria-hidden="true" />}{reason}
      </button>)}
    </div>
  </>;
}
