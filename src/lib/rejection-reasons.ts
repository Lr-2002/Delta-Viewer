export const REJECTION_REASONS = ["骨架抖动", "镜头污渍", "镜头遮挡", "动作错误", "画面过曝", "轨迹不动", "无效数据", "任务不符", "动作过快", "状态异常", "动作失范", "数据内容缺失", "其他原因"];
export const MAX_CUSTOM_REASONS = 20;
export const MAX_CUSTOM_REASON_LENGTH = 40;

export function customReasonError(value: string, existing: string[]): string {
  const reason = value.trim();
  if (!reason) return "请输入常用原因。";
  if ([...reason].length > MAX_CUSTOM_REASON_LENGTH) return "常用原因最多 40 字。";
  if (/[\r\n\u0000-\u001f\u007f]/.test(reason) || reason.startsWith("其他原因：")) return "请填写单行原因名称，不要添加“其他原因：”前缀。";
  if (REJECTION_REASONS.includes(reason) || existing.includes(reason)) return "这个原因已经存在，请直接使用已有按钮。";
  if (existing.length >= MAX_CUSTOM_REASONS) return "最多添加 20 个常用原因，请先移除不再使用的原因。";
  return "";
}

export function normalizeCustomReasons(saved: unknown): string[] {
  const custom: string[] = [];
  if (Array.isArray(saved)) for (const value of saved) {
    if (typeof value !== "string") continue;
    if (!customReasonError(value, custom)) custom.push(value.trim());
  }
  return custom;
}

export function normalizeReasonOrder(saved: unknown, custom: string[] = []): string[] {
  const available = [...REJECTION_REASONS.filter(reason => reason !== "其他原因"), ...normalizeCustomReasons(custom)];
  const ordered = Array.isArray(saved) ? saved.filter((reason): reason is string => typeof reason === "string" && available.includes(reason)) : [];
  return [...new Set([...ordered, ...available]), "其他原因"];
}

export function reorderReason(order: string[], from: string, to: string, custom: string[] = []): string[] {
  const next = normalizeReasonOrder(order, custom);
  const start = next.indexOf(from), end = next.indexOf(to);
  if (start < 0 || end < 0 || from === "其他原因" || to === "其他原因") return next;
  next.splice(end, 0, ...next.splice(start, 1));
  return next;
}

export function rejectionReasonValue(reason: string, custom: string[]): string {
  return custom.includes(reason) ? `其他原因：${reason}` : reason;
}
