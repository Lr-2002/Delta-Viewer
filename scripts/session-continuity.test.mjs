import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUserCenter } from "./user-center-server.mjs";

test("idle app stays authenticated, service restart/reconnect retains original audit identity, logout and pause revoke", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delta-continuity-"));
  const port = 17985, day = 24 * 3600_000;
  let now = Date.now(), service;
  const config = { schemaVersion: 1, listenHost: "127.0.0.1", listenPort: port,
    publicBaseUrl: `https://10.1.41.17:${port}`, sessionTtlSeconds: 28800, tlsAlternativeHosts: ["delta-session.local"] };
  const logger = { log() {}, error() {} };
  const req = (method, url, body, token) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = httpsRequest({ hostname: "127.0.0.1", port, method, path: url, agent: false,
      ca, servername: "delta-session.local", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) } }, res => {
      let data = "";
      res.on("data", b => { data += b; });
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on("error", reject); r.end(payload);
  });
  let ca;
  const start = async () => {
    service = await createUserCenter(config, root, logger, { clock: () => now });
    ca = await readFile(path.join(root, "tls/ca.crt"));
    await service.start();
  };
  try {
    await start();
    const password = "isolated-password";
    assert.equal((await req("POST", "/api/v1/setup", { username: "manager", displayName: "Manager", password })).status, 201);
    const admin = (await req("POST", "/api/v1/auth/login", { username: "manager", password })).body.token;
    const a = (await req("POST", "/api/v1/auth/register", { username: "alice", displayName: "Alice", password })).body;
    const b = (await req("POST", "/api/v1/auth/register", { username: "bobby", displayName: "Bob", password })).body;
    const clientId = randomUUID(), poll = { clientId, version: "1.5.9", platform: "windows", acknowledgedIds: [] };
    now += 9 * 3600_000;
    assert.equal((await req("POST", "/api/v1/client/poll", poll, a.token)).status, 200, "idle beyond old absolute expiry");
    let versions = (await req("GET", "/api/v1/admin/client-versions", null, admin)).body;
    assert.equal(versions.users.find(u => u.username === "alice").clients[0].online, true);
    const emptyAudit=(await req("GET", "/api/v1/admin/reviews", null, admin)).body;
    assert.equal(emptyAudit.total,0,"presence must not create audit work");
    assert.equal(emptyAudit.users.find(u=>u.username==="alice").online,true,"app presence is observable before loading a review");
    const event = { eventId: randomUUID(), sessionId: randomUUID(), episodeKey: "a".repeat(64),
      episodeName: "isolated", action: "approved", occurredAtMs: Date.now(), elapsedMs: 6000, details: {} };
    await service.stop(); service = null;
    await assert.rejects(req("POST", "/api/v1/review/events", { events: [event] }, a.token), /ECONNREFUSED/);
    now += 2 * day;
    await start();
    versions = (await req("GET", "/api/v1/admin/client-versions", null, admin)).body;
    assert.equal(versions.users.find(u => u.username === "alice").clients[0].online, false, "saved sessions do not fabricate fresh presence");
    assert.equal((await req("POST", "/api/v1/client/poll", poll, a.token)).status, 200);
    for (let retry = 0; retry < 2; retry++) {
      const result = await req("POST", "/api/v1/review/events", { events: [event] }, a.token);
      assert.equal(result.status, 200); assert.deepEqual(result.body.eventIds, [event.eventId]);
    }
    const audit = (await req("GET", "/api/v1/admin/reviews", null, admin)).body;
    assert.equal(audit.total, 1); assert.equal(audit.events[0].eventId, event.eventId);
    assert.equal(audit.events[0].occurredAtMs, event.occurredAtMs);
    assert.equal(audit.events[0].username, "alice");
    assert.equal((await req("GET", "/api/v1/auth/me", null, b.token)).body.user.username, "bobby");
    assert.equal((await req("POST", "/api/v1/auth/logout", {}, a.token)).status, 204);
    assert.equal((await req("POST", "/api/v1/review/events", { events: [event] }, a.token)).status, 401);
    assert.equal((await req("PUT", "/api/v1/admin/users/status", { usernames: ["bobby"], status: "paused" }, admin)).status, 200);
    await service.stop(); service = null; await start();
    assert.equal((await req("PUT", "/api/v1/admin/users/status", { usernames: ["bobby"], status: "active" }, admin)).status, 200);
    assert.equal((await req("POST", "/api/v1/client/poll", poll, b.token)).status, 401, "reactivation must not resurrect paused session");
    now += 31 * day;
    assert.equal((await req("GET", "/api/v1/auth/me", null, admin)).status, 401, "bounded unattended recovery");
  } finally { if (service) await service.stop(); await rm(root, { recursive: true, force: true }); }
});
