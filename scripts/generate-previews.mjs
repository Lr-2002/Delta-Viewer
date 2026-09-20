#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, readdir, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Parser } from "m3u8-parser";

const profiles = [{ height: 480, bitrate: 700000 }, { height: 720, bitrate: 1500000 }, { height: 1080, bitrate: 3500000 }];
const streams = new Set(["cam0", "cam1", "cam2", "t265_left", "t265_right", "cam3", "cam4"]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

async function run(binary, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-8192); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(Error(`${binary} exited ${code}: ${error}`)));
  });
}

export async function sourceStamp(root, relative) {
  const file = await realpath(path.resolve(root, relative));
  if (!inside(root, file)) throw Error("Source video escapes episode directory");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error("Source video is not a regular file");
    const first = Buffer.alloc(Math.min(16384, info.size));
    const last = Buffer.alloc(Math.min(16384, info.size));
    await handle.read(first, 0, first.length, 0);
    await handle.read(last, 0, last.length, Math.max(0, info.size - last.length));
    return { path: relative.replaceAll(path.sep, "/"), size: info.size, modifiedSeconds: Math.floor(info.mtimeMs / 1000),
      sampleSha256: createHash("sha256").update(first).update(last).digest("hex") };
  } finally { await handle.close(); }
}

async function probe(ffprobe, file, signal) {
  const data = JSON.parse(await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration", "-of", "json", file], signal));
  const video = data.streams?.[0];
  const rate = (value) => { const [n, d = 1] = String(value).split("/").map(Number); return n / d; };
  const fps = rate(video?.avg_frame_rate), count = Number(video?.nb_read_frames);
  if (!video || !Number.isFinite(fps) || fps < 1 || fps > 240 || !Number.isSafeInteger(count) || count < 1
    || Math.abs(fps - rate(video.r_frame_rate)) > .05) throw Error("Preview requires a valid constant-frame-rate video");
  return { width: video.width, height: video.height, fps, count };
}

export async function generateEpisode(episode, destination, { ffmpeg = "ffmpeg", ffprobe = "ffprobe", signal } = {}) {
  episode = await realpath(episode);
  let manifestPath = "manifest.json";
  let raw;
  try { raw = await readFile(path.join(episode, manifestPath)); }
  catch (error) { if (error.code !== "ENOENT") throw error; manifestPath = ".session_meta/manifest.json"; raw = await readFile(path.join(episode, manifestPath)); }
  const source = JSON.parse(raw);
  if (!source.streams || typeof source.streams !== "object") throw Error("Recording manifest has no streams");
  await mkdir(destination, { recursive: true });
  const lockPath = path.join(destination, ".preview.lock");
  const lock = await open(lockPath, "wx");
  const generation = `generation-${randomUUID()}`;
  const partial = path.join(destination, `.${generation}.partial`);
  let published = false;
  try {
    const result = { schemaVersion: 1, sourceManifest: { path: manifestPath, sha256: createHash("sha256").update(raw).digest("hex") }, streams: {} };
    const previous = await readFile(path.join(destination, "preview.json"), "utf8").then(JSON.parse).catch(() => null);
    const entries = Object.entries(source.streams).filter(([name, info]) => streams.has(name) && info.segments?.length);
    if (!entries.length) throw Error("Recording contains no supported MP4 streams");
    const stamps = {};
    for (const [name, info] of entries) stamps[name] = await Promise.all(info.segments.map((segment) => sourceStamp(episode, segment.path)));
    if (previous?.sourceManifest.sha256 === result.sourceManifest.sha256
      && entries.every(([name]) => JSON.stringify(previous.streams[name]?.sources) === JSON.stringify(stamps[name]))
      && Object.values(previous.streams).every((stream) => stream.segments.every((segment) => segment.variants.length))) return "unchanged";
    await mkdir(partial);
    for (const [name, info] of entries) {
      const output = { sources: stamps[name], mediaFps: 0, segments: [] };
      for (const [index, segment] of info.segments.entries()) {
        signal?.throwIfAborted();
        const sourceFile = await realpath(path.join(episode, segment.path));
        const input = await probe(ffprobe, sourceFile, signal);
        if (output.mediaFps && Math.abs(output.mediaFps - input.fps) > .001) throw Error("Stream segments have different frame rates");
        output.mediaFps = input.fps;
        const levels = profiles.filter((profile) => profile.height <= input.height);
        if (!levels.length) levels.push({ height: Math.floor(input.height / 2) * 2, bitrate: 500000 });
        const encoded = [];
        for (const level of levels) {
          const width = Math.max(2, Math.floor(input.width / input.height * level.height / 2) * 2);
          const relative = `${name}/${index}/${level.height}`;
          const folder = path.join(partial, relative);
          await mkdir(folder, { recursive: true });
          const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", sourceFile,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `scale=${width}:${level.height}`, "-c:v", "libx264",
            "-preset", "veryfast", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-crf", "23",
            "-maxrate", String(level.bitrate), "-bufsize", String(level.bitrate * 2), "-g", String(Math.ceil(input.fps * 2)),
            "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*2)", "-f", "hls", "-hls_time", "2",
            "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_segment_filename", path.join(folder, "%06d.ts"), path.join(folder, "index.m3u8")];
          encoded.push({ ...level, width, relative, folder });
          await run(ffmpeg, args, signal);
        }
        const variants = [];
        for (const level of encoded) {
          const playlist = path.join(level.folder, "index.m3u8");
          const checked = await probe(ffprobe, playlist, signal);
          if (checked.count !== input.count || Math.abs(checked.fps - input.fps) > .001
            || checked.width !== level.width || checked.height !== level.height) throw Error("Preview frame count/rate/dimensions do not match source");
          const parser = new Parser(); parser.push(await readFile(playlist, "utf8")); parser.end();
          if (!parser.manifest.endList || !parser.manifest.segments?.length) throw Error("Incomplete preview playlist");
          const fragments = [];
          for (const fragment of parser.manifest.segments) {
            if (!/^\d{6,}\.ts$/.test(fragment.uri) || !(fragment.duration > 0 && fragment.duration <= 10)) throw Error("Invalid preview fragment");
            const size = (await stat(path.join(level.folder, fragment.uri))).size;
            fragments.push({ path: `${generation}/${level.relative}/${fragment.uri}`, duration: fragment.duration, size });
          }
          variants.push({ width: level.width, height: level.height,
            bandwidth: Math.ceil(Math.max(...fragments.map((part) => part.size * 8 / part.duration)) * 1.1), fragments });
        }
        output.segments.push({ frameCount: input.count, variants });
      }
      result.streams[name] = output;
    }
    for (const [name, info] of entries) {
      const after = await Promise.all(info.segments.map((segment) => sourceStamp(episode, segment.path)));
      if (JSON.stringify(after) !== JSON.stringify(stamps[name])) throw Error("Source changed while generating previews");
    }
    if (!raw.equals(await readFile(path.join(episode, manifestPath)))) throw Error("Recording manifest changed during generation");
    await rename(partial, path.join(destination, generation));
    const pointer = path.join(destination, `.${generation}.json`);
    const handle = await open(pointer, "wx");
    try { await handle.writeFile(JSON.stringify(result)); await handle.sync(); } finally { await handle.close(); }
    await rename(pointer, path.join(destination, "preview.json"));
    published = true;
    return "generated";
  } finally {
    await lock.close(); await rm(lockPath, { force: true });
    if (!published) await rm(partial, { recursive: true, force: true });
  }
}

export async function generateTree(sourceRoot, outputRoot, options = {}) {
  sourceRoot = await realpath(sourceRoot);
  await mkdir(outputRoot, { recursive: true });
  outputRoot = await realpath(outputRoot);
  if (inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot)) throw Error("Source and preview directories must be separate");
  const queue = [sourceRoot];
  let count = 0;
  while (queue.length) {
    options.signal?.throwIfAborted();
    const folder = queue.pop();
    const entries = await readdir(folder, { withFileTypes: true });
    const episode = entries.some((entry) => entry.isFile() && entry.name === "manifest.json")
      || await stat(path.join(folder, ".session_meta/manifest.json")).then((info) => info.isFile()).catch(() => false);
    if (episode) {
      const status = await generateEpisode(folder, path.join(outputRoot, path.relative(sourceRoot, folder)), options);
      console.log(`${status}: ${path.relative(sourceRoot, folder) || "."}`); count++;
    } else for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) queue.push(path.join(folder, entry.name));
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--source-root", "--output-root", "--ffmpeg", "--ffprobe"].includes(args[i]) || !args[i + 1]) throw Error("Usage: node scripts/generate-previews.mjs --source-root <recordings> --output-root <separate preview directory> [--ffmpeg <binary>] [--ffprobe <binary>]");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options["source-root"] || !options["output-root"]) throw Error("Both source and output roots are required");
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  await generateTree(options["source-root"], options["output-root"], { ffmpeg: options.ffmpeg, ffprobe: options.ffprobe, signal: abort.signal });
}
