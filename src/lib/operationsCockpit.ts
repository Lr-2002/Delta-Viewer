import type { SupervisionUserSummary } from "../types";

export interface AllocationShare {
  username: string;
  quantity: number;
}

export function distributeEvenly(total: number, usernames: string[]): AllocationShare[] {
  const quantity = Math.max(0, Math.floor(total));
  if (!usernames.length || quantity === 0) return usernames.map((username) => ({ username, quantity: 0 }));
  const base = Math.floor(quantity / usernames.length);
  const remainder = quantity % usernames.length;
  return usernames.map((username, index) => ({
    username,
    quantity: base + (index < remainder ? 1 : 0),
  }));
}

export function distributeBySpeed(total: number, users: SupervisionUserSummary[]): AllocationShare[] {
  const quantity = Math.max(0, Math.floor(total));
  if (!users.length || quantity === 0) return users.map((user) => ({ username: user.username, quantity: 0 }));
  const weights = users.map((user) => Math.max(
    user.completionRatePerHour,
    user.averageCompletionMs && user.averageCompletionMs > 0 ? 3_600_000 / user.averageCompletionMs : 0,
    0.1,
  ));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const raw = weights.map((weight) => quantity * weight / weightTotal);
  const shares = raw.map((value) => Math.floor(value));
  let remainder = quantity - shares.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) shares[order[index].index] += 1;
  return users.map((user, index) => ({ username: user.username, quantity: shares[index] }));
}

export function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
