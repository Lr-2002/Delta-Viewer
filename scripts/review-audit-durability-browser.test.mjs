import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// Real recorder + native queue integration, with isolated fake IPC commits.
// No real account, user-center request, source data or model API is used.
test("audit events survive delayed materialization, disk failures, and update barriers", async (t) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{
    name: "audit-durability-fixture", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__durability") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><body><script type="module">import * as audit from "/src/lib/review-audit.ts"; window.audit=audit;</script></body></html>');
      });
    },
  }] });
  t.after(() => server.close());
  await server.listen();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync) ?? chromium.executablePath();
  const browser = await chromium.launch({ executablePath, headless: true });
  async function page() {
    const page = await browser.newPage();
    page.on("pageerror", error => { throw error; });
    await page.addInitScript(() => {
      window.disk = new Map(); window.messages = []; window.failDisk = false;
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === "review_identity_path") {
          if (window.failIdentity) throw Error("local aliases unavailable");
          return args.path.replace("/fixture/new/", "/fixture/old/");
        }
        if (command === "persist_review_audit") {
          if (window.failDisk) throw Error("disk unavailable");
          if (window.diskGate) await window.diskGate;
          for (const event of args.events) window.disk.set(args.username+":"+event.eventId, { ...event, username: args.username });
          return { pending: window.disk.size, blocked: 0, error: "" };
        }
        if (command === "get_review_audit_queue_status") return { pending: window.disk.size, blocked: 0, error: "" };
        if (command === "flush_review_audit_queue") return { pending: window.disk.size, blocked: 0, error: "offline" };
        throw Error(command);
      } };
      window.addEventListener("review-audit-status", event => window.messages.push(event.detail));
      window.closeBlocked = () => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event); return event.defaultPrevented;
      };
    });
    await page.goto(`${server.resolvedUrls.local[0]}__durability`);
    await page.waitForFunction(() => window.audit);
    return page;
  }
  try {
    const delayed = await page();
    await delayed.evaluate(async () => {
      const audit = window.audit;
      audit.configureReviewAudit("alice", "service"); audit.observeReviewInteractions();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const gate = new Promise(resolve => { window.releaseKey = resolve; });
      crypto.subtle.digest = async (...args) => { await gate; return digest(...args); };
      window.diskGate = new Promise(resolve => { window.releaseDisk = resolve; });
      audit.beginReviewAudit("/fixture/a", "a");
      audit.recordReviewInteraction("approved", { revision: "r1" });
      window.blockedDuringKey = window.closeBlocked();
      window.persisted = false;
      window.saving = audit.persistPendingReviewAudit().then(() => { window.persisted = true; });
    });
    assert.equal(await delayed.evaluate(() => window.blockedDuringKey), true, "digest gap must block close");
    await delayed.evaluate(() => window.releaseKey());
    await delayed.waitForFunction(() => window.closeBlocked());
    assert.equal(await delayed.evaluate(() => window.persisted), false);
    await delayed.evaluate(async () => { window.releaseDisk(); await window.saving; });
    assert.equal(await delayed.evaluate(() => window.closeBlocked()), false);
    assert.deepEqual(await delayed.evaluate(() => [...window.disk.values()].map(e => e.action)), ["loaded", "approved"]);
    await delayed.close();

    const retry = await page();
    const retryResult = await retry.evaluate(async () => {
      const a = window.audit; a.configureReviewAudit("alice", "service"); a.observeReviewInteractions();
      const digest = crypto.subtle.digest.bind(crypto.subtle); let failed = false;
      crypto.subtle.digest = async (...args) => { if (!failed) { failed = true; throw Error("key unavailable"); } return digest(...args); };
      a.beginReviewAudit("/fixture/retry", "retry");
      await new Promise(resolve => setTimeout(resolve, 0));
      const blockedAfterHashFailure = window.closeBlocked();
      window.failDisk = true;
      a.recordReviewInteraction("rejected", { revision: "original-revision" });
      let blocked = false;
      try { await a.persistPendingReviewAudit(); } catch { blocked = window.closeBlocked(); }
      window.failDisk = false;
      await a.persistPendingReviewAudit();
      const original = [...window.disk.values()];
      await a.persistPendingReviewAudit();
      return { blockedAfterHashFailure, blocked, events: original, count: window.disk.size, messages: window.messages };
    });
    assert.equal(retryResult.blockedAfterHashFailure, true);
    assert.equal(retryResult.blocked, true);
    assert.deepEqual(retryResult.events.map(e => e.action), ["loaded", "rejected"]);
    assert.equal(retryResult.count, 2);
    assert.equal(retryResult.events[1].details.revision, "original-revision");
    assert.ok(retryResult.messages.some(message => message.includes("尚未落盘")));
    assert.ok(!retryResult.messages.at(-1).includes("key unavailable"), "recovery clears materialization error");
    await retry.close();

    const renamed = await page();
    const identity = await renamed.evaluate(async () => {
      const a = window.audit; a.configureReviewAudit("alice", "service");
      a.observeReviewInteractions(); window.failIdentity = true;
      a.beginReviewAudit("/fixture/new/sample", "sample");
      let failed = false;
      try { await a.persistPendingReviewAudit(); } catch { failed = window.closeBlocked(); }
      window.failIdentity = false;
      await a.persistPendingReviewAudit();
      const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("/fixture/old/sample"))), v=>v.toString(16).padStart(2,"0")).join("");
      const event = await a.createDeferredReviewEvent("/fixture/new/sample", "sample", "rejected", "无效数据");
      return {failed,expected,key:[...window.disk.values()][0].episodeKey,eventKey:event.episodeKey};
    });
    assert.equal(identity.failed,true);
    assert.equal(identity.key,identity.expected);
    assert.equal(identity.eventKey,identity.expected);
    await renamed.close();

    const update = await page();
    const updateResult = await update.evaluate(async () => {
      const a = window.audit; a.configureReviewAudit("alice", "service");
      a.beginReviewAudit("/fixture/a", "a");
      window.failDisk = true;
      let blockedUpdate = false;
      try { await a.pauseAndPersistReviewAudit(); } catch { blockedUpdate = true; }
      window.failDisk = false;
      a.recordReviewInteraction("control");
      await a.persistPendingReviewAudit();
      const resume = await a.pauseAndPersistReviewAudit();
      const count = window.disk.size;
      a.recordReviewInteraction("heartbeat"); a.recordReviewInteraction("control");
      await a.persistPendingReviewAudit();
      const pausedCount = window.disk.size;
      resume(); a.recordReviewInteraction("control"); await a.persistPendingReviewAudit();
      return { blockedUpdate, count, pausedCount, resumedCount: window.disk.size };
    });
    assert.equal(updateResult.blockedUpdate, true);
    assert.equal(updateResult.count, 2, "failed update restores recording");
    assert.equal(updateResult.pausedCount, updateResult.count);
    assert.equal(updateResult.resumedCount, updateResult.count+1);
    await update.close();

    const owner = await page();
    const owners = await owner.evaluate(async () => {
      const a = window.audit; const unconfigure = a.configureReviewAudit("alice", "service");
      a.beginReviewAudit("/fixture/a", "a"); const save = a.reviewAuditRecorder("/fixture/a");
      await a.persistPendingReviewAudit(); unconfigure();
      a.configureReviewAudit("bob", "service"); a.beginReviewAudit("/fixture/b", "b");
      save("approved", { revision: "alice-delayed-save" });
      await a.persistPendingReviewAudit();
      return [...window.disk.values()].map(e => [e.action, e.username, e.episodeName]);
    });
    assert.deepEqual(owners.filter(e => e[0] === "closed"), [["closed", "alice", "a"]]);
    assert.deepEqual(owners.filter(e => e[0] === "approved"), [["approved", "alice", "a"]]);
    await owner.close();
  } finally { await browser.close(); }
});
