#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseChangelog } from "./release-changelog.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_UPDATER_BYTES = 64 * 1024 * 1024;

function parseArguments(argv) {
  const options = { input: null, output: null, tag: null, commit: null, root: defaultRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--input", "--output", "--tag", "--commit", "--root"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    options[argument.slice(2)] = value;
  }
  for (const key of ["input", "output", "tag", "commit"]) {
    const value = options[key];
    if (!value) throw new Error(`--${key} is required`);
  }
  options.input = path.resolve(options.input);
  options.output = path.resolve(options.output);
  options.root = path.resolve(options.root);
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
      updater: {
        target: "windows-x86_64-nsis",
        fileName: `DOHC-Viewer_${version}_UNSIGNED_windows-x64-updater.exe`,
      },
    },
    {
      key: "macos-arm64",
      platform: "macos",
      architecture: "arm64",
      installer: `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.dmg`,
      report: `DOHC-Viewer_${version}_macos-arm64.verification.json`,
      updater: {
        target: "darwin-aarch64-app",
        fileName: `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.app.tar.gz`,
      },
    },
    {
      key: "ubuntu-deb-x64",
      platform: "linux",
      architecture: "x64",
      packageKind: "deb",
      installer: `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
      report: `DOHC-Viewer_${version}_linux-deb-x64.verification.json`,
      updater: {
        target: "linux-x86_64-deb",
        fileName: `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
      },
    },
  ];
}

async function validateArtifact(options, expected, version, updaterPublicKey) {
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
    const gatekeeper = report.gatekeeper;
    if (
      report.signing?.mode !== "adhoc" ||
      report.signing?.structureVerified !== true ||
      report.signing?.verified !== false ||
      gatekeeper?.quarantineApplied !== true ||
      gatekeeper?.adHocSignatureConfirmed !== true ||
      gatekeeper?.notarizationTicketMissing !== true ||
      gatekeeper?.structuralError !== false ||
      gatekeeper?.userOverrideRequired !== true
    ) {
      throw new Error(`${expected.report} has not passed the macOS Gatekeeper structure checks`);
    }
    const policyClassified =
      gatekeeper.assessment === "rejected-untrusted-adhoc-not-notarized" &&
      gatekeeper.policyServiceAvailable === true &&
      gatekeeper.internalXprotectError === false &&
      gatekeeper.controlAssessmentMatched === false;
    const policyServiceUnavailable =
      gatekeeper.assessment === "rejected-not-notarized-xprotect-unavailable" &&
      gatekeeper.policyServiceAvailable === false &&
      gatekeeper.internalXprotectError === true &&
      gatekeeper.controlAssessmentMatched === true;
    if (!policyClassified && !policyServiceUnavailable) {
      throw new Error(`${expected.report} has an unsupported macOS policy-service result`);
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
  if (
    expected.platform === "linux" &&
    (report.signing?.mode !== "unsigned" ||
      report.signing?.verified !== false ||
      report.ffmpeg?.codeSigned !== false ||
      report.ffmpeg?.signatureMode !== "unsigned" ||
      report.ffmpeg?.trustedSignature !== false ||
      !/^[0-9a-f]{64}$/.test(report.ffmpeg?.sourceArchiveSha256 ?? "") ||
      !/^[0-9a-f]{40}$/.test(report.ffmpeg?.sourceRevision ?? ""))
  ) {
    throw new Error(`${expected.report} has incomplete Linux FFmpeg source evidence`);
  }
  if (expected.packageKind === "deb") {
    const requiredDependencies = [
      "libwebkit2gtk-4.1-0",
      "libgtk-3-0",
      "libayatana-appindicator3-1",
      "librsvg2-2",
      "gstreamer1.0-libav",
      "gstreamer1.0-vaapi",
    ];
    const dependencies = report.deb?.dependencies ?? [];
    if (
      report.deb?.packageName !== "dohc-viewer" ||
      report.deb?.packageVersion !== version ||
      report.deb?.packageArchitecture !== "amd64" ||
      report.deb?.hostMinimum !== "ubuntu-22.04" ||
      report.deb?.verifiedHost !== "ubuntu-22.04" ||
      report.deb?.installationMethod !== "apt-local-deb" ||
      report.deb?.sandboxed !== false ||
      !Array.isArray(dependencies) ||
      !dependencies.every((dependency) => typeof dependency === "string") ||
      !requiredDependencies.every((required) =>
        dependencies.some((actual) => actual === required || actual.startsWith(`${required} `)),
      ) ||
      report.runtimeSmoke?.displayServer !== "xvfb"
    ) {
      throw new Error(`${expected.report} has incomplete Debian install/runtime evidence`);
    }
  }
  const updaterPath = path.join(options.input, expected.updater.fileName);
  const updaterSignaturePath = `${updaterPath}.sig`;
  const updaterInfo = await stat(updaterPath);
  if (!updaterInfo.isFile() || updaterInfo.size < 1_000_000 || updaterInfo.size > MAX_UPDATER_BYTES) {
    throw new Error(`${expected.updater.fileName} is missing or outside the updater size limit`);
  }
  const updaterSignature = await verifyUpdaterSignature(
    updaterPath,
    updaterSignaturePath,
    updaterPublicKey,
  );

  return {
    ...expected,
    sourcePath: installerPath,
    sizeBytes: installerInfo.size,
    sha256: actualHash,
    updater: {
      ...expected.updater,
      signatureFile: `${expected.updater.fileName}.sig`,
      sizeBytes: updaterInfo.size,
      sha256: await sha256(updaterPath),
      signature: updaterSignature.signature,
      keyId: updaterSignature.keyId,
    },
    updaterSourcePath: updaterPath,
    updaterSignatureSourcePath: updaterSignaturePath,
    verification: {
      ffmpegSha256: report.ffmpeg.sha256,
      ffmpegSourceBinarySha256: report.ffmpeg.sourceBinarySha256,
      ffmpegSourceArchiveSha256: report.ffmpeg.sourceArchiveSha256,
      ffmpegSourceRevision: report.ffmpeg.sourceRevision,
      ffmpegLicenseSha256: report.ffmpeg.licenseSha256,
      ffmpegManifestSha256: report.ffmpeg.manifestSha256,
      signingMode: report.signing.mode,
      ...(report.gatekeeper
        ? {
            gatekeeperAssessment: report.gatekeeper.assessment,
            gatekeeperPolicyServiceAvailable: report.gatekeeper.policyServiceAvailable,
          }
        : {}),
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
  const tauriConfig = await readJson(path.join(options.root, "src-tauri/tauri.conf.json"));
  const updaterPublicKey = tauriConfig.plugins?.updater?.pubkey;
  if (typeof updaterPublicKey !== "string" || !updaterPublicKey.trim()) {
    throw new Error("Tauri updater public key is missing");
  }
  const changelog = parseReleaseChangelog(
    await readFile(path.join(options.root, "CHANGELOG.md"), "utf8"),
    version,
  );

  await mkdir(options.output, { recursive: true });
  const existing = await readdir(options.output);
  if (existing.length !== 0) throw new Error(`output directory is not empty: ${options.output}`);

  const expected = expectedArtifacts(version);
  const inputEntries = await readdir(options.input);
  const expectedInputFiles = new Set(expected.flatMap((item) => [
    item.installer,
    item.report,
    item.updater.fileName,
    `${item.updater.fileName}.sig`,
  ]));
  const unexpectedInstallers = inputEntries.filter(
    (name) =>
      /(?:\.(?:deb|dmg|exe|flatpak|sig)|\.nsis\.zip|\.app\.tar\.gz)$/i.test(name) &&
      !expectedInputFiles.has(name),
  );
  if (unexpectedInstallers.length > 0) {
    throw new Error(`unexpected installer artifacts: ${unexpectedInstallers.join(", ")}`);
  }

  const verified = [];
  for (const item of expected) {
    verified.push(await validateArtifact(options, item, version, updaterPublicKey));
  }
  const copied = new Set();
  for (const item of verified) {
    await copyFile(item.sourcePath, path.join(options.output, item.installer), 0);
    copied.add(item.installer);
    if (!copied.has(item.updater.fileName)) {
      await copyFile(
        item.updaterSourcePath,
        path.join(options.output, item.updater.fileName),
        0,
      );
      copied.add(item.updater.fileName);
    }
    await copyFile(
      item.updaterSignatureSourcePath,
      path.join(options.output, item.updater.signatureFile),
      0,
    );
  }

  const releaseAssetUrl = (fileName) => (
    `https://github.com/Lr-2002/Delta-Viewer/releases/download/${options.tag}/${encodeURIComponent(fileName)}`
  );
  const latest = {
    version,
    notes: changelog.body,
    pub_date: `${changelog.date}T00:00:00Z`,
    platforms: Object.fromEntries(verified.map((item) => [
      item.updater.target,
      {
        url: releaseAssetUrl(item.updater.fileName),
        signature: item.updater.signature,
        size: item.updater.sizeBytes,
        sha256: item.updater.sha256,
      },
    ])),
  };
  await writeFile(
    path.join(options.output, "latest.json"),
    `${JSON.stringify(latest, null, 2)}\n`,
    { flag: "wx" },
  );

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
        "These installers are not signed by a trusted publisher or notarized. The macOS app has a valid local ad-hoc seal but still requires the standard Gatekeeper user override; the Ubuntu deb package is unsigned. Verify SHA256SUMS.txt before use.",
      updaterSignature: "minisign-ed25519",
      updaterPublicKeyId: verified[0].updater.keyId,
    },
    assets: verified.map(({
      sourcePath: _sourcePath,
      report: _report,
      updaterSourcePath: _updaterSourcePath,
      updaterSignatureSourcePath: _updaterSignatureSourcePath,
      ...item
    }) => item),
  };
  const manifestName = "release-manifest.json";
  const manifestPath = path.join(options.output, manifestName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  const checksumTargets = (await readdir(options.output)).sort();
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
