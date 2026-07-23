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
  ].find(existsSync)
  ?? chromium.executablePath();

const visibleImageSelector = ".camera-grid img[aria-hidden='false']";

test("keeps decoded tiles visible through delayed playback, honors the clip end, and clears failed replacements", async () => {
  assert.ok(existsSync(browserPath), "Chromium is required; run `pnpm exec playwright-core install chromium`");
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
    // The browser demo now uses data URLs, so delay only FramePanel's off-DOM decode preloader.
    await page.addInitScript(() => {
      const nativeImage = window.Image;
      const sourceDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      const control = { rejectedFrameId: null, requestedFrameIds: [] };
      Object.defineProperty(window, "__playbackFrameControl", { configurable: true, value: control });

      window.Image = function PlaybackTestImage(...args) {
        const image = new nativeImage(...args);
        Object.defineProperty(image, "src", {
          configurable: true,
          get: () => sourceDescriptor?.get?.call(image),
          set: (source) => {
            const match = decodeURIComponent(String(source)).match(/FRAME\s+(\d+)/);
            const frameId = match ? Number(match[1]) : null;
            if (frameId !== null) control.requestedFrameIds.push(frameId);
            if (frameId === control.rejectedFrameId) {
              window.queueMicrotask(() => image.onerror?.(new Event("error")));
              return;
            }
            const delay = frameId === 1 ? 300 : frameId === 2 || frameId === 3 ? 220 : 0;
            if (delay) window.setTimeout(() => sourceDescriptor?.set?.call(image, source), delay);
            else sourceDescriptor?.set?.call(image, source);
          },
        });
        return image;
      };
    });

    await page.goto(url);
    await page.locator('input[autocomplete="name"]').fill("Playback Test");
    await page.locator('input[autocomplete="username"]').fill("playback-test");
    await page.locator('input[autocomplete="new-password"]').nth(0).fill("password-123");
    await page.locator('input[autocomplete="new-password"]').nth(1).fill("password-123");
    await page.getByRole("button", { name: "创建并登录" }).click();

    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")];
      return images.length === 5 && images.every((image) => image.naturalWidth > 0);
    });
    const initialSources = await page.locator(visibleImageSelector).evaluateAll((images) => images.map((image) => image.getAttribute("src")));

    await page.getByRole("button", { name: "下一帧" }).click();
    await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent?.includes("帧 1 / 195"));
    await page.waitForTimeout(100);

    const duringDelay = await page.locator(visibleImageSelector).evaluateAll((images) => images.map((image) => ({
      source: image.getAttribute("src"),
      naturalWidth: image.naturalWidth,
      alt: image.getAttribute("alt"),
    })));
    assert.equal(duringDelay.length, 5);
    assert.deepEqual(duringDelay.map((image) => image.source), initialSources);
    assert.ok(duringDelay.every((image) => image.naturalWidth > 0 && image.alt?.endsWith("frame 0")));

    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")];
      return images.length === 5 && images.every((image) => image.getAttribute("alt")?.endsWith("frame 1"));
    });
    const frameOneSources = await page.locator(visibleImageSelector).evaluateAll((images) => images.map((image) => image.getAttribute("src")));
    assert.equal(await page.locator(".frame-error").count(), 0);

    await page.getByLabel("裁剪结束帧").fill("3");
    await page.waitForFunction(() => document.querySelector(".trim-summary")?.textContent?.includes("帧 0–3"));
    await page.getByRole("button", { name: "播放" }).click();
    await page.waitForFunction(() => {
      const frame = Number(document.querySelector(".frame-counter")?.textContent?.match(/帧\s+(\d+)/)?.[1]);
      return frame >= 2;
    });
    await page.waitForTimeout(100);
    const duringPlayback = await page.locator(visibleImageSelector).evaluateAll((images) => images.map((image) => ({
      alt: image.getAttribute("alt"),
      source: image.getAttribute("src"),
      width: image.naturalWidth,
    })));
    assert.equal(duringPlayback.length, 5);
    assert.deepEqual(duringPlayback.map((image) => image.source), frameOneSources);
    assert.ok(duringPlayback.every((image) => image.width > 0 && image.alt?.endsWith("frame 1")), JSON.stringify(duringPlayback));
    const screenshotPath = process.env.PLAYBACK_SCREENSHOT_PATH;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent?.includes("帧 3 / 195"));
    await page.getByRole("button", { name: "播放" }).waitFor();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".camera-grid img[aria-hidden='false']")];
      return images.length === 5 && images.every((image) => image.getAttribute("alt")?.endsWith("frame 3"));
    });
    const readAheadFrameIds = await page.evaluate(() => window.__playbackFrameControl.requestedFrameIds);
    assert.ok(readAheadFrameIds.every((frameId) => frameId <= 3));
    for (const viewport of [{ width: 960, height: 680 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => ({
        imageCount: document.querySelectorAll(".camera-grid img[aria-hidden='false']").length,
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

    await page.getByLabel("裁剪结束帧").fill("4");
    await page.waitForFunction(() => document.querySelector(".trim-summary")?.textContent?.includes("帧 0–4"));
    await page.evaluate(() => { window.__playbackFrameControl.rejectedFrameId = 4; });
    await page.getByRole("button", { name: "下一帧" }).click();
    await page.waitForFunction(() => document.querySelector(".frame-counter")?.textContent?.includes("帧 4 / 195"));
    await page.waitForFunction(() => (
      document.querySelectorAll(".camera-grid .frame-error").length === 5
      && document.querySelectorAll(".camera-grid img[aria-hidden='false']").length === 0
    ));
    assert.equal(await page.locator(visibleImageSelector).count(), 0);
    assert.equal(await page.locator(".camera-grid .frame-error").count(), 5);
    const failureScreenshotPath = process.env.PLAYBACK_FAILURE_SCREENSHOT_PATH;
    if (failureScreenshotPath) await page.screenshot({ path: failureScreenshotPath, fullPage: true });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
