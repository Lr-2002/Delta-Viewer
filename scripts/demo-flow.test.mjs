import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const root = process.cwd();
const browserExecutable = findBrowserExecutable();
const requireBrowser = process.env.DEMO_FLOW_REQUIRE_BROWSER === "1";
const cleanViewport = parseViewport(process.env.DEMO_FLOW_CLEAN_VIEWPORT) ?? { width: 1440, height: 920 };
const batchViewport = parseViewport(process.env.DEMO_FLOW_BATCH_VIEWPORT) ?? { width: 1440, height: 920 };
const skeletonScreenshotDirectory = process.env.DEMO_FLOW_SKELETON_SCREENSHOT_DIR;
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
    const viteArgs = ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)];
    const serverCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : pnpmCommand();
    const serverArgs = process.platform === "win32" ? ["/d", "/s", "/c", pnpmCommand(), ...viteArgs] : viteArgs;
    server = spawn(serverCommand, serverArgs, {
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

  test("development operators can annotate videos with tracking warnings and retain proofreading", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    for (const scenario of ["static", "unavailable"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
      const page = await context.newPage();
      await registerDemoAccount(page, `${baseUrl}/?machineAnnotation=present&trajectoryWarning=${scenario}`, `tracking-${scenario}`, false);
      assert.equal(await page.locator(".episode-item").count(), 1);
      assert.equal(await page.getByRole("button", { name: "保存标注", exact: true }).count(), 0);
      await page.getByRole("button", { name: "校对", exact: true }).click();
      await page.getByLabel("裁剪起始帧").fill("30");
      await page.getByLabel("裁剪结束帧").fill("90");
      const taskSave = acceptNextSaveConfirmation(page);
      await page.getByRole("button", { name: "保存标注", exact: true }).click();
      await taskSave;
      await page.getByText("已保存 · r1", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("已标注", { exact: true }).count(), 0);
      await page.locator(".segment-list button").first().click();
      await page.getByLabel("片段注解").fill("人工核对后的动作");
      const segmentSave = acceptNextSaveConfirmation(page);
      await page.getByRole("button", { name: "保存片段", exact: true }).click();
      await segmentSave;
      await page.getByText("已保存 · r2", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("已标注", { exact: true }).count(), 1);
      await page.getByRole("button", { name: "校对", exact: true }).click();
      await page.getByRole("button", { name: "定位机标片段 3" }).click();
      await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent === "帧 120 / 195");
      assert.equal(await page.locator("[data-boundary-frame]").count(), 0);
      await page.locator(".episode-item").first().dblclick();
      await page.getByRole("button", { name: "校对", exact: true }).click();
      await page.getByRole("button", { name: "重新保存片段", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "重新保存片段", exact: true }).isEnabled(), true);
      assert.equal(await page.getByLabel("裁剪起始帧").inputValue(), "30");
      assert.equal(await page.getByLabel("裁剪结束帧").inputValue(), "90");
      assert.equal(await page.getByRole("button", { name: "重新保存片段", exact: true }).count(), 1);
      await page.getByRole("button", { name: "重新扫描", exact: true }).click();
      await page.getByRole("button", { name: "校对", exact: true }).click();
      await page.getByRole("button", { name: "重新保存片段", exact: true }).waitFor();
      assert.equal(await page.getByLabel("裁剪起始帧").inputValue(), "30");
      assert.equal(await page.getByLabel("裁剪结束帧").inputValue(), "90");
      await context.close();
    }
  });

  test("machine annotations preview outside the human trim without changing saved bounds", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    for (const viewport of [{ width: 1440, height: 920 }, { width: 960, height: 680 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", (request) => errors.push(request.url()));
      await registerDemoAccount(page, `${baseUrl}/?machineAnnotation=present`, `machine-${viewport.width}`);
      const panel = page.getByRole("region", { name: "机标结果" });
      assert.equal(await panel.count(), 0);
      assert.equal(await page.locator(".episode-item.annotated").count(), 0);
      await page.getByLabel("裁剪起始帧").fill("30");
      await page.getByLabel("裁剪结束帧").fill("90");
      const confirmation = acceptNextSaveConfirmation(page);
      await page.getByRole("button", { name: "保存标注", exact: true }).click();
      await confirmation;
      await page.getByText("已保存 · r1", { exact: true }).waitFor();
      await page.locator(".segment-list button").first().click();
      await page.getByLabel("片段注解").fill("人工保留的动作");
      const segmentConfirmation = acceptNextSaveConfirmation(page);
      await page.getByRole("button", { name: "保存片段", exact: true }).click();
      await segmentConfirmation;
      await page.getByText("已保存 · r2", { exact: true }).waitFor();
      await page.getByRole("button", { name: "校对", exact: true }).click();
      await panel.getByRole("button", { name: "定位机标片段 1" }).waitFor();
      assert.equal(await panel.getByRole("listitem").count(), 3);
      assert.equal(await page.locator(".segment-editor-embedded").count(), 0);
      await page.waitForFunction(() => [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")].every((image) => image.naturalWidth > 0));
      await panel.getByRole("button", { name: "定位机标片段 3" }).click();
      await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent === "帧 120 / 195");
      assert.equal(await page.getByRole("button", { name: "重新保存片段", exact: true }).count(), 0);
      assert.equal(await page.getByLabel("复核动作描述").inputValue(), "右手打开门");
      assert.equal(await page.locator(".quality-camera .frame-panel").count(), 1);
      assert.equal(await page.locator("[data-boundary-frame]").count(), 0);
      await panel.getByRole("button", { name: "查看 JSON" }).click();
      await page.getByRole("dialog", { name: "机标 JSON" }).waitFor();
      await page.getByRole("button", { name: "关闭 JSON" }).click();
      await page.getByRole("button", { name: "选择机标片段 1" }).click();
      await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent === "帧 0 / 195");
      assert.equal(await page.getByLabel("复核结束帧", { exact: true }).inputValue(), "60");
      await panel.getByRole("button", { name: "定位机标片段 3" }).click();
      await page.waitForFunction(() => [...document.querySelectorAll(".quality-camera img[aria-hidden='false']")].filter((image) => image.naturalWidth > 0).length === 1);
      const directory = resolve(root, "artifacts/machine-annotation");
      mkdirSync(directory, { recursive: true });
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(directory, `comparison-${viewport.width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await panel.getByRole("button", { name: "定位机标片段 2" }).click();
      await page.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(() => {
        const frame = Number(document.querySelector(".frame-counter")?.textContent?.match(/帧 (\d+)/)?.[1]);
        return frame > 60 && frame <= 119;
      });
      await page.getByRole("button", { name: "校对", exact: true }).click();
      assert.equal(await panel.count(), 0);
      assert.equal(await page.getByLabel("裁剪起始帧").inputValue(), "30");
      assert.equal(await page.getByLabel("裁剪结束帧").inputValue(), "90");
      const saved = await page.evaluate(async () => {
        const backend = await import("/src/lib/backend.ts");
        const item = await backend.loadEpisodeAnnotation(backend.DEMO_ROOT);
        return { start: item?.clipStartFrame, end: item?.clipEndFrame, revision: item?.revision };
      });
      assert.deepEqual(saved, { start: 30, end: 90, revision: 2 });
      await page.getByRole("button", { name: "检查", exact: true }).click();
      await page.getByRole("button", { name: "导出", exact: true }).click();
      await page.getByRole("button", { name: "批量", exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  test("missing invalid and mismatched machine results do not block human annotation", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    for (const scenario of ["missing", "invalid", "mismatch"]) {
      const context = await browser.newContext({ viewport: { width: 960, height: 680 } });
      const page = await context.newPage();
      await registerDemoAccount(page, `${baseUrl}/?machineAnnotation=${scenario}`, `machine-${scenario}`);
      await page.getByRole("button", { name: "保存标注", exact: true }).waitFor();
      await page.getByRole("button", { name: "校对", exact: true }).click();
      const panel = page.getByRole("region", { name: "机标结果" });
      await panel.getByRole("button", { name: "重新读取机标" }).waitFor();
      if (scenario === "missing") await panel.getByText("未发现 机标 JSON").waitFor();
      if (scenario === "invalid") await panel.getByRole("alert").waitFor();
      if (scenario === "mismatch") {
        await panel.getByText(/无法可靠对齐/).waitFor();
        assert.equal(await panel.getByRole("button", { name: "定位机标片段 1" }).isDisabled(), true);
      }
      await page.getByRole("button", { name: "回放", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "保存标注", exact: true }).isEnabled(), true);
      await context.close();
    }
  });

  test("proofreading source switching keeps Flash and original drafts separate", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    try {
      const page = await context.newPage();
      await registerDemoAccount(page, `${baseUrl}/?machineAnnotation=present`, "flash-review");
      await page.getByRole("button", { name: "校对", exact: true }).click();
      const picker = page.getByLabel("机标来源", { exact: true });
      await picker.selectOption("bailian_annotation.qwen3.8-flash.json");
      await page.getByLabel("复核动作描述").fill("Flash 人工修改");
      await page.waitForFunction(() => document.querySelector("select[aria-label='机标来源']")?.disabled === false);
      await picker.selectOption("bailian_annotation.json");
      await page.waitForFunction(() => document.querySelector("textarea[aria-label='复核动作描述']")?.value === "站立");
      await page.getByLabel("复核动作描述").fill("Max 人工修改");
      await page.waitForFunction(() => document.querySelector("select[aria-label='机标来源']")?.disabled === false);
      await picker.selectOption("bailian_annotation.qwen3.8-flash.json");
      await page.waitForFunction(() => document.querySelector("textarea[aria-label='复核动作描述']")?.value === "Flash 人工修改");
      await page.getByRole("button", { name: "查看 JSON", exact: true }).click();
      await page.getByRole("dialog").getByText("bailian_annotation.qwen3.8-flash.json", { exact: true }).waitFor();
    } finally { await context.close(); }
  });

  test("proofreading autosaves every edit and records whole-episode decisions", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    await registerDemoAccount(page, `${baseUrl}/?machineAnnotation=present`, "human-review");
    await page.getByRole("button", { name: "校对", exact: true }).click();
    const state = () => page.evaluate(async () => {
      const backend = await import("/src/lib/backend.ts");
      return backend.loadMachineReview(backend.DEMO_ROOT);
    });
    await page.getByLabel("复核动作描述").fill("人工修改动作");
    await page.getByLabel("复核结束帧", { exact: true }).fill("65");
    await page.getByText("review 已实时保存", { exact: false }).waitFor();
    let saved = await state();
    assert.equal(saved.published, true);
    assert.equal(saved.segments[0].description, "人工修改动作");
    assert.equal(saved.segments[0].endFrame, 64);
    assert.equal(saved.segments[1].startFrame, 65);
    assert.equal(saved.status, "pending");
    assert.equal(await page.locator(".machine-gap").count(), 0);
    await page.getByRole("button", { name: "校对", exact: true }).click();
    await page.getByRole("button", { name: "校对", exact: true }).click();
    await page.getByLabel("复核动作描述").waitFor();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工修改动作");
    assert.equal(await page.getByLabel("复核结束帧", { exact: true }).inputValue(), "65");
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await page.getByRole("listitem").nth(1).hover();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).click();
    assert.equal(await page.locator(".machine-segment").count(), 2);
    assert.equal(await page.locator(".review-span").count(), 2);
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.getByText("已通过", { exact: true }).waitFor();
    saved = await state();
    assert.equal(saved.published, true);
    assert.equal(saved.status, "approved");
    const approvedVersion = saved.versionId;
    assert.equal(saved.segments.filter((segment) => segment.deleted).length, 1);
    await page.getByLabel("复核动作描述").fill("后续修改");
    await page.getByText("review 已实时保存", { exact: false }).waitFor();
    saved = await state();
    assert.equal(saved.segments[2].description, "后续修改");
    assert.equal(saved.status, "pending");
    assert.notEqual(saved.versionId, approvedVersion);
    assert.equal(saved.segments[2].decision, "pending");
    await page.getByRole("button", { name: "恢复删除的片段" }).click();
    assert.equal(await page.locator(".machine-segment").count(), 3);
    assert.equal(await page.locator(".machine-gap").count(), 0);
    await context.close();
  });

  test("camera quality findings keep readable recordings loaded and preserve export errors", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    for (const code of ["DIMENSION_MISMATCH", "DECODE_FAILED", "EMPTY_STREAM"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
      const page = await context.newPage();
      await registerDemoAccount(page, `${baseUrl}/?frameQualityIssue=${code}`, `quality-${code.toLowerCase()}`);
      assert.equal(await page.locator(".camera-grid .frame-panel").count(), 5);
      await page.getByLabel("裁剪起始帧").fill("30");
      await page.getByLabel("裁剪结束帧").fill("90");
      await page.getByRole("button", { name: "检查", exact: true }).click();
      await page.getByText(code, { exact: true }).waitFor();
      await page.getByRole("button", { name: "回放", exact: true }).click();
      assert.equal(await page.locator(".camera-grid .frame-panel").count(), 5);
      assert.equal(await page.getByLabel("裁剪结束帧").inputValue(), "90");
      const status = await page.evaluate(async () => {
        const backend = await import("/src/lib/backend.ts");
        return (await backend.validateEpisode(backend.DEMO_ROOT, 1)).report.status;
      });
      assert.equal(status, "error");
      await context.close();
    }
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

  test("review supervision shows account activity, live events and exports without annotation tools", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (localStorage.getItem("dohc.demo.review-events")) return;
      const now = Date.now(), sessionId = crypto.randomUUID();
      localStorage.setItem("dohc.demo.review-events", JSON.stringify(["loaded", "seek", "label_add", "approved"].map((action, index) => ({
        eventId: crypto.randomUUID(), id: index + 1, sessionId, episodeKey: "a".repeat(64), episodeName: "审核样例-001", username: "alice", displayName: "审核员甲", action,
        occurredAtMs: now - 42000 + index * 14000, receivedAtMs: now, elapsedMs: index * 14000,
        details: action === "label_add" ? { value: "拿起杯子" } : action === "seek" ? { frameFrom: 12, frameTo: 90, mediaTimeMs: 3000 } : {},
      }))));
    });
    await page.goto(`${baseUrl}/?demoScenario=operations-cockpit`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "审核监管", exact: true }).waitFor();
    for (const name of ["任务分配", "质量管理", "报表", "标注导入"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
    await page.getByRole("button", { name: "审核记录", exact: true }).click();
    await page.getByRole("cell", { name: "0 分 42 秒", exact: true }).waitFor();
    await page.getByRole("button", { name: "实时行为", exact: true }).click();
    await page.getByLabel("操作筛选").selectOption("label_add");
    await page.getByRole("button", { name: "内容: 拿起杯子", exact: true }).click();
    await page.getByRole("dialog", { name: "审核操作明细" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "审核操作明细" }).waitFor({ state: "detached" });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出审核事件" }).click();
    assert.equal((await download).suggestedFilename(), "review-events.csv");
    await page.getByLabel("操作筛选").selectOption("");
    await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("dohc.demo.review-events"));
      rows.push({ ...rows[0], eventId: crypto.randomUUID(), id: 5, action: "label_delete", details: { value: "实时新增的删除记录" }, occurredAtMs: Date.now() });
      localStorage.setItem("dohc.demo.review-events", JSON.stringify(rows));
    });
    await page.getByRole("button", { name: "内容: 实时新增的删除记录", exact: true }).waitFor();
    await page.screenshot({ path: "artifacts/review-supervision-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "artifacts/review-supervision-mobile.png", fullPage: true });
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    assert.ok(layout.scrollWidth <= layout.viewportWidth, JSON.stringify(layout));
    assert.deepEqual(errors, []);
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
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")];
      return images.length === 5 && images.every((image) => image.naturalWidth > 0);
    });
    const cameraWidths = await page.locator(".camera-grid").evaluate((grid) => ({
      cam0: grid.querySelector(".camera-0")?.getBoundingClientRect().width ?? 0,
      cam1: grid.querySelector(".camera-1")?.getBoundingClientRect().width ?? 0,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    assert.deepEqual(fileSystemResponses, []);
    assert.ok(fixtureStatuses.includes(200));
    assert.ok(cameraWidths.cam0 >= cameraWidths.cam1 * 1.9, JSON.stringify(cameraWidths));
    assert.ok(cameraWidths.scrollWidth <= cameraWidths.viewportWidth, JSON.stringify(cameraWidths));
    if (process.env.DEMO_FLOW_CLEAN_SCREENSHOT) {
      await page.screenshot({ path: resolve(root, process.env.DEMO_FLOW_CLEAN_SCREENSHOT), fullPage: true });
    }
    await context.close();
  });

  test("offline mode is unavailable and managed login is required", async () => {
    const context = await browser.newContext({ viewport: cleanViewport });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("button", { name: "离线模式" }).count(), 0);
    await page.getByRole("button", { name: "登录工作区" }).click();
    await page.locator('input[autocomplete="username"]').waitFor();
    const reconfigure = page.getByRole("button", { name: "重新导入用户中心配置" });
    assert.equal(await reconfigure.count(), 1);
    await reconfigure.click();
    await page.locator('input[autocomplete="username"]').waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByText("多路回放", { exact: true }).count(), 0);
    await context.close();
  });

  test("trim handles share the segment editing track", { skip: "Covered by the unified proofreading regression suite" }, async () => {
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
    for (const viewport of [{ width: 1440, height: 920 }, { width: 960, height: 680 }, { width: 390, height: 844 }]) {
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
        let bonePixels = 0;
        let minBoneX = canvas.width;
        let maxBoneX = -1;
        let minBoneY = canvas.height;
        let maxBoneY = -1;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 0 && (pixels[index] > 30 || pixels[index + 1] > 35 || pixels[index + 2] > 35)) {
            visiblePixels += 1;
          }
          if (pixels[index + 1] > 90 && pixels[index + 1] > pixels[index] * 1.35 && pixels[index + 2] > pixels[index] * 1.3) {
            const pixel = index / 4;
            const x = pixel % canvas.width;
            const y = Math.floor(pixel / canvas.width);
            bonePixels += 1;
            minBoneX = Math.min(minBoneX, x);
            maxBoneX = Math.max(maxBoneX, x);
            minBoneY = Math.min(minBoneY, y);
            maxBoneY = Math.max(maxBoneY, y);
          }
        }
        const boneBounds = bonePixels > 0
          ? { width: maxBoneX - minBoneX + 1, height: maxBoneY - minBoneY + 1 }
          : null;
        return { camera, skeleton, visiblePixels, bonePixels, boneBounds, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      assert.ok(layout, `missing skeleton layout at ${viewport.width}px`);
      assert.ok(layout.visiblePixels > 100, `blank skeleton canvas at ${viewport.width}px`);
      assert.ok(layout.bonePixels > 20, `missing skeleton bones at ${viewport.width}px`);
      assert.ok(layout.boneBounds.height > layout.boneBounds.width, `skeleton is not upright at ${viewport.width}px: ${JSON.stringify(layout.boneBounds)}`);
      if (viewport.width > 1100) {
        assert.ok(layout.skeleton.left >= layout.camera.right - 0.5, JSON.stringify(layout));
        assert.ok(Math.abs(layout.skeleton.top - layout.camera.top) < 0.5, JSON.stringify(layout));
      } else {
        assert.ok(layout.skeleton.top >= layout.camera.bottom - 0.5, JSON.stringify(layout));
      }
      assert.ok(layout.scrollWidth <= layout.viewportWidth, JSON.stringify(layout));
      if (skeletonScreenshotDirectory) {
        mkdirSync(resolve(root, skeletonScreenshotDirectory), { recursive: true });
        await page.screenshot({
          path: resolve(root, skeletonScreenshotDirectory, `skeleton-${viewport.width}x${viewport.height}.png`),
          fullPage: true,
        });
      }
      if (viewport.width > 760) {
        const canvas = page.getByLabel("SMPL 骨架三维视图");
        const checksum = () => canvas.evaluate((element) => {
          const gl = element.getContext("webgl2") ?? element.getContext("webgl");
          if (!gl) return 0;
          const pixels = new Uint8Array(element.width * element.height * 4);
          gl.readPixels(0, 0, element.width, element.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let hash = 2166136261;
          for (let index = 0; index < pixels.length; index += 16) {
            hash = Math.imul(hash ^ pixels[index] ^ pixels[index + 1] ^ pixels[index + 2], 16777619);
          }
          return hash >>> 0;
        });
        const initialChecksum = await checksum();
        for (let step = 0; step < 15; step += 1) await page.getByRole("button", { name: "下一帧" }).click();
        await page.waitForFunction(() => document.querySelector(".segment-frame-readout")?.textContent?.includes("帧 15 / 195"));
        await page.waitForTimeout(100);
        const animatedChecksum = await checksum();
        assert.notEqual(animatedChecksum, initialChecksum, "skeleton canvas did not update with playback frame");

        await canvas.scrollIntoViewIfNeeded();
        const canvasBounds = await canvas.boundingBox();
        assert.ok(canvasBounds, "missing skeleton canvas bounds");
        await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(canvasBounds.x + canvasBounds.width / 2 + 48, canvasBounds.y + canvasBounds.height / 2 + 12, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(100);
        assert.notEqual(await checksum(), animatedChecksum, "skeleton orbit controls did not redraw the canvas");
      }
      await context.close();
    }
  });

  test("custom tasks receive automatic codes, batch export succeeds, and telemetry renders colored series", { skip: "Covered by the unified proofreading regression suite" }, async () => {
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
    await page.getByLabel("任务描述", { exact: true }).selectOption("__custom_description__");
    await page.locator(".annotation-custom-description").fill("整理餐具并核对数量");
    const saveConfirmation = acceptNextSaveConfirmation(page);
    await page.getByRole("button", { name: "保存标注" }).click();
    await saveConfirmation;
    await page.getByText("已保存 · r1", { exact: true }).waitFor();
    assert.equal(await page.locator(".episode-annotation-tag").count(), 0);
    assert.equal(await page.getByLabel("轨迹编码").inputValue(), "整理餐具-001");

    const series = await page.locator(".chart-legend span[data-series-color]").evaluateAll((items) => (
      items.map((item) => item.getAttribute("data-series-color"))
    ));
    assert.deepEqual(series, ["#d1495b", "#007c73", "#2f67c7"]);
    const coloredPixels = await page.locator(".telemetry-chart canvas.telemetry-plot").evaluate((canvas) => {
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

    await page.getByRole("button", { name: "导出", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "选择目录并导出" }).click();
    await page.locator(".export-result").waitFor();
    assert.match(await page.locator(".export-result").innerText(), /Metadata 已写入/);

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

  test("imported task templates keep intervals manual and offer editable segment labels", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    const context = await browser.newContext({ viewport: cleanViewport });
    const page = await context.newPage();
    await registerDemoAccount(page, baseUrl, "template-import");
    await page.getByText("多路回放", { exact: true }).waitFor();

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入模板配置" }).click();
    await (await chooser).setFiles({
      name: "task-template.workflows.json",
      mimeType: "application/json",
      buffer: readFileSync(resolve(root, "docs/task-template.workflows.json")),
    });
    await page.getByText("已导入 10 个任务模板", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("任务", { exact: true }).inputValue(), "sofa");
    assert.equal(await page.getByLabel("任务描述", { exact: true }).inputValue(), "整理沙发靠枕");

    const saveConfirmation = acceptNextSaveConfirmation(page);
    await page.getByRole("button", { name: "保存标注" }).click();
    await saveConfirmation;
    await page.getByText("已保存 · r1", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".segment-list strong").allTextContents(), ["片段 1"]);
    await page.locator(".segment-list button").click();
    assert.equal(await page.getByLabel("片段模板", { exact: true }).count(), 1);
    assert.equal(await page.getByLabel("片段名称", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("片段注解", { exact: true }).count(), 1);
    assert.deepEqual(await page.locator(".segment-list strong").allTextContents(), ["片段 1"]);
    await page.getByLabel("片段模板", { exact: true }).selectOption("拿起靠枕");
    assert.deepEqual(await page.locator(".segment-list strong").allTextContents(), ["拿起靠枕"]);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
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

  test("checks show the expected, measured, and stable state frame rate without overflow", async () => {
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
      await page.getByText("状态记录 · 目标 30 FPS / 中位 29.50 FPS / 稳定度 91.8%", { exact: true }).waitFor();
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

  test("a missing fixture reports an actionable error before source loading", { skip: "Readable media loads directly; diagnostics remain in checks" }, async () => {
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

  test("segment annotations create non-overlapping timeline drafts without viewport overflow", { skip: "Covered by the unified proofreading regression suite" }, async () => {
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
        const saveConfirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存标注" }).click();
        await saveConfirmation;
        await page.getByText("已保存 · r1", { exact: true }).waitFor();
        const segmentTrack = page.locator(".segment-track");
        const trackBox = await segmentTrack.boundingBox();
        assert.ok(trackBox);
        await segmentTrack.click({ position: { x: trackBox.width * (20 / 195), y: trackBox.height / 2 } });
        await page.getByRole("button", { name: "在当前帧分割" }).click();
        await page.getByLabel("片段注解").fill("右手拿起桌面上的工具并移动到操作区");

        assert.match(await page.locator(".segment-list").innerText(), /片段 2/);
        assert.match(await page.locator(".segment-list").innerText(), /右手拿起桌面上的工具/);
        assert.match(await page.locator(".segment-list").innerText(), /帧 21–195/);
        assert.equal(await page.locator(".segment-block").count(), 2);
        await segmentTrack.click({ position: { x: trackBox.width * (40 / 195), y: trackBox.height / 2 } });
        await page.getByRole("button", { name: "在当前帧分割" }).click();
        assert.equal(await page.locator(".segment-block").count(), 3);
        const segmentSaveConfirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await segmentSaveConfirmation;
        await page.getByText("已保存 · r2", { exact: true }).waitFor();
        await page.getByText(/当前分配队列已处理完毕/).waitFor();
        assert.match(await page.locator(".segment-list").innerText(), /片段 2/);
        await page.getByLabel("裁剪结束帧").fill("40");
        await page.getByText("保留范围 · 帧 0–40 · 2 个片段", { exact: true }).waitFor();
        const clippedSaveConfirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await clippedSaveConfirmation;
        await page.getByText("已保存 · r3", { exact: true }).waitFor();
        await page.getByRole("button", { name: "恢复完整轨迹" }).click();
        await page.getByText("保留范围 · 帧 0–195 · 2 个片段", { exact: true }).waitFor();
        assert.match(await page.locator(".segment-list").innerText(), /帧 21–195/);
        const restoredSaveConfirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await restoredSaveConfirmation;
        await page.getByText("已保存 · r4", { exact: true }).waitFor();
        assert.equal(await page.locator(".camera-grid img[aria-hidden='false']").first().evaluate((image) => image.naturalWidth > 0), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(consoleErrors, []);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    }
  });

  test("read-only preview stays available while annotation restoration gates draft editors", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.annotationRestoreGate = new Promise((resolveGate) => { window.releaseAnnotationRestore = resolveGate; });
      });
      await page.route("**/src/lib/backend.ts", async (route) => {
        const response = await route.fetch();
        const original = await response.text();
        const signature = "export async function loadEpisodeAnnotation(sourcePath) {";
        assert.ok(original.includes(signature));
        await route.fulfill({ response, body: original.replace(signature,
          `${signature}\nwindow.annotationRestoreWaiting = true; await window.annotationRestoreGate;`) });
      });
      await registerDemoAccount(page, baseUrl, "annotation-restore-gate");
      await page.waitForFunction(() => window.annotationRestoreWaiting === true);
      assert.equal(await page.locator(".camera-grid").isVisible(), true);
      assert.equal(await page.locator(".segment-editor-embedded").count(), 0);
      assert.equal(await page.getByRole("button", { name: "保存标注", exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("dohc-viewer.segment-draft."))), false);
      await page.evaluate(() => window.releaseAnnotationRestore());
      await page.locator(".segment-editor-embedded").waitFor();
      assert.equal(await page.getByRole("button", { name: "保存标注", exact: true }).count(), 1);
    } finally {
      await context.close();
    }
  });

  test("saved trims survive re-entry and catalog completion requires saved segments", { skip: "Covered by the unified proofreading regression suite" }, async () => {
    for (const viewport of [{ width: 1440, height: 920 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await registerDemoAccount(page, baseUrl, `trim-reentry-${viewport.width}`);
        await page.locator(".segment-editor-embedded").waitFor();
        assert.equal(await page.locator(".episode-annotation-tag").count(), 0);
        let confirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存标注", exact: true }).click();
        await confirmation;
        await page.getByText("已保存 · r1", { exact: true }).waitFor();
        assert.equal(await page.locator(".episode-annotation-tag").count(), 0);

        await page.getByLabel("裁剪起始帧").fill("30");
        await page.getByLabel("裁剪结束帧").fill("90");
        await page.getByText("保留范围 · 帧 30–90 · 1 个片段", { exact: true }).waitFor();
        await page.locator(".episode-item").first().press("Enter");
        await page.getByRole("button", { name: "仍要标注" }).click({ timeout: 2_000 }).catch(() => undefined);
        await page.getByText("保留范围 · 帧 30–90 · 1 个片段", { exact: true }).waitFor();
        assert.equal(await page.locator(".episode-annotation-tag").count(), 0);
        confirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await confirmation;
        await page.getByText("已保存 · r2", { exact: true }).waitFor();
        await page.locator(".episode-annotation-tag").waitFor();

        const stored = await page.evaluate(async () => {
          const backend = await import("/src/lib/backend.ts");
          const [{ annotation }] = await backend.listAnnotatedEpisodes();
          // A stale draft from the previous full-range preview must never win
          // over the saved revision when an episode is reopened.
          localStorage.setItem(`dohc-viewer.segment-draft.v1:${annotation.episodeRoot}:${annotation.taskId}`, JSON.stringify({
            clipStartFrame: 0, clipEndFrame: 195,
            segments: [{ id: "stale", startFrame: 0, endFrame: 195, title: "stale", note: "", children: [] }],
          }));
          return annotation;
        });
        assert.equal(stored.clipStartFrame, 30);
        assert.equal(stored.clipEndFrame, 90);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await page.locator(".episode-item").first().press("Enter");
          await page.getByRole("button", { name: "仍要标注" }).click({ timeout: 2_000 }).catch(() => undefined);
          await page.getByText("保留范围 · 帧 30–90 · 1 个片段", { exact: true }).waitFor();
          assert.equal(await page.getByLabel("裁剪起始帧").inputValue(), "30");
          assert.equal(await page.getByLabel("裁剪结束帧").inputValue(), "90");
          assert.match(await page.locator(".segment-frame-readout").innerText(), /帧 30 /);
          assert.equal(await page.locator(".episode-annotation-tag").count(), 1);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        mkdirSync(resolve(root, "artifacts/annotation-reentry"), { recursive: true });
        await page.screenshot({ path: resolve(root, `artifacts/annotation-reentry/saved-${viewport.width}.png`), fullPage: true });

        await page.getByRole("button", { name: "创建任务" }).click();
        await page.getByLabel("新任务名称").fill("新任务验收");
        await page.locator(".task-create-form button[type=submit]").click();
        await page.waitForFunction(() => document.querySelector('input[aria-label="轨迹编码"]')?.value === "新任务验收-001");
        assert.equal(await page.getByRole("button", { name: "保存片段", exact: true }).isDisabled(), true);
        confirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存标注", exact: true }).click();
        await confirmation;
        await page.getByText("已保存 · r3", { exact: true }).waitFor();
        assert.equal(await page.locator(".episode-annotation-tag").count(), 0);
        confirmation = acceptNextSaveConfirmation(page);
        await page.getByRole("button", { name: "保存片段", exact: true }).click();
        await confirmation;
        await page.getByText("已保存 · r4", { exact: true }).waitFor();
        assert.equal(await page.locator(".episode-annotation-tag").count(), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  test("a malformed fixture reports an actionable error before source loading", { skip: "Readable media loads directly; diagnostics remain in checks" }, async () => {
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

  test("a fixture with a noncanonical stream reports an actionable error before source loading", { skip: "Readable media loads directly; diagnostics remain in checks" }, async () => {
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

async function registerDemoAccount(page, url, suffix, acknowledgeWarnings = true) {
  await page.goto(url, { waitUntil: "networkidle" });
  if (await page.getByRole("button", { name: "登录工作区" }).count()) {
    await page.getByRole("button", { name: "登录工作区" }).click();
  }
  await page.getByLabel("显示名称").fill("Demo Test");
  await page.locator('input[autocomplete="username"]').fill(`demo-${suffix}`);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("demo-password-123");
  await passwords.nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
  if (acknowledgeWarnings) await page.getByRole("button", { name: "仍要标注" }).click({ timeout: 2_000 }).catch(() => undefined);
  if (acknowledgeWarnings) {
    await page.getByRole("button", { name: "校对", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "工作区视图" }).getByRole("button").first().innerText(), "校对");
    await page.getByRole("button", { name: "校对", exact: true }).click();
  }
}

function acceptNextSaveConfirmation(page) {
  return page.waitForEvent("dialog").then(async (dialog) => {
    assert.equal(dialog.type(), "confirm");
    assert.match(dialog.message(), /^当前任务：.+\n片段数：\d+\n覆盖帧数：\d+/);
    await dialog.accept();
  });
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
