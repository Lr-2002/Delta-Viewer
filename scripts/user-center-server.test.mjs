import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUserCenter, initializeUserCenter } from "./user-center-server.mjs";

function request(port, ca, method, pathname, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const normalizedBody = pathname === "/api/v1/audit/events" && body && !body.eventId
      ? { ...body, eventId: randomUUID() }
      : body;
    const payload = normalizedBody == null ? null : Buffer.from(JSON.stringify(normalizedBody));
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

test("user center supports operator self-registration and administrator account management", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dohc-user-center-test-"));
  const port = 17981;
  let service;
  const configuration = {
    schemaVersion: 1,
    listenHost: "127.0.0.1",
    listenPort: port,
    publicBaseUrl: `https://10.1.11.200:${port}`,
    tlsAlternativeHosts: ["10.1.11.201", "dohc-center.local"],
    sessionTtlSeconds: 300,
  };
  const logger = { log() {}, error() {} };
  try {
    await initializeUserCenter({ ...configuration, tlsAlternativeHosts: [] }, root);
    const originalCa = await readFile(path.join(root, "tls/ca.crt"), "utf8");
    const initialized = await initializeUserCenter(configuration, root);
    assert.equal(await readFile(path.join(root, "tls/ca.crt"), "utf8"), originalCa);
    const serverCertificate = new X509Certificate(await readFile(path.join(root, "tls/server.crt")));
    assert.equal(serverCertificate.checkIP("10.1.11.200"), "10.1.11.200");
    assert.equal(serverCertificate.checkIP("10.1.11.201"), "10.1.11.201");
    assert.equal(serverCertificate.checkHost("dohc-center.local"), "dohc-center.local");
    service = await createUserCenter(configuration, root, logger);
    await service.start();
    const ca = await readFile(path.join(root, "tls/ca.crt"));
    const health = await request(port, ca, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.setupRequired, true);
    assert.deepEqual(health.body.capabilities, [
      "structuredTaskAssignmentsV1",
      "operatorSelfRegistrationV1",
      "operatorProfileV1",
      "operationsCockpitV1",
    ]);
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
    const selfRegistered = await request(port, ca, "POST", "/api/v1/auth/register", {
      username: "selfoperator",
      displayName: "自助标注员",
      password: "self-operator-password",
    });
    assert.equal(selfRegistered.status, 201);
    assert.equal(selfRegistered.body.user.role, "operator");
    const secondSelfSession = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "selfoperator",
      password: "self-operator-password",
    });
    const updatedProfile = await request(port, ca, "PUT", "/api/v1/auth/profile", {
      displayName: "流动员工姓名",
    }, selfRegistered.body.token);
    assert.equal(updatedProfile.status, 200);
    assert.equal(updatedProfile.body.user.displayName, "流动员工姓名");
    const synchronizedSession = await request(port, ca, "GET", "/api/v1/auth/me", null, secondSelfSession.body.token);
    assert.equal(synchronizedSession.body.user.displayName, "流动员工姓名");
    const profileFieldInjection = await request(port, ca, "PUT", "/api/v1/auth/profile", {
      displayName: "禁止修改账号",
      username: "supervisor",
    }, selfRegistered.body.token);
    assert.equal(profileFieldInjection.status, 400);
    const adminProfileDenied = await request(port, ca, "PUT", "/api/v1/auth/profile", {
      displayName: "管理员改名",
    }, login.body.token);
    assert.equal(adminProfileDenied.status, 403);
    const selfAssigned = await request(port, ca, "GET", "/api/v1/tasks/assigned", null, selfRegistered.body.token);
    assert.deepEqual(selfAssigned.body.tasks, []);
    const roleInjection = await request(port, ca, "POST", "/api/v1/auth/register", {
      username: "forbiddenadmin",
      displayName: "禁止管理员",
      password: "forbidden-admin-password",
      role: "admin",
    });
    assert.equal(roleInjection.status, 400);
    const duplicateRegistration = await request(port, ca, "POST", "/api/v1/auth/register", {
      username: "selfoperator",
      displayName: "重复账号",
      password: "self-operator-password",
    });
    assert.equal(duplicateRegistration.status, 409);
    const concurrentUsernames = Array.from({ length: 10 }, (_, index) => `concurrent${index}`);
    const concurrentRegistrations = await Promise.all(concurrentUsernames.map((username) => request(
      port,
      ca,
      "POST",
      "/api/v1/auth/register",
      { username, displayName: username, password: "concurrent-password" },
    )));
    assert.deepEqual(concurrentRegistrations.map((result) => result.status), Array(10).fill(201));
    const accountsAfterRegistration = await request(port, ca, "GET", "/api/v1/admin/users", null, login.body.token);
    assert.ok(accountsAfterRegistration.body.users.some((user) => (
      user.username === "selfoperator" && user.displayName === "流动员工姓名"
    )));
    assert.deepEqual(
      accountsAfterRegistration.body.users
        .map((user) => user.username)
        .filter((username) => username.startsWith("concurrent"))
        .sort(),
      concurrentUsernames,
    );
    const batchCreated = await request(port, ca, "POST", "/api/v1/admin/users/batch", {
      users: [
        { username: "batch01", displayName: "批量账号一", password: "batch-password-01" },
        { username: "batch02", displayName: "批量账号二", password: "batch-password-02" },
      ],
    }, login.body.token);
    assert.equal(batchCreated.status, 201);
    assert.deepEqual(batchCreated.body.users.map((user) => user.username), ["batch01", "batch02"]);
    const paused = await request(port, ca, "PUT", "/api/v1/admin/users/status", {
      usernames: ["batch01", "batch02"],
      status: "paused",
    }, login.body.token);
    assert.equal(paused.status, 200);
    assert.ok(paused.body.users.every((user) => user.accountStatus === "paused"));
    const pausedLogin = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "batch01",
      password: "batch-password-01",
    });
    assert.equal(pausedLogin.status, 403);
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
      assignmentPlans: [
        { task: "BedMaking", quantity: 3, priority: "urgent", deadlineAtMs: Date.now() + 3_600_000, status: "active" },
        { task: "Bedsheet", quantity: 2, priority: "normal", deadlineAtMs: null, status: "paused" },
      ],
    }, login.body.token);
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.user.assignedTasks, 5);
    assert.deepEqual(assigned.body.user.assignedTaskNames, ["BedMaking", "Bedsheet"]);
    assert.deepEqual(assigned.body.user.assignedTaskQuantities, { BedMaking: 3, Bedsheet: 2 });
    assert.equal(assigned.body.user.assignmentPlans[0].priority, "urgent");
    assert.equal(assigned.body.user.assignmentPlans[1].status, "paused");
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
    for (const username of ["allocatora", "allocatorb"]) {
      const result = await request(port, ca, "POST", "/api/v1/admin/users", {
        username,
        displayName: username,
        password: "allocator-password",
      }, login.body.token);
      assert.equal(result.status, 201);
    }
    const concurrentAssignments = await Promise.all(["allocatora", "allocatorb"].map((username) => request(
      port,
      ca,
      "PUT",
      `/api/v1/admin/users/${username}/assignment`,
      { assignedTaskQuantities: { ConcurrentTask: 7 } },
      login.body.token,
    )));
    assert.deepEqual(concurrentAssignments.map((result) => result.status), [200, 200]);
    const concurrentRanges = concurrentAssignments
      .map((result) => result.body.user.assignmentPlans[0])
      .sort((left, right) => left.startIndex - right.startIndex);
    assert.ok(concurrentRanges[0].startIndex + concurrentRanges[0].quantity <= concurrentRanges[1].startIndex);
    const transferred = await request(port, ca, "POST", "/api/v1/admin/assignments/transfer", {
      fromUsername: "allocatora",
      toUsername: "operator2",
      task: "ConcurrentTask",
    }, login.body.token);
    assert.equal(transferred.status, 200);
    assert.ok(!transferred.body.source.assignedTaskNames.includes("ConcurrentTask"));
    assert.ok(transferred.body.target.assignedTaskNames.includes("ConcurrentTask"));
    const secondLogin = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "operator2",
      password: "operator2-password",
    });
    const secondTasks = await request(port, ca, "GET", "/api/v1/tasks/assigned", null, secondLogin.body.token);
    assert.deepEqual(secondTasks.body.tasks, [
      { task: "BedMaking", quantity: 2, startIndex: 3, priority: "normal", deadlineAtMs: null, status: "active", order: 0, detail: "BedMaking", completed: 0, remaining: 2, estimatedCompletionAtMs: null },
      { task: "ConcurrentTask", quantity: 7, startIndex: 0, priority: "normal", deadlineAtMs: null, status: "active", order: 1, detail: "ConcurrentTask", completed: 0, remaining: 7, estimatedCompletionAtMs: null },
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
      { task: "BedMaking", quantity: 3, startIndex: 0, priority: "urgent", deadlineAtMs: assigned.body.user.assignmentPlans[0].deadlineAtMs, status: "active", order: 0, detail: "BedMaking", completed: 0, remaining: 3, estimatedCompletionAtMs: null },
      { task: "Bedsheet", quantity: 2, startIndex: 0, priority: "normal", deadlineAtMs: null, status: "paused", order: 1, detail: "整理床单并完成整段视频标注。", completed: 0, remaining: 2, estimatedCompletionAtMs: null },
    ]);
    const startedAtMs = Date.now() - 60_000;
    const stableEventId = randomUUID();
    const started = await request(port, ca, "POST", "/api/v1/audit/events", {
      eventId: stableEventId,
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_started",
      occurredAtMs: startedAtMs,
    }, operator.body.token);
    assert.equal(started.status, 201);
    const duplicateStarted = await request(port, ca, "POST", "/api/v1/audit/events", {
      eventId: stableEventId,
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_started",
      occurredAtMs: startedAtMs,
    }, operator.body.token);
    assert.equal(duplicateStarted.status, 200);
    assert.equal(duplicateStarted.body.duplicate, true);
    const auditFieldRejected = await request(port, ca, "POST", "/api/v1/audit/events", {
      eventId: randomUUID(),
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_started",
      occurredAtMs: Date.now(),
      episodeId: "must-not-leave-client",
    }, operator.body.token);
    assert.equal(auditFieldRejected.status, 400);
    const event = await request(port, ca, "POST", "/api/v1/audit/events", {
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_saved",
      occurredAtMs: Date.now(),
    }, operator.body.token);
    assert.equal(event.status, 201);
    const revision = await request(port, ca, "POST", "/api/v1/audit/events", {
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      action: "annotation_saved",
      occurredAtMs: Date.now(),
    }, operator.body.token);
    assert.equal(revision.status, 201);
    const sourceUnavailable = await request(port, ca, "POST", "/api/v1/audit/events", {
      taskId: "sofa",
      trajectoryCode: "",
      action: "source_unavailable",
      occurredAtMs: Date.now(),
    }, operator.body.token);
    assert.equal(sourceUnavailable.status, 201);
    const statePath = path.join(root, "users.json");
    const storedState = JSON.parse(await readFile(statePath, "utf8"));
    const idleOperator = storedState.users.find((user) => user.username === "operator2");
    idleOperator.assignmentUpdatedAtMs = Date.now() - 2 * 60 * 60_000;
    idleOperator.lastLoginAtMs = Date.now() - 2 * 60 * 60_000;
    await writeFile(statePath, `${JSON.stringify(storedState, null, 2)}\n`, { mode: 0o600 });
    const audit = await request(port, ca, "GET", "/api/v1/admin/audit", null, login.body.token);
    assert.equal(audit.status, 200);
    const operatorSummary = audit.body.users.find((user) => user.username === "operator");
    assert.equal(operatorSummary.assignedTasks, 5);
    assert.deepEqual(operatorSummary.assignedTaskNames, ["BedMaking", "Bedsheet"]);
    assert.deepEqual(operatorSummary.assignedTaskQuantities, { BedMaking: 3, Bedsheet: 2 });
    assert.equal(operatorSummary.completedToday, 1);
    assert.equal(operatorSummary.totalCompleted, 1);
    assert.ok(operatorSummary.averageCompletionMs >= 60_000);
    assert.equal(audit.body.overview.completedToday, 1);
    assert.equal(audit.body.hourlyTrend.length, 24);
    assert.equal(audit.body.dailyTrend.length, 7);
    assert.ok(audit.body.taskSummaries.some((task) => task.task === "BedMaking"));
    assert.ok(Number.isSafeInteger(audit.body.generatedAtMs));
    assert.ok(audit.body.alerts.some((alert) => alert.type === "source_unavailable"));
    const stagnationAlert = audit.body.alerts.find((alert) => alert.alertId === "possible-stagnation:operator2");
    assert.equal(stagnationAlert.status, "open");
    const acknowledged = await request(port, ca, "PUT", `/api/v1/admin/alerts/${encodeURIComponent(stagnationAlert.alertId)}`, {
      status: "acknowledged",
      note: "已电话确认，稍后继续。",
    }, login.body.token);
    assert.equal(acknowledged.status, 200);
    const acknowledgedAudit = await request(port, ca, "GET", "/api/v1/admin/audit", null, login.body.token);
    assert.equal(acknowledgedAudit.body.alerts.find((alert) => alert.alertId === stagnationAlert.alertId).status, "acknowledged");
    assert.equal(audit.body.taskDetails.length, 2);
    assert.ok(audit.body.events.some((item) => item.action === "annotation_saved"));
    const quality = await request(port, ca, "POST", "/api/v1/admin/quality-reviews", {
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      outcome: "rework",
      errorType: "片段边界",
      note: "请复核边界。",
      annotatorUsername: "operator",
      annotationRevision: 2,
      segmentIndex: 0,
      startFrame: 1,
      endFrame: 195,
    }, login.body.token);
    assert.equal(quality.status, 201);
    assert.equal(quality.body.review.reviewer, "supervisor");
    assert.equal(quality.body.review.reworkAssignmentCreated, true);
    const reworkTasks = await request(port, ca, "GET", "/api/v1/tasks/assigned", null, operator.body.token);
    assert.ok(reworkTasks.body.tasks.some((task) => task.task === "sofa" && task.priority === "rework"));
    const reworkPassed = await request(port, ca, "POST", "/api/v1/admin/quality-reviews", {
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      outcome: "passed",
      errorType: "",
      note: "返工后通过。",
      annotatorUsername: "operator",
      annotationRevision: 3,
      segmentIndex: 0,
      startFrame: 1,
      endFrame: 195,
      parentReviewId: quality.body.review.reviewId,
    }, login.body.token);
    assert.equal(reworkPassed.status, 201);
    const qualityPathRejected = await request(port, ca, "POST", "/api/v1/admin/quality-reviews", {
      taskId: "sofa",
      trajectoryCode: "sofa-001",
      outcome: "rework",
      errorType: "路径泄漏",
      note: "/mnt/source/private/frame.jpg",
      annotatorUsername: "operator",
    }, login.body.token);
    assert.equal(qualityPathRejected.status, 400);
    const qualityAudit = await request(port, ca, "GET", "/api/v1/admin/audit", null, login.body.token);
    assert.equal(qualityAudit.body.qualityReviews[0].trajectoryCode, "sofa-001");
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
