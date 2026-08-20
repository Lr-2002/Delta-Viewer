import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentConflicts,
  defaultAssignmentQuantity,
  sameAssignmentQuantities,
  validateAssignmentSelection,
} from "../src/lib/supervisionAssignments.ts";
import { distributeBySpeed, distributeEvenly } from "../src/lib/operationsCockpit.ts";
import type { SupervisionTaskSummary } from "../src/types.ts";

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
  };
  const result = distributeBySpeed(12, [
    { ...base, username: "fast", averageCompletionMs: 60_000, completionRatePerHour: 60 },
    { ...base, username: "slow", averageCompletionMs: 180_000, completionRatePerHour: 20 },
  ]);
  assert.equal(result.reduce((sum, row) => sum + row.quantity, 0), 12);
  assert.ok(result[0].quantity > result[1].quantity);
});
