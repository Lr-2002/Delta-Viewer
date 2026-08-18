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

function requestHeaders(port, ca, pathname) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: pathname,
      ca,
      rejectUnauthorized: false,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.headers));
    });
    request.on("error", reject);
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
    const ca = await readFile(path.join(root, "tls/ca.crt"));
    const health = await request(port, ca, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.setupRequired, true);
    const pageHeaders = await requestHeaders(port, ca, "/");
    assert.match(pageHeaders["content-security-policy"], /(?:^|;)\s*connect-src 'self'(?:;|$)/);
    const supervisionHeaders = await requestHeaders(port, ca, "/supervision");
    assert.match(supervisionHeaders["content-type"], /text\/html/);
    const setup = await request(port, ca, "POST", "/api/v1/setup", {
      username: "supervisor",
      displayName: "管理员",
      password: "admin-password",
    });
    assert.equal(setup.status, 201);
    const login = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "supervisor",
      password: "admin-password",
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, "admin");
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
    assert.equal(operator.body.user.role, "operator");
    const assigned = await request(port, ca, "PUT", "/api/v1/admin/users/operator/assignment", {
      assignedTaskQuantities: { BedMaking: 3, Bedsheet: 2 },
    }, login.body.token);
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.user.assignedTasks, 5);
    assert.deepEqual(assigned.body.user.assignedTaskNames, ["BedMaking", "Bedsheet"]);
    assert.deepEqual(assigned.body.user.assignedTaskQuantities, { BedMaking: 3, Bedsheet: 2 });
    const secondCreated = await request(port, ca, "POST", "/api/v1/admin/users", {
      username: "operator2",
      displayName: "操作员二",
      password: "operator2-password",
    }, login.body.token);
    assert.equal(secondCreated.status, 201);
    const secondAssigned = await request(port, ca, "PUT", "/api/v1/admin/users/operator2/assignment", {
      assignedTaskQuantities: { BedMaking: 2 },
    }, login.body.token);
    assert.equal(secondAssigned.status, 200);
    const secondLogin = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "operator2",
      password: "operator2-password",
    });
    const secondTasks = await request(port, ca, "GET", "/api/v1/tasks/assigned", null, secondLogin.body.token);
    assert.deepEqual(secondTasks.body.tasks, [
      { task: "BedMaking", quantity: 2, startIndex: 3, detail: "BedMaking" },
    ]);
    const editedDetail = await request(port, ca, "PUT", "/api/v1/admin/task-details", {
      task: "Bedsheet",
      detail: "整理床单并完成整段视频标注。",
    }, login.body.token);
    assert.equal(editedDetail.status, 200);
    assert.equal(editedDetail.body.taskDetails[0].source, "admin");
    const importedDetail = await request(port, ca, "POST", "/api/v1/admin/task-details/import", {
      tasks: [{ task: "Sofa", detail: "整理沙发。" }],
    }, login.body.token);
    assert.equal(importedDetail.status, 200);
    assert.equal(importedDetail.body.taskDetails.length, 2);
    const operatorTasks = await request(port, ca, "GET", "/api/v1/tasks/assigned", null, operator.body.token);
    assert.equal(operatorTasks.status, 200);
    assert.deepEqual(operatorTasks.body.tasks, [
      { task: "BedMaking", quantity: 3, startIndex: 0, detail: "BedMaking" },
      { task: "Bedsheet", quantity: 2, startIndex: 0, detail: "整理床单并完成整段视频标注。" },
    ]);
    const startedAtMs = Date.now() - 60_000;
    const started = await request(port, ca, "POST", "/api/v1/audit/events", {
      episodeId: "12345678abcdef00",
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_started",
      occurredAtMs: startedAtMs,
    }, operator.body.token);
    assert.equal(started.status, 201);
    const event = await request(port, ca, "POST", "/api/v1/audit/events", {
      episodeId: "12345678abcdef00",
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_saved",
      occurredAtMs: Date.now(),
    }, operator.body.token);
    assert.equal(event.status, 201);
    const revision = await request(port, ca, "POST", "/api/v1/audit/events", {
      episodeId: "12345678abcdef00",
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_saved",
      occurredAtMs: Date.now(),
    }, operator.body.token);
    assert.equal(revision.status, 201);
    const audit = await request(port, ca, "GET", "/api/v1/admin/audit", null, login.body.token);
    assert.equal(audit.status, 200);
    const operatorSummary = audit.body.users.find((user) => user.username === "operator");
    assert.equal(operatorSummary.assignedTasks, 5);
    assert.deepEqual(operatorSummary.assignedTaskNames, ["BedMaking", "Bedsheet"]);
    assert.deepEqual(operatorSummary.assignedTaskQuantities, { BedMaking: 3, Bedsheet: 2 });
    assert.equal(operatorSummary.completedToday, 1);
    assert.equal(operatorSummary.totalCompleted, 1);
    assert.ok(operatorSummary.averageCompletionMs >= 60_000);
    assert.equal(audit.body.taskDetails.length, 2);
    assert.equal(audit.body.events[0].action, "annotation_saved");
    const auditDenied = await request(port, ca, "GET", "/api/v1/admin/audit", null, operator.body.token);
    assert.equal(auditDenied.status, 403);
    const denied = await request(port, ca, "GET", "/api/v1/admin/users", null, operator.body.token);
    assert.equal(denied.status, 403);
    const assignmentDenied = await request(port, ca, "PUT", "/api/v1/admin/users/operator/assignment", {
      assignedTasks: 3,
    }, operator.body.token);
    assert.equal(assignmentDenied.status, 403);
    assert.match(initialized.clientConfigPath, /DOHC-User-Center-Client\.json$/);
  } finally {
    await service?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
