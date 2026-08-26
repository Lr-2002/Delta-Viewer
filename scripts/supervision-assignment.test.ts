import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentConflicts,
  defaultAssignmentQuantity,
  sameAssignmentQuantities,
  validateBatchAssignmentTotals,
  validateAssignmentSelection,
} from "../src/lib/supervisionAssignments.ts";
import { distributeBySpeed, distributeEvenly, distributeTaskTotals } from "../src/lib/operationsCockpit.ts";
import { deadlineAtEndOfDay, deadlineAtMinute, deadlineDateInput, deadlineDateLabel, deadlineDateTimeInput } from "../src/lib/deadlines.ts";
import { assignmentFilterForSource } from "../src/lib/assignedEpisodes.ts";
import type { AssignedTask, EpisodeSummary, SupervisionTaskSummary } from "../src/types.ts";

function task(taskName: string, total: number): SupervisionTaskSummary {
  return {
    task: taskName,
    completed: 0,
    total,
    completedFrames: 0,
    totalFrames: 0,
  };
}

test("accepts assignments sourced only from imported task JSON", () => {
  assert.equal(validateAssignmentSelection({ BedMaking: 3 }, [], ["BedMaking"]), null);
});

test("shows only assigned task ranges on a removable drive", () => {
  const episodes = [episode("/media/DOHC1TB/BedMaking/20260821_060700_recording")];
  assert.deepEqual(assignmentFilterForSource(episodes, [assignedTask("BedMaking")], "removable"), {
    episodes,
    taskByRoot: { [episodes[0].root]: "BedMaking" },
  });
});

test("keeps assignment filtering for a mounted NAS source", () => {
  const episodes = [
    episode("/mnt/Datasets/BedMaking/episode-001"),
    episode("/mnt/Datasets/Bedsheet/episode-001"),
  ];
  assert.deepEqual(
    assignmentFilterForSource(episodes, [assignedTask("BedMaking")], "remote"),
    { episodes: [episodes[0]], taskByRoot: { [episodes[0].root]: "BedMaking" } },
  );
});

test("matches assignments to dated NAS task folders with recording-style episode names", () => {
  const episodes = [
    episode("\\\\10.1.40.2\\Datasets\\DOHC\\Seed_sample\\2026-8-25-Washing\\20260824_002737_session"),
    episode("\\\\10.1.40.2\\Datasets\\DOHC\\Seed_sample\\2026-08-25-Box\\20260825_073237_session"),
  ];
  assert.deepEqual(
    assignmentFilterForSource(episodes, [assignedTask("Washing")], "remote"),
    { episodes: [episodes[0]], taskByRoot: { [episodes[0].root]: "Washing" } },
  );
  assert.deepEqual(
    assignmentFilterForSource(episodes, [assignedTask("Box")], "remote"),
    { episodes: [episodes[1]], taskByRoot: { [episodes[1].root]: "Box" } },
  );
});

test("keeps NAS task quantity bounds when a catalog is available", () => {
  assert.equal(
    validateAssignmentSelection({ BedMaking: 4 }, [task("BedMaking", 3)], []),
    "任务 BedMaking 的分配数量超过 NAS 中可用视频数量",
  );
});

test("rejects tasks absent from both current sources", () => {
  assert.equal(
    validateAssignmentSelection({ UnknownTask: 1 }, [task("BedMaking", 3)], ["Bedsheet"]),
    "任务 UnknownTask 不在当前任务 JSON 或 NAS 目录中",
  );
});

test("compares persisted assignments independent of key order and case", () => {
  assert.equal(
    sameAssignmentQuantities({ BedMaking: 3, Bedsheet: 2 }, { bedsheet: 2, bedmaking: 3 }),
    true,
  );
});

test("defaults a scanned task to every item in its folder", () => {
  assert.equal(defaultAssignmentQuantity("BedMaking", [task("BedMaking", 23)]), 23);
  assert.equal(defaultAssignmentQuantity("ImportedOnly", []), 1);
});

test("reports tasks already assigned to another operator", () => {
  const users = [{
    username: "operator2",
    displayName: "操作员二",
    role: "operator" as const,
    assignedTasks: 2,
    assignedTaskNames: ["BedMaking"],
    assignedTaskQuantities: { BedMaking: 2 },
    assignmentPlans: [],
    completedToday: 0,
    totalCompleted: 0,
    remainingTasks: 2,
    averageCompletionMs: null,
    completionRatePerHour: 0,
    estimatedCompletionAtMs: null,
    firstActivityAtMs: null,
    lastActivityAtMs: null,
    lastLoginAtMs: null,
    operationCount: 0,
    possibleStagnation: false,
    accountStatus: "active" as const,
  }];
  assert.deepEqual(assignmentConflicts("operator1", { bedmaking: 3 }, users), [{
    task: "bedmaking",
    assignees: ["操作员二"],
  }]);
});

test("distributes a batch evenly without losing remainder", () => {
  assert.deepEqual(distributeEvenly(8, ["a", "b", "c"]), [
    { username: "a", quantity: 3 },
    { username: "b", quantity: 3 },
    { username: "c", quantity: 2 },
  ]);
});

test("suggests more work for the historically faster operator", () => {
  const base = {
    displayName: "Operator",
    role: "operator" as const,
    assignedTasks: 0,
    assignedTaskNames: [],
    assignedTaskQuantities: {},
    assignmentPlans: [],
    completedToday: 0,
    totalCompleted: 0,
    remainingTasks: 0,
    estimatedCompletionAtMs: null,
    firstActivityAtMs: null,
    lastActivityAtMs: null,
    lastLoginAtMs: null,
    operationCount: 0,
    possibleStagnation: false,
    accountStatus: "active" as const,
  };
  const result = distributeBySpeed(12, [
    { ...base, username: "fast", averageCompletionMs: 60_000, completionRatePerHour: 60 },
    { ...base, username: "slow", averageCompletionMs: 180_000, completionRatePerHour: 20 },
  ]);
  assert.equal(result.reduce((sum, row) => sum + row.quantity, 0), 12);
  assert.ok(result[0].quantity > result[1].quantity);
});

test("distributes multiple selected tasks without losing any folder items", () => {
  const users = [
    operator("a", 60),
    operator("b", 30),
  ];
  const result = distributeTaskTotals([
    { task: "BedMaking", total: 5 },
    { task: "Bedsheet", total: 4 },
  ], users, "even");
  assert.deepEqual(result.map((item) => ({ task: item.task, shares: item.shares.map((share) => share.quantity) })), [
    { task: "BedMaking", shares: [3, 2] },
    { task: "Bedsheet", shares: [2, 2] },
  ]);
});

test("prevents a whole-folder batch from exceeding totals held by unselected operators", () => {
  const users = [
    { ...operator("selected", 10), assignedTaskNames: [], assignedTaskQuantities: {} },
    { ...operator("outside", 10), assignedTaskNames: ["BedMaking"], assignedTaskQuantities: { BedMaking: 2 } },
  ];
  assert.equal(
    validateBatchAssignmentTotals(["selected"], { BedMaking: 5 }, [task("BedMaking", 5)], users),
    "任务 BedMaking 仍有 2 条分配在未选标注员，当前批量分配会超过文件夹总量；请同时选择这些标注员或先移除原分配",
  );
  assert.equal(validateBatchAssignmentTotals(["selected", "outside"], { BedMaking: 5 }, [task("BedMaking", 5)], users), null);
});

test("stores exact minute deadlines and labels today", () => {
  const value = deadlineAtEndOfDay("2026-08-21");
  assert.ok(value);
  assert.equal(deadlineDateInput(value), "2026-08-21");
  assert.equal(new Date(value).getHours(), 23);
  assert.equal(deadlineDateLabel(value, new Date(2026, 7, 21, 9)), "截止 2026/8/21（今天） 23:59");
  assert.equal(deadlineAtEndOfDay("2026-02-31"), null);
  const exact = deadlineAtMinute("2026-08-21T18:40");
  assert.ok(exact);
  assert.equal(deadlineDateTimeInput(exact), "2026-08-21T18:40");
});

function operator(username: string, completionRatePerHour: number) {
  return {
    username,
    displayName: username,
    role: "operator" as const,
    assignedTasks: 0,
    assignedTaskNames: [],
    assignedTaskQuantities: {},
    assignmentPlans: [],
    completedToday: 0,
    totalCompleted: 0,
    remainingTasks: 0,
    averageCompletionMs: null,
    completionRatePerHour,
    estimatedCompletionAtMs: null,
    firstActivityAtMs: null,
    lastActivityAtMs: null,
    lastLoginAtMs: null,
    operationCount: 0,
    possibleStagnation: false,
    accountStatus: "active" as const,
  };
}

function assignedTask(taskName: string): AssignedTask {
  return {
    task: taskName,
    detail: taskName,
    quantity: 10,
    startIndex: 0,
    priority: "normal",
    deadlineAtMs: null,
    status: "active",
    order: 0,
    completed: 0,
    remaining: 10,
    estimatedCompletionAtMs: null,
  };
}

function episode(root: string): EpisodeSummary {
  return {
    root,
    name: root.split("/").at(-1) ?? root,
    totalFiles: 0,
    totalBytes: 0,
    stateCount: 0,
    indexed: false,
    streams: [],
  };
}
