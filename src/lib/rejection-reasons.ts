export const REJECTION_REASONS = ["骨架抖动", "镜头污渍", "镜头遮挡", "动作错误", "画面过曝", "轨迹不动", "无效数据", "任务不符", "动作过快", "状态异常", "动作失范", "其他原因"];

export function normalizeReasonOrder(saved: unknown): string[] {
  const available = REJECTION_REASONS.filter(reason => reason !== "其他原因");
  const ordered = Array.isArray(saved) ? saved.filter((reason): reason is string => typeof reason === "string" && available.includes(reason)) : [];
  return [...new Set([...ordered, ...available]), "其他原因"];
}

export function reorderReason(order: string[], from: string, to: string): string[] {
  const next = normalizeReasonOrder(order);
  const start = next.indexOf(from), end = next.indexOf(to);
  if (start < 0 || end < 0 || from === "其他原因" || to === "其他原因") return next;
  next.splice(end, 0, ...next.splice(start, 1));
  return next;
}
