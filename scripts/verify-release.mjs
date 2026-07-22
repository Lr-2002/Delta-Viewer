#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Usage: node scripts/verify-release.mjs --tag <vX.Y.Z> [options]

Options:
  --output <path>   Write verification metadata as JSON.
  --root <path>     Verify another checkout (used by tests).
  --help            Show this help.
`);
}

function parseArguments(argv) {
  const options = { root: defaultRoot, output: null, tag: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (!["--tag", "--output", "--root"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--tag") options.tag = value;
    if (argument === "--output") options.output = path.resolve(value);
    if (argument === "--root") options.root = path.resolve(value);
  }
  if (!options.tag) throw new Error("--tag is required");
  return options;
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function packageVersionFromToml(contents) {
  const packageSection = contents.match(/\[package\]([\s\S]*?)(?:\n\s*\[|$)/)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error("could not read [package].version from Cargo.toml");
  return version;
}

function packageVersionFromLock(contents) {
  for (const block of contents.split("[[package]]")) {
    if (/^\s*name\s*=\s*"dohc-viewer"\s*$/m.test(block)) {
      const version = block.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)?.[1];
      if (version) return version;
    }
  }
  throw new Error("could not read dohc-viewer version from Cargo.lock");
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function verify(options) {
  const tagMatch = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(options.tag);
  if (!tagMatch) throw new Error(`release tag must be v<semver>, got ${options.tag}`);
  const version = tagMatch[1];

  const [
    packageJson,
    cargoToml,
    cargoLock,
    tauriConfig,
    linuxConfig,
    flatpakManifest,
    macConfig,
    windowsConfig,
    changelog,
    metainfo,
  ] =
    await Promise.all([
      readJson(options.root, "package.json"),
      readFile(path.join(options.root, "src-tauri/Cargo.toml"), "utf8"),
      readFile(path.join(options.root, "src-tauri/Cargo.lock"), "utf8"),
      readJson(options.root, "src-tauri/tauri.conf.json"),
      readJson(options.root, "src-tauri/tauri.linux.conf.json"),
      readJson(options.root, "packaging/flatpak/com.dohc.viewer.json"),
      readJson(options.root, "src-tauri/tauri.macos.conf.json"),
      readJson(options.root, "src-tauri/tauri.windows.conf.json"),
      readFile(path.join(options.root, "CHANGELOG.md"), "utf8"),
      readFile(path.join(options.root, "packaging/flatpak/com.dohc.viewer.metainfo.xml"), "utf8"),
    ]);

  const versions = {
    packageJson: packageJson.version,
    cargoToml: packageVersionFromToml(cargoToml),
    cargoLock: packageVersionFromLock(cargoLock),
    tauriConfig: tauriConfig.version,
  };
  for (const [source, actual] of Object.entries(versions)) {
    if (actual !== version) {
      throw new Error(`${source} version ${actual} does not match release tag ${options.tag}`);
    }
  }

  if (!new RegExp(`^## ${version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md has no dated ${version} release heading`);
  }
  if (tauriConfig.bundle?.active !== true) throw new Error("Tauri bundling is not active");
  if (!macConfig.bundle?.targets?.includes("dmg")) throw new Error("macOS DMG target is missing");
  if (macConfig.bundle?.macOS?.minimumSystemVersion !== "12.0") {
    throw new Error("macOS minimumSystemVersion must be 12.0 for formal releases");
  }
  if (!windowsConfig.bundle?.targets?.includes("nsis")) throw new Error("Windows NSIS target is missing");
  if (windowsConfig.bundle?.windows?.webviewInstallMode?.type !== "offlineInstaller") {
    throw new Error("Windows formal releases must embed the offline WebView2 installer");
  }
  const linuxBundle = linuxConfig.bundle;
  const linuxDeb = linuxBundle?.linux?.deb;
  if (!linuxBundle?.targets?.includes("deb") || !linuxDeb) {
    throw new Error("Linux deb target is missing");
  }
  for (const dependency of [
    "libwebkit2gtk-4.1-0",
    "libgtk-3-0",
    "libayatana-appindicator3-1",
    "librsvg2-2",
  ]) {
    if (!linuxDeb.depends?.includes(dependency)) {
      throw new Error(`Linux deb dependency is missing: ${dependency}`);
    }
  }
  if (
    flatpakManifest["app-id"] !== "com.dohc.viewer" ||
    flatpakManifest.runtime !== "org.gnome.Platform" ||
    flatpakManifest["runtime-version"] !== "50" ||
    flatpakManifest.sdk !== "org.gnome.Sdk" ||
    flatpakManifest.command !== "dohc-viewer"
  ) {
    throw new Error("Flatpak app id, runtime, SDK, or command is invalid");
  }
  for (const permission of [
    "--socket=wayland",
    "--socket=fallback-x11",
    "--device=dri",
    "--share=ipc",
    "--filesystem=/media:rw",
    "--filesystem=/run/media:rw",
    "--filesystem=/mnt:rw",
  ]) {
    if (!flatpakManifest["finish-args"]?.includes(permission)) {
      throw new Error(`Flatpak permission is missing: ${permission}`);
    }
  }
  if (flatpakManifest["finish-args"]?.some((permission) => permission.includes("network"))) {
    throw new Error("Flatpak must not request network access");
  }
  if (!metainfo.includes("<id>com.dohc.viewer</id>")) {
    throw new Error("Flatpak AppStream metainfo has the wrong application id");
  }

  const tagType = runGit(options.root, ["cat-file", "-t", `refs/tags/${options.tag}`]);
  if (tagType !== "tag") throw new Error(`${options.tag} is not an annotated tag`);
  const head = runGit(options.root, ["rev-parse", "HEAD"]);
  const taggedCommit = runGit(options.root, ["rev-list", "-n", "1", options.tag]);
  if (head !== taggedCommit) {
    throw new Error(`HEAD ${head} is not the commit referenced by ${options.tag} (${taggedCommit})`);
  }
  const status = runGit(options.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("release checkout is not clean");
  const annotation = runGit(options.root, [
    "for-each-ref",
    "--format=%(contents)",
    `refs/tags/${options.tag}`,
  ]);
  if (!annotation) throw new Error(`${options.tag} has an empty annotation`);

  return {
    schemaVersion: 1,
    application: "DOHC Viewer",
    tag: options.tag,
    version,
    commit: head,
    prerelease: version.includes("-"),
    verifiedAtUtc: new Date().toISOString(),
    versions,
    distribution: {
      signingMode: "unsigned",
      trustedPublisher: false,
    },
    packaging: {
      windows: "unsigned-nsis-x64-offline-webview2",
      macos: ["untrusted-adhoc-sealed-dmg-arm64", "untrusted-adhoc-sealed-dmg-x64"],
      macosMinimumSystemVersion: "12.0",
      linux: "unsigned-flatpak-ubuntu-20.04+-x64",
      linuxRuntime: "org.gnome.Platform//50",
    },
  };
}

async function writeJsonAtomically(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.partial-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, outputPath);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await verify(options);
  if (options.output) await writeJsonAtomically(options.output, result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[verify-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
