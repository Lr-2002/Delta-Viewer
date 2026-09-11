import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openReviewAuditStore, validateReviewEvent } from "./review-audit-store.mjs";
import { reviewAuditQueue } from "../src/lib/review-audit-queue.ts";

const user = { username: "alice", displayName: "Alice", role: "operator" };
const event = (overrides = {}) => ({ eventId: randomUUID(), sessionId: randomUUID(), episodeKey: "a".repeat(64), episodeName: "episode-001", action: "loaded", occurredAtMs: Date.now(), elapsedMs: 0, details: {}, ...overrides });
class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}

test("durable review history is idempotent, paginated past 500 and survives restart", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "review-audit-"));
  let store = openReviewAuditStore(root);
  try {
    const start = Date.now() - 60000, sessionId = randomUUID();
    const approved = event({ sessionId, action: "approved", occurredAtMs: start + 42000, elapsedMs: 42000 });
    store.append(user, [approved]);
    store.append(user, [event({ sessionId, occurredAtMs: start }), approved]);
    store.append({ ...user, username: "bob" }, [approved]);
    let data = store.query({ username: "alice" }, [user]);
    assert.equal(data.total, 2);
    assert.equal(data.sessions[0].status, "approved");
    assert.equal(data.sessions[0].loadedAtMs, start);
    assert.equal(data.sessions[0].durationMs, 42000);
    assert.equal(data.users[0].averageMs, 42000);
    store.append(user, [event({ sessionId, action: "saved", elapsedMs: 45000, occurredAtMs: start + 45000 })]);
    assert.equal(store.query({ username: "alice" }, [user]).sessions[0].status, "pending");
    for (let i = 0; i < 30; i++) store.append(user, Array.from({ length: 20 }, () => event()));
    store.close(); store = openReviewAuditStore(root);
    const ids = new Set(); let before;
    do {
      data = store.query({ username: "alice", before, limit: 37 }, [user]);
      for (const row of data.events) { assert.ok(!ids.has(row.id)); ids.add(row.id); }
      before = data.nextBefore;
    } while (before);
    assert.equal(ids.size, 603);
    const sessions = new Set(); let sessionBefore;
    do {
      data = store.query({ username: "alice", sessionBefore, limit: 31 }, [user]);
      for (const row of data.sessions) { assert.ok(!sessions.has(row.sessionId)); sessions.add(row.sessionId); }
      sessionBefore = data.nextSessionBefore;
    } while (sessionBefore);
    assert.equal(sessions.size, 601);
    assert.equal(store.query({ action: "approved", username: "alice" }, [user]).total, 1);
    assert.equal(store.query({ fromMs: Date.now() + 10000 }, [user]).total, 0);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});

test("review payload accepts offline events and rejects spoofed or unbounded fields", () => {
  validateReviewEvent(event({ occurredAtMs: Date.now() - 90 * 86400000 }));
  for (const override of [{ username: "other" }, { path: "/media/private" }, { action: "unknown" }, { elapsedMs: -1 }, { occurredAtMs: Date.now() + 900000 }, { details: { password: "secret" } }, { details: { value: "x".repeat(2001) } }]) assert.throws(() => validateReviewEvent(event(override)), /REVIEW_EVENT_INVALID/);
});

test("queue retains failed sends across reload, isolates accounts and preserves concurrent additions", async () => {
  const storage = new Storage(), a = event(), b = event();
  const offline = reviewAuditQueue(storage, "service:alice", async () => { throw new Error("offline"); });
  offline.push(a);
  await assert.rejects(offline.flush(), /offline/);
  const received = [];
  const queue = reviewAuditQueue(storage, "service:alice", async (events) => { received.push(...events); queue.push(b); return { eventIds: events.map((row) => row.eventId) }; });
  assert.equal(reviewAuditQueue(storage, "service:bob", async () => ({ eventIds: [] })).count(), 0);
  assert.equal(await queue.flush(), 1);
  assert.deepEqual(received.map((row) => row.eventId), [a.eventId]);
  const restored = reviewAuditQueue(storage, "service:alice", async (events) => ({ eventIds: events.map((row) => row.eventId) }));
  assert.equal(await restored.flush(), 0);
  storage.setItem = () => { throw new Error("quota"); };
  assert.throws(() => restored.push(event()), /quota/);
  assert.equal(restored.volatileCount(), 1);
  assert.equal(await restored.flush(), 0);
  assert.equal(restored.volatileCount(), 0);
});
