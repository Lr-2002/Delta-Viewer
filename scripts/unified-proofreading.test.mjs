import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";


test("failed save keeps a recovery snapshot, releases navigation and survives reload", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(/(export async function saveMachineReview\([^]*?\) \{)/,
      '$1\n if (localStorage.getItem("test.fail-review") === "1") throw new Error("MACHINE_REVIEW: 模拟写入失败");');
    await route.fulfill({ response, body });
  });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.evaluate(() => localStorage.setItem("test.fail-review", "1"));
    await page.getByLabel("复核动作描述").fill("人工草稿必须保留");
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "重新读取机标", exact: true }).isEnabled(), true);
    const backup = await page.evaluate(() => JSON.parse(localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")));
    assert.equal(backup.segments[0].description, "人工草稿必须保留");
    const nav = page.getByRole("navigation", { name: "工作区视图" });
    const other = nav.getByRole("button").filter({ hasText: "检查" }).first();
    await other.click();
    assert.equal(await page.getByLabel("复核动作描述").count(), 0);
    await nav.getByRole("button", { name: "校对", exact: true }).click();
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    await page.getByRole("button", { name: "重新读取机标", exact: true }).click();
    await page.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    // A fresh page has no in-memory backend reviews or account, just like restarting.
    await page.close();
    const restarted = await context.newPage();
    await open(restarted, "machineAnnotation=present");
    await restarted.getByRole("button", { name: "重试保存复核" }).waitFor();
    assert.equal(await restarted.getByLabel("复核动作描述").inputValue(), "人工草稿必须保留");
    await restarted.evaluate(() => localStorage.removeItem("test.fail-review"));
    await restarted.getByRole("button", { name: "重试保存复核" }).click();
    await restarted.waitForFunction(() => !document.querySelector('[aria-label="重试保存复核"]'));
    const saved = await restarted.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    assert.equal(saved.segments[0].description, "人工草稿必须保留");
    assert.equal(await restarted.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:review-test")), null);
    await restarted.screenshot({ path: "artifacts/unified-proofreading/recovery-desktop.png", fullPage: true });
  } finally { await context.close(); }
});

test("directory restore succeeds despite failed task services after restarting with the same account", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/src/App.tsx", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    assert.ok(original.includes("didAutoLoad.current || isTauriRuntime()"), "disable browser-only auto loading so this tests restored directories");
    const body = original.replace("didAutoLoad.current || isTauriRuntime()", "true || isTauriRuntime()");
    await route.fulfill({ response, body });
  });
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    for (const name of ["listAssignedTaskDefinitions", "getAssignedTasks", "getAssignedTaskActivity"]) {
      body = body.replace(new RegExp("(export async function " + name + "\\([^]*?\\) \\{)"),
        '$1\n throw new Error("模拟任务服务断开");');
    }
    body = body.replace(/(export async function getAssignedSourceRoot\([^]*?\) \{)/,
      '$1\n return "/demo/2026-07-13_07-34-12";');
    await route.fulfill({ response, body });
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await context.newPage();
      await open(page, "machineAnnotation=present");
      await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
      assert.ok(await page.locator(".episode-list button").count() > 0);
      await page.close();
    }
  } finally { await context.close(); }
});


test("account review tags survive logout and restart, isolate other users and retain reviewed entries", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.route("**/src/lib/backend.ts", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(export async function getAssignedSourceRoot\([^]*?\) \{)/,
      '$1\n return "/demo/2026-07-13_07-34-12";');
    await route.fulfill({ response, body });
  });
  let page = await context.newPage();
  try {
    await open(page, "machineAnnotation=present", "alice");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    await dialog.getByRole("button", { name: "镜头遮挡", exact: true }).click();
    await page.screenshot({ path: "artifacts/unified-proofreading/lens-occlusion.png", fullPage: true });
    await dialog.getByRole("button", { name: "确认不通过" }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    const record = await page.evaluate(async () => (await import("/src/lib/backend.ts")).listMyMachineReviews(["/demo/2026-07-13_07-34-12"]));
    assert.equal(record[0].username, "alice");
    assert.equal(record[0].rejectionReason, "镜头遮挡");
    await page.getByRole("button", { name: "跳过 2026-07-13_07-34-12", exact: true }).click();
    assert.equal(await page.getByLabel("已审核", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "返回登录", exact: true }).click();
    await page.locator('input[autocomplete="username"]').fill("alice");
    await page.locator('input[type="password"]').fill("demo-password-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    await page.close();
    page = await context.newPage();
    await open(page, "machineAnnotation=present", "bob");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.equal(await page.getByLabel("已审核", { exact: true }).count(), 0);
    assert.ok(await page.locator(".episode-list .episode-item").count() > 0);
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·通过");
    await page.close();
    page = await context.newPage();
    await open(page, "machineAnnotation=present", "alice");
    await page.getByLabel("已审核", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("已审核", { exact: true }).textContent(), "我已审·不通过");
    await page.screenshot({ path: "artifacts/unified-proofreading/account-restored.png", fullPage: true });
  } finally { await context.close(); }
});

test("new account cannot automatically save another account's recovery draft", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:alice",
      JSON.stringify({sourceHash:"old",status:"rejected",rejectionReason:"镜头遮挡",
        segments:[{sourceIndex:0,startFrame:0,endFrame:10,description:"Alice 私有草稿",deleted:false,decision:"pending"}]})));
    await open(page, "machineAnnotation=present", "bob");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.notEqual(await page.getByLabel("复核动作描述").inputValue(), "Alice 私有草稿");
    const mine = await page.evaluate(async () => (await import("/src/lib/backend.ts")).listMyMachineReviews(["/demo/2026-07-13_07-34-12"]));
    assert.deepEqual(mine, []);
    assert.ok(await page.evaluate(() => localStorage.getItem("dohc.machine-review.pending:/demo/2026-07-13_07-34-12:account:alice")));
  } finally { await context.close(); }
});

let server, browser, url;
before(async () => {
  server = await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 5174, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls.local[0];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync) ?? chromium.executablePath();
  browser = await chromium.launch({ executablePath, headless: true });
  await mkdir("artifacts/unified-proofreading", { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(page, query, username = "review-test") {
  await page.goto(`${url}?${query}`);
  if (await page.getByRole("button", { name: "登录工作区" }).count()) await page.getByRole("button", { name: "登录工作区" }).click();
  await page.getByLabel("显示名称").fill("Review Test");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[type="password"]').nth(0).fill("demo-password-123");
  await page.locator('input[type="password"]').nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
  await page.getByRole("navigation", { name: "工作区视图" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".camera-grid .frame-panel").length === 5);
}

test("review controls support segment/global play, shortcuts, splitting and saved edits", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await open(page, "machineAnnotation=present&trajectoryWarning=static");
    const rail = page.getByLabel("校对播放帧", { exact: true });
    const seek = async (frame) => { await rail.fill(String(frame)); };
    const current = async () => Number(await rail.inputValue());
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    await page.getByRole("button", { name: "定位机标片段 2", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) > 60);
    await page.keyboard.press("Space");
    const paused = await current();
    await page.waitForTimeout(150);
    assert.equal(await current(), paused);
    await page.keyboard.press("Space");
    await page.waitForFunction((value) => Number(document.querySelector('[aria-label="校对播放帧"]').value) > value, paused);
    await page.waitForFunction(() => document.querySelector('[aria-label="校对播放帧"]').value === "119");
    await page.waitForTimeout(200);
    assert.equal(await current(), 119);
    await page.getByRole("button", { name: "全局播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) > 119);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await seek(30);
    await page.getByRole("button", { name: "下一帧", exact: true }).click();
    assert.equal(await current(), 31);
    await page.getByRole("button", { name: "上一帧", exact: true }).click();
    assert.equal(await current(), 30);
    await page.getByRole("button", { name: "定位机标片段 1", exact: true }).click();
    await seek(30);
    await page.getByRole("button", { name: "分帧", exact: true }).click();
    assert.equal(await page.locator(".machine-segment").count(), 4);
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await page.getByRole("slider", { name: "微调起始帧" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "31");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "60");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), "30");
    await seek(40);
    await page.getByRole("button", { name: "新增片段", exact: true }).click();
    assert.equal(await page.locator(".machine-segment").count(), 5);
    await page.getByLabel("复核动作描述").fill("人工新片段");
    await page.keyboard.press("Space");
    assert.equal(await page.getByLabel("复核动作描述").inputValue(), "人工新片段 ");
    await page.waitForFunction(() => !document.querySelector(".quality-save-state").textContent.includes("正在保存"));
    const state = await saved();
    assert.equal(state.segments.at(-1).description, "人工新片段 ");
    const end = page.getByRole("slider", { name: "微调结束帧" });
    const box = await end.boundingBox(), track = await page.locator(".review-track").boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();
    await page.mouse.move(track.x+track.width*55/196,box.y+box.height/2,{steps:4});
    await page.mouse.up();
    assert.equal(await page.getByLabel("复核结束帧", { exact: true }).inputValue(), "55");
    await page.getByRole("slider", { name: "微调结束帧" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(async () => {
      const backend = await import("/src/lib/backend.ts");
      return (await backend.loadMachineReview("/demo/2026-07-13_07-34-12")).status === "approved";
    });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("unified layout fits desktop and mobile with a visible interactive skeleton", async () => {
  const page = await browser.newPage();
  await open(page, "machineAnnotation=present");
  for (const [width, height] of [[1920,1080],[1440,920],[960,680],[390,844]]) {
    await page.setViewportSize({ width, height });
    const canvas = page.locator(".skeleton-canvas canvas");
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".skeleton-canvas canvas").width > 0);
    const pixels = () => canvas.evaluate((element) => {
      const gl = element.getContext("webgl2");
      const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
      let bones = 0, hash = 0;
      for (let i=0;i<data.length;i+=4) { if (data[i+1]>90 && data[i+1]>data[i]*1.35) bones++; hash=(hash*31+data[i+1])>>>0; }
      return { bones, hash };
    });
    const before = await pixels();
    assert.ok(before.bones > 20);
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width/2+40,bounds.y+bounds.height/2+20,{steps:5});
    await page.mouse.up();
    assert.notEqual((await pixels()).hash, before.hash);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width >= 1440) {
      const replay = await page.locator(".camera-section").boundingBox();
      const telemetry = await page.locator(".telemetry-section").boundingBox();
      const timeline = await page.locator(".quality-timeline").boundingBox();
      const editor = await page.locator(".quality-inspector").boundingBox();
      assert.ok(telemetry.y >= replay.y + replay.height, "telemetry stays below replay");
      assert.ok(timeline.x >= replay.x + replay.width, "timeline stays in right column");
      assert.ok(editor.y >= timeline.y + timeline.height, "segments stay below timeline");
      assert.ok(editor.y + editor.height <= height, "approval buttons fit the window");
      assert.ok(telemetry.y + telemetry.height <= height, "compact state chart fits the window");
    }
    await page.screenshot({ path: `artifacts/unified-proofreading/layout-${width}.png`, fullPage: true });
    await page.locator(".quality-inspector").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/unified-proofreading/editor-${width}.png`, fullPage: true });
  }
  await page.close();
});

test("deleting a segment moves the next real boundary and saved review, with working undo", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    const before = await saved();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).focus();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 2 && document.querySelector(".quality-save-state").textContent.includes("已实时保存"));
    assert.equal(await page.getByLabel("复核起始帧", { exact: true }).inputValue(), String(before.segments[0].endFrame + 1));
    const after = await saved();
    assert.equal(after.segments[1].deleted, true);
    assert.equal(after.segments[2].startFrame, before.segments[0].endFrame + 1);
    assert.equal(after.segments[2].endFrame, before.segments[2].endFrame);
    await page.screenshot({ path: "artifacts/unified-proofreading/delete-aligned.png", fullPage: true });
    await page.getByRole("button", { name: "恢复删除的片段", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-segment").length === 3 && document.querySelector(".quality-save-state").textContent.includes("已实时保存"));
    assert.deepEqual((await saved()).segments.map((s) => [s.startFrame,s.endFrame,s.deleted]), before.segments.map((s) => [s.startFrame,s.endFrame,s.deleted]));
  } finally { await page.close(); }
});

test("history shows the installed patch and its Chinese summary", async () => {
  const page = await browser.newPage();
  try {
    await open(page, "machineAnnotation=present");
    await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
    await page.getByRole("dialog", { name: "历史版本" }).waitFor();
    assert.equal(await page.locator(".version-history-entry").first().locator("strong").textContent(), "v1.0.18");
    assert.match(await page.locator(".version-history-summary").first().textContent(), /校对改进/);
  } finally { await page.close(); }
});

test("rejection uses buttons, requires other text, persists the reason and clears it on approval", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    const saved = () => page.evaluate(async () => (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12"));
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const before = await saved();
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不通过原因" });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("button", { name: "确认不通过" }).isEnabled(), false);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await saved()).revision, before.revision);
    for (const reason of ["骨架抖动", "镜头污渍", "动作错误", "画面过曝", "其他原因"]) {
      await page.getByRole("button", { name: "不通过", exact: true }).click();
      await dialog.getByRole("button", { name: reason, exact: true }).click();
      let expected = reason;
      if (reason === "其他原因") {
        await dialog.getByLabel("其他原因内容").fill("   ");
        assert.equal(await dialog.getByRole("button", { name: "确认不通过" }).isEnabled(), false);
        await dialog.getByLabel("其他原因内容").fill("视频缺帧，需要重新采集");
        expected = "其他原因：视频缺帧，需要重新采集";
        await page.screenshot({ path: "artifacts/unified-proofreading/rejection-desktop.png" });
        await page.setViewportSize({ width: 390, height: 844 });
        const choices = await dialog.locator(".rejection-options button").evaluateAll((buttons) => buttons.map((button) => ({ fontSize: parseFloat(getComputedStyle(button).fontSize), width: button.clientWidth, text: button.textContent })));
        assert.ok(choices.every((choice) => choice.fontSize >= 12 && choice.width >= 100 && choice.text.length));
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
        await page.screenshot({ path: "artifacts/unified-proofreading/rejection-mobile.png" });
        await page.setViewportSize({ width: 1440, height: 920 });
      }
      await dialog.getByRole("button", { name: "确认不通过" }).click();
      await dialog.waitFor({ state: "detached" });
      const state = await saved();
      assert.equal(state.status, "rejected");
      assert.equal(state.rejectionReason, expected);
      assert.equal(state.revisionLabel, `${state.versionId} · 审核不通过：${expected}`);
      assert.equal(await page.locator(".review-revision").textContent(), state.revisionLabel);
    }
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await page.waitForFunction(async () => (await (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12")).status === "approved");
    assert.equal((await saved()).rejectionReason, "");
    await page.getByLabel("复核动作描述").fill("更正动作描述");
    await page.waitForFunction(async () => (await (await import("/src/lib/backend.ts")).loadMachineReview("/demo/2026-07-13_07-34-12")).changeSummary?.includes("修改描述"));
    assert.match((await saved()).revisionLabel, /修改描述 1 段；改为待审核/);
  } finally { await page.close(); }
});

test("timeline colors remain distinct for adjacent segments after splitting and deletion", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    const distinct = async () => {
      const colors = await page.locator(".review-span").evaluateAll((spans) => spans.map((span) => getComputedStyle(span).backgroundColor));
      for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
    };
    await distinct();
    for (const frame of [10, 20, 30, 40, 50]) {
      await page.getByLabel("校对播放帧", { exact: true }).fill(String(frame));
      await page.getByRole("button", { name: "分帧", exact: true }).click();
      await distinct();
    }
    for (const index of [2, 3, 2]) {
      const button = page.getByRole("button", { name: `删除机标片段 ${index}`, exact: true });
      await button.focus(); await button.click(); await distinct();
    }
    await page.getByRole("button", { name: "恢复删除的片段", exact: true }).click();
    await distinct();
    await page.screenshot({ path: "artifacts/unified-proofreading/timeline-colors.png", fullPage: true });
  } finally { await page.close(); }
});

test("missing machine JSON still allows five-camera playback and seeking", async () => {
  const page = await browser.newPage();
  await open(page, "machineAnnotation=missing&trajectoryWarning=static");
  await page.getByText("未发现 机标 JSON", { exact: true }).waitFor();
  await page.getByLabel("校对播放帧").fill("80");
  await page.waitForFunction(() => document.querySelector(".frame-counter").textContent === "帧 80 / 195");
  assert.equal(await page.getByRole("button", { name: "通过", exact: true }).isEnabled(), false);
  assert.equal(await page.locator(".frame-panel").count(), 5);
  await page.close();
});
