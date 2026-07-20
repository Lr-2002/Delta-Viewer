#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoManifest = "src-tauri/Cargo.toml";
const isWindows = process.platform === "win32";
const commands = {
  cargo: isWindows ? "cargo.exe" : "cargo",
  git: isWindows ? "git.exe" : "git",
  pnpm: isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
  rustc: isWindows ? "rustc.exe" : "rustc",
};
const pnpmArguments = (args) => (isWindows ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args);

function usage() {
  console.log(`Usage: node scripts/release-check.mjs [options]

Profiles:
  --quick                         Build, format, lint, and unit tests (default)
  --full                          Quick checks plus private-sample tests and a Tauri build

Options:
  --bundle                        Build a debug platform bundle after all checks
  --allow-nonportable-bundle      Allow a local-only staged FFmpeg in a debug bundle
  --require-clean                 Fail unless the Git worktree is clean
  --sample-root <path>            Override DOHC_SAMPLE_ROOT for full checks
  --report <path>                 Set the JSON evidence report path
  --help                          Show this help
`);
}

function parseArguments(argv) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const options = {
    profile: "quick",
    bundle: false,
    allowNonportableBundle: false,
    requireClean: false,
    sampleRoot: process.env.DOHC_SAMPLE_ROOT
      ? path.resolve(process.env.DOHC_SAMPLE_ROOT)
      : path.join(root, "data/raw/2026-07-13_07-34-12"),
    reportPath: path.join(
      root,
      "artifacts/release-check",
      `${timestamp}-${process.platform}-${process.arch}.json`,
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--quick":
        options.profile = "quick";
        break;
      case "--full":
        options.profile = "full";
        break;
      case "--bundle":
        options.bundle = true;
        break;
      case "--allow-nonportable-bundle":
        options.allowNonportableBundle = true;
        break;
      case "--require-clean":
        options.requireClean = true;
        break;
      case "--sample-root":
      case "--report": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`${argument} requires a value`);
        }
        index += 1;
        if (argument === "--sample-root") {
          options.sampleRoot = path.resolve(value);
        } else {
          options.reportPath = path.resolve(value);
        }
        break;
      }
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.allowNonportableBundle && !options.bundle) {
    throw new Error("--allow-nonportable-bundle requires --bundle");
  }
  return options;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function printableCommand(command, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value));
  return [command, ...args].map(quote).join(" ");
}

async function runCommand(report, name, command, args, environment = {}) {
  const started = Date.now();
  console.log(`\n[release-check] ${name}`);
  console.log(`$ ${printableCommand(command, args)}`);

  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => resolve({ exitCode: null, error: error.message }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const commandReport = {
    name,
    command: printableCommand(command, args),
    startedAtUtc: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    status: result.exitCode === 0 ? "passed" : "failed",
  };
  if (result.error) {
    commandReport.error = result.error;
  }
  report.commands.push(commandReport);

  if (result.exitCode !== 0) {
    const detail = result.error ?? `exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(`${name} failed: ${detail}`);
  }
}

async function recordCheck(report, name, operation) {
  const started = Date.now();
  try {
    const details = await operation();
    report.checks.push({
      name,
      status: "passed",
      durationMs: Date.now() - started,
      ...(details === undefined ? {} : { details }),
    });
    console.log(`[release-check] PASS ${name}`);
    return details;
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function packageVersionFromToml(contents) {
  const marker = "[package]";
  const markerIndex = contents.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("Cargo.toml does not contain a [package] section");
  }
  const remaining = contents.slice(markerIndex + marker.length);
  const nextSection = remaining.search(/\n\s*\[/);
  const packageSection = nextSection === -1 ? remaining : remaining.slice(0, nextSection);
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    throw new Error("could not read [package].version from Cargo.toml");
  }
  return version;
}

function packageVersionFromLock(contents) {
  for (const block of contents.split("[[package]]")) {
    if (/^\s*name\s*=\s*"dohc-viewer"\s*$/m.test(block)) {
      const version = block.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)?.[1];
      if (version) {
        return version;
      }
    }
  }
  throw new Error("could not read dohc-viewer version from Cargo.lock");
}

async function verifyVersions() {
  const [packageJsonText, cargoToml, cargoLock, tauriConfigText] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, cargoManifest), "utf8"),
    readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  ]);
  const versions = {
    packageJson: JSON.parse(packageJsonText).version,
    cargoToml: packageVersionFromToml(cargoToml),
    cargoLock: packageVersionFromLock(cargoLock),
    tauriConfig: JSON.parse(tauriConfigText).version,
  };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    throw new Error(`application versions differ: ${JSON.stringify(versions)}`);
  }
  const [version] = unique;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`application version is not valid semver: ${version}`);
  }
  return { version, files: versions };
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function captureRequired(command, args, maxBuffer = 8 * 1024 * 1024) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${printableCommand(command, args)} failed: ${result.error?.message ?? result.status}`,
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function expectedFfmpegPlatform() {
  if (process.platform === "darwin") {
    return `darwin-${process.arch}`;
  }
  if (process.platform === "win32") {
    return `win32-${process.arch}`;
  }
  throw new Error(`bundling is not configured for ${process.platform}`);
}

async function verifyStagedFfmpeg(allowNonportable) {
  const resources = path.join(root, "src-tauri/resources");
  const expectedBinary = process.platform === "win32" ? "bin/ffmpeg.exe" : "bin/ffmpeg";
  const manifestPath = path.join(resources, "ffmpeg-manifest.json");
  const rawManifest = (await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "");
  const manifest = JSON.parse(rawManifest);

  const requiredStrings = ["sourceUrl", "buildId", "sha256", "version", "configuration"];
  for (const field of requiredStrings) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      throw new Error(`FFmpeg manifest field ${field} is missing`);
    }
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported FFmpeg manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.platform !== expectedFfmpegPlatform()) {
    throw new Error(
      `staged FFmpeg platform ${manifest.platform} does not match ${expectedFfmpegPlatform()}`,
    );
  }
  if (manifest.binaryPath !== expectedBinary) {
    throw new Error(`FFmpeg manifest binaryPath must be ${expectedBinary}`);
  }
  if (manifest.licensePath !== "licenses/FFmpeg.txt") {
    throw new Error("FFmpeg manifest licensePath must be licenses/FFmpeg.txt");
  }
  if (manifest.encoder !== "mpeg4") {
    throw new Error("staged FFmpeg must declare the mpeg4 encoder");
  }
  if (!/^https:\/\//i.test(manifest.sourceUrl)) {
    throw new Error("FFmpeg sourceUrl must use HTTPS");
  }
  if (!Array.isArray(manifest.licenseFiles) || manifest.licenseFiles.length === 0) {
    throw new Error("FFmpeg manifest must name at least one reviewed license file");
  }
  if (
    manifest.licenseFiles.some(
      (name) => typeof name !== "string" || name.trim() === "" || /[\\/]/.test(name),
    )
  ) {
    throw new Error("FFmpeg manifest licenseFiles must contain plain non-empty file names");
  }
  if (Number.isNaN(Date.parse(manifest.stagedAtUtc))) {
    throw new Error("FFmpeg manifest stagedAtUtc is invalid");
  }
  if (manifest.portable !== true && !allowNonportable) {
    throw new Error(
      "staged FFmpeg is marked non-portable; formal bundles require a portable reviewed build",
    );
  }

  const binaryPath = path.join(resources, ...manifest.binaryPath.split("/"));
  const licensePath = path.join(resources, ...manifest.licensePath.split("/"));
  const [binaryInfo, licenseInfo, actualHash, manifestHash, licenseHash] = await Promise.all([
    stat(binaryPath),
    stat(licensePath),
    sha256(binaryPath),
    sha256(manifestPath),
    sha256(licensePath),
  ]);
  if (!binaryInfo.isFile() || binaryInfo.size === 0) {
    throw new Error("staged FFmpeg binary is empty or not a file");
  }
  if (process.platform !== "win32" && (binaryInfo.mode & 0o111) === 0) {
    throw new Error("staged FFmpeg is not executable");
  }
  if (!licenseInfo.isFile() || licenseInfo.size < 256) {
    throw new Error("staged FFmpeg license bundle is missing or implausibly small");
  }
  if (actualHash !== manifest.sha256.toLowerCase()) {
    throw new Error(`staged FFmpeg SHA-256 mismatch: expected ${manifest.sha256}, got ${actualHash}`);
  }

  const expectedArchitecture =
    process.platform === "win32" ? "x86_64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (manifest.architecture !== expectedArchitecture) {
    throw new Error(
      `staged FFmpeg architecture ${manifest.architecture} does not match ${expectedArchitecture}`,
    );
  }
  const licenseText = await readFile(licensePath, "utf8");
  for (const licenseFile of manifest.licenseFiles) {
    if (!licenseText.includes(`===== ${licenseFile} =====`)) {
      throw new Error(`FFmpeg license bundle does not contain ${licenseFile}`);
    }
  }

  const versionOutput = captureRequired(binaryPath, ["-version"], 4 * 1024 * 1024);
  if (!versionOutput.split(/\r?\n/).includes(manifest.version)) {
    throw new Error("staged FFmpeg version output differs from its manifest");
  }
  if (!versionOutput.split(/\r?\n/).includes(`configuration: ${manifest.configuration}`)) {
    throw new Error("staged FFmpeg configuration differs from its manifest");
  }
  if (/(^|\s)--enable-nonfree(\s|$)/.test(manifest.configuration)) {
    throw new Error("staged FFmpeg configuration contains --enable-nonfree");
  }
  const encoderOutput = captureRequired(binaryPath, ["-hide_banner", "-encoders"]);
  if (!/^\s*[A-Z.]{6}\s+mpeg4(?:\s|$)/m.test(encoderOutput)) {
    throw new Error("staged FFmpeg no longer reports the required mpeg4 encoder");
  }
  return {
    platform: manifest.platform,
    portable: manifest.portable,
    sha256: actualHash,
    manifestSha256: manifestHash,
    licenseSha256: licenseHash,
    sizeBytes: binaryInfo.size,
    version: manifest.version,
  };
}

async function findBundleArtifacts(notBefore) {
  const base = path.join(root, "src-tauri/target/debug/bundle");
  const artifacts = [];
  const addMatches = async (directory, suffix) => {
    let entries;
    try {
      entries = await readdir(path.join(base, directory), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.endsWith(suffix)) {
        const artifactPath = path.join(base, directory, entry.name);
        const artifactInfo = await stat(artifactPath);
        if (artifactInfo.mtimeMs >= notBefore - 2_000) {
          artifacts.push(path.relative(root, artifactPath));
        }
      }
    }
  };

  if (process.platform === "darwin") {
    await addMatches("macos", ".app");
    await addMatches("dmg", ".dmg");
  } else if (process.platform === "win32") {
    await addMatches("nsis", ".exe");
  }
  if (artifacts.length === 0) {
    throw new Error("bundle command succeeded but no platform artifact was found");
  }
  return artifacts.sort();
}

async function verifyMacApp(appPath, expectedVersion, dependency) {
  const contents = path.join(appPath, "Contents");
  const executable = path.join(contents, "MacOS/dohc-viewer");
  const resources = path.join(contents, "Resources");
  const binary = path.join(resources, "bin/ffmpeg");
  const license = path.join(resources, "licenses/FFmpeg.txt");
  const manifest = path.join(resources, "ffmpeg-manifest.json");
  const [appInfo, executableInfo, binaryInfo, binaryHash, licenseHash, manifestHash] =
    await Promise.all([
      stat(appPath),
      stat(executable),
      stat(binary),
      sha256(binary),
      sha256(license),
      sha256(manifest),
    ]);
  if (!appInfo.isDirectory()) {
    throw new Error("macOS app artifact is not a directory");
  }
  if (!executableInfo.isFile() || (executableInfo.mode & 0o111) === 0) {
    throw new Error("macOS app main executable is missing or not executable");
  }
  if (!binaryInfo.isFile() || (binaryInfo.mode & 0o111) === 0) {
    throw new Error("bundled FFmpeg is missing or not executable");
  }
  if (binaryHash !== dependency.sha256) {
    throw new Error("bundled FFmpeg hash differs from the staged dependency");
  }
  if (licenseHash !== dependency.licenseSha256) {
    throw new Error("bundled FFmpeg license differs from the staged dependency");
  }
  if (manifestHash !== dependency.manifestSha256) {
    throw new Error("bundled FFmpeg manifest differs from the staged dependency");
  }
  const version = captureRequired("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    path.join(contents, "Info.plist"),
  ]).trim();
  if (version !== expectedVersion) {
    throw new Error(`macOS app version ${version} does not match ${expectedVersion}`);
  }
  return {
    version,
    executableSizeBytes: executableInfo.size,
    ffmpegSha256: binaryHash,
  };
}

async function verifyMacDmg(dmgPath, expectedVersion, dependency) {
  const dmgInfo = await stat(dmgPath);
  if (!dmgInfo.isFile() || dmgInfo.size === 0) {
    throw new Error("macOS DMG artifact is empty or not a file");
  }
  const imageInfo = captureRequired("hdiutil", ["imageinfo", dmgPath]);
  if (!imageInfo.includes("UDZO")) {
    throw new Error("macOS DMG is not a compressed read-only UDZO image");
  }

  const mountPoint = await mkdtemp(path.join(tmpdir(), "dohc-viewer-dmg-"));
  let attached = false;
  try {
    captureRequired(
      "hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath],
      16 * 1024 * 1024,
    );
    attached = true;
    const applicationsLink = path.join(mountPoint, "Applications");
    const linkInfo = await lstat(applicationsLink);
    if (!linkInfo.isSymbolicLink() || (await readlink(applicationsLink)) !== "/Applications") {
      throw new Error("macOS DMG does not contain the expected /Applications link");
    }
    const app = await verifyMacApp(
      path.join(mountPoint, "DOHC Viewer.app"),
      expectedVersion,
      dependency,
    );
    return { sizeBytes: dmgInfo.size, format: "UDZO", mountedApp: app };
  } finally {
    if (attached) {
      const detach = spawnSync("hdiutil", ["detach", mountPoint], {
        cwd: root,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      if (detach.error || detach.status !== 0) {
        throw new Error(
          `failed to detach DMG verification mount ${mountPoint}: ${detach.error?.message ?? detach.status}`,
        );
      }
    }
    await rmdir(mountPoint).catch(() => {});
  }
}

async function verifyBundleArtifacts(artifactPaths, report) {
  if (process.platform === "darwin") {
    const app = artifactPaths.find((artifact) => artifact.endsWith(".app"));
    const dmg = artifactPaths.find((artifact) => artifact.endsWith(".dmg"));
    if (!app || !dmg) {
      throw new Error("macOS bundle verification requires both .app and .dmg artifacts");
    }
    const appDetails = await verifyMacApp(path.join(root, app), report.appVersion, report.ffmpeg);
    const dmgDetails = await verifyMacDmg(path.join(root, dmg), report.appVersion, report.ffmpeg);
    return { paths: artifactPaths, app: appDetails, dmg: dmgDetails };
  }

  if (process.platform === "win32") {
    const installer = artifactPaths.find((artifact) => artifact.endsWith(".exe"));
    if (!installer) {
      throw new Error("Windows bundle verification requires an NSIS .exe artifact");
    }
    const installerInfo = await stat(path.join(root, installer));
    if (!installerInfo.isFile() || installerInfo.size === 0) {
      throw new Error("Windows NSIS artifact is empty or not a file");
    }
    return { paths: artifactPaths, installerSizeBytes: installerInfo.size };
  }

  throw new Error(`bundle artifact verification is not configured for ${process.platform}`);
}

async function publishReport(reportPath, report) {
  const directory = path.dirname(reportPath);
  await mkdir(directory, { recursive: true });
  try {
    await access(reportPath, fsConstants.F_OK);
    throw new Error(`report path already exists: ${reportPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = path.join(
    directory,
    `.${path.basename(reportPath)}.partial-${process.pid}-${Date.now()}`,
  );
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporary, reportPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = Date.now();
  const gitStatus = capture(commands.git, ["status", "--porcelain=v1"]);
  const report = {
    schemaVersion: 1,
    application: "DOHC Viewer",
    appVersion: null,
    profile: options.profile,
    bundleRequested: options.bundle,
    allowNonportableBundle: options.allowNonportableBundle,
    startedAtUtc: new Date(started).toISOString(),
    finishedAtUtc: null,
    durationMs: null,
    status: "running",
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    tools: {
      pnpm: capture(commands.pnpm, pnpmArguments(["--version"])),
      cargo: capture(commands.cargo, ["--version"]),
      rustc: capture(commands.rustc, ["--version"]),
    },
    git: {
      head: capture(commands.git, ["rev-parse", "HEAD"]),
      branch: capture(commands.git, ["branch", "--show-current"]),
      clean: gitStatus === "",
    },
    checks: [],
    commands: [],
    artifacts: [],
    failure: null,
  };

  try {
    const versionDetails = await recordCheck(report, "version consistency", verifyVersions);
    report.appVersion = versionDetails.version;

    await recordCheck(report, "Git repository state", async () => {
      if (!report.git.head || gitStatus === null) {
        throw new Error("could not inspect Git repository state");
      }
      if (options.requireClean && !report.git.clean) {
        throw new Error("Git worktree is not clean");
      }
      return { clean: report.git.clean, requireClean: options.requireClean };
    });

    await runCommand(
      report,
      "frontend production build",
      commands.pnpm,
      pnpmArguments(["build"]),
    );
    await runCommand(report, "Rust format check", commands.cargo, [
      "fmt",
      "--manifest-path",
      cargoManifest,
      "--",
      "--check",
    ]);
    await runCommand(report, "Rust Clippy", commands.cargo, [
      "clippy",
      "--manifest-path",
      cargoManifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    await runCommand(report, "Rust unit tests", commands.cargo, [
      "test",
      "--manifest-path",
      cargoManifest,
    ]);

    if (options.profile === "full") {
      await recordCheck(report, "private sample availability", async () => {
        const sampleInfo = await stat(options.sampleRoot);
        if (!sampleInfo.isDirectory()) {
          throw new Error("DOHC_SAMPLE_ROOT is not a directory");
        }
        await access(path.join(options.sampleRoot, "states.jsonl"), fsConstants.R_OK);
        return {
          source: process.env.DOHC_SAMPLE_ROOT ? "environment" : "repository default",
          statesReadable: true,
        };
      });
      const sampleEnvironment = { DOHC_SAMPLE_ROOT: options.sampleRoot };
      await runCommand(
        report,
        "real sample import and hash readback",
        commands.cargo,
        [
          "test",
          "--manifest-path",
          cargoManifest,
          "imports_real_sample_and_verifies_hashes",
          "--",
          "--ignored",
          "--nocapture",
        ],
        sampleEnvironment,
      );
      await runCommand(
        report,
        "real sample validation and three-format readback",
        commands.cargo,
        [
          "test",
          "--manifest-path",
          cargoManifest,
          "validates_and_exports_real_sample",
          "--",
          "--ignored",
          "--nocapture",
        ],
        sampleEnvironment,
      );
      await runCommand(
        report,
        "Tauri debug application build",
        commands.pnpm,
        pnpmArguments(["tauri", "build", "--debug", "--no-bundle", "--ci"]),
      );
    }

    if (options.bundle) {
      const dependency = await recordCheck(report, "staged FFmpeg", () =>
        verifyStagedFfmpeg(options.allowNonportableBundle),
      );
      report.ffmpeg = dependency;
      const bundleStartedAt = Date.now();
      if (process.platform === "darwin") {
        await runCommand(
          report,
          "macOS debug app bundle",
          commands.pnpm,
          pnpmArguments([
            "tauri",
            "build",
            "--debug",
            "--bundles",
            "app",
            "--no-sign",
            "--ci",
          ]),
        );
        const appPath = path.join(root, "src-tauri/target/debug/bundle/macos/DOHC Viewer.app");
        const dmgPath = path.join(
          root,
          "src-tauri/target/debug/bundle/dmg",
          `DOHC Viewer_${report.appVersion}_${process.arch}.headless-${bundleStartedAt}.dmg`,
        );
        await runCommand(report, "macOS headless DMG bundle", "bash", [
          "scripts/make-dmg.sh",
          "--app",
          appPath,
          "--output",
          dmgPath,
          "--volume-name",
          "DOHC Viewer",
        ]);
      } else if (process.platform === "win32") {
        await runCommand(
          report,
          "Windows debug NSIS bundle",
          commands.pnpm,
          pnpmArguments(["tauri", "build", "--debug", "--no-sign", "--ci"]),
        );
      } else {
        throw new Error(`bundle verification is not configured for ${process.platform}`);
      }
      const artifactPaths = await findBundleArtifacts(bundleStartedAt);
      const bundle = await recordCheck(report, "bundle artifacts and contents", () =>
        verifyBundleArtifacts(artifactPaths, report),
      );
      report.artifacts = bundle.paths;
      report.bundle = bundle;
    }

    await recordCheck(report, "post-check Git repository state", async () => {
      const finalGitStatus = capture(commands.git, ["status", "--porcelain=v1"]);
      if (finalGitStatus === null) {
        throw new Error("could not inspect final Git repository state");
      }
      report.git.cleanAfter = finalGitStatus === "";
      if (finalGitStatus !== gitStatus) {
        throw new Error("Git worktree changed while release checks were running");
      }
      if (options.requireClean && !report.git.cleanAfter) {
        throw new Error("Git worktree is not clean after release checks");
      }
      return { clean: report.git.cleanAfter, unchanged: true };
    });

    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAtUtc = new Date().toISOString();
    report.durationMs = Date.now() - started;
    await publishReport(options.reportPath, report);
    console.log(`\n[release-check] ${report.status.toUpperCase()}`);
    console.log(`[release-check] report: ${path.relative(root, options.reportPath)}`);
  }

  if (report.status !== "passed") {
    console.error(`[release-check] ${report.failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[release-check] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
