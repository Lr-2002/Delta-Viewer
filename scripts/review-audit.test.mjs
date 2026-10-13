import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openReviewAuditStore, validateReviewEvent } from "./review-audit-store.mjs";
import { reviewAuditQueue } from "../src/lib/review-audit-queue.ts";
import { durableReviewAuditQueue } from "../src/lib/durable-review-audit-queue.ts";

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

test("native queue migrates full browser storage only after disk commit and preserves offline records", async () => {
  const storage = new Storage(), a = event(), b = event();
  const prefix = "dohc.review-audit.v1:service%3Aalice:";
  storage.setItem(prefix + a.eventId, JSON.stringify(a));
  storage.setItem("dohc.review-audit.v1:service%3Abob:" + b.eventId, JSON.stringify(b));
  storage.setItem("label-library", "keep");
  storage.setItem = () => { throw Error("quota"); };
  const disk = new Map();
  let online = false, failDisk = true;
  const backend = {
    async persist(events) {
      if (failDisk) throw Error("disk unavailable");
      for (const row of events) disk.set(row.eventId,row);
      return { pending: disk.size, blocked: 0, error: "" };
    },
    async flush() {
      if (!online) return { pending: disk.size, blocked: 0, error: "AUTH_REQUIRED" };
      disk.clear(); return { pending: 0, blocked: 0, error: "" };
    },
  };
  let message = "";
  const queue = durableReviewAuditQueue(storage,"service:alice",backend,(value) => { message=value; });
  queue.push(b);
  await assert.rejects(queue.persist(), /disk unavailable/);
  assert.equal(queue.volatileCount(),1);
  assert.ok(storage.getItem(prefix+a.eventId),"failed migration must preserve old record");
  failDisk=false;
  assert.equal(await queue.flush(),2);
  assert.equal(queue.volatileCount(),0);
  assert.equal(storage.getItem(prefix+a.eventId),null);
  assert.equal(storage.getItem("label-library"),"keep");
  assert.ok(storage.getItem("dohc.review-audit.v1:service%3Abob:"+b.eventId));
  assert.match(message,/AUTH_REQUIRED/);
  assert.match(message,/已保存在本机/);
  queue.push(event());
  await queue.persist();
  assert.match(message,/AUTH_REQUIRED/,"new disk writes must not hide the reauthentication prompt");
  const reopened=durableReviewAuditQueue(storage,"service:alice",backend,()=>{});
  assert.equal(await reopened.flush(),3);
  online=true;
  assert.equal(await reopened.flush(),0);
});

test("native migration handles concurrent additions and retains malformed legacy records", async () => {
  const storage=new Storage(), a=event(), b=event();
  const prefix="dohc.review-audit.v1:service%3Aalice:";
  storage.setItem(prefix+"broken","{bad");
  let release, started;
  const ready=new Promise((resolve)=>{started=resolve;});
  const disk=new Map(); let first=true, message="";
  const queue=durableReviewAuditQueue(storage,"service:alice",{
    async persist(events) {
      if(first) { first=false; started(); await new Promise((resolve)=>{release=resolve;}); }
      for(const row of events) disk.set(row.eventId,row);
      return {pending:disk.size,blocked:0,error:""};
    },
    async flush(){return {pending:disk.size,blocked:0,error:"offline"};},
  },(value)=>{message=value;});
  queue.push(a); await ready; queue.push(b); release(); await queue.persist();
  assert.equal(disk.size,2);
  assert.equal(queue.volatileCount(),0);
  assert.equal(storage.getItem(prefix+"broken"),"{bad");
  assert.match(message,/无法解析/);
});

test("invalid native acknowledgements retain both memory and legacy events", async () => {
  const storage=new Storage(), a=event();
  const key="dohc.review-audit.v1:service%3Aalice:"+a.eventId;
  storage.setItem(key,JSON.stringify(a));
  let message="";
  const queue=durableReviewAuditQueue(storage,"service:alice",{
    persist:async()=>null,flush:async()=>null,
  },value=>{message=value;});
  queue.push(event());
  await assert.rejects(queue.persist(),/状态无效/);
  await queue.flush();
  assert.equal(queue.volatileCount(),1);
  assert.ok(storage.getItem(key));
  assert.match(message,/状态无效/);
});

test("native persistence waits for operations added during legacy migration", async () => {
  const storage = new Storage(), legacy = event(), submitted = event({ action: "approved" });
  storage.setItem("dohc.review-audit.v1:service%3Aalice:" + legacy.eventId, JSON.stringify(legacy));
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const disk = new Map();
  const queue = durableReviewAuditQueue(storage, "service:alice", {
    async persist(events) {
      if (events.some(row => row.eventId === legacy.eventId)) {
        entered(); await new Promise(resolve => { release = resolve; });
      }
      for (const row of events) disk.set(row.eventId, row);
      return { pending: disk.size, blocked: 0, error: "" };
    },
    async flush() { return { pending: disk.size, blocked: 0, error: "offline" }; },
  }, () => {});
  const saving = queue.persist();
  await started;
  queue.push(submitted);
  release();
  await saving;
  assert.equal(queue.volatileCount(), 0);
  assert.deepEqual(new Set(disk.keys()), new Set([legacy.eventId, submitted.eventId]));
});

test("queue health distinguishes storage, transport, and rejected events across restart", async () => {
  const storage = new Storage(), disk = new Map();
  const oldest = event({ occurredAtMs: 1700000000000 });
  disk.set(oldest.eventId, oldest);
  let lastSuccessAtMs = null, blocked = new Set(), network = 'AUTH_REQUIRED', diskFailure = false;
  const status = () => ({ pending: disk.size, blocked: blocked.size,
    error: blocked.size ? 'REVIEW_EVENT_INVALID' : '', blockedError: blocked.size ? 'REVIEW_EVENT_INVALID' : '',
    oldestPendingAtMs: disk.size ? Math.min(...[...disk.values()].map(e => e.occurredAtMs)) : null, lastSuccessAtMs });
  const backend = {
    status: async () => status(),
    persist: async events => { if (diskFailure) throw Error('ENOSPC'); for (const e of events) disk.set(e.eventId,e); return status(); },
    flush: async () => {
      if (network) return {...status(),error:network};
      let acknowledged = false;
      for (const id of disk.keys()) if (!blocked.has(id)) { disk.delete(id); acknowledged = true; }
      if (acknowledged) lastSuccessAtMs = 1700000100000;
      return status();
    },
  };
  const queue = durableReviewAuditQueue(storage, 'service:alice', backend, () => {});
  await queue.refresh();
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().oldestPendingAtMs, oldest.occurredAtMs);
  assert.equal(queue.snapshot().lastSuccessAtMs, null);
  await queue.flush();
  queue.push(event()); await queue.persist();
  assert.match(queue.snapshot().uploadError, /AUTH_REQUIRED/, 'a successful local write cannot clear authentication failure');
  for (network of ['offline', 'request timed out', 'HTTP 503', 'unclassified failure']) {
    await queue.flush();
    assert.equal(queue.snapshot().uploadError, network);
    assert.equal(queue.snapshot().pending, 2);
    assert.equal(queue.snapshot().lastSuccessAtMs, null);
  }
  blocked.add(oldest.eventId); network = '';
  await queue.flush();
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().blocked, 1);
  assert.equal(queue.snapshot().lastSuccessAtMs, 1700000100000);
  assert.equal(queue.snapshot().oldestPendingAtMs, oldest.occurredAtMs);
  network = 'offline'; await queue.flush(true);
  assert.equal(queue.snapshot().blocked, 1, 'failed retry must not erase rejected record state');
  assert.match(queue.snapshot().blockedError, /REVIEW_EVENT_INVALID/);
  diskFailure = true; queue.push(event());
  await assert.rejects(queue.persist(), /ENOSPC/);
  assert.equal(queue.snapshot().volatile, 1);
  assert.equal(queue.snapshot().pending, 2);
  network = ''; await queue.flush();
  assert.match(queue.snapshot().localError, /ENOSPC/, 'unrelated upload cannot clear a disk failure');
  diskFailure = false; await queue.persist(); await queue.flush();
  const reopened = durableReviewAuditQueue(storage, 'service:alice', backend, () => {});
  await reopened.refresh();
  assert.equal(reopened.snapshot().blocked, 1);
  assert.equal(reopened.snapshot().oldestPendingAtMs, oldest.occurredAtMs);
  assert.equal(reopened.snapshot().lastSuccessAtMs, 1700000100000);
  blocked.clear(); await reopened.flush(true);
  assert.equal(reopened.snapshot().pending, 0);
  assert.equal(reopened.snapshot().blocked, 0);
  assert.equal(reopened.snapshot().oldestPendingAtMs, null);
});

test("explicit retry waits for automatic upload then retries rejected events", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const queue = durableReviewAuditQueue(new Storage(), 'service:alice', {
    persist: async () => ({pending:1,blocked:1,error:'REVIEW_EVENT_INVALID'}),
    flush: async retry => {
      calls.push(retry);
      if (!retry) { entered(); await new Promise(resolve => { release=resolve; }); }
      return {pending:retry?0:1,blocked:retry?0:1,error:retry?'':'REVIEW_EVENT_INVALID'};
    },
  }, () => {});
  const automatic = queue.flush(); await started;
  const manual = queue.flush(true); release();
  await automatic; assert.equal(await manual, 0);
  assert.deepEqual(calls, [false,true]);
});
