import type { BatchClaim, TaskNode } from "./task-center";

export interface TaskFilters { owner: string; name: string; dateFrom: string; dateTo: string }
export const emptyTaskFilters = (): TaskFilters => ({ owner: "", name: "", dateFrom: "", dateTo: "" });

export function batchCollectionDate(name: string): string | null {
  const date = /^(\d{4}-\d{2}-\d{2})(?:\D|$)/.exec(name)?.[1];
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

export function matchesTaskBatch(node: TaskNode, claim: BatchClaim | undefined, filters: TaskFilters): boolean {
  const name = filters.name.trim().toLocaleLowerCase();
  if (name && !node.name.toLocaleLowerCase().includes(name)) return false;
  const owner = filters.owner.trim().toLocaleLowerCase().replace(/^@/, "");
  if (owner === "未领取") { if (claim) return false; }
  else if (owner && (!claim || !`${claim.displayName}\n${claim.username}`.toLocaleLowerCase().includes(owner))) return false;
  if (filters.dateFrom || filters.dateTo) {
    const date = batchCollectionDate(node.name);
    if (!date || (filters.dateFrom && date < filters.dateFrom) || (filters.dateTo && date > filters.dateTo)) return false;
  }
  return true;
}
