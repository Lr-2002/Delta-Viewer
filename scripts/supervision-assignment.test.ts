import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentConflicts,
  defaultAssignmentQuantity,
  sameAssignmentQuantities,
  validateAssignmentSelection,
} from "../src/lib/supervisionAssignments.ts";
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
    completedToday: 0,
    totalCompleted: 0,
    averageCompletionMs: null,
  }];
  assert.deepEqual(assignmentConflicts("operator1", { bedmaking: 3 }, users), [{
    task: "bedmaking",
    assignees: ["操作员二"],
  }]);
});
