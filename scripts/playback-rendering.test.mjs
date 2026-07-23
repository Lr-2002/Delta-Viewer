import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.PLAYWRIGHT_CHROMIUM
  ?? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find(existsSync);

const streams = ["cam0", "cam1", "cam2", "t265_left", "t265_right"];
const delayedFrame = 1;

function demoStates() {
  return Array.from({ length: 196 }, (_, frameId) => JSON.stringify({
    frame_id: frameId,
    capture_time_ns: 1783928052087173494 + frameId * 33_900_000,
    position: [frameId, 0, 0],
    velocity: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    euler: [0, 0, 0],
    omega: [0, 0, 0],
    confidence: 1,
  })).join("\n");
}

function frameSvg(stream, frameId) {
  const palette = ["#29405c", "#395f3c", "#6d4545", "#5d4e7d", "#5c5130"];
  const color = palette[streams.indexOf(stream)];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
    <rect width="320" height="180" fill="${color}"/>
    <text x="160" y="96" fill="white" font-family="sans-serif" font-size="56" text-anchor="middle">${stream} ${frameId}</text>
  </svg>`;
}

test("keeps decoded tiles visible while a paused frame read is delayed", { skip: !browserPath }, async () => {
  const server = await createServer({
    root,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [root, "/Users/w/Projects/DOHC_Viewer/data/raw"] },
    },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert.ok(url, "Vite did not expose a local URL");

  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.includes("/@fs/")) {
        await route.continue();
        return;
      }
      const pathname = url.pathname;
      if (pathname.endsWith("/states.jsonl")) {
        await route.fulfill({ contentType: "application/json", body: demoStates() });
        return;
      }
      const match = pathname.match(/\/(cam0|cam1|cam2|t265_left|t265_right)\/(\d+)\.jpg$/);
      if (!match) {
        await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
        return;
      }
      const [, stream, rawFrameId] = match;
      const frameId = Number(rawFrameId);
      if (frameId === delayedFrame) await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        contentType: "image/svg+xml",
        headers: { "cache-control": "public, max-age=3600" },
        body: frameSvg(stream, frameId),
      });
    });

    await page.goto(url);
    await page.locator('input[autocomplete="name"]').fill("Playback Test");
    await page.locator('input[autocomplete="username"]').fill("playback-test");
    await page.locator('input[autocomplete="new-password"]').nth(0).fill("password-123");
    await page.locator('input[autocomplete="new-password"]').nth(1).fill("password-123");
    await page.getByRole("button", { name: "创建并登录" }).click();

    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img")];
      return images.length === 5 && images.every((image) => image.naturalWidth > 0);
    });
    const initialSources = await page.locator(".camera-grid img").evaluateAll((images) => images.map((image) => image.getAttribute("src")));

    await page.getByRole("button", { name: "下一帧" }).click();
    await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent?.includes("帧 1 / 195"));
    await page.waitForTimeout(100);

    const duringDelay = await page.locator(".camera-grid img").evaluateAll((images) => images.map((image) => ({
      source: image.getAttribute("src"),
      naturalWidth: image.naturalWidth,
      alt: image.getAttribute("alt"),
    })));
    assert.equal(duringDelay.length, 5);
    assert.deepEqual(duringDelay.map((image) => image.source), initialSources);
    assert.ok(duringDelay.every((image) => image.naturalWidth > 0 && image.alt?.endsWith("frame 0")));

    const screenshotPath = process.env.PLAYBACK_SCREENSHOT_PATH;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img")];
      return images.length === 5 && images.every((image) => image.getAttribute("alt")?.endsWith("frame 1"));
    });
    assert.equal(await page.locator(".frame-error").count(), 0);
    for (const viewport of [{ width: 960, height: 680 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => ({
        imageCount: document.querySelectorAll(".camera-grid img").length,
        offenders: [...document.querySelectorAll("*")]
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 5)
          .map((element) => ({
            className: element.className,
            right: Math.round(element.getBoundingClientRect().right),
            tagName: element.tagName,
          })),
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      assert.equal(layout.imageCount, 5);
      assert.ok(layout.scrollWidth <= layout.viewportWidth, `${viewport.width}px viewport overflowed: ${JSON.stringify(layout.offenders)}`);
    }
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.context().unrouteAll({ behavior: "ignoreErrors" });
    await browser.close();
    await server.close();
  }
});
