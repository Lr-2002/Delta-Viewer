import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const requireBrowser = process.env.DIALOG_RECOVERY_REQUIRE_BROWSER === "1";
const dialogViewport = parseViewport(process.env.DIALOG_RECOVERY_VIEWPORT) ?? { width: 1440, height: 920 };
const configuredBrowser = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE
  ?? process.env.CHROME_BIN
  ?? process.env.CHROME_PATH;
const browserCandidates = configuredBrowser ? [configuredBrowser] : [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const browserExecutable = browserCandidates.find((candidate) => existsSync(candidate));

if (!browserExecutable && requireBrowser) {
  test("native dialog recovery", () => {
    assert.fail("DIALOG_RECOVERY_REQUIRE_BROWSER is set but no supported Chromium executable is available");
  });
} else if (!browserExecutable) {
  test("native dialog recovery", { skip: "No supported Chromium executable is installed" }, () => {});
} else {
  let browser;
  let server;
  let baseUrl;

  before(async () => {
    const port = await findAvailablePort();
    server = await createServer({
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        fs: { allow: [process.cwd()] },
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite did not expose a local test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true, args: ["--no-sandbox"] });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  test("native export dialogs recover rejected calls and preserve successful export behavior", { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: dialogViewport });
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(request.url()));

    await page.addInitScript(() => {
      const callbacks = new Map();
      const listeners = new Map();
      const failures = [];
      const records = [];
      const calls = {
        exportEpisode: 0,
        exportValidationReport: 0,
        exportAnnotatedEpisodes: 0,
        importEpisode: 0,
        revealedPaths: [],
      };
      let callbackId = 1;
      let recordId = 1;
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
        root: "/source/episode",
        name: "episode",
        totalFiles: 6,
        totalBytes: 6,
        stateCount: 1,
        startTimeNs: "1",
        endTimeNs: "1",
        streams,
      };
      const report = {
        formatVersion: 4,
        episodeRoot: "/source/episode",
        parsedStateCount: 1,
        imageValidationMode: "sampled",
        imageSamplePercentages: [1, 25, 50, 73, 99],
        stateFrameRate: { expectedFps: 30, measuredFps: null, tolerancePercent: 5, intervalCount: 0 },
        autoReportPath: "/reports/episode.json",
        status: "warning",
        checkedFiles: 6,
        elapsedMs: 1,
        issues: [{
          severity: "warning",
          scope: "states",
          code: "TIMESTAMP_GAP",
          message: "Fixture warning",
          frameId: null,
        }],
        streams: streams.map((stream) => ({
          name: stream.name,
          checkedFrames: 1,
          decodeFailures: 0,
          status: "ok",
        })),
      };
      const annotatedEpisode = (episodeId, trajectoryCode, episodeRoot) => ({
        annotation: {
          formatVersion: 1,
          episodeId,
          episodeRoot,
          episodeFingerprint: `fingerprint-${episodeId}`,
          trajectoryCode,
          taskId: "task",
          taskDescription: "测试批量导出",
          processedBy: { username: "tester", displayName: "Tester" },
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        sourceAvailable: true,
      });

      window.__dialogRecoveryMock = {
        calls,
        records,
        failNext(command, message) {
          failures.push({ command, message });
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
          const id = callbackId;
          callbackId += 1;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id) {
          callbacks.delete(id);
        },
        async invoke(command, args = {}) {
          const failureIndex = failures.findIndex((failure) => failure.command === command);
          if (failureIndex >= 0) {
            const [failure] = failures.splice(failureIndex, 1);
            throw new Error(failure.message);
          }
          if (command === "plugin:event|listen") {
            const current = listeners.get(args.event) ?? [];
            listeners.set(args.event, [...current, args.handler]);
            return args.handler;
          }
          if (command === "plugin:event|unlisten") return null;
          if (command === "plugin:dialog|open") return "/destination";
          if (command === "plugin:dialog|message") {
            return args.buttons?.OkCancelCustom?.[0] ?? args.buttons?.OkCustom ?? "Ok";
          }
          if (command === "plugin:opener|reveal_item_in_dir") {
            calls.revealedPaths.push(...args.paths);
            return null;
          }
          switch (command) {
            case "get_auth_status":
              return {
                workspaceMode: "managed",
                userCenter: { configured: true, endpoint: "demo://user-center", serviceId: "demo-user-center" },
                currentUser: { username: "tester", displayName: "Tester" },
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
            case "list_operation_errors":
              return [];
            case "list_annotated_episodes":
              return [
                annotatedEpisode("episode-success", "task-001", "/source/episode-success"),
                annotatedEpisode("episode-failed", "task-002", "/source/episode-failed"),
              ];
            case "record_operation_error": {
              const record = {
                formatVersion: 1,
                id: `history-${recordId}`,
                occurredAtMs: Date.now(),
                operation: args.request.operation,
                code: "OPERATION_FAILED",
                message: args.request.message,
                sourcePath: args.request.sourcePath,
                processedBy: { username: "tester", displayName: "Tester" },
              };
              recordId += 1;
              records.push(record);
              return record;
            }
            case "scan_source":
              return {
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
            case "import_episode":
              calls.importEpisode += 1;
              throw new Error("Direct-source UI must not invoke import_episode");
            case "load_episode":
              return {
                summary: { ...episode, root: args.path },
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
            case "export_episode":
              calls.exportEpisode += 1;
              return {
                outputPath: "/destination/episode.mcap",
                totalFiles: 1,
                totalBytes: 42,
                elapsedMs: 1,
              };
            case "export_validation_report":
              calls.exportValidationReport += 1;
              return {
                outputPath: "/destination/episode-report.json",
                totalFiles: 1,
                totalBytes: 42,
                elapsedMs: 1,
              };
            case "export_annotated_episodes":
              calls.exportAnnotatedEpisodes += 1;
              return {
                format: args.request.format,
                destinationParent: args.request.destinationParent,
                requestedCount: 2,
                exportedCount: 1,
                failedCount: 1,
                cancelled: false,
                totalFiles: 1,
                totalBytes: 42,
                elapsedMs: 2,
                items: [
                  {
                    episodeId: "episode-success",
                    trajectoryCode: "task-001",
                    sourcePath: "/source/episode-success",
                    status: "exported",
                    validationStatus: "ok",
                    result: {
                      format: args.request.format,
                      outputPath: "/destination/task-001.mcap",
                      trajectoryCode: "task-001",
                      totalFiles: 1,
                      totalBytes: 42,
                      elapsedMs: 1,
                      range: { startFrame: 0, endFrame: 0 },
                      stateCount: 1,
                    },
                    error: null,
                    errorLogPath: null,
                  },
                  {
                    episodeId: "episode-failed",
                    trajectoryCode: "task-002",
                    sourcePath: "/source/episode-failed",
                    status: "failed",
                    validationStatus: "error",
                    result: null,
                    error: "FRAME_ID_MISMATCH: 图像帧集合不一致",
                    errorLogPath: "/app-data/reports/operation-errors/task-002.json",
                  },
                ],
              };
            default:
              return null;
          }
        },
      };
    });

    try {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.locator(".app-shell").waitFor();
      await page.locator(".topbar-actions .button-secondary").click();
      await page.locator(".view-tabs").waitFor();
      await page.locator(".camera-grid img").first().waitFor();

      await page.locator(".view-tabs button").nth(2).click();
      await page.evaluate(() => window.__dialogRecoveryMock.failNext("plugin:dialog|message", "CONFIRM_DIALOG_FAILURE"));
      await page.locator(".export-button").click();
      await expectFailure(page, "CONFIRM_DIALOG_FAILURE", 1, "export_episode");

      await page.evaluate(() => window.__dialogRecoveryMock.failNext("plugin:dialog|open", "EXPORT_DIRECTORY_DIALOG_FAILURE"));
      await page.locator(".export-button").click();
      await expectFailure(page, "EXPORT_DIRECTORY_DIALOG_FAILURE", 2, "export_episode");

      await page.locator(".view-tabs button").nth(1).click();
      await page.evaluate(() => window.__dialogRecoveryMock.failNext("plugin:dialog|open", "REPORT_DIRECTORY_DIALOG_FAILURE"));
      await page.locator(".check-heading-actions button").click();
      await expectFailure(page, "REPORT_DIRECTORY_DIALOG_FAILURE", 3, "export_validation_report");

      await page.locator(".view-tabs button").nth(2).click();
      await page.locator(".export-button").click();
      await page.waitForFunction(() => window.__dialogRecoveryMock.calls.exportEpisode === 1);
      await page.locator(".export-result").waitFor();
      assert.match(await page.locator(".export-result").innerText(), /episode\.mcap/);
      assert.equal(await page.locator(".alert-error").count(), 0);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.records.length), 3);

      await page.locator(".view-tabs button").nth(1).click();
      await page.locator(".check-heading-actions button").click();
      await page.waitForFunction(() => window.__dialogRecoveryMock.calls.exportValidationReport === 1);
      await page.waitForFunction(() => [...document.querySelectorAll(".alert-notice")]
        .some((element) => element.textContent?.includes("检查报告已导出")));
      assert.equal(await page.locator(".alert-error").count(), 0);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.records.length), 3);

      await page.getByLabel("操作错误历史").click();
      await page.waitForFunction(() => document.querySelectorAll(".operation-history-row").length === 3);
      const historyText = await page.locator(".operation-history").innerText();
      assert.match(historyText, /CONFIRM_DIALOG_FAILURE/);
      assert.match(historyText, /EXPORT_DIRECTORY_DIALOG_FAILURE/);
      assert.match(historyText, /REPORT_DIRECTORY_DIALOG_FAILURE/);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.calls.exportEpisode), 1);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.calls.exportValidationReport), 1);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.calls.importEpisode), 0);

      await page.getByRole("button", { name: "批量", exact: true }).click();
      await page.getByText("task-001", { exact: true }).waitFor();
      await page.getByRole("button", { name: "选择目录并批量导出" }).click();
      await page.locator(".batch-result").waitFor();
      assert.match(await page.locator(".batch-result").innerText(), /成功 1 · 失败 1/);
      await page.getByRole("button", { name: "查看 task-002 失败日志" }).click();
      const failureLog = page.getByRole("region", { name: "task-002 失败日志" });
      await failureLog.waitFor();
      assert.match(await failureLog.innerText(), /FRAME_ID_MISMATCH/);
      assert.match(await failureLog.innerText(), /task-002\.json/);
      await failureLog.getByRole("button", { name: "打开日志所在位置" }).click();
      await page.getByRole("button", { name: "打开文件所在位置" }).click();
      await page.waitForFunction(() => window.__dialogRecoveryMock.calls.revealedPaths.length === 2);
      assert.deepEqual(await page.evaluate(() => window.__dialogRecoveryMock.calls.revealedPaths), [
        "/app-data/reports/operation-errors/task-002.json",
        "/destination/task-001.mcap",
      ]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(await page.evaluate(() => window.__dialogRecoveryMock.calls.exportAnnotatedEpisodes), 1);
      if (process.env.DIALOG_RECOVERY_SCREENSHOT) {
        await page.screenshot({ path: process.env.DIALOG_RECOVERY_SCREENSHOT, fullPage: true });
      }
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(failedRequests, []);
    } finally {
      await page.close();
    }
  });
}

async function expectFailure(page, message, recordCount, operation) {
  await page.waitForFunction((failureMessage) => (
    document.querySelector(".alert-error")?.textContent?.includes(failureMessage)
  ), message);
  await page.waitForFunction((expectedCount) => window.__dialogRecoveryMock.records.length === expectedCount, recordCount);
  const record = await page.evaluate(() => window.__dialogRecoveryMock.records.at(-1));
  assert.equal(record.operation, operation);
  assert.equal(record.sourcePath, "/source/episode");
  assert.equal(record.message, message);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not determine a local test port")));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function parseViewport(value) {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid DIALOG_RECOVERY_VIEWPORT: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
