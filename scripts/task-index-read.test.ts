import assert from "node:assert/strict";
import test from "node:test";
import { createTaskIndexReader } from "../src/lib/task-index-read.ts";

test("blocked NAS reads time out without multiplying native workers; retry receives real data", async () => {
  let calls = 0;
  let finish!: (value: never) => void;
  const reader = createTaskIndexReader(async () => {
    calls++;
    return new Promise<never>((resolve) => { finish = resolve; });
  }, 20);
  await assert.rejects(reader("root", "batch"), /TASK_INDEX_TIMEOUT/);
  await assert.rejects(reader("root", "batch"), /TASK_INDEX_TIMEOUT/);
  assert.equal(calls, 1);
  const retry = reader("root", "batch");
  const actual = { catalog: null, server: { generation: "latest" } };
  finish(actual as never);
  assert.deepEqual(await retry, actual);
  const next = reader("root", "batch");
  await assert.rejects(next, /TASK_INDEX_TIMEOUT/);
  assert.equal(calls, 2, "a settled read releases its slot");
  finish(actual as never);
});

test("late failures remain retryable and different roots have independent requests", async () => {
  let calls = 0;
  const reader = createTaskIndexReader(async (root) => {
    calls++;
    if (root === "denied") throw new Error("access denied");
    return { catalog: null, server: { generation: root } } as never;
  });
  await assert.rejects(reader("denied"), /access denied/);
  await assert.rejects(reader("denied"), /access denied/);
  const result = await reader("different");
  assert.equal(result.server.generation, "different");
  assert.equal(calls, 3);
});

test("a fresh receipt read is not coalesced into a stale ordinary SMB read", async () => {
  const calls: (string | undefined)[] = [];
  const reader = createTaskIndexReader(async (_root, _path, receipt) => {
    calls.push(receipt);
    return { catalog: null, server: { generation: receipt ?? "old" } } as never;
  });
  const [old, latest] = await Promise.all([reader("root"), reader("root", "", "new-request")]);
  assert.equal(old.server.generation, "old");
  assert.equal(latest.server.generation, "new-request");
  assert.deepEqual(calls, [undefined, "new-request"]);
});
