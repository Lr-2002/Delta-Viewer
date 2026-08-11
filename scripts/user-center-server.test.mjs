import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUserCenter, initializeUserCenter } from "./user-center-server.mjs";

function request(port, ca, method, pathname, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path: pathname,
      ca,
      rejectUnauthorized: false,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
      }));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

test("user center only allows administrator-created accounts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dohc-user-center-test-"));
  const port = 17981;
  let service;
  const configuration = {
    schemaVersion: 1,
    listenHost: "127.0.0.1",
    listenPort: port,
    publicBaseUrl: `https://10.1.11.200:${port}`,
    sessionTtlSeconds: 300,
  };
  const logger = { log() {}, error() {} };
  try {
    const initialized = await initializeUserCenter(configuration, root);
    service = await createUserCenter(configuration, root, logger);
    await service.start();
    const ca = await readFile(path.join(root, "tls/server.crt"));
    const health = await request(port, ca, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.setupRequired, true);
    const setup = await request(port, ca, "POST", "/api/v1/setup", {
      username: "admin",
      displayName: "管理员",
      password: "admin-password",
    });
    assert.equal(setup.status, 201);
    const login = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "admin",
      password: "admin-password",
    });
    assert.equal(login.status, 200);
    const created = await request(port, ca, "POST", "/api/v1/admin/users", {
      username: "operator",
      displayName: "操作员",
      password: "operator-password",
    }, login.body.token);
    assert.equal(created.status, 201);
    const operator = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "operator",
      password: "operator-password",
    });
    assert.equal(operator.status, 200);
    const denied = await request(port, ca, "GET", "/api/v1/admin/users", null, operator.body.token);
    assert.equal(denied.status, 403);
    assert.match(initialized.clientConfigPath, /DOHC-User-Center-Client\.json$/);
  } finally {
    await service?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
