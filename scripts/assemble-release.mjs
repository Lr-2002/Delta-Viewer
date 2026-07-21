#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArguments(argv) {
  const options = { input: null, output: null, tag: null, commit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--input", "--output", "--tag", "--commit"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    options[argument.slice(2)] = value;
  }
  for (const [key, value] of Object.entries(options)) {
    if (!value) throw new Error(`--${key} is required`);
  }
  options.input = path.resolve(options.input);
  options.output = path.resolve(options.output);
  return options;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function expectedArtifacts(version) {
  return [
    {
      key: "windows-x64",
      platform: "windows",
      architecture: "x64",
      installer: `DOHC-Viewer_${version}_UNSIGNED_windows-x64-setup.exe`,
      report: `DOHC-Viewer_${version}_windows-x64.verification.json`,
    },
    {
      key: "macos-arm64",
      platform: "macos",
      architecture: "arm64",
      installer: `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.dmg`,
      report: `DOHC-Viewer_${version}_macos-arm64.verification.json`,
    },
    {
      key: "macos-x64",
      platform: "macos",
      architecture: "x64",
      installer: `DOHC-Viewer_${version}_UNSIGNED_macos-x64.dmg`,
      report: `DOHC-Viewer_${version}_macos-x64.verification.json`,
    },
  ];
}

async function validateArtifact(options, expected, version) {
  const installerPath = path.join(options.input, expected.installer);
  const reportPath = path.join(options.input, expected.report);
  const [installerInfo, report] = await Promise.all([stat(installerPath), readJson(reportPath)]);
  if (!installerInfo.isFile() || installerInfo.size < 1_000_000) {
    throw new Error(`${expected.installer} is missing, not a file, or implausibly small`);
  }
  const actualHash = await sha256(installerPath);
  const required = {
    schemaVersion: 1,
    status: "passed",
    tag: options.tag,
    commit: options.commit,
    version,
    platform: expected.platform,
    architecture: expected.architecture,
  };
  for (const [field, value] of Object.entries(required)) {
    if (report[field] !== value) {
      throw new Error(`${expected.report} field ${field} does not match ${JSON.stringify(value)}`);
    }
  }
  if (report.artifact?.fileName !== expected.installer || report.artifact?.sha256 !== actualHash) {
    throw new Error(`${expected.report} does not match ${expected.installer}`);
  }
  if (report.artifact?.sizeBytes !== installerInfo.size) {
    throw new Error(`${expected.report} records the wrong artifact size`);
  }
  if (report.ffmpeg?.portable !== true || !/^[0-9a-f]{64}$/.test(report.ffmpeg?.sha256 ?? "")) {
    throw new Error(`${expected.report} has no verified portable FFmpeg dependency`);
  }
  if (
    !/^[0-9a-f]{64}$/.test(report.ffmpeg?.licenseSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(report.ffmpeg?.manifestSha256 ?? "")
  ) {
    throw new Error(`${expected.report} has incomplete FFmpeg license/manifest evidence`);
  }
  if (
    report.distribution?.signingMode !== "unsigned" ||
    report.distribution?.trustedPublisher !== false ||
    report.signing?.inspected !== true ||
    report.runtimeSmoke?.passed !== true
  ) {
    throw new Error(`${expected.report} has not passed unsigned-distribution and runtime checks`);
  }
  if (expected.platform === "windows") {
    if (report.signing?.mode !== "unsigned" || report.signing?.verified !== false) {
      throw new Error(`${expected.report} has an invalid unsigned Windows signing state`);
    }
  }
  if (expected.platform === "macos") {
    if (
      report.signing?.mode !== "adhoc" ||
      report.signing?.structureVerified !== true ||
      report.signing?.verified !== false ||
      report.gatekeeper?.assessment !== "rejected-untrusted-adhoc-not-notarized" ||
      report.gatekeeper?.structuralError !== false ||
      report.gatekeeper?.userOverrideRequired !== true
    ) {
      throw new Error(`${expected.report} has not passed the macOS Gatekeeper structure checks`);
    }
  }
  if (
    expected.platform === "windows" &&
    (report.webview2?.offlineInstallerVerified !== true ||
      !/^https:\/\//.test(report.webview2?.sourceUrl ?? ""))
  ) {
    throw new Error(`${expected.report} has not verified the offline WebView2 payload`);
  }
  if (
    expected.platform === "macos" &&
    (report.notarization?.verified !== false || report.notarization?.stapled !== false)
  ) {
    throw new Error(`${expected.report} has an invalid unsigned notarization state`);
  }
  if (
    expected.platform === "macos" &&
    (report.ffmpeg?.codeSigned !== true ||
      report.ffmpeg?.signatureMode !== "adhoc" ||
      report.ffmpeg?.trustedSignature !== false ||
      !/^[0-9a-f]{64}$/.test(report.ffmpeg?.sourceBinarySha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(report.ffmpeg?.sourceArchiveSha256 ?? "") ||
      !/^[0-9a-f]{40}$/.test(report.ffmpeg?.sourceRevision ?? ""))
  ) {
    throw new Error(`${expected.report} has incomplete macOS FFmpeg source evidence`);
  }
  return {
    ...expected,
    sourcePath: installerPath,
    sizeBytes: installerInfo.size,
    sha256: actualHash,
    verification: {
      ffmpegSha256: report.ffmpeg.sha256,
      ffmpegSourceBinarySha256: report.ffmpeg.sourceBinarySha256,
      ffmpegSourceArchiveSha256: report.ffmpeg.sourceArchiveSha256,
      ffmpegSourceRevision: report.ffmpeg.sourceRevision,
      ffmpegLicenseSha256: report.ffmpeg.licenseSha256,
      ffmpegManifestSha256: report.ffmpeg.manifestSha256,
      signingMode: report.signing.mode,
      ...(report.webview2?.sha256
        ? {
            webview2Sha256: report.webview2.sha256,
            webview2SourceUrl: report.webview2.sourceUrl,
          }
        : {}),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const tagMatch = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(options.tag);
  if (!tagMatch) throw new Error(`invalid release tag: ${options.tag}`);
  if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error("--commit must be a full Git SHA");
  const version = tagMatch[1];

  await mkdir(options.output, { recursive: true });
  const existing = await readdir(options.output);
  if (existing.length !== 0) throw new Error(`output directory is not empty: ${options.output}`);

  const expected = expectedArtifacts(version);
  const inputEntries = await readdir(options.input);
  const unexpectedInstallers = inputEntries.filter(
    (name) => /\.(?:dmg|exe)$/i.test(name) && !expected.some((item) => item.installer === name),
  );
  if (unexpectedInstallers.length > 0) {
    throw new Error(`unexpected installer artifacts: ${unexpectedInstallers.join(", ")}`);
  }

  const verified = [];
  for (const item of expected) verified.push(await validateArtifact(options, item, version));
  for (const item of verified) {
    await copyFile(item.sourcePath, path.join(options.output, item.installer), 0);
  }

  const manifest = {
    schemaVersion: 1,
    application: "DOHC Viewer",
    tag: options.tag,
    version,
    commit: options.commit,
    createdAtUtc: new Date().toISOString(),
    distribution: {
      signingMode: "unsigned",
      trustedPublisher: false,
      warning:
        "These installers are not signed by a trusted publisher or notarized. The macOS app has a valid local ad-hoc seal but still requires the standard Gatekeeper user override. Verify SHA256SUMS.txt before use.",
    },
    assets: verified.map(({ sourcePath: _sourcePath, report: _report, ...item }) => item),
  };
  const manifestName = "release-manifest.json";
  const manifestPath = path.join(options.output, manifestName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  const checksumTargets = [...verified.map((item) => item.installer), manifestName].sort();
  const checksumLines = [];
  for (const name of checksumTargets) {
    checksumLines.push(`${await sha256(path.join(options.output, name))}  ${name}`);
  }
  await writeFile(path.join(options.output, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, {
    flag: "wx",
  });
  console.log(`Assembled ${verified.length} verified installers in ${options.output}`);
}

main().catch((error) => {
  console.error(`[assemble-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
