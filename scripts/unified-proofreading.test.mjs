import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

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

async function open(page, query) {
  await page.goto(`${url}?${query}`);
  if (await page.getByRole("button", { name: "登录工作区" }).count()) await page.getByRole("button", { name: "登录工作区" }).click();
  await page.getByLabel("显示名称").fill("Review Test");
  await page.locator('input[autocomplete="username"]').fill("review-test");
  await page.locator('input[type="password"]').nth(0).fill("demo-password-123");
  await page.locator('input[type="password"]').nth(1).fill("demo-password-123");
  await page.getByRole("button", { name: "创建并登录" }).click();
  await page.getByRole("navigation", { name: "工作区视图" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".camera-grid .frame-panel").length === 5);
}

test("unified proofreading keeps five cameras and skeleton, autosaves edits and loads warnings directly", async () => {
  for (const scenario of ["static", "unavailable"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await open(page, `machineAnnotation=present&trajectoryWarning=${scenario}`);
    await page.getByLabel("复核动作描述").waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="复核动作描述"]').disabled);
    assert.equal(await page.getByRole("region", { name: "标注前数据警告" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "回放", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "校对", exact: true }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "数据标注", exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "创建片段", exact: true }).count(), 0);
    assert.equal(await page.locator(".frame-panel").count(), 5);
    assert.equal(await page.locator(".skeleton-canvas canvas").count(), 1);
    assert.equal(await page.getByRole("heading", { name: "状态数据", exact: true }).count(), 1);
    await page.getByRole("button", { name: "定位机标片段 3" }).click();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.camera-grid img[aria-hidden="false"]')];
      return images.length === 5 && images.every((image) => image.alt.endsWith("frame 120"));
    });
    await page.waitForFunction(() => document.querySelector(".skeleton-canvas canvas").dataset.frameId === "120");
    await page.getByRole("button", { name: "下一帧", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".frame-counter").textContent === "帧 121 / 195");
    await page.getByLabel("播放速度").selectOption("2");
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector(".skeleton-canvas canvas").dataset.frameId) > 121);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "定位机标片段 1" }).click();
    const track = await page.locator(".review-track").boundingBox();
    const edge = await page.getByRole("slider", { name: "微调结束帧" }).boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 65 / 196, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[aria-label="复核结束帧"]').value === "65");
    await page.getByLabel("复核动作描述").fill("人工调整床单");
    await page.getByText("review 已实时保存", { exact: false }).waitFor();
    const saved = await page.evaluate(async () => {
      const backend = await import("/src/lib/backend.ts");
      return backend.loadMachineReview("/demo/2026-07-13_07-34-12");
    });
    assert.equal(saved.segments[0].endFrame, 64);
    assert.equal(saved.segments[1].startFrame, 65);
    assert.equal(saved.segments[0].description, "人工调整床单");
    assert.ok(saved.versionId);
    await page.getByRole("button", { name: "重新扫描", exact: true }).click();
    await page.getByLabel("复核动作描述").waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="复核动作描述"]').value === "人工调整床单");
    assert.equal(await page.getByRole("button", { name: "仍要标注" }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("selected segments stop at their end, replay from their start and follow edited boundaries", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await open(page, "machineAnnotation=present");
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await page.getByLabel("播放速度").selectOption("2");
    const waitFrame = (frame) => page.waitForFunction((value) => document.querySelector(".frame-counter").textContent === `帧 ${value} / 195`, frame);
    await waitFrame(60);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await waitFrame(119);
    await page.getByRole("button", { name: "播放", exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await page.getByLabel("校对播放帧").inputValue(), "119");
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => {
      const frame = Number(document.querySelector('[aria-label="校对播放帧"]').value);
      return frame >= 60 && frame < 119;
    });
    await page.getByRole("button", { name: "定位机标片段 3" }).click();
    await waitFrame(120);
    await page.getByRole("button", { name: "播放", exact: true }).waitFor();
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await page.getByLabel("复核结束帧", { exact: true }).fill("90");
    await waitFrame(89);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) < 89);
    await waitFrame(89);
    await page.getByRole("button", { name: "播放", exact: true }).waitFor();
    await page.getByLabel("校对播放帧").fill("150");
    await waitFrame(150);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="校对播放帧"]').value) < 90);
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await page.getByRole("button", { name: "删除机标片段 2", exact: true }).click();
    await page.getByRole("button", { name: "定位机标片段 2" }).click();
    await waitFrame(90);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await waitFrame(195);
    await page.getByRole("button", { name: "播放", exact: true }).waitFor();
  } finally { await page.close(); }
});

test("unified layout fits desktop and mobile with a visible interactive skeleton", async () => {
  const page = await browser.newPage();
  await open(page, "machineAnnotation=present");
  for (const [width, height] of [[1440,920],[960,680],[390,844]]) {
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
    await page.screenshot({ path: `artifacts/unified-proofreading/layout-${width}.png`, fullPage: true });
    await page.locator(".quality-inspector").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/unified-proofreading/editor-${width}.png`, fullPage: true });
  }
  await page.close();
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
