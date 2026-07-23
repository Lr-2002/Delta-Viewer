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
    let activeScan = null;
    const calls = { scanSource: 0, cancelTask: 0, loadEpisode: 0 };
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
    const episode = {
      root: "/source/episode-1",
      name: "episode-1",
      totalFiles: 6,
      totalBytes: 6,
      stateCount: 1,
      startTimeNs: "1",
      endTimeNs: "1",
      streams,
    };
    const scan = {
      sourceRoot: "/source",
      episodes: [episode],
      totalFiles: 6,
      totalBytes: 6,
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
      episodeRoot: episode.root,
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

    window.__concurrencyMock = {
      calls,
      listenerCount(event) {
        return listeners.get(event)?.length ?? 0;
      },
      emitProgress(payload) {
        for (const handler of listeners.get("task-progress") ?? []) {
          callbacks.get(handler)?.({ event: "task-progress", id: handler, payload });
        }
      },
      resolveActiveScan() {
        if (!activeScan) throw new Error("No active scan to resolve.");
        const scanToResolve = activeScan;
        activeScan = null;
        scanToResolve.resolve(scan);
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
        switch (command) {
          case "plugin:event|listen": {
            const current = listeners.get(args.event) ?? [];
            listeners.set(args.event, [...current, args.handler]);
            return args.handler;
          }
          case "plugin:event|unlisten":
            return null;
          case "plugin:dialog|open":
            return "/source";
          case "plugin:dialog|message":
            return "OK";
          case "get_auth_status":
            return { hasAccounts: true, currentUser: { username: "tester", displayName: "Tester" } };
          case "list_task_definitions":
            return [];
          case "list_operation_errors":
            return [];
          case "scan_source":
            calls.scanSource += 1;
            if (activeScan) throw new Error("A native task is already active.");
            return new Promise((resolve, reject) => {
              activeScan = { resolve, reject };
            });
          case "prepare_import_workspace":
            return "/managed-imports";
          case "list_partial_imports":
            return [];
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
            return {
              destination: "/managed-imports/episode-1",
              totalFiles: 6,
              totalBytes: 6,
              datasetBlake3: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              elapsedMs: 1,
            };
          case "load_episode":
            calls.loadEpisode += 1;
            return {
              summary: episode,
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
            return report;
          case "load_episode_annotation":
            return null;
          case "read_frame":
            return { mimeType: "image/png", data: png };
          case "cancel_task": {
            calls.cancelTask += 1;
            if (activeScan) {
              const scanToCancel = activeScan;
              activeScan = null;
              queueMicrotask(() => scanToCancel.reject(new Error("\u4efb\u52a1\u5df2\u53d6\u6d88")));
            }
            return null;
          }
          default:
            return null;
        }
      },
    };
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor();
  console.log("browser-smoke: app loaded");
  await page.waitForFunction(() => window.__concurrencyMock.listenerCount("task-progress") >= 1);
  console.log("browser-smoke: progress listener registered");

  const chooseSource = page.locator(".topbar-actions button.button-secondary");
  await chooseSource.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 1);
  console.log("browser-smoke: overlapping scan request blocked");

  const rescan = page.locator(".sidebar-heading .icon-button");
  await page.waitForFunction(() => document.querySelector(".sidebar-heading .icon-button")?.disabled === true);
  assert.equal(await chooseSource.isDisabled(), true);
  assert.equal(await rescan.isDisabled(), true);

  await page.evaluate(() => window.__concurrencyMock.emitProgress({
    task: "scan",
    phase: "Scanning",
    current: 1,
    total: 2,
    bytesDone: 1,
    totalBytes: 2,
    currentPath: "/source",
    elapsedMs: 1,
  }));
  await page.locator(".progress-strip").waitFor();
  console.log("browser-smoke: active scan controls disabled");
  if (screenshotTarget) {
    await mkdir(path.dirname(screenshotTarget), { recursive: true });
    await page.screenshot({ path: screenshotTarget, fullPage: true });
  }

  await page.evaluate(() => window.__concurrencyMock.resolveActiveScan());
  await page.waitForFunction(() => window.__concurrencyMock.calls.loadEpisode === 1);
  console.log("browser-smoke: scan completion advanced to load");
  await page.locator(".camera-grid img").first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".camera-grid img")]
    .every((image) => image.naturalWidth > 0));
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  assert.equal(await rescan.isDisabled(), false);
  console.log("browser-smoke: normal completion restored controls");

  for (const viewport of [
    { width: 1440, height: 920 },
    { width: 960, height: 680 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  await page.setViewportSize({ width: 1440, height: 920 });
  console.log("browser-smoke: responsive viewports clear");

  await rescan.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.scanSource === 2);
  await page.evaluate(() => window.__concurrencyMock.emitProgress({
    task: "scan",
    phase: "Rescanning",
    current: 1,
    total: 2,
    bytesDone: 1,
    totalBytes: 2,
    currentPath: "/source",
    elapsedMs: 1,
  }));
  const cancel = page.locator(".progress-strip .icon-button");
  await cancel.waitFor();
  await cancel.click();
  await page.waitForFunction(() => window.__concurrencyMock.calls.cancelTask === 1);
  console.log("browser-smoke: cancellation requested");
  await page.waitForFunction(() => !document.querySelector(".progress-strip"));
  await page.waitForFunction(() => document.querySelector(".alert-notice") !== null);
  assert.equal(await rescan.isDisabled(), false);

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log("Concurrency browser smoke passed: overlap, completion, cancellation, responsive layout.");
} catch (error) {
  throw new Error(`${error}\nVite output:\n${viteOutput}`);
} finally {
  await browser?.close();
  await stop(vite);
}
