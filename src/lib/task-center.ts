import { Channel, invoke } from "@tauri-apps/api/core";

export interface TaskNode {
  name: string; relativePath: string; batchKey: string; session: boolean;
  status: string; error: string; total: number; reviewed: number;
  approved: number; rejected: number; errors: number; incomplete: boolean; scanning: boolean; children: TaskNode[];
}
export interface TaskCatalog { sourceRoot: string; tree: TaskNode; stats?: { elapsedMs: number; qcReads: number; cacheHits: number } }
export interface BatchClaim { batchKey: string; username: string; displayName: string; claimedAtMs: number }
export type TaskScanUpdate = { kind: "catalog"; catalog: TaskCatalog } | { kind: "batch"; node: TaskNode }
  | { kind: "progress"; sessions: number; path: string; elapsedMs: number };
const scans = new Map<string, { promise: Promise<TaskCatalog>; operationId: number; cancelling: boolean; listeners: Set<(update: TaskScanUpdate) => void> }>();
let nextOperationId = Date.now();
export function scanTaskCenter(sourceRoot: string, onUpdate: (update: TaskScanUpdate) => void, force = false): Promise<TaskCatalog> {
  const pending = scans.get(sourceRoot);
  if (pending?.cancelling) return pending.promise.catch(() => {}).then(() => scanTaskCenter(sourceRoot, onUpdate, force));
  if (pending) { pending.listeners.add(onUpdate); return pending.promise; }
  const listeners = new Set([onUpdate]);
  const onUpdateChannel = new Channel<TaskScanUpdate>();
  onUpdateChannel.onmessage = (update) => { for (const listener of listeners) listener(update); };
  const operationId = ++nextOperationId;
  const promise = invoke<TaskCatalog>("scan_task_center", { sourceRoot, operationId, force, onUpdate: onUpdateChannel })
    .finally(() => scans.delete(sourceRoot));
  scans.set(sourceRoot, { promise, operationId, cancelling: false, listeners });
  return promise;
}
export async function cancelTaskCenterScan(sourceRoot: string): Promise<void> {
  const scan = scans.get(sourceRoot);
  if (!scan) return;
  scan.cancelling = true;
  await invoke("cancel_task", { operationId: scan.operationId });
  await scan.promise.catch(() => {});
}

// Keep the last view while the panel is closed; it is never used to authorize a claim.
const catalogs = new Map<string, { catalog: TaskCatalog; updatedAt: number }>();
export const getCachedTaskCatalog = (owner: string, root: string) => catalogs.get(JSON.stringify([owner, root]));
export function markTaskCatalogStale(catalog: TaskCatalog): TaskCatalog {
  return { ...catalog, tree: { ...catalog.tree, scanning: true, children: catalog.tree.children.map((node) => ({ ...node, scanning: true })) } };
}
export function cacheTaskCatalog(owner: string, root: string, catalog: TaskCatalog) {
  const key = JSON.stringify([owner, root]);
  catalogs.delete(key);
  if (catalogs.size >= 2) catalogs.delete(catalogs.keys().next().value!);
  catalogs.set(key, { catalog, updatedAt: Date.now() });
}

export function mergeTaskBatch(catalog: TaskCatalog, node: TaskNode): TaskCatalog {
  const children = catalog.tree.children.map((child) => child.relativePath === node.relativePath ? node : child);
  const tree = { ...catalog.tree, children, total: 0, reviewed: 0, approved: 0, rejected: 0, errors: 0, incomplete: false, scanning: false };
  for (const child of children) {
    tree.total += child.total; tree.reviewed += child.reviewed; tree.approved += child.approved;
    tree.rejected += child.rejected; tree.errors += child.errors;
    tree.incomplete ||= child.incomplete; tree.scanning ||= child.scanning;
  }
  return { ...catalog, tree };
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
