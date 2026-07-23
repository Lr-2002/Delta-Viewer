import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
let server;
let OperationScope;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  ({ OperationScope } = await server.ssrLoadModule("/src/lib/operationScope.ts"));
});

after(async () => {
  await server?.close();
});

test("rejected overlap keeps the active busy, progress, and error state", () => {
  const scope = new OperationScope();
  const scan = scope.begin();
  const state = { busy: true, progress: "scanning", error: "active operation failed" };

  assert.ok(scan);
  const rejectedOperation = scope.begin();
  assert.equal(rejectedOperation, null);
  if (rejectedOperation && scope.finish(rejectedOperation)) {
    state.busy = false;
    state.progress = "";
    state.error = "";
  }
  assert.deepEqual(state, {
    busy: true,
    progress: "scanning",
    error: "active operation failed",
  });
  assert.equal(scope.current(), scan);
  assert.equal(scope.isCurrent(scan), true);
});

test("stale cleanup cannot clear a newer operation state", () => {
  const scope = new OperationScope();
  const completedScan = scope.begin();

  assert.ok(completedScan);
  assert.equal(scope.finish(completedScan), true);

  const activeImport = scope.begin();
  assert.ok(activeImport);
  const state = { busy: true, progress: "importing", error: "active operation failed" };

  if (scope.finish(completedScan)) {
    state.busy = false;
    state.progress = "";
    state.error = "";
  }

  assert.deepEqual(state, {
    busy: true,
    progress: "importing",
    error: "active operation failed",
  });
  assert.equal(scope.current(), activeImport);
});

test("cancellation leaves ownership active until its operation settles", () => {
  const scope = new OperationScope();
  const scan = scope.begin();

  assert.ok(scan);
  const cancellationOwner = scope.current();
  assert.equal(cancellationOwner, scan);
  assert.equal(scope.requestCancellation(scan), true);
  assert.equal(scope.isCancellationRequested(scan), true);
  assert.equal(scope.isCurrent(cancellationOwner), true);
  assert.equal(scope.finish(scan), true);
  assert.equal(scope.current(), null);
});

test("a delayed cancellation cannot transfer to a later operation id", () => {
  const scope = new OperationScope();
  const first = scope.begin();

  assert.ok(first);
  assert.equal(scope.requestCancellation(first), true);
  assert.equal(scope.finish(first), true);

  const second = scope.begin();
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(scope.requestCancellation(first), false);
  assert.equal(scope.isCancellationRequested(second), false);
});
