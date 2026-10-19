import assert from "node:assert/strict";
import test from "node:test";
import { batchCollectionDate, emptyTaskFilters, matchesTaskBatch } from "../src/lib/task-center-filter.ts";
import type { BatchClaim, TaskNode } from "../src/lib/task-center";

test("collection date uses a valid folder date, not the claim timestamp", () => {
  assert.equal(batchCollectionDate("2026-09-20-Dish Washer"), "2026-09-20");
  assert.equal(batchCollectionDate("2026-02-30-错误"), null);
  assert.equal(batchCollectionDate("其他"), null);
});
test("owner, folder name and inclusive date range combine without mutating QC", () => {
  const node = { name: "2026-09-20-Dish Washer", reviewed: 616, total: 616 } as TaskNode;
  const claim = { username: "delta", displayName: "审核甲", claimedAtMs: Date.UTC(2026, 9, 19) } as BatchClaim;
  const filters = { owner: "审核甲", name: "dish", dateFrom: "2026-09-20", dateTo: "2026-09-20" };
  assert.equal(matchesTaskBatch(node, claim, filters), true);
  assert.equal(matchesTaskBatch(node, claim, { ...filters, owner: "@DELTA" }), true);
  assert.equal(matchesTaskBatch(node, claim, { ...filters, dateFrom: "2026-09-21" }), false);
  assert.equal(matchesTaskBatch(node, claim, { ...filters, owner: "未领取" }), false);
  assert.equal(matchesTaskBatch(node, undefined, { ...emptyTaskFilters(), owner: "未领取" }), true);
  assert.equal(matchesTaskBatch(node, undefined, filters), false);
  assert.equal(matchesTaskBatch({ ...node, name: "无日期" }, claim, { ...emptyTaskFilters(), dateTo: "2026-10-19" }), false);
  assert.equal(node.reviewed, 616);
});
