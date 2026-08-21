export function localDateInput(value = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function deadlineAtEndOfDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const deadline = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(deadline.getTime()) || localDateInput(deadline) !== value ? null : deadline.getTime();
}

export function deadlineDateInput(value: number | null): string {
  return value ? localDateInput(new Date(value)) : "";
}

export function isTodayDate(value: string, now = new Date()): boolean {
  return Boolean(value) && value === localDateInput(now);
}

export function deadlineDateLabel(value: number | null, now = new Date()): string {
  if (!value) return "无截止日期";
  const deadline = new Date(value);
  const date = deadline.toLocaleDateString("zh-CN");
  return `截止 ${date}${localDateInput(deadline) === localDateInput(now) ? "（今天）" : ""}`;
}
