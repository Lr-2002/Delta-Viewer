import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUserCenter, initializeUserCenter } from "./user-center-server.mjs";

function call(port, ca, method, route, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = httpsRequest({ hostname: "localhost", port, path: route, method, ca,
      headers: { ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode, body: bytes.length ? JSON.parse(bytes.toString()) : null });
      });
    });
    request.on("error", reject); request.end(bytes);
  });
}

test("existing Manager sessions relay individually authenticated QC requests without account binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-cloud-session-"));
  const config = { schemaVersion: 1, listenHost: "::", listenPort: 17977,
    publicBaseUrl: "https://10.1.11.200:17977", sessionTtlSeconds: 300 };
  const key = "isolated-manager-bridge-".repeat(4);
  let center, upstream;
  const received = [];
  try {
    await initializeUserCenter(config, root);
    const ca = await readFile(path.join(root, "tls/ca.crt"));
    const keyFile = path.join(root, "bridge.key"); await writeFile(keyFile, key, { mode: 0o600 });
    upstream = createServer({ key: await readFile(path.join(root, "tls/server.key")),
      cert: await readFile(path.join(root, "tls/server.crt")) }, async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const assertion = request.headers["x-manager-assertion"];
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-manager-signature"], createHmac("sha256", key).update(assertion, "ascii").digest("hex"));
      const claim = JSON.parse(Buffer.from(assertion, "base64url").toString());
      assert.equal(claim.path, request.url); assert.equal(claim.method, request.method);
      assert.equal(claim.body_sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(claim.iss, JSON.parse(await readFile(path.join(root, "users.json"))).serviceId);
      assert.ok(claim.exp - claim.iat <= 30);
      assert.ok(!received.some(row => row.nonce === claim.nonce));
      received.push(claim);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ account_id: claim.sub, display_name: claim.name, role: claim.role, plans: [] }));
    });
    await new Promise(resolve => upstream.listen(0, resolve));
    const cloudQc = { origin: `https://localhost:${upstream.address().port}`, keyFile,
      certificateFile: path.join(root, "tls/ca.crt"), downloadHosts: ["isolated.bcebos.com"] };
    center = await createUserCenter({ ...config, cloudQc }, root, { log() {}, error() {} });
    await center.start();
    const request = (method, route, body, token) => call(config.listenPort, ca, method, route, body, token);
    assert.equal((await request("GET", "/api/v1/cloud-qc/connection")).status, 401);
    await request("POST", "/api/v1/setup", { username: "bridge-admin", displayName: "管理员", password: "isolated-password" });
    const admin = (await request("POST", "/api/v1/auth/login", { username: "bridge-admin", password: "isolated-password" })).body.token;
    const register = async username => (await request("POST", "/api/v1/auth/register", {
      username, displayName: username, password: "isolated-password",
    })).body.token;
    const alice = await register("bridge-alice"), bob = await register("bridge-bob");
    const metadata = await request("GET", "/api/v1/cloud-qc/connection", null, alice);
    assert.deepEqual(metadata.body, { origin: cloudQc.origin, download_hosts: cloudQc.downloadHosts });
    assert.ok(!(JSON.stringify(metadata.body).includes(key)));
    const proxy = (token, route = "/api/review/v1/identity", payload = null, tenant = "_all") =>
      request("POST", "/api/v1/cloud-qc/proxy", { path: route, payload, tenant }, token);
    assert.equal((await proxy(alice)).body.account_id, "bridge-alice");
    assert.equal((await proxy(bob)).body.account_id, "bridge-bob");
    assert.equal((await proxy(admin)).body.role, "admin");
    assert.equal((await proxy(alice, "/api/review/v1/admin/batches")).status, 403);
    assert.equal((await proxy(alice, "https://elsewhere.example/api/review/v1/tasks")).status, 422);
    assert.equal((await proxy(alice, "/api/delivery/v2/jobs")).status, 422);
    const claim = { base_version: 1, action: "claim", recording_ids: ["a".repeat(32)], reason: "实际账号领取" };
    assert.equal((await proxy(alice, `/api/review/v1/jobs/${"b".repeat(32)}/plans/${"c".repeat(32)}/claim`, claim)).status, 200);
    await request("POST", "/api/v1/auth/logout", {}, bob);
    const before = received.length;
    assert.equal((await proxy(bob)).status, 401);
    assert.equal((await request("PUT", "/api/v1/admin/users/status", { usernames: ["bridge-alice"], status: "paused" }, admin)).status, 200);
    assert.equal((await proxy(alice)).status, 401);
    assert.equal(received.length, before);
    assert.equal((await request("GET", "/healthz")).body.capabilities.includes("cloudQcManagedSessionV1"), true);
  } finally {
    await center?.stop();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
