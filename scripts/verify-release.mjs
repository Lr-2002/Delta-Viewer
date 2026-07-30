#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseChangelog } from "./release-changelog.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Usage: node scripts/verify-release.mjs --tag <vX.Y.Z> [options]

Options:
  --expected-commit <sha> Require the annotated tag to peel to this commit.
  --expected-tag-object <sha> Require this exact annotated tag object.
  --trusted-main-ref <ref> Require the tag commit to be reachable from this protected ref.
  --expected-trusted-main-commit <sha> Require the protected ref to remain at this recorded commit.
  --output <path>   Write verification metadata as JSON.
  --root <path>     Verify another checkout (used by tests).
  --help            Show this help.
`);
}

function parseArguments(argv) {
  const options = {
    root: defaultRoot,
    output: null,
    tag: null,
    expectedCommit: null,
    expectedTagObject: null,
    expectedTrustedMainCommit: null,
    trustedMainRef: "origin/main",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (
      ![
        "--tag",
        "--output",
        "--root",
        "--expected-commit",
        "--expected-tag-object",
        "--expected-trusted-main-commit",
        "--trusted-main-ref",
      ].includes(argument)
    ) {
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
    if (argument === "--expected-commit") options.expectedCommit = value;
    if (argument === "--expected-tag-object") options.expectedTagObject = value;
    if (argument === "--expected-trusted-main-commit") options.expectedTrustedMainCommit = value;
    if (argument === "--trusted-main-ref") options.trustedMainRef = value;
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

function isGitAncestor(root, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`git merge-base --is-ancestor failed: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const stderr = result.stderr?.trim();
  throw new Error(`git merge-base --is-ancestor failed${stderr ? `: ${stderr}` : ""}`);
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
    macConfig,
    windowsConfig,
    updateServiceConfig,
    changelogContents,
    metainfo,
  ] =
    await Promise.all([
      readJson(options.root, "package.json"),
      readFile(path.join(options.root, "src-tauri/Cargo.toml"), "utf8"),
      readFile(path.join(options.root, "src-tauri/Cargo.lock"), "utf8"),
      readJson(options.root, "src-tauri/tauri.conf.json"),
      readJson(options.root, "src-tauri/tauri.linux.conf.json"),
      readJson(options.root, "src-tauri/tauri.macos.conf.json"),
      readJson(options.root, "src-tauri/tauri.windows.conf.json"),
      readJson(options.root, "update-service.config.json"),
      readFile(path.join(options.root, "CHANGELOG.md"), "utf8"),
      readFile(path.join(options.root, "packaging/linux/com.dohc.viewer.metainfo.xml"), "utf8"),
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

  const changelog = parseReleaseChangelog(changelogContents, version);
  if (tauriConfig.bundle?.active !== true) throw new Error("Tauri bundling is not active");
  if (tauriConfig.bundle?.category !== "Utility") {
    throw new Error("Tauri bundle category must be Utility");
  }
  for (const icon of ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"]) {
    if (!tauriConfig.bundle?.icon?.includes(icon)) {
      throw new Error(`Tauri bundle icon is missing: ${icon}`);
    }
  }
  if (tauriConfig.bundle?.createUpdaterArtifacts !== false) {
    throw new Error("base Tauri config must leave updater artifacts to the controlled release jobs");
  }
  const updaterConfig = tauriConfig.plugins?.updater;
  const expectedUpdaterEndpoint = `${updateServiceConfig.publicBaseUrl}/latest.json`;
  if (
    !updaterConfig
    || !Array.isArray(updaterConfig.endpoints)
    || updaterConfig.endpoints.length !== 1
    || updaterConfig.endpoints[0] !== expectedUpdaterEndpoint
    || updaterConfig.dangerousInsecureTransportProtocol !== true
    || updaterConfig.windows?.installMode !== "passive"
  ) {
    throw new Error("Tauri updater must explicitly limit insecure transport to the configured local mirror and passive NSIS mode");
  }
  if (
    updateServiceConfig.schemaVersion !== 1
    || updateServiceConfig.listenHost !== "0.0.0.0"
    || updateServiceConfig.listenPort !== 17879
    || updateServiceConfig.publicBaseUrl !== "http://10.1.11.36:17879"
    || updateServiceConfig.upstreamManifestUrl
      !== "https://github.com/Lr-2002/Delta-Viewer/releases/latest/download/latest.json"
    || !Number.isInteger(updateServiceConfig.refreshIntervalSeconds)
    || updateServiceConfig.refreshIntervalSeconds < 60
    || updateServiceConfig.refreshIntervalSeconds > 3600
    || updateServiceConfig.retainedVersions !== 2
  ) {
    throw new Error("the local update mirror configuration is not release-safe");
  }
  const updaterPublicKey = updaterConfig.pubkey;
  let decodedUpdaterPublicKey = "";
  try {
    decodedUpdaterPublicKey = Buffer.from(updaterPublicKey, "base64").toString("utf8");
  } catch {
    throw new Error("Tauri updater public key is not valid base64");
  }
  if (
    typeof updaterPublicKey !== "string"
    || Buffer.from(decodedUpdaterPublicKey, "utf8").toString("base64") !== updaterPublicKey
    || !/^untrusted comment: minisign public key:[^\n]+\nRW[A-Za-z0-9+/]+={0,2}\n?$/.test(
      decodedUpdaterPublicKey,
    )
  ) {
    throw new Error("Tauri updater public key is not a canonical Minisign public key");
  }
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
    linuxDeb.files?.["/usr/share/metainfo/com.dohc.viewer.metainfo.xml"] !==
    "../packaging/linux/com.dohc.viewer.metainfo.xml"
  ) {
    throw new Error("Linux deb AppStream metainfo mapping is missing or reversed");
  }
  if (!metainfo.includes("<id>com.dohc.viewer</id>")) {
    throw new Error("Linux AppStream metainfo has the wrong application id");
  }

  const tagType = runGit(options.root, ["cat-file", "-t", `refs/tags/${options.tag}`]);
  if (tagType !== "tag") throw new Error(`${options.tag} is not an annotated tag`);
  const tagObject = runGit(options.root, ["rev-parse", `refs/tags/${options.tag}`]);
  if (options.expectedTagObject && tagObject !== options.expectedTagObject) {
    throw new Error(`tag object ${tagObject} does not match expected ${options.expectedTagObject}`);
  }
  const head = runGit(options.root, ["rev-parse", "HEAD"]);
  const taggedCommit = runGit(options.root, ["rev-list", "-n", "1", options.tag]);
  if (head !== taggedCommit) {
    throw new Error(`HEAD ${head} is not the commit referenced by ${options.tag} (${taggedCommit})`);
  }
  if (options.expectedCommit && taggedCommit !== options.expectedCommit) {
    throw new Error(`tag commit ${taggedCommit} does not match expected ${options.expectedCommit}`);
  }
  const trustedMainCommit = runGit(options.root, [
    "rev-parse",
    "--verify",
    `${options.trustedMainRef}^{commit}`,
  ]);
  if (
    options.expectedTrustedMainCommit &&
    trustedMainCommit !== options.expectedTrustedMainCommit
  ) {
    throw new Error(
      `trusted main ref ${options.trustedMainRef} (${trustedMainCommit}) does not match expected protected main commit ${options.expectedTrustedMainCommit}`,
    );
  }
  if (!isGitAncestor(options.root, taggedCommit, trustedMainCommit)) {
    throw new Error(
      `tag commit ${taggedCommit} is not reachable from trusted main ref ${options.trustedMainRef} (${trustedMainCommit})`,
    );
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
    tagObject,
    trustedMainRef: options.trustedMainRef,
    trustedMainCommit,
    expectedTrustedMainCommit: options.expectedTrustedMainCommit,
    prerelease: version.includes("-"),
    verifiedAtUtc: new Date().toISOString(),
    versions,
    changelog: {
      date: changelog.date,
      changeCount: changelog.changeCount,
    },
    distribution: {
      signingMode: "unsigned",
      trustedPublisher: false,
      updaterSignature: "minisign-ed25519",
    },
    packaging: {
      windows: "unsigned-nsis-x64-offline-webview2",
      macos: ["untrusted-adhoc-sealed-dmg-arm64"],
      macosMinimumSystemVersion: "12.0",
      linux: ["unsigned-deb-ubuntu-22.04+-x64"],
      linuxDebMinimum: "ubuntu-22.04",
      linuxDebBuildHost: "ubuntu-22.04",
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
