import assert from "node:assert/strict";
import test from "node:test";
import { createAuditFlusher } from "../src/lib/audit-flush.ts";

const event = (eventId) => ({ eventId, action: "episode_opened", taskId: "task", trajectoryCode: "", occurredAtMs: 1 });

test("concurrent flushes preserve events enqueued during upload", async () => {
  let queue = [event("first")];
  let release;
  const sent = [];
  const flush = createAuditFlusher(() => [...queue], (next) => { queue = next; }, async (item) => {
    sent.push(item.eventId);
    await new Promise((resolve) => { release = resolve; });
  });
  const active = flush();
  assert.equal(flush(), active);
  queue.push(event("new"));
  release();
  assert.equal(await active, 1);
  assert.deepEqual(queue.map((item) => item.eventId), ["new"]);
  assert.deepEqual(sent, ["first"]);
});

test("authentication failure stops the batch and retains unacknowledged events for retry", async () => {
  let queue = [event("first"), event("second")];
  let fail = true;
  const sent = [];
  const flush = createAuditFlusher(() => [...queue], (next) => { queue = next; }, async (item) => {
    sent.push(item.eventId);
    if (fail) throw new Error("AUTH_REQUIRED");
  });
  await assert.rejects(flush(), /AUTH_REQUIRED/);
  assert.equal(queue.length, 2);
  assert.deepEqual(sent, ["first"]);
  fail = false;
  assert.equal(await flush(), 0);
  assert.equal(queue.length, 0);
});
