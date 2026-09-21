import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const screenshotTarget = process.env.CONCURRENCY_SMOKE_SCREENSHOT
  ? path.resolve(root, process.env.CONCURRENCY_SMOKE_SCREENSHOT)
  : null;
const browserPath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));

if (!browserPath) {
  throw new Error("Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to run the browser smoke test.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to reserve a local port."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

async function waitForLayoutSettle(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;

    const root = document.documentElement;
    const body = document.body;
    const stableFramesRequired = 3;
    const snapshot = () => [
      window.innerWidth,
      window.innerHeight,
      root.clientWidth,
      root.clientHeight,
      root.scrollWidth,
      root.scrollHeight,
      body?.clientWidth ?? 0,
      body?.clientHeight ?? 0,
      body?.scrollWidth ?? 0,
      body?.scrollHeight ?? 0,
    ].join(":");

    await new Promise((resolve, reject) => {
      let animationFrame = 0;
      let stableFrames = 0;
      let previous = "";
      let resized = false;
      const observer = new ResizeObserver(() => { resized = true; });
      const cleanup = () => {
        observer.disconnect();
        cancelAnimationFrame(animationFrame);
        clearTimeout(timeout);
      };
      const timeout = window.setTimeout(() => {
        const lastSnapshot = snapshot();
        cleanup();
        reject(new Error(`Layout did not settle after viewport resize: ${lastSnapshot}`));
      }, 5_000);
      const sample = () => {
        const next = snapshot();
        if (resized || next !== previous) {
          previous = next;
          stableFrames = 0;
          resized = false;
        } else {
          stableFrames += 1;
        }

        if (stableFrames >= stableFramesRequired) {
          cleanup();
          resolve();
          return;
        }

        animationFrame = requestAnimationFrame(sample);
      };

      observer.observe(root);
      if (body) observer.observe(body);
      animationFrame = requestAnimationFrame(sample);
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const port = await getFreePort();
const url = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [
  path.join(root, "node_modules/vite/bin/vite.js"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += chunk; });
vite.stderr.on("data", (chunk) => { viteOutput += chunk; });

let browser;
try {
  await waitFor(async () => {
    const response = await fetch(url);
    return response.ok;
  }, "the Vite server");

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

  await page.addInitScript(() => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallbackId = 1;
    let activeTask = null;
    const calls = {
      scanSource: 0,
      scanOperationIds: [],
      importEpisode: 0,
      loadEpisode: 0,
      validateEpisode: 0,
      cancelOperationIds: [],
    };
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JrJ4AAAAASUVORK5CYII=";
    const streams = ["cam0", "cam1", "cam2", "t265_left", "t265_right", ...(location.search === '?task-center' ? ['extension_right', 't265_pose', 'extension_left'] : [])].map((name) => ({
      name,
      label: name,
      frameCount: 1,
      firstFrame: 0,
      lastFrame: 0,
      missingFrames: [],
      missingFrameCount: 0,
      totalBytes: 1,
      width: name.startsWith('extension_') ? null : 1,
      height: name.startsWith('extension_') ? null : 1,
      channels: 3,
    }));
    const taskCenterMode = location.search === '?task-center';
    const sourceRoot = taskCenterMode ? '/source/batch' : '/source';
    const makeEpisode = (name, indexed = false) => ({
      root: `${sourceRoot}/${name}`,
      name,
      indexed,
      totalFiles: indexed ? 6 : 0,
      totalBytes: indexed ? 6 : 0,
      stateCount: indexed ? 1 : 0,
      startTimeNs: indexed ? "1" : null,
      endTimeNs: indexed ? "1" : null,
      streams: indexed ? streams : streams.map((stream) => ({
        ...stream,
        frameCount: 0,
        firstFrame: null,
        lastFrame: null,
        totalBytes: 0,
        width: null,
        height: null,
        channels: null,
      })),
    });
    const episodes = [makeEpisode("episode-1"), makeEpisode("episode-2")];
    const previewEpisode = { ...makeEpisode("episode-1", true), indexed: false, totalBytes: 0 };
    const indexedEpisode = makeEpisode("episode-1", true);
    const scan = {
      sourceRoot,
      episodes,
      totalFiles: 0,
      totalBytes: 0,
      volume: {
        root: "/source",
        filesystem: "exFAT",
        driveType: "removable",
        totalBytes: 10_000,
        availableBytes: 5_000,
      },
    };
    const report = {
      formatVersion: 6,
      episodeRoot: episodes[0].root,
      parsedStateCount: 1,
      imageValidationMode: "sampled",
      imageSamplePercentages: [1, 25, 50, 73, 99],
      stateFrameRate: { expectedFps: 30, measuredFps: 30, tolerancePercent: 5, intervalCount: 0, stabilityPercent: null, stable: null },
      autoReportPath: null,
      status: "ok",
      checkedFiles: 6,
      elapsedMs: 1,
      issues: [],
      streams: streams.map((stream) => ({
        name: stream.name,
        checkedFrames: 1,
        decodeFailures: 0,
        status: "ok",
      })),
    };
    function beginTask(kind, operationId) {
      if (activeTask) throw new Error("A native task is already active.");
      return new Promise((resolve, reject) => {
        activeTask = { kind, operationId, resolve, reject };
      });
    }

    function activeSnapshot() {
      return activeTask
        ? { kind: activeTask.kind, operationId: activeTask.operationId }
        : null;
    }

    function takeActiveTask() {
      if (!activeTask) throw new Error("No active native task.");
      const task = activeTask;
      activeTask = null;
      return task;
    }

    window.__concurrencyMock = {
      calls,
      listenerCount(event) {
        return listeners.get(event)?.length ?? 0;
      },
      activeTask: activeSnapshot,
      emitProgress(payload) {
        for (const handler of listeners.get("task-progress") ?? []) {
          callbacks.get(handler)?.({ event: "task-progress", id: handler, payload });
        }
      },
      resolveActiveTask(value) {
        const task = takeActiveTask();
        task.resolve(value ?? (task.kind === "scan" || task.kind === "validate"
          ? task.kind === "scan" ? scan : { report, summary: indexedEpisode }
          : undefined));
      },
      rejectActiveTask(message) {
        takeActiveTask().reject(new Error(message));
      },
      cancelWith(operationId) {
        return window.__TAURI_INTERNALS__.invoke("cancel_task", { operationId });
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, id) {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter((candidate) => candidate !== id));
      },
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) {
        const id = nextCallbackId;
        nextCallbackId += 1;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      async invoke(command, args = {}) {
        if (command === "plugin:event|listen") {
          const current = listeners.get(args.event) ?? [];
          listeners.set(args.event, [...current, args.handler]);
          return args.handler;
        }
        if (command === "plugin:event|unlisten") return null;
        if (command === "persist_review_audit" || command === "flush_review_audit_queue") return { pending: 0, blocked: 0, error: "" };
        if (command === "plugin:dialog|open") return window.__concurrencyMock.chosenDirectory ?? "/source";
        if (command === "plugin:dialog|message") {
          return args.buttons?.OkCancelCustom?.[0] ?? args.buttons?.OkCustom ?? "Ok";
        }
        if (command.startsWith("plugin:dialog|")) return true;

        switch (command) {
          case "get_auth_status":
            return {
              workspaceMode: "managed",
              userCenter: { configured: true, endpoint: "demo://user-center", serviceId: "demo-user-center" },
              currentUser: { username: "tester", displayName: "Tester", role: taskCenterMode ? "operator" : undefined },
            };
          case "check_for_app_update":
            return {
              currentVersion: "0.17.17",
              latestVersion: "0.17.17",
              available: false,
              notes: null,
              publishedAt: null,
            };
          case "install_app_update":
            return false;
          case "list_task_definitions":
          case "list_assigned_task_definitions":
          case "get_assigned_tasks":
          case "list_my_machine_reviews":
          case "list_machine_annotation_sources":
          case "list_operation_errors":
            return [];
          case "get_assigned_task_activity":
            return { date: args.date, events: [] };
          case "get_task_center_root":
            return '/source';
          case "scan_task_center":
            (calls.folderRejectionRoots ??= []).push(args.sourceRoot);
            return { sourceRoot: args.sourceRoot, tree: { name: 'batch', relativePath: '', session: false, children: [
              { name: 'episode-1', relativePath: 'episode-1', session: true, status: 'pending', children: [] },
              { name: 'episode-2', relativePath: 'episode-2', session: true, status: 'approved', children: [] },
            ] } };
          case "reject_pending_machine_review":
            (calls.batchRejections ??= []).push(args);
            return args.sourcePath.endsWith('episode-2') ? null : { revision: 1, status: 'rejected' };
          case "read_task_index": {
            const batch = { name: 'batch', relativePath: 'batch', batchKey: 'a'.repeat(64), session: false, status: 'pending', total: 2, reviewed: 0, approved: 0, rejected: 0, errors: 0, incomplete: false, children: [] };
            return { catalog: { sourceRoot: '/source', tree: { ...batch, name: 'source', relativePath: '', children: [batch] } }, server: { completedAtMs: Date.now(), heartbeatAtMs: Date.now(), running: false } };
          }
          case "task_center_claims":
            if (args.action === 'lookup') return { claims: window.__concurrencyMock.claim ? [window.__concurrencyMock.claim] : [] };
            window.__concurrencyMock.claim = { batchKey: args.body.batchKey, username: 'tester', displayName: 'Tester', claimedAtMs: Date.now() };
            return { claim: window.__concurrencyMock.claim };
          case "record_operation_error":
            return {
              formatVersion: 1,
              id: `error-${Date.now()}`,
              occurredAtMs: Date.now(),
              operation: args.request.operation,
              code: "OPERATION_FAILED",
              message: args.request.message,
              sourcePath: args.request.sourcePath,
              processedBy: { username: "tester", displayName: "Tester" },
            };
          case "scan_source":
            calls.scanSource += 1;
            calls.scanOperationIds.push(args.operationId);
            calls.lastSourcePath = args.path;
            if (taskCenterMode && calls.scanSource === 1) throw Error('NAS disconnected');
            return beginTask("scan", args.operationId);
          case "import_episode":
            calls.importEpisode += 1;
            throw new Error("Direct-source UI must not invoke import_episode");
          case "load_episode":
            calls.loadEpisode += 1;
            if (calls.loadEpisode === 1 && !taskCenterMode) return beginTask("load", args.operationId);
            calls.lastEpisodeRoot = args.path;
            return {
              summary: previewEpisode,
              states: [{
                frameId: 0,
                captureTimeNs: "1",
                position: [0, 0, 0],
                velocity: [0, 0, 0],
                quaternion: [0, 0, 0, 1],
                euler: [0, 0, 0],
                omega: [0, 0, 0],
                confidence: 1,
              }],
            };
          case "validate_episode":
            calls.validateEpisode += 1;
            if (calls.validateEpisode === 1 && !taskCenterMode) return beginTask("validate", args.operationId);
            return { report, summary: indexedEpisode };
          case "load_episode_annotation":
            return null;
          case "read_frame":
            return { mimeType: "image/png", data: png };
          case "cancel_task": {
            calls.cancelOperationIds.push(args.operationId);
            if (!activeTask || activeTask.operationId !== args.operationId) return false;
            const task = takeActiveTask();
            queueMicrotask(() => task.reject(new Error("\u4efb\u52a1\u5df2\u53d6\u6d88")));
            return true;
          }
          default:
            return null;
        }
      },
    };
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor();
  await page.waitForFunction(() => window.__concurrencyMock.listenerCount("task-progress") >= 1);
  console.log("browser-smoke: app and progress listener loaded");

  const chooseSource = page.locator(".topbar-actions button.button-secondary");
  const rescan = page.getByRole("button", { name: "重新扫描", exact: true });
  assert.equal(await chooseSource.isDisabled(), false);
  assert.equal(await rescan.isDisabled(), false);

  await chooseSource.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 1);
  const firstScan = await page.evaluate(() => window.__concurrencyMock.activeTask());
  assert.equal(firstScan?.kind, "scan");
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "scan",
    phase: "Scanning source",
    current: 1,
    total: 2,
    bytesDone: 1,
    totalBytes: 2,
    currentPath: "/source",
    elapsedMs: 1,
  }), firstScan.operationId);
  await page.locator(".progress-strip").waitFor();
  assert.match(await page.locator(".progress-strip").innerText(), /Scanning source/);
  if (screenshotTarget) {
    await mkdir(path.dirname(screenshotTarget), { recursive: true });
    await page.screenshot({ path: screenshotTarget, fullPage: true });
  }
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask());
  await page.waitForFunction(() => {
    const active = window.__concurrencyMock.activeTask();
    return window.__concurrencyMock.calls.loadEpisode === 1 && active?.kind === "load";
  });
  const stagedLoad = await page.evaluate(() => window.__concurrencyMock.activeTask());
  assert.equal(stagedLoad?.operationId, firstScan.operationId);
  assert.match(await page.locator(".episode-item-meta").first().innerText(), /待读取/);
  const delayedCancelAccepted = await page.evaluate((operationId) => window.__concurrencyMock.cancelWith(operationId), firstScan.operationId + 1000);
  assert.equal(delayedCancelAccepted, false);
  assert.deepEqual(await page.evaluate(() => window.__concurrencyMock.activeTask()), stagedLoad);
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "validate",
    phase: "Reading source episode",
    current: 1,
    total: 1,
    bytesDone: 6,
    totalBytes: 6,
    currentPath: "/source/episode-1",
    elapsedMs: 1,
  }), stagedLoad.operationId);
  await page.waitForFunction(() => document.querySelector(".progress-strip")?.textContent?.includes("Reading source episode"));
  const cancel = page.locator(".progress-strip .icon-button");
  await cancel.click();
  await page.waitForFunction((operationId) => window.__concurrencyMock.calls.cancelOperationIds.includes(operationId), stagedLoad.operationId);
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  await page.waitForFunction(() => document.querySelector('[aria-label="重新扫描"]')?.disabled === false);
  assert.equal(await page.locator(".episode-source-state").filter({ hasText: "读取中" }).count(), 0);
  assert.ok(await page.locator(".episode-source-state").filter({ hasText: "可用" }).count() > 0);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.loadEpisode), 1);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.validateEpisode), 0);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.importEpisode), 0);
  console.log("browser-smoke: direct-source read cancellation stops follow-on validation without importing");

  await rescan.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 2);
  await page.evaluate(() => window.__concurrencyMock.rejectActiveTask("已有任务正在运行，请先等待或取消当前任务"));
  await page.locator(".alert-error").waitFor();
  assert.match(await page.locator(".alert-error").innerText(), /已有任务正在运行/);
  await page.waitForFunction(() => document.querySelector('[aria-label="重新扫描"]')?.disabled === false);
  console.log("browser-smoke: native rejection restores controls and shows an owned error");

  await rescan.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 3);
  const finalScan = await page.evaluate(() => window.__concurrencyMock.activeTask());
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "scan",
    phase: "Final scan",
    current: 2,
    total: 2,
    bytesDone: 2,
    totalBytes: 2,
    currentPath: "/source",
    elapsedMs: 1,
  }), finalScan.operationId);
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask());
  await page.waitForFunction(() => window.__concurrencyMock.calls.loadEpisode === 2);
  await page.waitForFunction(() => window.__concurrencyMock.activeTask()?.kind === "validate");
  await page.locator(".camera-grid img").first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".camera-grid img")]
    .every((image) => image.naturalWidth > 0));
  assert.match(await page.locator(".episode-item-meta").first().innerText(), /快速预览/);
  await page.locator(".view-tabs button").filter({ hasText: "导出" }).click();
  assert.equal(await page.locator(".export-button").isDisabled(), true);
  assert.match(await page.locator(".export-heading .status-mark").innerText(), /等待检查/);
  await page.locator(".view-tabs button").filter({ hasText: "校对" }).click();
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.validateEpisode), 1);
  await cancel.click();
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  await page.locator(".episode-item").filter({ hasText: "episode-1" }).dblclick();
  await page.waitForFunction(() => window.__concurrencyMock.calls.validateEpisode === 2);
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  assert.match(await page.locator(".episode-item-meta").first().innerText(), /1 states/);
  assert.equal(await rescan.isDisabled(), false);

  for (const viewport of [
    { width: 1440, height: 920 },
    { width: 960, height: 680 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await waitForLayoutSettle(page);
    const layout = await page.evaluate(() => {
      const overflow = [...document.querySelectorAll("*")]
        .filter((element) => element.scrollWidth > window.innerWidth)
        .slice(0, 3)
        .map((element) => ({
          className: element.className,
          scrollWidth: element.scrollWidth,
          tagName: element.tagName,
        }));
      return { innerWidth: window.innerWidth, overflow, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.ok(
      layout.scrollWidth <= layout.innerWidth,
      `${viewport.width}px viewport overflowed: ${JSON.stringify(layout)}`,
    );
  }
  console.log("browser-smoke: completed flow renders five images without responsive overflow");
  assert.equal(await page.locator('.camera-placeholder').count(), 2);
  assert.equal(await page.locator('.camera-5 figcaption').textContent(), 'extension_left');
  assert.equal(await page.locator('.camera-6 figcaption').textContent(), 'extension_right');

  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto(`${url}?task-center`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  const taskDialogBeforeClaim = page.getByRole('dialog', { name: '任务中心' });
  assert.equal(await taskDialogBeforeClaim.getByRole('button', { name: '批量不通过', exact: true }).count(), 0);
  assert.equal(await taskDialogBeforeClaim.getByRole('button', { name: '文件夹不通过', exact: true }).count(), 0);
  await page.getByRole('button', { name: '领取', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: '任务中心' });
  await taskDialog.getByRole('alert').filter({ hasText: 'NAS disconnected' }).waitFor();
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.lastSourcePath), '/source/batch');
  assert.equal(await page.evaluate(() => window.__concurrencyMock.claim.username), 'tester');
  await taskDialog.getByRole('button', { name: '进入审核', exact: true }).click();
  await page.waitForFunction(() => window.__concurrencyMock.activeTask()?.kind === 'scan');
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask({ sourceRoot: '/source/batch', episodes: [], volume: {} }));
  await taskDialog.getByRole('alert').filter({ hasText: '未发现可加载的数据' }).waitFor();
  await taskDialog.getByRole('button', { name: '进入审核', exact: true }).click();
  await page.waitForFunction(() => window.__concurrencyMock.activeTask()?.kind === 'scan');
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask());
  await taskDialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.loadEpisode), 1);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.lastEpisodeRoot), '/source/batch/episode-1');
  assert.equal(await page.locator('.episode-item').count(), 2);
  await page.getByRole('checkbox', { name: '选择 episode-1' }).check();
  assert.equal(await page.getByRole('button', { name: '批量不通过', exact: true }).isVisible(), true);
  await page.getByRole('checkbox', { name: '选择 episode-1' }).uncheck();
  await page.locator('.camera-grid img').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.camera-grid img[aria-hidden="false"]')].filter(image => image.naturalWidth > 0).length === 7);
  assert.equal(await page.locator('.camera-placeholder').count(), 0);
  assert.equal(await page.locator('.camera-grid .frame-panel').count(), 7);
  assert.equal(await page.locator('.camera-grid').getByText('t265_pose', {exact:true}).count(), 0);
  await page.waitForFunction(() => document.querySelector('.frame-render-progress-count')?.textContent.includes('7/7'));
  for (const [index, name] of [[5, 'extension_left'], [6, 'extension_right']]) {
    assert.equal(await page.locator(`.camera-${index} .frame-camera-name`).textContent(), name);
    assert.equal(await page.locator(`.camera-${index} img`).first().getAttribute('alt'), `${name} frame 0`);
    assert.equal(await page.locator(`.camera-${index} .frame-resolution`).textContent(), '1×1');
  }
  const slots = await page.locator('.camera-grid').evaluate(grid => {
    const bounds = i => { const r = grid.querySelector('.camera-' + i).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
    return [1,2,3,4,5,6].map(bounds);
  });
  for (const slot of slots) {
    assert.ok(Math.abs(slot.w - slots[0].w) < 1, 'all secondary cameras have equal width');
    assert.ok(Math.abs(slot.h - slots[0].h) < 1, 'all secondary cameras have equal height');
  }
  assert.ok(slots[4].x > slots[1].x && slots[5].y > slots[4].y, 'new cameras occupy the rightmost column');
  await mkdir('artifacts/extra-cameras', {recursive:true});
  await page.screenshot({path:'artifacts/extra-cameras/seven-desktop.png',fullPage:true});
  for (const width of [960, 390]) {
    await page.setViewportSize({width,height:844});
    await waitForLayoutSettle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const index of [5, 6]) {
      assert.equal(await page.locator(`.camera-${index} .frame-resolution`).isVisible(), true);
      assert.equal(await page.locator(`.camera-${index} figcaption`).evaluate(caption =>
        caption.scrollWidth <= caption.clientWidth && [...caption.children].every(child =>
          child.getBoundingClientRect().right <= caption.getBoundingClientRect().right)), true);
    }
    await page.screenshot({path:`artifacts/extra-cameras/seven-${width}.png`,fullPage:true});
  }
  console.log('browser-smoke: task claim opens batch and first episode; NAS/empty-directory failures retain claim and allow retry');

  // Bulk review belongs to the loaded source list, never the task catalog.
  const toolbar = page.locator('.sidebar-review-toolbar');
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 900});
    await waitForLayoutSettle(page);
    assert.equal(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await toolbar.getByRole('button', {name: '整文件夹不通过', exact: true}).isVisible(), true);
    await page.screenshot({path:`artifacts/batch-rejection/sidebar-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('checkbox', {name:'选择 episode-1', exact:true}).check();
  await toolbar.getByRole('button', {name:'批量不通过', exact:true}).click();
  const rejectDialog = page.locator('.batch-rejection-dialog');
  await rejectDialog.getByText('待处理 1 条', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:'选择数据目录', exact:true}).isDisabled(), true);
  await rejectDialog.getByRole('textbox', {name:'批量不通过原因'}).fill('无效数据');
  await rejectDialog.getByRole('checkbox').check();
  await rejectDialog.getByRole('button', {name:'确认不通过', exact:true}).click();
  await rejectDialog.getByText('成功 1 · 跳过 0 · 失败 0 · 未执行 0', {exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__concurrencyMock.calls.batchRejections.map(call => call.sourcePath)), ['/source/batch/episode-1']);
  await rejectDialog.getByRole('button', {name:'完成', exact:true}).click();
  await page.getByRole('checkbox', {name:'选择 episode-2', exact:true}).check();
  await page.evaluate(() => { window.__concurrencyMock.chosenDirectory = '/source/other-batch'; });
  await page.getByRole('button', {name:'选择数据目录', exact:true}).click();
  await page.waitForFunction(() => window.__concurrencyMock.activeTask()?.kind === 'scan');
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask({
    sourceRoot:'/source/other-batch', volume:{driveType:'remote'},
    episodes:[1,2].map(i => ({root:'/source/other-batch/episode-'+i,name:'episode-'+i,indexed:false,streams:[]})),
  }));
  await toolbar.getByText('已选 0 条', {exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox', {name:'选择 episode-2', exact:true}).isChecked(), false);
  await toolbar.getByRole('button', {name:'整文件夹不通过', exact:true}).click();
  await rejectDialog.getByText('待处理 1 条 · 已排除已审核或异常数据 1 条', {exact:true}).waitFor();
  await rejectDialog.getByRole('textbox', {name:'批量不通过原因'}).fill('任务不符');
  await rejectDialog.getByRole('checkbox').check();
  await rejectDialog.getByRole('button', {name:'确认不通过', exact:true}).click();
  await rejectDialog.getByText('成功 1 · 跳过 0 · 失败 0 · 未执行 0', {exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.folderRejectionRoots.at(-1)), '/source/other-batch');
  assert.deepEqual(await page.evaluate(() => window.__concurrencyMock.calls.batchRejections.map(call => call.sourcePath)), ['/source/batch/episode-1', '/source/other-batch/episode-1']);
  await rejectDialog.getByRole('button', {name:'完成', exact:true}).click();
  console.log('browser-smoke: sidebar bulk rejection is limited to the loaded batch, directory changes clear selection and folder review skips completed QC');

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.importEpisode), 0);
  console.log("Concurrency browser smoke passed: direct-source ownership, cancellation, failure, completion, responsive layout.");
} catch (error) {
  throw new Error(`${error}\nVite output:\n${viteOutput}`);
} finally {
  await browser?.close();
  await stop(vite);
}
