import type { SupervisionTaskSummary } from "../types";

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

function displayTaskName(task: string): string {
  return task.replaceAll("_", " ");
}
