import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const root = process.cwd();
const browserExecutable = findBrowserExecutable();
const requireBrowser = process.env.DEMO_FLOW_REQUIRE_BROWSER === "1";
const cleanViewport = parseViewport(process.env.DEMO_FLOW_CLEAN_VIEWPORT) ?? { width: 1440, height: 920 };
const batchViewport = parseViewport(process.env.DEMO_FLOW_BATCH_VIEWPORT) ?? { width: 1440, height: 920 };
const fixture = JSON.parse(readFileSync(resolve(root, "public/demo/fixture.json"), "utf8"));
const expectedFixture = {
  formatVersion: 1,
  episode: {
    name: "2026-07-13_07-34-12",
    totalFiles: 981,
    totalBytes: 80_531_730,
    stateCount: 196,
    startTimeNs: "1783928052087173494",
    endTimeNs: "1783928062419877176",
    streams: [
      { name: "cam0", label: "Camera 0", width: 1920, height: 1080, channels: 3, totalBytes: 31_072_290 },
      { name: "cam1", label: "Camera 1", width: 1280, height: 720, channels: 3, totalBytes: 11_367_788 },
      { name: "cam2", label: "Camera 2", width: 1280, height: 720, channels: 3, totalBytes: 13_771_441 },
      { name: "t265_left", label: "T265 Left", width: 848, height: 800, channels: 1, totalBytes: 11_863_300 },
      { name: "t265_right", label: "T265 Right", width: 848, height: 800, channels: 1, totalBytes: 12_367_534 },
    ],
  },
};

if (!browserExecutable) {
  if (requireBrowser) {
    test("browser demo flow", () => {
      assert.fail("DEMO_FLOW_REQUIRE_BROWSER is set but no supported Chromium executable is installed");
    });
  } else {
    test("browser demo flow", { skip: "No supported Chromium executable is installed" }, () => {});
  }
} else {
  let browser;
  let server;
  let baseUrl;

  before(async () => {
    const port = await findAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(pnpmCommand(), ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root,
      stdio: "ignore",
    });
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  });

  after(async () => {
    await browser?.close();
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  });

  test("fixture v1 preserves the canonical streams and exact generated endpoint", async () => {
    assert.deepEqual(fixture, expectedFixture);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const observed = await page.evaluate(async () => {
      const response = await fetch("/demo/fixture.json");
      const demoFixture = await response.json();
      const { createDemoStates, demoEpisodeSummary } = await import("/src/lib/demoFixture.ts");
      const states = createDemoStates(demoFixture);
      const summary = demoEpisodeSummary("/demo/contract", demoFixture);
      return {
        stateCount: states.length,
        initialTimestamp: states.at(0)?.captureTimeNs,
        finalTimestamp: states.at(-1)?.captureTimeNs,
        expectedStart: demoFixture.episode.startTimeNs,
        expectedEnd: demoFixture.episode.endTimeNs,
        streamNames: summary.streams.map((stream) => stream.name),
        firstFrame: summary.streams[0]?.firstFrame,
        lastFrame: summary.streams[0]?.lastFrame,
      };
    });

    assert.equal(observed.stateCount, 196);
    assert.equal(observed.initialTimestamp, observed.expectedStart);
    assert.equal(observed.finalTimestamp, observed.expectedEnd);
    assert.deepEqual(observed.streamNames, ["cam0", "cam1", "cam2", "t265_left", "t265_right"]);
    assert.equal(observed.firstFrame, 0);
    assert.equal(observed.lastFrame, 195);
    await context.close();
  });

  test("registration loads the packaged browser demo without /@fs requests", async () => {
    const context = await browser.newContext({ viewport: cleanViewport });
    const page = await context.newPage();
    const fileSystemResponses = [];
    const fixtureStatuses = [];
    page.on("response", (response) => {
      if (response.url().includes("/@fs")) fileSystemResponses.push(response.status());
      if (response.url().endsWith("/demo/fixture.json")) fixtureStatuses.push(response.status());
    });

    await registerDemoAccount(page, baseUrl, "clean");
    await page.getByText("多路回放", { exact: true }).waitFor();
    await page.locator('img[alt="Camera 0 frame 0"]').waitFor();

    assert.deepEqual(fileSystemResponses, []);
    assert.ok(fixtureStatuses.includes(200));
    if (process.env.DEMO_FLOW_CLEAN_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_CLEAN_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("offline mode enters the local workspace without an account or user-center request", async () => {
    const context = await browser.newContext({ viewport: cleanViewport });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "离线模式" }).click();
    await page.getByText("多路回放", { exact: true }).waitFor();
    assert.equal(await page.locator('input[autocomplete="username"]').count(), 0);
    assert.equal(await page.getByLabel("退出登录").count(), 0);
    assert.equal(await page.locator(".account-summary").count(), 0);
    assert.equal(await page.locator(".annotation-processor").count(), 0);
    assert.equal(requests.some((url) => url.includes("user-center")), false);

    await page.getByRole("button", { name: "创建任务" }).click();
    await page.getByLabel("新任务名称").fill("离线整理");
    await page.locator(".task-create-form button[type=submit]").click();
    await page.getByLabel("轨迹编码").waitFor();
    await page.locator(".annotation-description textarea").fill("离线任务描述");
    await page.getByRole("button", { name: "保存标注" }).click();
    await page.getByText("已保存 · r1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.DEMO_FLOW_OFFLINE_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_OFFLINE_SCREENSHOT), fullPage: true });
    }

    await page.getByLabel("切换工作模式").click();
    await page.getByText("选择工作模式", { exact: true }).waitFor();
    await context.close();
  });

  test("trim handles share the segment editing track", async () => {
    for (const viewport of [{ width: 1440, height: 920 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await registerDemoAccount(page, baseUrl, `trim-${viewport.width}`);
      await page.locator(".segment-track").waitFor();

      const alignment = await page.locator(".segment-track").evaluate((track) => {
        const rail = track.getBoundingClientRect();
        const controls = [...track.querySelectorAll('.segment-trim-handle')]
          .map((control) => control.getBoundingClientRect());
        return {
          rail: rail && { left: rail.left, right: rail.right },
          controls: controls.map(({ left, right }) => ({ left, right })),
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });

      assert.ok(alignment.rail, `missing segment trim rail at ${viewport.width}px`);
      assert.equal(alignment.controls.length, 2);
      for (const control of alignment.controls) {
        assert.ok(Math.abs(alignment.rail.left - control.left) < 0.5, JSON.stringify(alignment));
        assert.ok(Math.abs(alignment.rail.right - control.right) < 0.5, JSON.stringify(alignment));
      }
      assert.ok(alignment.scrollWidth <= alignment.viewportWidth);
      await context.close();
    }
  });

  test("SMPL skeleton renders beside synchronized frames and stacks on a narrow viewport", async () => {
    for (const viewport of [{ width: 1440, height: 920 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await registerDemoAccount(page, baseUrl, `skeleton-${viewport.width}`);
      await page.getByLabel("SMPL 骨架三维视图").waitFor();
      const layout = await page.locator(".replay-visual-row").evaluate((row) => {
        const bounds = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        };
        const camera = bounds(row.querySelector(".camera-grid"));
        const skeleton = bounds(row.querySelector(".skeleton-side-panel"));
        const canvas = row.querySelector('canvas[aria-label="SMPL 骨架三维视图"]');
        if (!camera || !skeleton || !(canvas instanceof HTMLCanvasElement)) return null;
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (!gl) return { camera, skeleton, visiblePixels: 0, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let visiblePixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 0 && (pixels[index] > 30 || pixels[index + 1] > 35 || pixels[index + 2] > 35)) {
            visiblePixels += 1;
          }
        }
        return { camera, skeleton, visiblePixels, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      assert.ok(layout, `missing skeleton layout at ${viewport.width}px`);
      assert.ok(layout.visiblePixels > 100, `blank skeleton canvas at ${viewport.width}px`);
      if (viewport.width > 760) {
        assert.ok(layout.skeleton.left >= layout.camera.right - 0.5, JSON.stringify(layout));
        assert.ok(Math.abs(layout.skeleton.top - layout.camera.top) < 0.5, JSON.stringify(layout));
      } else {
        assert.ok(layout.skeleton.top >= layout.camera.bottom - 0.5, JSON.stringify(layout));
      }
      assert.ok(layout.scrollWidth <= layout.viewportWidth, JSON.stringify(layout));
      await context.close();
    }
  });

  test("custom tasks receive automatic codes, batch export succeeds, and telemetry renders colored series", async () => {
    const context = await browser.newContext({ viewport: batchViewport });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(request.url()));
    await registerDemoAccount(page, baseUrl, "annotation-color");
    await page.getByText("多路回放", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")];
      return images.length === 5 && images.every((image) => image.naturalWidth > 0);
    });

    await page.getByRole("button", { name: "创建任务" }).click();
    await page.getByLabel("新任务名称").fill("整理餐具");
    await page.locator(".task-create-form button[type=submit]").click();
    await page.getByLabel("轨迹编码").waitFor();
    await page.waitForFunction(() => document.querySelector('input[aria-label="轨迹编码"]')?.value === "整理餐具-001");
    await page.locator(".annotation-description textarea").fill("整理餐具并核对数量");
    await page.getByRole("button", { name: "保存标注" }).click();
    await page.getByText("已保存 · r1", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("轨迹编码").inputValue(), "整理餐具-001");

    const series = await page.locator(".chart-legend span[data-series-color]").evaluateAll((items) => (
      items.map((item) => item.getAttribute("data-series-color"))
    ));
    assert.deepEqual(series, ["#d1495b", "#007c73", "#2f67c7"]);
    const coloredPixels = await page.locator(".telemetry-chart canvas").evaluate((canvas) => {
      const context2d = canvas.getContext("2d");
      if (!context2d) return [];
      const pixels = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
      const targets = [[209, 73, 91], [0, 124, 115], [47, 103, 199]];
      return targets.map(([red, green, blue]) => {
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            Math.abs(pixels[index] - red) <= 4
            && Math.abs(pixels[index + 1] - green) <= 4
            && Math.abs(pixels[index + 2] - blue) <= 4
            && pixels[index + 3] > 0
          ) count += 1;
        }
        return count;
      });
    });
    assert.ok(coloredPixels.every((count) => count > 0), `missing telemetry colors: ${coloredPixels}`);

    await page.getByRole("button", { name: "批量", exact: true }).click();
    await page.getByText("整理餐具-001", { exact: true }).waitFor();
    await page.waitForFunction(() => (
      document.querySelector('input[aria-label="选择轨迹 整理餐具-001"]')?.checked === true
    ));
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "选择目录并批量导出" }).click();
    await page.locator(".batch-result").waitFor();
    assert.match(await page.locator(".batch-result").innerText(), /成功 1 · 失败 0/);
    await page.getByRole("button", { name: "打开文件所在位置" }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedRequests, []);
    if (process.env.DEMO_FLOW_BATCH_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_BATCH_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("a state-scoped issue locates its matching playback frame", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(request.url()));

    await registerDemoAccount(page, baseUrl, "issue-locate");
    await page.getByRole("button", { name: "检查", exact: true }).click();
    await page.getByRole("button", { name: "定位到帧 180" }).click();
    await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent?.includes("帧 180 / 195"));
    await page.locator('img[alt="Camera 0 frame 180"]').waitFor();

    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedRequests, []);
    await context.close();
  });

  test("checks show the expected and measured state frame rate without overflow", async () => {
    for (const viewport of [
      { width: 1440, height: 920 },
      { width: 960, height: 680 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => failedRequests.push(request.url()));

      await registerDemoAccount(page, baseUrl, `frame-rate-${viewport.width}`);
      await page.getByRole("button", { name: "检查", exact: true }).click();
      await page.getByText("状态记录 · 目标 30 FPS / 实测 29.50 FPS", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedRequests, []);
      await context.close();
    }
  });

  test("a missing fixture reports an actionable error before source loading", async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 680 } });
    const page = await context.newPage();
    await page.route("**/demo/fixture.json", (route) => route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    }));

    await registerDemoAccount(page, baseUrl, "missing");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const message = await alert.textContent();

    assert.match(message ?? "", /DEMO_FIXTURE_UNAVAILABLE/);
    assert.match(message ?? "", /public\/demo\/fixture\.json/);
    assert.equal(await page.getByText("多路回放", { exact: true }).count(), 0);
    if (process.env.DEMO_FLOW_MISSING_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_MISSING_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("segment annotations create non-overlapping timeline drafts without viewport overflow", async () => {
    for (const viewport of [{ width: 1440, height: 920 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await registerDemoAccount(page, baseUrl, `segments-${viewport.width}`);
        await page.locator(".segment-editor-embedded").waitFor();
        assert.equal(await page.getByRole("button", { name: "分段标注", exact: true }).count(), 0);
        await page.getByText("保留范围 · 帧 0–195 · 1 个片段", { exact: true }).waitFor();
        await page.getByRole("button", { name: "保存标注" }).click();
        await page.getByText("已保存 · r1", { exact: true }).waitFor();
        const segmentTrack = page.locator(".segment-track");
        const trackBox = await segmentTrack.boundingBox();
        assert.ok(trackBox);
        await segmentTrack.click({ position: { x: trackBox.width * (20 / 195), y: trackBox.height / 2 } });
        await page.getByRole("button", { name: "在当前帧分割" }).click();
        await page.getByLabel("片段名称").fill("拿取工具");
        await page.getByLabel("片段注解").fill("右手拿起桌面上的工具并移动到操作区");

        assert.match(await page.locator(".segment-list").innerText(), /拿取工具/);
        assert.match(await page.locator(".segment-list").innerText(), /右手拿起桌面上的工具/);
        assert.match(await page.locator(".segment-list").innerText(), /帧 21–195/);
        assert.equal(await page.locator(".segment-block").count(), 2);
        await segmentTrack.click({ position: { x: trackBox.width * (40 / 195), y: trackBox.height / 2 } });
        await page.getByRole("button", { name: "在当前帧分割" }).click();
        assert.equal(await page.locator(".segment-block").count(), 3);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await page.getByText("片段已保存到本机 · r2", { exact: true }).waitFor();
        assert.match(await page.locator(".segment-list").innerText(), /拿取工具/);
        await page.getByLabel("裁剪结束帧").fill("40");
        await page.getByText("保留范围 · 帧 0–40 · 2 个片段", { exact: true }).waitFor();
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await page.getByText("片段已保存到本机 · r3", { exact: true }).waitFor();
        await page.getByRole("button", { name: "恢复完整轨迹" }).click();
        await page.getByText("保留范围 · 帧 0–195 · 2 个片段", { exact: true }).waitFor();
        assert.match(await page.locator(".segment-list").innerText(), /帧 21–195/);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await page.getByText("片段已保存到本机 · r4", { exact: true }).waitFor();
        assert.equal(await page.locator(".camera-grid img[aria-hidden='false']").first().evaluate((image) => image.naturalWidth > 0), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(consoleErrors, []);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    }
  });

  test("a malformed fixture reports an actionable error before source loading", async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 680 } });
    const page = await context.newPage();
    await page.route("**/demo/fixture.json", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...fixture,
        episode: { ...fixture.episode, startTimeNs: "not-a-number" },
      }),
    }));

    await registerDemoAccount(page, baseUrl, "malformed");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const message = await alert.textContent();

    assert.match(message ?? "", /DEMO_FIXTURE_UNAVAILABLE/);
    assert.doesNotMatch(message ?? "", /Cannot convert/);
    assert.equal(await page.getByText("多路回放", { exact: true }).count(), 0);
    assert.equal(await page.getByText("已导入", { exact: true }).count(), 0);
    if (process.env.DEMO_FLOW_MALFORMED_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_MALFORMED_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("a fixture with a noncanonical stream reports an actionable error before source loading", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/demo/fixture.json", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...fixture,
        episode: {
          ...fixture.episode,
          streams: fixture.episode.streams.map((stream, index) => index === 0
            ? { ...stream, name: "camera0" }
            : stream),
        },
      }),
    }));

    await registerDemoAccount(page, baseUrl, "stream-contract");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const message = await alert.textContent();

    assert.match(message ?? "", /DEMO_FIXTURE_UNAVAILABLE/);
    assert.equal(await page.getByText("多路回放", { exact: true }).count(), 0);
    assert.equal(await page.getByText("已导入", { exact: true }).count(), 0);
    await context.close();
  });
}

async function registerDemoAccount(page, url, suffix) {
  await page.goto(url, { waitUntil: "networkidle" });
  if (await page.getByRole("button", { name: "统一管理模式" }).count()) {
    await page.getByRole("button", { name: "统一管理模式" }).click();
  }
  await page.getByLabel("显示名称").fill("Demo Test");
  await page.locator('input[autocomplete="username"]').fill(`demo-${suffix}`);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("demo-password-123");
  await passwords.nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
}

async function findAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createServer();
    listener.once("error", rejectPort);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Unable to reserve a local test port"));
        return;
      }
      listener.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Vite exited before the demo test server became available");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed out waiting for the demo test server");
}

function findBrowserExecutable() {
  const configured = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE ?? process.env.CHROME_PATH;
  const candidates = configured ? [configured] : [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function parseViewport(value) {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid DEMO_FLOW_BATCH_VIEWPORT: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
