import { useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { REJECTION_REASONS, normalizeReasonOrder, reorderReason } from "../lib/rejection-reasons";

export function RejectionReasons({ username, value, onChange, disabled }: {
  username: string; value: string; onChange: (reason: string) => void; disabled: boolean;
}) {
  const storageKey = `delta-viewer.rejection-order.v1:${encodeURIComponent(username)}`;
  const [order, setOrder] = useState(() => {
    try { return normalizeReasonOrder(JSON.parse(localStorage.getItem(storageKey) ?? "null")); }
    catch { return [...REJECTION_REASONS]; }
  });
  const [sorting, setSorting] = useState(false);
  const [error, setError] = useState("");
  const dragged = useRef<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  function save(next: string[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setOrder(next); setError("");
    } catch { setError("排序未保存，本机存储不可用，请稍后重试。"); }
  }
  return <>
    <div className="rejection-sort-tools">
      <span>{sorting ? "拖动标签调整顺序；其他原因固定右下角" : "可将常用原因排在前面"}</span>
      <button type="button" className="button button-secondary" disabled={disabled} onClick={() => { setSorting(!sorting); dragged.current = null; setTarget(null); }}>{sorting ? "完成排序" : "调整顺序"}</button>
      {sorting && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => save([...REJECTION_REASONS])}>恢复默认</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="rejection-options" role="group" aria-label="原因选项">
      {order.map((reason, index) => <button key={reason} autoFocus={index === 0} type="button"
        className={`button button-secondary${reason === "其他原因" ? " rejection-other" : ""}${target === reason ? " rejection-drop-target" : ""}`}
        aria-pressed={value === reason} disabled={disabled} draggable={sorting && reason !== "其他原因" && !disabled}
        title={sorting && reason !== "其他原因" ? "拖动排序，也可使用 Alt + 方向键移动" : undefined}
        onDragStart={event => { if (!sorting || disabled || reason === "其他原因") { event.preventDefault(); return; } dragged.current = reason; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", reason); }}
        onDragOver={event => { if (sorting && !disabled && dragged.current && reason !== "其他原因") { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTarget(reason); } }}
        onDrop={event => { event.preventDefault(); if (sorting && !disabled && dragged.current) save(reorderReason(order, dragged.current, reason)); dragged.current = null; setTarget(null); }}
        onDragEnd={() => { dragged.current = null; setTarget(null); }}
        onKeyDown={event => {
          if (!sorting || disabled || reason === "其他原因" || !event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 } as Record<string, number>)[event.key];
          const next = order[index + step];
          if (next) save(reorderReason(order, reason, next));
        }}
        onClick={() => { if (!sorting && !dragged.current) onChange(reason); }}>
        {sorting && reason !== "其他原因" && <GripVertical size={14} aria-hidden="true" />}{reason}
      </button>)}
    </div>
  </>;
}
