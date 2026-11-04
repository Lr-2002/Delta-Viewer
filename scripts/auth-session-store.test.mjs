import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openAuthSessions, DEFAULT_SESSION_IDLE_SECONDS } from "./auth-session-store.mjs";

const day = 24 * 3600_000;
const account = username => ({ username, displayName: username, role: "operator", createdAtMs: 123,
  password: { algorithm: "fixture", salt: "salt", digest: username + "-digest" } });

test("open app renews beyond eight hours; sleep, restart and disconnect do not fabricate presence or work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delta-session-"));
  let now = 1_700_000_000_000, store = openAuthSessions(root, { clock: () => now });
  const users = [account("alice"), account("bob")];
  try {
    const a = store.create(users[0]), b = store.create(users[1]);
    assert.equal(a.expiresAtMs, now + DEFAULT_SESSION_IDLE_SECONDS * 1000);
    for (let i = 0; i < 45; i++) { now += day; assert.equal(store.authenticate(a.token, users).user.username, "alice"); }
    assert.equal(store.authenticate(b.token, users), null, "disconnected session eventually expires");
    store.close(); store = openAuthSessions(root, { clock: () => now });
    now += 2 * day;
    assert.equal(store.authenticate(a.token, users).user.username, "alice", "resume without storing password on client");
    const expiry = store.authenticate(a.token, users).expiresAtMs;
    now = expiry - 1;
    assert.equal(store.activeTokens(users).has(a.token), true);
    now = expiry;
    assert.equal(store.activeTokens(users).has(a.token), false, "admin views never renew idle sessions");
    assert.equal(store.authenticate(a.token, users), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("revocation, paused/deleted/replaced accounts and password changes survive restart; tokens stay hashed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delta-session-security-"));
  let store = openAuthSessions(root);
  const alice = account("alice"), bob = account("bob"), users = [alice, bob];
  try {
    const a = store.create(alice), a2 = store.create(alice), b = store.create(bob);
    assert.equal((await stat(path.join(root, "auth-sessions.sqlite"))).mode & 0o777, 0o600);
    for (const file of await readdir(root)) {
      const bytes = await readFile(path.join(root, file));
      for (const token of [a.token, a2.token, b.token]) assert.equal(bytes.includes(Buffer.from(token)), false);
      assert.equal(bytes.includes(Buffer.from(alice.password.digest)), false);
    }
    store.revoke(a.token);
    store.close(); store = openAuthSessions(root);
    assert.equal(store.authenticate(a.token, users), null);
    assert.ok(store.authenticate(a2.token, users));
    store.revokeUsers([alice.username]);
    store.close(); store = openAuthSessions(root);
    assert.equal(store.authenticate(a2.token, users), null);
    assert.equal(store.authenticate(b.token, users).user.username, "bob");
    const paused = store.create(alice);
    assert.equal(store.authenticate(paused.token, [{ ...alice, accountStatus: "paused" }]), null);
    assert.equal(store.authenticate(paused.token, users), null, "reenabling never revives revoked token");
    for (const changed of [[], [{ ...alice, createdAtMs: 456 }], [{ ...alice, password: { ...alice.password, digest: "new" } }]]) {
      const session = store.create(alice);
      assert.equal(store.authenticate(session.token, changed), null);
      assert.equal(store.authenticate(session.token, users), null);
    }
    assert.equal(store.authenticate(randomBytes(32).toString("base64url"), users), null, "unknown token cannot auto-login");
    assert.equal(store.authenticate("invalid", users), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed renewal fails closed and retains the durable session for recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delta-session-storage-"));
  let now = 1_700_000_000_000;
  const store = openAuthSessions(root, { idleTtlSeconds: 300, clock: () => now });
  const disk = new DatabaseSync(path.join(root, "auth-sessions.sqlite")), users = [account("alice")];
  try {
    const session = store.create(users[0]);
    disk.exec("CREATE TRIGGER fail_touch BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'ISOLATED_STORAGE_FAILURE'); END;");
    now += 90_000;
    assert.throws(() => store.authenticate(session.token, users), /ISOLATED_STORAGE_FAILURE/);
    assert.equal(disk.prepare("SELECT expires_ms FROM sessions").get().expires_ms, session.expiresAtMs);
    disk.exec("DROP TRIGGER fail_touch");
    assert.equal(store.authenticate(session.token, users).expiresAtMs, now + 300_000);
    assert.equal(disk.prepare("SELECT count(*) n FROM sessions").get().n, 1);
  } finally { disk.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
