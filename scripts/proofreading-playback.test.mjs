import assert from "node:assert/strict";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = process.cwd();
const artifacts = path.join(root, "artifacts/machine-annotation");
const browserPath = process.env.PLAYWRIGHT_CHROMIUM ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync) ?? chromium.executablePath();

for (const callback of [true, false]) test(`proofreading uses actual video frames with a doubled backend timeline (presentation callback: ${callback})`, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const media = path.join(artifacts, "proofreading-test.mp4");
  const ffmpeg = process.env.FFMPEG ?? (process.platform === "win32" ? path.join(root, "src-tauri/resources/bin/ffmpeg.exe") : "ffmpeg");
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", media], { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "proofreading-media", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/proofreading-test.mp4")) return next();
      const size = (await stat(media)).size;
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(range?.[1] ?? 0);
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
      const stream = createReadStream(media, { start, end });
      res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res);
    });
  } }] });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  await server.listen();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ callback }) => {
    if (!callback) Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { value: undefined });
    const stream = { name: "cam0", label: "Camera 0", width: 320, height: 180, firstFrame: 0, lastFrame: 179, frameCount: 90, totalBytes: 1, missingFrames: [], missingFrameCount: 0, channels: 3 };
    window.__proofData = { summary: { name: "synthetic", root: "/synthetic", streams: [stream] }, states: [{ frameId: 0 }, { frameId: 89 }] };
    const segments = [0,1,2].map((sourceIndex) => ({ sourceIndex, startFrame: sourceIndex * 30, endFrame: sourceIndex * 30 + 29, description: `Action ${sourceIndex}`, label: "test", attributes: {} }));
    window.__proofStats = { fallbacks: 0 };
    if (callback) document.addEventListener("loadeddata", (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      const video = event.target;
      const presented = (_now, metadata) => { video.dataset.presentedFrame = String(Math.round(metadata.mediaTime * 30)); video.requestVideoFrameCallback(presented); };
      video.requestVideoFrameCallback(presented);
    }, true);
    window.__TAURI_INTERNALS__ = { invoke: async (command) => {
      if (command === "get_video_source") return { fps: 30, mediaFps: 30, segmentSeconds: 3, startFrame: 0, paths: [new URL("/proofreading-test.mp4", location.origin).href] };
      if (command === "load_machine_annotation") return { sourceHash: "test", episodeId: "synthetic", model: "Test", frameCount: 90, segments, warnings: [] };
      if (command === "load_machine_review") return { sourceHash: "test", revision: 0, segments: segments.map((item) => ({ ...item, deleted: false, decision: "pending" })), published: false };
      window.__proofStats.fallbacks++;
      throw Error(`Unexpected command ${command}`);
    } };
  }, { callback });
  await page.goto(new URL("scripts/fixtures/proofreading.html", server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => document.querySelectorAll("video").length === 3 && [...document.querySelectorAll("video")].every((v) => v.readyState >= 2 && !v.seeking));
  const evidence = [];
  for (const [segment, frame] of [[1,0],[2,30],[3,60]]) {
    await page.getByRole("button", { name: `定位机标片段 ${segment}` }).click();
    await page.waitForFunction((frame) => [...document.querySelectorAll("video")].slice(0,2).every((v) => !v.seeking && Math.abs(v.currentTime - (frame + .5) / 30) < .001), frame);
    if (callback && frame > 0) await page.waitForFunction((frame) => [...document.querySelectorAll("video")].slice(0,2).every((v) => v.dataset.presentedFrame === String(frame)), frame);
    assert.equal(await page.getByLabel("当前视频帧").inputValue(), String(frame));
    const pixels = await page.locator("video").evaluateAll((videos) => videos.slice(0,2).map((video) => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const ctx = canvas.getContext("2d"); ctx.drawImage(video,0,0,160,90);
      const pixels = ctx.getImageData(0,0,160,90).data;
      return { hash: Array.from(pixels).reduce((hash, value) => (hash * 31 + value) >>> 0, 0), lit: Array.from(pixels).filter((value, index) => index % 4 !== 3 && value > 30).length };
    }));
    assert.deepEqual(pixels[0], pixels[1], "main video and start-frame preview must display the same pixels");
    assert.ok(pixels[0].lit > 5000, "video must be visibly nonblank");
    evidence.push({ segment, frame, pixels });
  }
  await page.getByLabel("当前视频帧").fill("89");
  await page.waitForFunction(() => { const v = document.querySelector("video"); return !v.seeking && Math.abs(v.currentTime - 89.5/30) < .001; });
  if (callback) await page.waitForFunction(() => document.querySelector("video").dataset.presentedFrame === "89");
  assert.equal(await page.locator(".frame-counter").textContent(), "帧 89 / 89");
  await page.getByRole("button", { name: "播放机标片段 1" }).click();
  await page.waitForFunction(() => Number(document.querySelector(".proofread-frame-input").value) > 2);
  await page.getByRole("button", { name: "播放机标片段 3" }).click();
  await page.waitForFunction(() => { const frame = Number(document.querySelector(".proofread-frame-input").value); return frame > 60 && frame < 89; });
  await page.waitForFunction(() => document.querySelector(".proofread-frame-input").value === "89" && document.querySelector("video").paused);
  const scrubStarted = Date.now();
  for (const frame of [5,80,20,65,10,75]) await page.getByLabel("当前视频帧").fill(String(frame));
  await page.waitForFunction(() => { const video = document.querySelector("video"); return !video.seeking && Math.abs(video.currentTime - 75.5/30) < .001; });
  if (callback) await page.waitForFunction(() => document.querySelector("video").dataset.presentedFrame === "75");
  evidence.push({ rapidScrubMs: Date.now() - scrubStarted, finalFrame: 75 });
  await page.evaluate(() => {
    window.__proofStats.listMutations = 0;
    new MutationObserver((records) => window.__proofStats.listMutations += records.length).observe(document.querySelector(".machine-segment-list"), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".proofread-frame-input").value === "89" && document.querySelector("video").paused);
  assert.equal(await page.evaluate(() => window.__proofStats.listMutations), 0, "playback must not rebuild the segment list");
  assert.equal(await page.evaluate(() => window.__proofStats.fallbacks), 0);
  assert.deepEqual(errors, []);
  for (const width of [1440, 960, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, `proofreading-${callback}-${width}.png`), fullPage: true });
  }
  await writeFile(path.join(artifacts, `proofreading-native-${callback}.json`), JSON.stringify({ callback, evidence, errors }, null, 2));
});
