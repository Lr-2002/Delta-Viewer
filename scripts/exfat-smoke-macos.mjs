#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markerName = ".dohc-exfat-smoke-v1.json";
const tempPrefix = "dohc-viewer-exfat-smoke-";
let activeChild = null;
let interruptedBy = null;

function usage() {
  console.log(`Usage: node scripts/exfat-smoke-macos.mjs [options]

Copies the private fixture to a real virtual ExFAT volume, remounts it read-only,
and runs the production stress workflow in explicit development-fixture mode.

Options:
  --sample-root <path>  Override DOHC_SAMPLE_ROOT or the repository default
  --ffmpeg <path>       Override DOHC_FFMPEG or the first ffmpeg on PATH
  --report <path>       Set the JSON evidence report path
  --help                Show this help
`);
}

function parseArguments(argv) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const options = {
    sampleRoot: path.resolve(
      process.env.DOHC_SAMPLE_ROOT ?? path.join(root, "data/raw/2026-07-13_07-34-12"),
    ),
    ffmpeg: process.env.DOHC_FFMPEG ? path.resolve(process.env.DOHC_FFMPEG) : null,
    reportPath: path.join(
      root,
      "artifacts/exfat-smoke",
      `${timestamp}-${process.platform}-${process.arch}.json`,
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (["--sample-root", "--ffmpeg", "--report"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--sample-root") {
        options.sampleRoot = path.resolve(value);
      } else if (argument === "--ffmpeg") {
        options.ffmpeg = path.resolve(value);
      } else {
        options.reportPath = path.resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function printableCommand(command, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value));
  return [command, ...args].map(quote).join(" ");
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(options.environment ?? {}) },
    input: options.input,
    shell: false,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit code ${result.status}`;
    throw new Error(`${printableCommand(command, args)} failed: ${detail}`);
  }
  return result.stdout;
}

function captureOptional(command, args) {
  try {
    return runCapture(command, args).trim();
  } catch {
    return null;
  }
}

function plistToJson(plist) {
  const json = runCapture(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    { input: plist },
  );
  return JSON.parse(json);
}

function throwIfInterrupted() {
  if (interruptedBy) {
    throw new Error(`interrupted by ${interruptedBy}`);
  }
}

async function findExecutable(explicit, name) {
  const candidates = [];
  if (explicit) {
    candidates.push(explicit);
  } else {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (directory) {
        candidates.push(path.join(directory, name));
      }
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through deterministic candidates.
    }
  }
  const source = explicit ? explicit : `PATH (${process.env.PATH ?? "empty"})`;
  throw new Error(`${name} is not executable or was not found in ${source}`);
}

async function summarizeDirectory(directory) {
  const summary = { totalFiles: 0, totalBytes: 0 };
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        throw new Error(`fixture contains unsupported symlink: ${entryPath}`);
      }
      if (info.isDirectory()) {
        await visit(entryPath);
      } else if (info.isFile()) {
        summary.totalFiles += 1;
        summary.totalBytes += info.size;
      }
    }
  }
  await visit(directory);
  return summary;
}

function attachImage(imagePath, readOnly) {
  const args = ["attach", "-nobrowse", "-plist"];
  if (readOnly) {
    args.push("-readonly");
  }
  args.push(imagePath);
  const details = plistToJson(runCapture("/usr/bin/hdiutil", args));
  const mounted = details["system-entities"]?.find((entity) => entity["mount-point"]);
  if (!mounted?.["dev-entry"] || !mounted?.["mount-point"]) {
    throw new Error("hdiutil attached the image without a mounted filesystem entity");
  }
  const wholeDeviceMatch = mounted["dev-entry"].match(/^\/dev\/(disk\d+)/);
  if (!wholeDeviceMatch) {
    throw new Error(`unexpected attached device: ${mounted["dev-entry"]}`);
  }
  return {
    device: `/dev/${wholeDeviceMatch[1]}`,
    mountedDevice: mounted["dev-entry"],
    mountPoint: mounted["mount-point"],
  };
}

function findAttachedImage(imagePath) {
  const details = plistToJson(runCapture("/usr/bin/hdiutil", ["info", "-plist"]));
  const expected = path.resolve(imagePath);
  const image = details.images?.find(
    (candidate) => candidate["image-path"] && path.resolve(candidate["image-path"]) === expected,
  );
  if (!image) {
    return null;
  }
  const mounted = image["system-entities"]?.find((entity) => entity["mount-point"]);
  const deviceEntry =
    mounted?.["dev-entry"] ??
    image["system-entities"]?.find((entity) => entity["dev-entry"])?.["dev-entry"];
  const wholeDeviceMatch = deviceEntry?.match(/^\/dev\/(disk\d+)/);
  if (!wholeDeviceMatch) {
    throw new Error(`could not resolve attached device for image: ${imagePath}`);
  }
  return {
    device: `/dev/${wholeDeviceMatch[1]}`,
    mountedDevice: mounted?.["dev-entry"] ?? null,
    mountPoint: mounted?.["mount-point"] ?? null,
  };
}

async function detachImage(device) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      runCapture("/usr/bin/hdiutil", ["detach", device]);
      return { attempts: attempt, detached: true };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

function volumeInfo(mountPoint) {
  return plistToJson(runCapture("/usr/sbin/diskutil", ["info", "-plist", mountPoint]));
}

async function runStress(report, cargo, source, workRoot, ffmpeg) {
  const args = [
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "stress-check",
    "--",
    "--source",
    source,
    "--work-root",
    workRoot,
    "--development-fixture",
  ];
  const started = Date.now();
  console.log(`[exfat-smoke] $ ${printableCommand(cargo, args)}`);
  const result = await new Promise((resolve) => {
    const child = spawn(cargo, args, {
      cwd: root,
      detached: true,
      env: { ...process.env, DOHC_FFMPEG: ffmpeg },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    child.once("error", (error) => resolve({ exitCode: null, error: error.message }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  activeChild = null;
  report.command = {
    value: printableCommand(cargo, args),
    startedAtUtc: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    status: result.exitCode === 0 ? "passed" : "failed",
  };
  if (result.error) {
    report.command.error = result.error;
  }
  if (result.exitCode !== 0) {
    const detail = result.signal
      ? `stress-check terminated by ${result.signal}`
      : `stress-check exited with ${result.exitCode ?? "unknown"}`;
    throw new Error(result.error ?? detail);
  }
}

function verifyStressReport(stress, mountPoint, fixture) {
  const formats = new Set(stress.outputs?.map((output) => output.format));
  const checks = {
    passed: stress.status === "passed",
    developmentFixture: stress.formal === false,
    sourceIsExfat: stress.sourceVolume?.filesystem?.toLowerCase() === "exfat",
    sourceRootMatchesMount: stress.sourceVolume?.root === mountPoint,
    workIsSeparateVolume: stress.workVolume?.root !== stress.sourceVolume?.root,
    sourceSizeMatchesFixture:
      stress.sourceTotalFiles === fixture.totalFiles &&
      stress.sourceTotalBytes === fixture.totalBytes,
    sourceFingerprintStable:
      stress.sourceFingerprintBefore === stress.sourceFingerprintAfter,
    datasetHashStable:
      stress.importDatasetBlake3 === stress.sourceDatasetBlake3After,
    validationHasNoErrors: stress.validation?.errorCodes?.length === 0,
    cancellationWithinLimit:
      stress.cancellation?.latencyMs <= stress.cancellation?.maximumLatencyMs,
    cancellationCleaned:
      stress.cancellation?.partialsFound >= 1 &&
      stress.cancellation?.partialsFound === stress.cancellation?.partialsCleaned &&
      stress.cancellation?.publishedOutput === false,
    allAdaptersReadBack:
      formats.has("mcap") && formats.has("hdf5") && formats.has("lerobot_v2"),
  };
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(`ExFAT stress evidence failed checks: ${failures.join(", ")}`);
  }
  return checks;
}

async function publishReport(reportPath, report) {
  const directory = path.dirname(reportPath);
  await mkdir(directory, { recursive: true });
  try {
    await access(reportPath, fsConstants.F_OK);
    throw new Error(`report path already exists: ${reportPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = path.join(
    directory,
    `.${path.basename(reportPath)}.partial-${process.pid}-${Date.now()}`,
  );
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  try {
    await link(temporary, reportPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function removeMarkedTempRoot(tempRoot, markerId) {
  const canonicalTemp = await realpath(tmpdir());
  const canonicalRoot = await realpath(tempRoot);
  const expectedPrefix = `${canonicalTemp}${path.sep}${tempPrefix}`;
  if (!canonicalRoot.startsWith(expectedPrefix)) {
    throw new Error(`refusing to clean unexpected temp root: ${canonicalRoot}`);
  }
  const marker = JSON.parse(await readFile(path.join(canonicalRoot, markerName), "utf8"));
  if (marker.id !== markerId || marker.kind !== "dohc-exfat-smoke") {
    throw new Error(`refusing to clean temp root with invalid marker: ${canonicalRoot}`);
  }
  await rm(canonicalRoot, { recursive: true, force: false });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = Date.now();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const report = {
    schemaVersion: 1,
    kind: "macos-virtual-exfat-smoke",
    appVersion: packageJson.version,
    status: "running",
    startedAtUtc: new Date(started).toISOString(),
    host: { platform: process.platform, arch: process.arch },
    scope: {
      virtualDiskImage: true,
      physicalSdCard: false,
      formalStress: false,
      qualifiesGap003: false,
      qualifiesGap007: false,
      sourceMountedReadOnly: false,
    },
    git: {
      head: captureOptional("git", ["rev-parse", "HEAD"]),
      clean: captureOptional("git", ["status", "--porcelain=v1"]) === "",
    },
    cleanup: { detached: false, tempRemoved: false },
  };
  let tempRoot = null;
  let markerId = null;
  let imagePath = null;
  let attachment = null;
  let failure = null;

  try {
    if (process.platform !== "darwin") {
      throw new Error("the virtual ExFAT smoke test requires macOS hdiutil and diskutil");
    }
    const sampleInfo = await stat(options.sampleRoot);
    if (!sampleInfo.isDirectory()) {
      throw new Error(`sample root is not a directory: ${options.sampleRoot}`);
    }
    await access(path.join(options.sampleRoot, "states.jsonl"), fsConstants.R_OK);
    const ffmpeg = await findExecutable(options.ffmpeg, "ffmpeg");
    const cargo = await findExecutable(null, "cargo");
    const fixture = await summarizeDirectory(options.sampleRoot);
    if (fixture.totalFiles === 0 || fixture.totalBytes === 0) {
      throw new Error("sample fixture is empty");
    }
    report.fixture = {
      path: options.sampleRoot,
      ...fixture,
    };
    report.tools = {
      cargo: { path: cargo, version: captureOptional(cargo, ["--version"]) },
      ffmpeg: { path: ffmpeg, version: captureOptional(ffmpeg, ["-version"])?.split(/\r?\n/)[0] },
      hdiutil: "/usr/bin/hdiutil",
      diskutil: "/usr/sbin/diskutil",
    };

    tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), tempPrefix)));
    markerId = randomUUID();
    await writeFile(
      path.join(tempRoot, markerName),
      `${JSON.stringify({ kind: "dohc-exfat-smoke", id: markerId })}\n`,
      { flag: "wx" },
    );
    const volumeLabel = `DHC${String(process.pid % 100_000).padStart(5, "0")}`;
    const imageSizeMiB = Math.max(
      256,
      Math.ceil((fixture.totalBytes * 1.5 + 64 * 1024 * 1024) / (1024 * 1024)),
    );
    imagePath = path.join(tempRoot, "source.sparseimage");
    report.image = { volumeLabel, logicalSizeMiB: imageSizeMiB };
    console.log(`[exfat-smoke] temp root: ${tempRoot}`);
    runCapture("/usr/bin/hdiutil", [
      "create",
      "-size",
      `${imageSizeMiB}m`,
      "-type",
      "SPARSE",
      "-fs",
      "ExFAT",
      "-volname",
      volumeLabel,
      "-nospotlight",
      imagePath,
    ]);
    throwIfInterrupted();

    attachment = attachImage(imagePath, false);
    console.log(`[exfat-smoke] writable mount: ${attachment.mountPoint}`);
    const episodeName = path.basename(options.sampleRoot);
    await cp(options.sampleRoot, path.join(attachment.mountPoint, episodeName), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    throwIfInterrupted();
    await detachImage(attachment.device);
    attachment = null;

    attachment = attachImage(imagePath, true);
    console.log(`[exfat-smoke] read-only mount: ${attachment.mountPoint}`);
    const disk = volumeInfo(attachment.mountPoint);
    report.volume = {
      device: disk.DeviceIdentifier,
      filesystemName: disk.FilesystemName,
      filesystemType: disk.FilesystemType,
      volumeName: disk.VolumeName,
      mountPoint: disk.MountPoint,
      writable: disk.Writable ?? null,
      writableMedia: disk.WritableMedia ?? null,
      writableVolume: disk.WritableVolume ?? null,
      removableMedia: disk.RemovableMedia ?? null,
      internal: disk.Internal ?? null,
    };
    if (disk.FilesystemType?.toLowerCase() !== "exfat") {
      throw new Error(`mounted fixture is not ExFAT: ${disk.FilesystemType ?? "unknown"}`);
    }
    if (
      disk.Writable !== false ||
      disk.WritableMedia !== false ||
      disk.WritableVolume !== false
    ) {
      throw new Error("ExFAT fixture did not remount read-only");
    }
    report.scope.sourceMountedReadOnly = true;
    throwIfInterrupted();

    const workRoot = path.join(tempRoot, "work");
    const source = path.join(attachment.mountPoint, episodeName);
    await runStress(report, cargo, source, workRoot, ffmpeg);
    const stress = JSON.parse(await readFile(path.join(workRoot, "stress-report.json"), "utf8"));
    report.verification = verifyStressReport(stress, attachment.mountPoint, fixture);
    report.stressReport = stress;
    report.status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    report.status = "failed";
    report.failure = failure;
  } finally {
    if (!attachment && imagePath) {
      try {
        attachment = findAttachedImage(imagePath);
        if (!attachment) {
          report.cleanup.detached = true;
        }
      } catch (error) {
        report.cleanup.discoveryError = error instanceof Error ? error.message : String(error);
      }
    }
    if (attachment) {
      try {
        const detached = await detachImage(attachment.device);
        report.cleanup.detachAttempts = detached.attempts;
        report.cleanup.detached = true;
        attachment = null;
      } catch (error) {
        report.cleanup.detachError = error instanceof Error ? error.message : String(error);
      }
    } else if (!imagePath) {
      report.cleanup.detached = true;
    }
    if (tempRoot && report.cleanup.detached) {
      try {
        await removeMarkedTempRoot(tempRoot, markerId);
        report.cleanup.tempRemoved = true;
      } catch (error) {
        report.cleanup.removeError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!report.cleanup.detached || !report.cleanup.tempRemoved) {
      report.status = "failed";
      report.failure = report.failure ?? "ExFAT smoke cleanup did not complete";
    }
    report.finishedAtUtc = new Date().toISOString();
    report.durationMs = Date.now() - started;
    await publishReport(options.reportPath, report);
    console.log(`[exfat-smoke] ${report.status.toUpperCase()}`);
    console.log(`[exfat-smoke] report: ${path.relative(root, options.reportPath)}`);
  }

  if (report.status !== "passed") {
    console.error(`[exfat-smoke] ${report.failure ?? failure}`);
    process.exitCode = interruptedBy ? 130 : 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedBy) {
      return;
    }
    interruptedBy = signal;
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, signal);
      } catch {
        activeChild.kill(signal);
      }
    }
  });
}

main().catch((error) => {
  console.error(`[exfat-smoke] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
