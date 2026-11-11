import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import test from "node:test";
import { openAnnotationAuditIndex } from "./annotation-audit-index.mjs";
import { createUserCenter, initializeUserCenter } from "./user-center-server.mjs";

const EVENT_COUNT = 200_001;

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

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function event(index, action, trajectoryCode) {
  return {
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    username: "operator",
    displayName: "标注员",
    taskId: "Bulk Task",
    trajectoryCode,
    action,
    occurredAtMs: 1_700_000_000_000 + index,
    receivedAtMs: 1_700_000_000_000 + index,
  };
}

async function writeLargeAudit(filename) {
  const output = createWriteStream(filename, { flags: "a", mode: 0o600 });
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    const row = event(index, index === EVENT_COUNT - 1 ? "annotation_saved" : "annotation_started", `trajectory-${index}`);
    if (!output.write(`${JSON.stringify(row)}\n`)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
}

test("annotation audit index resumes from its checkpoint and deduplicates completed trajectories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dohc-audit-index-test-"));
  const source = path.join(root, "annotation-audit.jsonl");
  const first = event(1, "annotation_saved", "trajectory-a");
  const revision = event(2, "annotation_saved", "TRAJECTORY-A");
  const second = event(3, "annotation_saved", "trajectory-b");
  try {
    await writeFile(source, `${JSON.stringify(first)}\n`, { mode: 0o600 });
    let index = await openAnnotationAuditIndex(root);
    assert.equal(index.has(first.eventId), true);
    assert.equal(index.completionCount("operator", "bulk task"), 1);
    index.close();

    await appendFile(source, `${JSON.stringify(revision)}\n${JSON.stringify(second)}\n`);
    index = await openAnnotationAuditIndex(root);
    assert.equal(index.has(first.eventId), true);
    assert.equal(index.has(revision.eventId), true);
    assert.equal(index.completionCount("OPERATOR", "BULK TASK"), 2);
    index.close();

    const start = { ...event(4, "annotation_started", "trajectory-c"), occurredAtMs: 1000 };
    const saved = { ...event(5, "annotation_saved", "trajectory-c"), occurredAtMs: 5000 };
    const lateStart = { ...event(6, "annotation_started", "trajectory-c"), occurredAtMs: 3000 };
    await appendFile(source, `${JSON.stringify(start)}\n${JSON.stringify(saved)}\n${JSON.stringify(lateStart)}\n`);
    index = await openAnnotationAuditIndex(root);
    assert.equal(index.averageCompletionMs("operator", "Bulk Task"), 2000, "late offline starts retain chronological duration semantics");
    assert.equal(index.averageCompletionMs("operator", "unassigned"), 2000, "task estimates retain the account average fallback");
    assert.deepEqual(index.activity("operator", 0, 10_000).map((item) => item.eventId), [lateStart.eventId, saved.eventId, start.eventId]);
    assert.deepEqual(index.activity("other-user", 0, Number.MAX_SAFE_INTEGER), []);
    index.close();

    await writeFile(source, `${JSON.stringify(first)}\n`);
    index = await openAnnotationAuditIndex(root);
    assert.equal(index.has(second.eventId), false, "truncation rebuilds the derived index");
    assert.equal(index.completionCount("operator", "Bulk Task"), 1);
    index.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed incremental indexing rolls back and replays every pending event after recovery", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"dohc-audit-recovery-"));
  const source=path.join(root,"annotation-audit.jsonl");
  const first=event(101,"annotation_saved","first");
  const second=event(102,"annotation_saved","second");
  const third=event(103,"annotation_saved","third");
  let index;
  try {
    await writeFile(source,`${JSON.stringify(first)}\n`);
    index=await openAnnotationAuditIndex(root);
    await appendFile(source,`${JSON.stringify(second)}\ninvalid-json\n`);
    await assert.rejects(index.add());
    assert.equal(index.has(second.eventId),false,"failed transactions must not publish partial counts");
    assert.equal(index.completionCount("operator","Bulk Task"),1);
    await writeFile(source,`${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(third)}\n`);
    await index.add();
    assert.equal(index.has(second.eventId),true);
    assert.equal(index.has(third.eventId),true);
    assert.equal(index.completionCount("operator","Bulk Task"),3);
    index.close();index=undefined;
    const replacement=path.join(root,"replacement.jsonl");
    await writeFile(replacement,`${JSON.stringify(third)}\n`);await rename(replacement,source);
    index=await openAnnotationAuditIndex(root);
    assert.equal(index.has(first.eventId),false,"replaced sources cannot retain old counts");
    assert.equal(index.completionCount("operator","Bulk Task"),1);
  } finally {index?.close();await rm(root,{recursive:true,force:true});}
});

test("queries see committed snapshots while incremental events are indexed", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"dohc-audit-snapshot-"));
  const source=path.join(root,"annotation-audit.jsonl");let index;
  try {
    await writeFile(source,`${JSON.stringify(event(1,"annotation_saved","initial"))}\n`);
    index=await openAnnotationAuditIndex(root);
    const rows=Array.from({length:5000},(_,i)=>event(i+2,"annotation_saved",`concurrent-${i}`));
    await appendFile(source,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    let done=false;const building=index.add().finally(()=>{done=true;});
    const observed=[];
    while(!done){observed.push(index.completionCount("operator","Bulk Task"));await new Promise(resolve=>setImmediate(resolve));}
    await building;
    assert.ok(observed.length>1,"exercise queries during the streamed write transaction");
    assert.ok(observed.every(count=>count===1||count===5001),"never expose partially indexed counts");
    assert.equal(index.completionCount("operator","Bulk Task"),5001);
  } finally {index?.close();await rm(root,{recursive:true,force:true});}
});

test("assigned tasks load from the index when audit volume exceeds the former limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dohc-large-audit-test-"));
  const port = await unusedPort();
  const configuration = {
    schemaVersion: 1,
    listenHost: "127.0.0.1",
    listenPort: port,
    publicBaseUrl: `https://10.0.0.1:${port}`,
    tlsAlternativeHosts: [],
    sessionTtlSeconds: 300,
  };
  const logger = { log() {}, error() {} };
  let service;
  try {
    await initializeUserCenter(configuration, root);
    service = await createUserCenter(configuration, root, logger);
    await service.start();
    const ca = await readFile(path.join(root, "tls/ca.crt"));
    const setup = await request(port, ca, "POST", "/api/v1/setup", {
      username: "supervisor", displayName: "管理员", password: "admin-password",
    });
    assert.equal(setup.status, 201);
    const admin = await request(port, ca, "POST", "/api/v1/auth/login", {
      username: "supervisor", password: "admin-password",
    });
    assert.equal(admin.status, 200);
    const created = await request(port, ca, "POST", "/api/v1/admin/users", {
      username: "operator", displayName: "标注员", password: "operator-password",
    }, admin.body.token);
    assert.equal(created.status, 201);
    const assignment = await request(port, ca, "PUT", "/api/v1/admin/users/operator/assignment", {
      assignedTaskQuantities: { "Bulk Task": 3 },
    }, admin.body.token);
    assert.equal(assignment.status, 200);
    await service.stop();
    service = undefined;

    const auditFile = path.join(root, "annotation-audit.jsonl");
    await writeLargeAudit(auditFile);
    service = await createUserCenter(configuration, root, logger);
    await service.start();
    const caAfterRestart = await readFile(path.join(root, "tls/ca.crt"));
    const operator = await request(port, caAfterRestart, "POST", "/api/v1/auth/login", {
      username: "operator", password: "operator-password",
    });
    assert.equal(operator.status, 200);

    const movedAuditFile = `${auditFile}.indexed-fixture`;
    await rename(auditFile, movedAuditFile);
    const assigned = await request(port, caAfterRestart, "GET", "/api/v1/tasks/assigned", null, operator.body.token);
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body.tasks.map(({ task, completed, remaining }) => ({ task, completed, remaining })), [
      { task: "Bulk Task", completed: 1, remaining: 2 },
    ]);
    const activityDate = new Date(1_700_000_000_000);
    const date = `${activityDate.getFullYear()}-${String(activityDate.getMonth()+1).padStart(2,"0")}-${String(activityDate.getDate()).padStart(2,"0")}`;
    const activity = await request(port, caAfterRestart, "GET", `/api/v1/tasks/assigned/activity?date=${date}`, null, operator.body.token);
    assert.equal(activity.status, 200);
    assert.equal(activity.body.events.length, 500);
    assert.ok(activity.body.events.every((row) => row.username === "operator"));
    await rename(movedAuditFile, auditFile);
    const newEvent = { eventId: randomUUID(), taskId: "Bulk Task", trajectoryCode: "trajectory-live", action: "annotation_saved", occurredAtMs: Date.now() };
    assert.equal((await request(port, caAfterRestart, "POST", "/api/v1/audit/events", newEvent, operator.body.token)).status, 201);
    await service.stop();service = undefined;
    service = await createUserCenter(configuration, root, logger);await service.start();
    const relogin = await request(port, caAfterRestart, "POST", "/api/v1/auth/login", { username: "operator", password: "operator-password" });
    const duplicate = await request(port, caAfterRestart, "POST", "/api/v1/audit/events", newEvent, relogin.body.token);
    assert.equal(duplicate.status, 200);assert.equal(duplicate.body.duplicate, true);
    const afterRestart = await request(port, caAfterRestart, "GET", "/api/v1/tasks/assigned", null, relogin.body.token);
    assert.equal(afterRestart.body.tasks[0].completed, 2);
  } finally {
    await service?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
