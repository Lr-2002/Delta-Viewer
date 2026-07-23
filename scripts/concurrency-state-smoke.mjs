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
const vite = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: root,
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
    let startupPartialPending = true;
    let importAttempt = 0;
    const calls = {
      scanSource: 0,
      scanOperationIds: [],
      cleanupPartialImport: 0,
      importEpisode: 0,
      loadEpisode: 0,
      validateEpisode: 0,
      cancelOperationIds: [],
    };
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JrJ4AAAAASUVORK5CYII=";
    const streams = ["cam0", "cam1", "cam2", "t265_left", "t265_right"].map((name) => ({
      name,
      label: name,
      frameCount: 1,
      firstFrame: 0,
      lastFrame: 0,
      missingFrames: [],
      missingFrameCount: 0,
      totalBytes: 1,
      width: 1,
      height: 1,
      channels: 3,
    }));
    const makeEpisode = (name) => ({
      root: `/source/${name}`,
      name,
      totalFiles: 6,
      totalBytes: 6,
      stateCount: 1,
      startTimeNs: "1",
      endTimeNs: "1",
      streams,
    });
    const episodes = [makeEpisode("episode-1"), makeEpisode("episode-2")];
    const scan = {
      sourceRoot: "/source",
      episodes,
      totalFiles: 12,
      totalBytes: 12,
      volume: {
        root: "/source",
        filesystem: "exFAT",
        driveType: "removable",
        totalBytes: 10_000,
        availableBytes: 5_000,
      },
    };
    const report = {
      formatVersion: 3,
      episodeRoot: episodes[0].root,
      parsedStateCount: 1,
      imageValidationMode: "sampled",
      imageSamplePercentages: [1, 25, 50, 73, 99],
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
    const partial = {
      path: "/managed-imports/.partial-episode",
      name: ".partial-episode",
      sourceName: "episode-previous",
      createdAtMs: 1,
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

    function importResult(sourcePath) {
      const name = sourcePath.split("/").at(-1);
      return {
        destination: `/managed-imports/${name}`,
        totalFiles: 6,
        totalBytes: 6,
        datasetBlake3: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        elapsedMs: 1,
      };
    }

    window.localStorage.setItem("dohc-viewer:last-managed-import-root", "/managed-imports");
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
        if (task.kind === "cleanup") startupPartialPending = false;
        task.resolve(value ?? (task.kind === "scan" ? scan : undefined));
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
        if (command === "plugin:dialog|open") return "/source";
        if (command === "plugin:dialog|message") {
          return args.buttons?.OkCancelCustom?.[0] ?? args.buttons?.OkCustom ?? "Ok";
        }
        if (command.startsWith("plugin:dialog|")) return true;

        switch (command) {
          case "get_auth_status":
            return { hasAccounts: true, currentUser: { username: "tester", displayName: "Tester" } };
          case "list_task_definitions":
          case "list_operation_errors":
            return [];
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
            return beginTask("scan", args.operationId);
          case "prepare_import_workspace":
            return "/managed-imports";
          case "list_partial_imports":
            return startupPartialPending ? [partial] : [];
          case "cleanup_partial_import":
            calls.cleanupPartialImport += 1;
            return beginTask("cleanup", args.operationId);
          case "inspect_import_destination":
            return {
              canImport: true,
              sourceBytes: 6,
              requiredBytes: 6,
              largestFileBytes: 1,
              volume: scan.volume,
              issues: [],
              partials: [],
            };
          case "import_episode":
            calls.importEpisode += 1;
            importAttempt += 1;
            if (importAttempt === 2) return beginTask("import", args.operationId);
            return importResult(args.sourcePath);
          case "load_episode":
            calls.loadEpisode += 1;
            return {
              summary: episodes[0],
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
            return report;
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
  const rescan = page.locator(".sidebar-heading .icon-button");
  await page.waitForFunction(() => window.__concurrencyMock.calls.cleanupPartialImport === 1);
  const cleanup = await page.evaluate(() => window.__concurrencyMock.activeTask());
  assert.equal(cleanup?.kind, "cleanup");
  assert.equal(await chooseSource.isDisabled(), true);
  assert.equal(await rescan.isDisabled(), true);
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "import",
    phase: "Startup cleanup",
    current: 1,
    total: 1,
    bytesDone: 1,
    totalBytes: 1,
    currentPath: "/managed-imports/.partial-episode",
    elapsedMs: 1,
  }), cleanup.operationId);
  await page.locator(".progress-strip").waitFor();
  console.log("browser-smoke: startup cleanup owns the UI and blocks rescan");
  await page.evaluate(() => window.__concurrencyMock.resolveActiveTask());
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  await page.waitForFunction(() => document.querySelector(".sidebar-heading .icon-button")?.disabled === false);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.scanSource), 0);

  await chooseSource.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 1);
  const firstScan = await page.evaluate(() => window.__concurrencyMock.activeTask());
  assert.equal(firstScan?.kind, "scan");
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "scan",
    phase: "Late cleanup progress",
    current: 1,
    total: 1,
    bytesDone: 1,
    totalBytes: 1,
    currentPath: "/managed-imports",
    elapsedMs: 1,
  }), cleanup.operationId);
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".progress-strip").count(), 0);
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
    return window.__concurrencyMock.calls.importEpisode === 2 && active?.kind === "import";
  });
  const stagedImport = await page.evaluate(() => window.__concurrencyMock.activeTask());
  assert.equal(stagedImport?.operationId, firstScan.operationId);
  const delayedCancelAccepted = await page.evaluate((operationId) => window.__concurrencyMock.cancelWith(operationId), cleanup.operationId);
  assert.equal(delayedCancelAccepted, false);
  assert.deepEqual(await page.evaluate(() => window.__concurrencyMock.activeTask()), stagedImport);
  await page.evaluate((operationId) => window.__concurrencyMock.emitProgress({
    operationId,
    task: "import",
    phase: "Importing second episode",
    current: 2,
    total: 2,
    bytesDone: 6,
    totalBytes: 12,
    currentPath: "/source/episode-2",
    elapsedMs: 1,
  }), stagedImport.operationId);
  await page.waitForFunction(() => document.querySelector(".progress-strip")?.textContent?.includes("Importing second episode"));
  const cancel = page.locator(".progress-strip .icon-button");
  await cancel.click();
  await page.waitForFunction((operationId) => window.__concurrencyMock.calls.cancelOperationIds.includes(operationId), stagedImport.operationId);
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  await page.waitForFunction(() => document.querySelector(".sidebar-heading .icon-button")?.disabled === false);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.loadEpisode), 0);
  assert.equal(await page.evaluate(() => window.__concurrencyMock.calls.validateEpisode), 0);
  console.log("browser-smoke: staged automatic import cancellation stops follow-on load and validate");

  await rescan.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 2);
  await page.evaluate(() => window.__concurrencyMock.rejectActiveTask("已有任务正在运行，请先等待或取消当前任务"));
  await page.locator(".alert-error").waitFor();
  assert.match(await page.locator(".alert-error").innerText(), /已有任务正在运行/);
  await page.waitForFunction(() => document.querySelector(".sidebar-heading .icon-button")?.disabled === false);
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
  await page.waitForFunction(() => window.__concurrencyMock.calls.loadEpisode === 1);
  await page.locator(".camera-grid img").first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".camera-grid img")]
    .every((image) => image.naturalWidth > 0));
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
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

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log("Concurrency browser smoke passed: startup cleanup, delayed ownership, cancellation, failure, completion, responsive layout.");
} catch (error) {
  throw new Error(`${error}\nVite output:\n${viteOutput}`);
} finally {
  await browser?.close();
  await stop(vite);
}
