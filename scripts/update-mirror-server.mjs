#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyUpdaterSignature } from "./updater-signature.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(repositoryRoot, "update-service.config.json");
const DEFAULT_CACHE_ROOT = path.join(
  homedir(),
  "Library/Application Support/DOHC Viewer Update Service",
);
const OFFICIAL_UPSTREAM_MANIFEST =
  "https://github.com/Lr-2002/Delta-Viewer/releases/latest/download/latest.json";
const OFFICIAL_ASSET_ORIGIN = "https://github.com";
const OFFICIAL_ASSET_PATH_PREFIX = "/Lr-2002/Delta-Viewer/releases/download/";
const MIN_ASSET_BYTES = 1024 * 1024;
const MAX_UPDATER_BYTES = 64 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
const ASSET_TIMEOUT_MS = 20 * 60_000;

const TARGETS = [
  {
    key: "windows-x64",
    target: "windows-x86_64-nsis",
    label: "Windows 10/11 x64",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_windows-x64-updater.exe`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_windows-x64-setup.exe`,
  },
  {
    key: "macos-arm64",
    target: "darwin-aarch64-app",
    label: "macOS 12+ Apple Silicon",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.app.tar.gz`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.dmg`,
  },
  {
    key: "ubuntu-deb-x64",
    target: "linux-x86_64-deb",
    label: "Ubuntu 22.04+ x86_64 deb",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
  },
];

function parseArguments(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    cacheRoot: process.env.DOHC_UPDATE_CACHE_ROOT || DEFAULT_CACHE_ROOT,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") {
      options.once = true;
      continue;
    }
    if (argument === "--config" || argument === "--cache-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--config") options.configPath = path.resolve(value);
      else options.cacheRoot = path.resolve(value);
      continue;
    }
    if (argument === "--help") {
      console.log(`Usage: node scripts/update-mirror-server.mjs [options]

  --config <path>       Service configuration (default: update-service.config.json)
  --cache-root <path>   Service-owned atomic cache directory
  --once                Synchronize once, then exit
`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSemver(value, label = "version") {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} is not valid semver`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256`);
  }
  return value;
}

function requireBoundedSize(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < MIN_ASSET_BYTES || value > maximum) {
    throw new Error(`${label} is outside ${MIN_ASSET_BYTES}-${maximum} bytes`);
  }
  return value;
}

function requireCanonicalBase64(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  if (Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} has invalid base64 padding`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("publicBaseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("publicBaseUrl must contain only an origin");
  }
  return url.origin;
}

function normalizeConfiguration(raw) {
  const config = requirePlainObject(raw, "update mirror configuration");
  if (config.schemaVersion !== 1) throw new Error("unsupported update mirror schemaVersion");
  if (typeof config.listenHost !== "string" || !config.listenHost) {
    throw new Error("listenHost is required");
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65535) {
    throw new Error("listenPort is invalid");
  }
  if (
    !Number.isInteger(config.refreshIntervalSeconds)
    || config.refreshIntervalSeconds < 60
    || config.refreshIntervalSeconds > 3600
  ) {
    throw new Error("refreshIntervalSeconds must be between 60 and 3600");
  }
  if (!Number.isInteger(config.retainedVersions) || config.retainedVersions < 1 || config.retainedVersions > 5) {
    throw new Error("retainedVersions must be between 1 and 5");
  }
  const upstreamManifestUrl = new URL(config.upstreamManifestUrl);
  if (
    upstreamManifestUrl.href !== OFFICIAL_UPSTREAM_MANIFEST
    && config.allowTestUpstream !== true
  ) {
    throw new Error("production mirror must use the official GitHub latest.json");
  }
  if (typeof config.updaterPublicKey !== "string" || !config.updaterPublicKey) {
    throw new Error("updaterPublicKey is required");
  }
  return {
    ...config,
    publicBaseUrl: normalizeBaseUrl(config.publicBaseUrl),
    upstreamManifestUrl: upstreamManifestUrl.href,
    upstreamAssetOrigin: config.upstreamAssetOrigin ?? OFFICIAL_ASSET_ORIGIN,
    upstreamAssetPathPrefix: config.upstreamAssetPathPrefix ?? OFFICIAL_ASSET_PATH_PREFIX,
    refreshIntervalMs: config.refreshIntervalSeconds * 1000,
  };
}

export async function loadMirrorConfiguration(
  configPath = DEFAULT_CONFIG_PATH,
  cacheRoot = process.env.DOHC_UPDATE_CACHE_ROOT || DEFAULT_CACHE_ROOT,
) {
  const [rawConfig, tauriConfig] = await Promise.all([
    readFile(configPath, "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  return {
    ...normalizeConfiguration({
      ...rawConfig,
      updaterPublicKey: tauriConfig.plugins?.updater?.pubkey,
    }),
    cacheRoot: path.resolve(cacheRoot),
  };
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchBytes(fetchImpl, url, maximumBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "DOHC-Viewer-Update-Mirror/1" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new Error(`${url} exceeds the ${maximumBytes}-byte response limit`);
    }
    const chunks = [];
    let total = 0;
    if (!response.body) throw new Error(`${url} returned no response body`);
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) throw new Error(`${url} exceeds the response limit`);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url) {
  const bytes = await fetchBytes(fetchImpl, url, MAX_JSON_BYTES, MANIFEST_TIMEOUT_MS);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${url} returned invalid JSON: ${error.message}`);
  }
}

function validateAssetUrl(value, version, expectedName, configuration) {
  const url = new URL(value);
  const prefix = `${configuration.upstreamAssetPathPrefix}v${version}/`;
  if (
    url.origin !== configuration.upstreamAssetOrigin
    || !url.pathname.startsWith(prefix)
    || url.search
    || url.hash
  ) {
    throw new Error(`${expectedName} is not an official immutable release URL`);
  }
  const remainder = url.pathname.slice(prefix.length);
  if (!remainder || remainder.includes("/") || decodeURIComponent(remainder) !== expectedName) {
    throw new Error(`${expectedName} release URL has the wrong file name`);
  }
  return url.href;
}

function validateLatestManifest(raw, configuration) {
  const manifest = requirePlainObject(raw, "latest.json");
  const version = requireSemver(manifest.version);
  const platforms = requirePlainObject(manifest.platforms, "latest.json platforms");
  const keys = Object.keys(platforms).sort();
  const expectedKeys = TARGETS.map(({ target }) => target).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("latest.json must contain exactly the three supported updater targets");
  }
  const normalizedPlatforms = {};
  for (const definition of TARGETS) {
    const entry = requirePlainObject(platforms[definition.target], definition.target);
    const fileName = definition.updaterName(version);
    normalizedPlatforms[definition.target] = {
      url: validateAssetUrl(entry.url, version, fileName, configuration),
      signature: requireCanonicalBase64(entry.signature, `${definition.target} signature`),
      size: requireBoundedSize(entry.size, MAX_UPDATER_BYTES, `${definition.target} size`),
      sha256: requireSha256(entry.sha256, `${definition.target} sha256`),
      fileName,
    };
  }
  if (manifest.pub_date != null && Number.isNaN(Date.parse(manifest.pub_date))) {
    throw new Error("latest.json pub_date is invalid");
  }
  return {
    version,
    notes: typeof manifest.notes === "string" ? manifest.notes : null,
    pub_date: manifest.pub_date ?? null,
    platforms: normalizedPlatforms,
  };
}

function validateReleaseManifest(raw, latest, configuration) {
  const manifest = requirePlainObject(raw, "release-manifest.json");
  if (
    manifest.schemaVersion !== 1
    || manifest.application !== "DOHC Viewer"
    || manifest.version !== latest.version
    || manifest.tag !== `v${latest.version}`
    || !Array.isArray(manifest.assets)
    || manifest.assets.length !== TARGETS.length
  ) {
    throw new Error("release-manifest.json does not match the mirrored release");
  }
  return TARGETS.map((definition) => {
    const asset = manifest.assets.find((candidate) => candidate?.key === definition.key);
    const expectedName = definition.installerName(latest.version);
    if (
      !asset
      || asset.installer !== expectedName
      || asset.updater?.target !== definition.target
      || asset.updater?.fileName !== definition.updaterName(latest.version)
    ) {
      throw new Error(`release manifest is missing ${definition.key}`);
    }
    const size = requireBoundedSize(asset.sizeBytes, MAX_INSTALLER_BYTES, `${expectedName} size`);
    const digest = requireSha256(asset.sha256, `${expectedName} sha256`);
    const url = validateAssetUrl(
      `${configuration.upstreamAssetOrigin}${configuration.upstreamAssetPathPrefix}v${latest.version}/${encodeURIComponent(expectedName)}`,
      latest.version,
      expectedName,
      configuration,
    );
    return { ...definition, fileName: expectedName, size, sha256: digest, url };
  });
}

async function downloadFile(fetchImpl, descriptor, destination) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  let handle;
  try {
    const response = await fetchImpl(descriptor.url, {
      headers: { accept: "application/octet-stream", "user-agent": "DOHC-Viewer-Update-Mirror/1" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${descriptor.fileName} returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared !== descriptor.size) {
      throw new Error(`${descriptor.fileName} Content-Length does not match its manifest`);
    }
    if (!response.body) throw new Error(`${descriptor.fileName} returned no response body`);
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(destination, flags, 0o600);
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > descriptor.size || total > descriptor.maximumBytes) {
        throw new Error(`${descriptor.fileName} exceeded its bounded size`);
      }
      hash.update(bytes);
      await handle.write(bytes);
    }
    await handle.sync();
    if (total !== descriptor.size) {
      throw new Error(`${descriptor.fileName} size mismatch: expected ${descriptor.size}, got ${total}`);
    }
    const digest = hash.digest("hex");
    if (digest !== descriptor.sha256) throw new Error(`${descriptor.fileName} SHA-256 mismatch`);
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => {});
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.partial-${process.pid}-${Date.now()}`;
  await writeJson(temporary, value);
  try {
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function localAssetUrl(configuration, version, fileName) {
  return `${configuration.publicBaseUrl}/releases/v${version}/${encodeURIComponent(fileName)}`;
}

async function createReleaseCache(configuration, latest, installers, directory, fetchImpl) {
  const downloads = new Map();
  for (const definition of TARGETS) {
    const updater = latest.platforms[definition.target];
    downloads.set(updater.fileName, {
      ...updater,
      maximumBytes: MAX_UPDATER_BYTES,
      updaterSignature: updater.signature,
    });
  }
  for (const installer of installers) {
    const existing = downloads.get(installer.fileName);
    if (existing && (existing.size !== installer.size || existing.sha256 !== installer.sha256)) {
      throw new Error(`${installer.fileName} has conflicting installer/updater metadata`);
    }
    downloads.set(installer.fileName, existing ?? {
      ...installer,
      maximumBytes: MAX_INSTALLER_BYTES,
    });
  }

  for (const descriptor of downloads.values()) {
    const destination = path.join(directory, descriptor.fileName);
    await downloadFile(fetchImpl, descriptor, destination);
    if (descriptor.updaterSignature) {
      const signaturePath = `${destination}.sig`;
      await writeFile(signaturePath, `${descriptor.updaterSignature}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await verifyUpdaterSignature(destination, signaturePath, configuration.updaterPublicKey);
    }
  }

  const localLatest = {
    version: latest.version,
    notes: latest.notes,
    pub_date: latest.pub_date,
    platforms: Object.fromEntries(TARGETS.map((definition) => {
      const updater = latest.platforms[definition.target];
      return [definition.target, {
        url: localAssetUrl(configuration, latest.version, updater.fileName),
        signature: updater.signature,
        size: updater.size,
        sha256: updater.sha256,
      }];
    })),
  };
  const localRelease = {
    schemaVersion: 1,
    version: latest.version,
    installers: installers.map((installer) => ({
      key: installer.key,
      label: installer.label,
      fileName: installer.fileName,
      size: installer.size,
      sha256: installer.sha256,
      url: localAssetUrl(configuration, latest.version, installer.fileName),
    })),
  };
  await writeJson(path.join(directory, "latest.json"), localLatest);
  await writeJson(path.join(directory, "release.json"), localRelease);
  await writeJson(path.join(directory, "mirror-release.json"), {
    schemaVersion: 1,
    version: latest.version,
    createdAtUtc: new Date().toISOString(),
  });

  const checksumFiles = [...downloads.keys()].sort();
  const checksumLines = checksumFiles.map((name) => `${downloads.get(name).sha256}  ${name}`);
  await writeFile(path.join(directory, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { latest: localLatest, release: localRelease };
}

async function verifyCachedRelease(configuration, version, expectedLatest = null) {
  const directory = path.join(configuration.cacheRoot, "versions", `v${version}`);
  const [latest, release, marker] = await Promise.all([
    readFile(path.join(directory, "latest.json"), "utf8").then(JSON.parse),
    readFile(path.join(directory, "release.json"), "utf8").then(JSON.parse),
    readFile(path.join(directory, "mirror-release.json"), "utf8").then(JSON.parse),
  ]);
  if (
    latest.version !== version
    || release.version !== version
    || release.schemaVersion !== 1
    || marker.schemaVersion !== 1
    || marker.version !== version
    || Number.isNaN(Date.parse(marker.createdAtUtc))
  ) {
    throw new Error(`cached v${version} metadata is inconsistent`);
  }
  for (const definition of TARGETS) {
    const entry = requirePlainObject(latest.platforms?.[definition.target], definition.target);
    const expectedName = definition.updaterName(version);
    if (entry.url !== localAssetUrl(configuration, version, expectedName)) {
      throw new Error(`cached ${definition.target} URL does not use the configured mirror`);
    }
    requireBoundedSize(entry.size, MAX_UPDATER_BYTES, `${definition.target} size`);
    requireSha256(entry.sha256, `${definition.target} sha256`);
    requireCanonicalBase64(entry.signature, `${definition.target} signature`);
    if (expectedLatest) {
      const upstream = expectedLatest.platforms[definition.target];
      if (
        entry.size !== upstream.size
        || entry.sha256 !== upstream.sha256
        || entry.signature !== upstream.signature
      ) throw new Error(`cached ${definition.target} differs from upstream immutable metadata`);
    }
    const filePath = path.join(directory, expectedName);
    const fileInfo = await lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.size !== entry.size || await sha256(filePath) !== entry.sha256) {
      throw new Error(`cached ${expectedName} failed size/hash verification`);
    }
    await verifyUpdaterSignature(filePath, `${filePath}.sig`, configuration.updaterPublicKey);
  }
  if (!Array.isArray(release.installers) || release.installers.length !== TARGETS.length) {
    throw new Error(`cached v${version} installer list is incomplete`);
  }
  for (const definition of TARGETS) {
    const installer = release.installers.find((candidate) => candidate?.key === definition.key);
    const expectedName = definition.installerName(version);
    if (
      !installer
      || installer.fileName !== expectedName
      || installer.url !== localAssetUrl(configuration, version, expectedName)
    ) throw new Error(`cached ${definition.key} installer metadata is invalid`);
    requireBoundedSize(installer.size, MAX_INSTALLER_BYTES, `${expectedName} size`);
    requireSha256(installer.sha256, `${expectedName} sha256`);
    const filePath = path.join(directory, expectedName);
    const info = await lstat(filePath);
    if (!info.isFile() || info.size !== installer.size || await sha256(filePath) !== installer.sha256) {
      throw new Error(`cached ${expectedName} failed size/hash verification`);
    }
  }
  return { version, directory, latest, release };
}

async function isOwnedCacheDirectory(directory, version) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return false;
  const marker = await readFile(path.join(directory, "mirror-release.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  return marker?.schemaVersion === 1 && marker.version === version;
}

async function pruneCachedVersions(configuration, currentVersion, previousVersion = null) {
  const versionsRoot = path.join(configuration.cacheRoot, "versions");
  const candidates = [];
  for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)) continue;
    const directory = path.join(versionsRoot, entry.name);
    const marker = await readFile(path.join(directory, "mirror-release.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (
      marker?.schemaVersion !== 1
      || `v${marker.version}` !== entry.name
      || Number.isNaN(Date.parse(marker.createdAtUtc))
    ) continue;
    candidates.push({
      directory,
      version: marker.version,
      createdAtMs: Date.parse(marker.createdAtUtc),
    });
  }
  candidates.sort((left, right) => right.createdAtMs - left.createdAtMs);
  const keep = new Set([currentVersion]);
  if (previousVersion && keep.size < configuration.retainedVersions) keep.add(previousVersion);
  for (const candidate of candidates) {
    if (keep.size >= configuration.retainedVersions) break;
    keep.add(candidate.version);
  }
  for (const candidate of candidates) {
    if (!keep.has(candidate.version)) {
      await rm(candidate.directory, { recursive: true, force: false });
    }
  }
}

function contentType(fileName) {
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  if (fileName.endsWith(".txt") || fileName.endsWith(".sig")) return "text/plain; charset=utf-8";
  if (fileName.endsWith(".gz")) return "application/gzip";
  if (fileName.endsWith(".deb")) return "application/vnd.debian.binary-package";
  return "application/octet-stream";
}

function sendJson(response, status, value, cacheControl = "no-store") {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    "cache-control": cacheControl,
    "content-length": body.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIndex(current) {
  if (!current) {
    return "<!doctype html><meta charset=\"utf-8\"><title>DOHC Viewer 更新服务</title><h1>更新尚未就绪</h1><p>服务正在同步已签名版本，请稍后刷新。</p>";
  }
  const links = current.release.installers.map((installer) => (
    `<li><a href="${escapeHtml(installer.url)}">${escapeHtml(installer.label)}</a>`
    + `<br><code>${escapeHtml(installer.fileName)}</code>`
    + `<br><small>SHA-256: <code>${escapeHtml(installer.sha256)}</code></small></li>`
  )).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>DOHC Viewer v${escapeHtml(current.version)}</title>
<style>body{max-width:900px;margin:40px auto;padding:0 20px;font:15px/1.55 system-ui;color:#171717}li{margin:18px 0}code{overflow-wrap:anywhere}a{color:#111;font-weight:650}</style>
<h1>DOHC Viewer v${escapeHtml(current.version)}</h1>
<p>请选择对应平台安装包。当前安装包没有可信发布者身份，安装前请核对下列 SHA-256。</p>
<ul>${links}</ul>
<p><a href="/releases/v${escapeHtml(current.version)}/SHA256SUMS.txt">SHA256SUMS.txt</a></p>
</html>`;
}

export function createUpdateMirror(inputConfiguration, dependencies = {}) {
  const configuration = normalizeConfiguration(inputConfiguration);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const logger = dependencies.logger ?? console;
  let server;
  let interval;
  let syncPromise;
  const state = {
    status: "starting",
    current: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };

  async function activate(cached) {
    const previousVersion = state.current?.version ?? null;
    await writeAtomicJson(path.join(configuration.cacheRoot, "current.json"), {
      schemaVersion: 1,
      version: cached.version,
      activatedAtUtc: new Date().toISOString(),
    });
    state.current = cached;
    state.status = "ready";
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    await pruneCachedVersions(configuration, cached.version, previousVersion).catch((error) => {
      logger.error(`[update-mirror] old cache cleanup failed: ${error.message}`);
    });
  }

  async function loadCurrent() {
    try {
      const pointer = JSON.parse(await readFile(path.join(configuration.cacheRoot, "current.json"), "utf8"));
      if (pointer.schemaVersion !== 1) throw new Error("current pointer schema is invalid");
      const version = requireSemver(pointer.version, "cached current version");
      state.current = await verifyCachedRelease(configuration, version);
      state.status = "ready";
    } catch (error) {
      if (error?.code !== "ENOENT") logger.error(`[update-mirror] cached release rejected: ${error.message}`);
      state.status = "syncing";
    }
  }

  async function performSync() {
    state.status = state.current ? "ready" : "syncing";
    state.lastAttemptAt = new Date().toISOString();
    const latest = validateLatestManifest(
      await fetchJson(fetchImpl, configuration.upstreamManifestUrl),
      configuration,
    );
    const releaseManifestUrl =
      `${configuration.upstreamAssetOrigin}${configuration.upstreamAssetPathPrefix}`
      + `v${latest.version}/release-manifest.json`;
    const installers = validateReleaseManifest(
      await fetchJson(fetchImpl, releaseManifestUrl),
      latest,
      configuration,
    );
    const finalDirectory = path.join(configuration.cacheRoot, "versions", `v${latest.version}`);
    try {
      const existing = await verifyCachedRelease(configuration, latest.version, latest);
      await activate(existing);
      return existing;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (!await isOwnedCacheDirectory(finalDirectory, latest.version)) throw error;
        await rm(finalDirectory, { recursive: true, force: false });
      }
    }

    const partial = await mkdtemp(
      path.join(configuration.cacheRoot, `partial-v${latest.version}-`),
    );
    try {
      const cached = await createReleaseCache(
        configuration,
        latest,
        installers,
        partial,
        fetchImpl,
      );
      await rename(partial, finalDirectory);
      const verified = await verifyCachedRelease(configuration, latest.version, latest);
      await activate({ ...verified, ...cached });
      return state.current;
    } finally {
      await rm(partial, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function sync() {
    if (syncPromise) return syncPromise;
    syncPromise = performSync()
      .catch((error) => {
        state.status = state.current ? "degraded" : "unavailable";
        state.lastError = error instanceof Error ? error.message : String(error);
        logger.error(`[update-mirror] synchronization failed: ${state.lastError}`);
        throw error;
      })
      .finally(() => {
        syncPromise = null;
      });
    return syncPromise;
  }

  async function serveFile(request, response, pathname) {
    const match = /^\/releases\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/([^/]+)$/.exec(pathname);
    if (!match) return false;
    const version = match[1];
    let fileName;
    try {
      fileName = decodeURIComponent(match[2]);
    } catch {
      sendJson(response, 400, { error: "invalid path encoding" });
      return true;
    }
    if (!/^[A-Za-z0-9_.+()-]+$/.test(fileName) || fileName === "." || fileName === "..") {
      sendJson(response, 404, { error: "not found" });
      return true;
    }
    const filePath = path.join(configuration.cacheRoot, "versions", version, fileName);
    const info = await lstat(filePath).catch(() => null);
    if (!info?.isFile()) {
      sendJson(response, 404, { error: "not found" });
      return true;
    }
    response.writeHead(200, {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": info.size,
      "content-type": contentType(fileName),
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
    return true;
  }

  async function handleRequest(request, response) {
    try {
      if (!request.url || !["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }
      const url = new URL(request.url, "http://update-mirror.local");
      if (url.search || url.hash) {
        sendJson(response, 400, { error: "query parameters are not supported" });
        return;
      }
      if (url.pathname === "/healthz") {
        sendJson(response, 200, {
          status: state.status,
          version: state.current?.version ?? null,
          lastAttemptAt: state.lastAttemptAt,
          lastSuccessAt: state.lastSuccessAt,
          lastError: state.lastError,
        });
        return;
      }
      if (url.pathname === "/latest.json") {
        if (!state.current) {
          sendJson(response, 503, { error: "signed release is not cached yet" });
          return;
        }
        sendJson(response, 200, state.current.latest, "no-cache");
        return;
      }
      if (url.pathname === "/") {
        const body = Buffer.from(renderIndex(state.current));
        response.writeHead(state.current ? 200 : 503, {
          "cache-control": "no-cache",
          "content-length": body.length,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      if (await serveFile(request, response, url.pathname)) return;
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      logger.error(`[update-mirror] request failed: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: "internal service error" });
      else response.destroy();
    }
  }

  async function start() {
    await mkdir(path.join(configuration.cacheRoot, "versions"), { recursive: true, mode: 0o700 });
    await loadCurrent();
    server = createServer((request, response) => void handleRequest(request, response));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuration.listenPort, configuration.listenHost, resolve);
    });
    const address = server.address();
    if (configuration.listenPort === 0 && typeof address === "object" && address) {
      configuration.publicBaseUrl = `http://127.0.0.1:${address.port}`;
    }
    void sync().catch(() => {});
    interval = setInterval(() => void sync().catch(() => {}), configuration.refreshIntervalMs);
    return { address, publicBaseUrl: configuration.publicBaseUrl };
  }

  async function stop() {
    clearInterval(interval);
    await syncPromise?.catch(() => {});
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  return { start, stop, sync, state, configuration };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const configuration = await loadMirrorConfiguration(options.configPath, options.cacheRoot);
  const mirror = createUpdateMirror(configuration);
  const started = await mirror.start();
  console.log(`[update-mirror] listening at ${started.publicBaseUrl}`);
  console.log(`[update-mirror] cache: ${configuration.cacheRoot}`);
  if (options.once) {
    await mirror.sync();
    await mirror.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[update-mirror] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
