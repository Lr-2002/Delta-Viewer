import type { SupervisionTaskSummary, SupervisionUserSummary } from "../types";

export interface AssignmentConflict {
  task: string;
  assignees: string[];
}

export function validateAssignmentSelection(
  quantities: Record<string, number>,
  catalogTasks: SupervisionTaskSummary[],
  importedTaskNames: string[],
): string | null {
  const available = new Map<string, SupervisionTaskSummary | null>();
  for (const task of importedTaskNames) available.set(task.toLowerCase(), null);
  for (const task of catalogTasks) available.set(task.task.toLowerCase(), task);

  if (available.size === 0) {
    return "请先导入任务 JSON 或读取 NAS 任务目录，再分配具体任务";
  }

  for (const [task, quantity] of Object.entries(quantities)) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return `任务 ${displayTaskName(task)} 的分配数量必须是正整数`;
    }
    const summary = available.get(task.toLowerCase());
    if (summary === undefined) {
      return `任务 ${displayTaskName(task)} 不在当前任务 JSON 或 NAS 目录中`;
    }
    if (summary && quantity > summary.total) {
      return `任务 ${displayTaskName(task)} 的分配数量超过 NAS 中可用视频数量`;
    }
  }
  return null;
}

export function sameAssignmentQuantities(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const normalize = (quantities: Record<string, number>) => Object.entries(quantities)
    .map(([task, quantity]) => [task.toLowerCase(), quantity] as const)
    .sort(([leftTask], [rightTask]) => leftTask.localeCompare(rightTask));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function defaultAssignmentQuantity(
  task: string,
  catalogTasks: SupervisionTaskSummary[],
): number {
  const summary = catalogTasks.find((item) => item.task.toLowerCase() === task.toLowerCase());
  return summary && summary.total > 0 ? summary.total : 1;
}

export function assignmentConflicts(
  username: string,
  quantities: Record<string, number>,
  users: SupervisionUserSummary[],
): AssignmentConflict[] {
  return Object.keys(quantities).flatMap((task) => {
    const assignees = users
      .filter((user) => user.username !== username
        && user.assignedTaskNames.some((assigned) => assigned.toLowerCase() === task.toLowerCase()))
      .map((user) => user.displayName || `@${user.username}`);
    return assignees.length ? [{ task, assignees }] : [];
  });
}

export function validateBatchAssignmentTotals(
  selectedUsernames: string[],
  totals: Record<string, number>,
  catalogTasks: SupervisionTaskSummary[],
  users: SupervisionUserSummary[],
): string | null {
  const selected = new Set(selectedUsernames);
  for (const [task, quantity] of Object.entries(totals)) {
    const summary = catalogTasks.find((item) => item.task.toLowerCase() === task.toLowerCase());
    if (!summary) continue;
    const assignedOutsideSelection = users
      .filter((user) => !selected.has(user.username))
      .reduce((sum, user) => sum + Object.entries(user.assignedTaskQuantities)
        .filter(([assigned]) => assigned.toLowerCase() === task.toLowerCase())
        .reduce((taskSum, [, assignedQuantity]) => taskSum + assignedQuantity, 0), 0);
    if (assignedOutsideSelection + quantity > summary.total) {
      return `任务 ${displayTaskName(task)} 仍有 ${assignedOutsideSelection} 条分配在未选标注员，当前批量分配会超过文件夹总量；请同时选择这些标注员或先移除原分配`;
    }
  }
  return null;
}

function displayTaskName(task: string): string {
  return task.replaceAll("_", " ");
}
