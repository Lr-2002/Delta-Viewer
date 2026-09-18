import { invoke } from "@tauri-apps/api/core";

export interface TaskNode {
  name: string; relativePath: string; batchKey: string; session: boolean;
  status: string; error: string; total: number; reviewed: number;
  approved: number; rejected: number; errors: number; incomplete: boolean; children: TaskNode[];
}
export interface TaskCatalog { sourceRoot: string; tree: TaskNode }
export interface BatchClaim { batchKey: string; username: string; displayName: string; claimedAtMs: number }
const scans = new Map<string, Promise<TaskCatalog>>();
export function scanTaskCenter(sourceRoot: string): Promise<TaskCatalog> {
  const pending = scans.get(sourceRoot);
  if (pending) return pending;
  const scan = invoke<TaskCatalog>("scan_task_center", { sourceRoot }).finally(() => scans.delete(sourceRoot));
  scans.set(sourceRoot, scan);
  return scan;
}
export const getTaskCenterRoot = () => invoke<string | null>("get_task_center_root");
export const setTaskCenterRoot = (sourceRoot: string) => invoke<string>("set_task_center_root", { sourceRoot });
export async function lookupClaims(keys: string[]): Promise<BatchClaim[]> {
  const claims: BatchClaim[] = [];
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const result = await invoke<{ claims: BatchClaim[] }>("task_center_claims", { action: "lookup", body: { keys: keys.slice(offset, offset + 1000) } });
    claims.push(...result.claims);
  }
  return claims;
}
export const mutateClaim = (action: "claim" | "release" | "transfer", batchKey: string, username?: string) =>
  invoke<{ claim: BatchClaim | null }>("task_center_claims", { action, body: { batchKey, ...(username ? { username } : {}) } });
