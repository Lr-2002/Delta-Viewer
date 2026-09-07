import assert from "node:assert/strict";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, "artifacts/nas-playback");
const browserPath = process.env.PLAYWRIGHT_CHROMIUM ?? [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync) ?? chromium.executablePath();

for (const presentationCallback of process.env.DOHC_MP4_SAMPLE_ROOT ? [true] : [true, false]) {
test(`native MP4 playback handles discovery, buffering, seeks and completion (presentation callback: ${presentationCallback})`, async (t) => {
  await mkdir(artifactRoot, { recursive: true });
  const sampleRoot = process.env.DOHC_MP4_SAMPLE_ROOT;
  let sources;
  let streams;
  let end;
  if (sampleRoot) {
    const manifest = JSON.parse(await readFile(path.join(sampleRoot, "manifest.json"), "utf8"));
    sources = Object.entries(manifest.streams).filter(([, info]) => info.segments?.length)
      .map(([name, info]) => ({ name, fps: info.fps, frames: info.frame_count,
        width: info.width, height: info.height, segmentSeconds: manifest.segment_seconds,
        files: info.segments.map((segment) => path.join(sampleRoot, segment.path)) }));
    end = sources[0].frames;
  } else {
    const ffmpeg = process.env.FFMPEG ?? (process.platform === "win32"
      ? path.join(root, "src-tauri/resources/bin/ffmpeg.exe") : "ffmpeg");
    const mediaPath = path.join(artifactRoot, "synthetic.mp4");
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", mediaPath], { windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    sources = ["cam0", "cam1"].map((name) => ({ name, fps: 30, frames: 180,
      width: 320, height: 180, segmentSeconds: 3, files: [mediaPath, mediaPath] }));
    end = 180;
  }
  streams = sources.map((source) => ({ name: source.name, label: source.name, width: source.width,
    height: source.height, firstFrame: 0, lastFrame: end, frameCount: end + 1,
    totalBytes: 1, missingFrames: [], missingFrameCount: 0, channels: 3 }));
  const files = sources.flatMap((source) => source.files);
  const sourcePayloads = Object.fromEntries(sources.map((source) => [source.name, {
    fps: source.fps, mediaFps: source.fps, segmentSeconds: source.segmentSeconds, startFrame: 0,
    paths: source.files.map((file, index) => `/test-media/${files.indexOf(file)}?segment=${index}`),
  }]));
  const mediaConfig = process.env.DOHC_MEDIA_TEST_CONFIG;
  if (mediaConfig) {
    const deadline = Date.now() + 300000;
    while (!existsSync(mediaConfig) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const urls = JSON.parse(await readFile(mediaConfig, "utf8"));
    for (const [name, paths] of Object.entries(urls)) sourcePayloads[name].paths = paths;
  }
  const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "registered-test-media", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/test-media\/(\d+)/);
        if (!match) return next();
        const file = files[Number(match[1])];
        if (!file) { res.writeHead(404).end(); return; }
        try {
          const size = (await stat(file)).size;
          const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
          const start = range ? Number(range[1]) : 0;
          const endByte = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
            "Content-Length": endByte - start + 1, "Cache-Control": "no-store",
            ...(range ? { "Content-Range": `bytes ${start}-${endByte}/${size}` } : {}) });
          const input = createReadStream(file, { start, end: endByte, highWaterMark: 1024 * 1024 });
          res.on("close", () => input.destroy());
          input.on("error", () => res.destroy());
          input.pipe(res);
        } catch { res.writeHead(404).end(); }
      });
    } }],
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    if (mediaConfig) await writeFile(mediaConfig.replace(/\.[^.]+$/, ".done"), "done");
  });
  await server.listen();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const h264Support = await page.evaluate(() => document.createElement("video")
      .canPlayType('video/mp4; codecs="avc1.42E01E"'));
    assert.notEqual(h264Support, "", `H.264 playback is unavailable in ${browserPath}`);
    const origin = server.resolvedUrls.local[0];
    await page.addInitScript(({ streams, sourcePayloads, end, origin, presentationCallback }) => {
      if (!presentationCallback) {
        Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { value: undefined });
      }
      window.__nativeStreams = streams;
      window.__nativeEnd = end;
      window.__nativeStats = { fallbacks: 0, events: [], discovered: false };
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command === "get_video_source") {
            await new Promise((resolve) => setTimeout(resolve, 500));
            window.__nativeStats.discovered = true;
            const source = sourcePayloads[args.stream];
            return { ...source, paths: source.paths.map((p) => new URL(p, origin).href) };
          }
          window.__nativeStats.fallbacks++;
          throw Error(`Unexpected fallback ${command}`);
        },
      };
      for (const event of ["seeking", "waiting", "playing", "ended", "error"]) {
        document.addEventListener(event, (e) => {
          if (e.target instanceof HTMLVideoElement) window.__nativeStats.events.push({
            event, time: performance.now(), mediaTime: e.target.currentTime,
            stream: e.target.closest("figure")?.querySelector("figcaption span")?.textContent,
          });
        }, true);
      }
    }, { streams, sourcePayloads, end, origin, presentationCallback });
    await page.goto(new URL("scripts/fixtures/native-playback.html", origin).href, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => window.__nativeStats.fallbacks > 0
      || [...document.querySelectorAll("video")].length > 0
      && [...document.querySelectorAll("video")].every((v) => v.readyState >= 2), null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => window.__nativeStats.fallbacks), 0);
    await page.evaluate(() => { window.__nativeStats.events = []; window.__nativePlayback.play(true); });
    await page.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > .1; }, null, { timeout: 60000 });
    const started = await page.evaluate(() => ({ wall: performance.now(), media: document.querySelector("video").currentTime }));
    await page.waitForTimeout(sampleRoot ? 7000 : 1500);
    const moving = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({
      time: v.currentTime, quality: v.getVideoPlaybackQuality().toJSON?.() ?? {
        total: v.getVideoPlaybackQuality().totalVideoFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
      }, paused: v.paused, error: v.error?.message,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
    })));
    assert.ok(moving.every((v) => v.time > 0.5 && !v.error), JSON.stringify(moving));
    if (!sampleRoot) {
      await page.evaluate(() => {
        const primary = document.querySelector("video");
        const tail = primary.currentTime + .05;
        Object.defineProperty(primary, "buffered", { configurable: true,
          value: { length: 1, start: () => 0, end: () => tail } });
        primary.dispatchEvent(new Event("waiting"));
      });
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.paused));
      const pausedPosition = await page.locator("#position").textContent();
      await page.waitForTimeout(250);
      assert.equal(await page.locator("#position").textContent(), pausedPosition,
        "buffering must freeze the shared timeline");
      await page.evaluate(() => { delete document.querySelector("video").buffered; });
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => !v.paused));
      const before = await page.evaluate(() => window.__nativeStats.events.filter((e) => e.event === "seeking" && e.stream === "cam0").length);
      await page.evaluate(() => window.__nativePlayback.speed(1.25));
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => window.__nativeStats.events.filter((e) => e.event === "seeking" && e.stream === "cam0").length), before);
      await page.evaluate(() => window.__nativePlayback.seek(30));
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => !v.seeking && Math.abs(v.currentTime - 1) < .05));
      await page.evaluate(() => window.__nativePlayback.play(true));
      await page.waitForFunction(() => document.getElementById("position").textContent === "180", null, { timeout: 15000 });
      assert.equal(await page.locator("#position").getAttribute("data-playing"), "false");
      await page.evaluate(() => { window.__nativePlayback.seek(0); });
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.currentTime < .05 && !v.seeking));
      await page.evaluate(() => window.__nativePlayback.play(true));
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.currentTime > .3 && !v.paused));
    }
    const stats = await page.evaluate(() => window.__nativeStats);
    const finished = await page.evaluate(() => ({ wall: performance.now(), media: document.querySelector("video").currentTime }));
    const result = { transport: mediaConfig ? "production-rust-loopback" : "test-node-loopback", started, finished, moving, stats, errors };
    const evidenceName = sampleRoot ? "real-native-playback"
      : `native-regression-${presentationCallback ? "presentation" : "media-time"}`;
    await writeFile(path.join(artifactRoot, `${evidenceName}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: path.join(artifactRoot, `${evidenceName}.png`) });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ moving, seeks: stats.events.filter((e) => e.event === "seeking").length }));
  } catch (error) {
    console.error(errors);
    console.error(await page.evaluate(() => ({ stats: window.__nativeStats, html: document.body.innerText,
      videos: [...document.querySelectorAll("video")].map((v) => ({ src: v.currentSrc, time: v.currentTime, ready: v.readyState, error: v.error?.message })) })).catch(() => null));
    throw error;
  }
});
}
