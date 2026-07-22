import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyScript = path.join(root, "scripts/verify-release.mjs");
const assembleScript = path.join(root, "scripts/assemble-release.mjs");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("verify-release accepts only a clean exact annotated version tag", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dohc-release-tag-"));
  await mkdir(path.join(testRoot, "src-tauri"), { recursive: true });
  await mkdir(path.join(testRoot, "packaging/flatpak"), { recursive: true });
  await writeJson(path.join(testRoot, "package.json"), { version: "1.2.3" });
  await writeFile(
    path.join(testRoot, "src-tauri/Cargo.toml"),
    '[package]\nname = "dohc-viewer"\nversion = "1.2.3"\n',
  );
  await writeFile(
    path.join(testRoot, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "dohc-viewer"\nversion = "1.2.3"\n',
  );
  await writeJson(path.join(testRoot, "src-tauri/tauri.conf.json"), {
    version: "1.2.3",
    bundle: {
      active: true,
      category: "Utility",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"],
    },
  });
  await writeJson(path.join(testRoot, "src-tauri/tauri.macos.conf.json"), {
    bundle: { targets: ["app", "dmg"], macOS: { minimumSystemVersion: "12.0" } },
  });
  await writeJson(path.join(testRoot, "src-tauri/tauri.linux.conf.json"), {
    bundle: {
      targets: ["deb"],
      linux: {
        deb: {
          depends: [
            "libwebkit2gtk-4.1-0",
            "libgtk-3-0",
            "libayatana-appindicator3-1",
            "librsvg2-2",
          ],
          files: {
            "/usr/share/metainfo/com.dohc.viewer.metainfo.xml":
              "../packaging/flatpak/com.dohc.viewer.metainfo.xml",
          },
        },
      },
    },
  });
  await writeJson(path.join(testRoot, "src-tauri/tauri.windows.conf.json"), {
    bundle: {
      targets: ["nsis"],
      windows: { webviewInstallMode: { type: "offlineInstaller" } },
    },
  });
  await writeJson(path.join(testRoot, "packaging/flatpak/com.dohc.viewer.json"), {
    "app-id": "com.dohc.viewer",
    runtime: "org.gnome.Platform",
    "runtime-version": "50",
    sdk: "org.gnome.Sdk",
    branch: "stable",
    command: "dohc-viewer",
    "finish-args": [
      "--socket=wayland",
      "--socket=fallback-x11",
      "--device=dri",
      "--share=ipc",
      "--filesystem=/media:rw",
      "--filesystem=/run/media:rw",
      "--filesystem=/mnt:rw",
    ],
  });
  await writeFile(
    path.join(testRoot, "packaging/flatpak/com.dohc.viewer.metainfo.xml"),
    "<component><id>com.dohc.viewer</id></component>\n",
  );
  await writeFile(path.join(testRoot, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3 - 2026-07-21\n");

  run("git", ["init", "-q"], testRoot);
  run("git", ["config", "user.name", "Release Test"], testRoot);
  run("git", ["config", "user.email", "release-test@example.invalid"], testRoot);
  run("git", ["add", "--all"], testRoot);
  run("git", ["commit", "-qm", "release fixture"], testRoot);
  run("git", ["tag", "-a", "v1.2.3", "-m", "DOHC Viewer v1.2.3"], testRoot);

  const output = path.join(path.dirname(testRoot), `${path.basename(testRoot)}-metadata.json`);
  run(process.execPath, [verifyScript, "--root", testRoot, "--tag", "v1.2.3", "--output", output], root);
  const metadata = JSON.parse(await readFile(output, "utf8"));
  assert.equal(metadata.version, "1.2.3");
  assert.equal(metadata.commit, run("git", ["rev-parse", "HEAD"], testRoot));
  assert.deepEqual(metadata.packaging.macos, [
    "untrusted-adhoc-sealed-dmg-arm64",
    "untrusted-adhoc-sealed-dmg-x64",
  ]);
  assert.deepEqual(metadata.packaging.linux, [
    "unsigned-deb-ubuntu-22.04+-x64",
    "unsigned-flatpak-ubuntu-20.04+-x64",
  ]);
  assert.equal(metadata.packaging.linuxDebMinimum, "ubuntu-22.04");
  assert.equal(metadata.packaging.linuxDebBuildHost, "ubuntu-22.04");
  assert.equal(metadata.packaging.linuxFlatpakBuildHost, "ubuntu-24.04");

  run("git", ["tag", "-d", "v1.2.3"], testRoot);
  run("git", ["tag", "v1.2.3"], testRoot);
  const lightweight = spawnSync(
    process.execPath,
    [verifyScript, "--root", testRoot, "--tag", "v1.2.3"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(lightweight.status, 0);
  assert.match(lightweight.stderr, /not an annotated tag/);
});

test("assemble-release rejects partial sets and emits checksums for a complete set", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dohc-release-assets-"));
  const input = path.join(testRoot, "input");
  const output = path.join(testRoot, "output");
  await mkdir(input);
  const version = "1.2.3";
  const tag = `v${version}`;
  const commit = "a".repeat(40);
  const definitions = [
    {
      platform: "windows",
      architecture: "x64",
      suffix: "windows-x64-setup.exe",
      reportSuffix: "windows-x64.verification.json",
    },
    {
      platform: "macos",
      architecture: "arm64",
      suffix: "macos-arm64.dmg",
      reportSuffix: "macos-arm64.verification.json",
    },
    {
      platform: "macos",
      architecture: "x64",
      suffix: "macos-x64.dmg",
      reportSuffix: "macos-x64.verification.json",
    },
    {
      platform: "linux",
      architecture: "x64",
      packageKind: "deb",
      suffix: "ubuntu-22.04+-x64.deb",
      reportSuffix: "linux-deb-x64.verification.json",
    },
    {
      platform: "linux",
      architecture: "x64",
      packageKind: "flatpak",
      suffix: "ubuntu-x64.flatpak",
      reportSuffix: "linux-flatpak-x64.verification.json",
    },
  ];

  for (const [index, definition] of definitions.entries()) {
    const installer = `DOHC-Viewer_${version}_UNSIGNED_${definition.suffix}`;
    const installerPath = path.join(input, installer);
    const contents = Buffer.alloc(1_000_001, index + 1);
    await writeFile(installerPath, contents);
    const digest = createHash("sha256").update(contents).digest("hex");
    const reportName = `DOHC-Viewer_${version}_${definition.reportSuffix}`;
    await writeJson(path.join(input, reportName), {
      schemaVersion: 1,
      status: "passed",
      tag,
      commit,
      version,
      platform: definition.platform,
      architecture: definition.architecture,
      distribution: { signingMode: "unsigned", trustedPublisher: false },
      artifact: { fileName: installer, sha256: digest, sizeBytes: contents.length },
      ffmpeg:
        definition.platform === "windows"
          ? {
              portable: true,
              sha256: "b".repeat(64),
              licenseSha256: "e".repeat(64),
              manifestSha256: "f".repeat(64),
            }
          : definition.platform === "linux"
            ? {
                portable: true,
                sha256: "b".repeat(64),
                sourceArchiveSha256: "d".repeat(64),
                sourceRevision: "1".repeat(40),
                licenseSha256: "e".repeat(64),
                manifestSha256: "f".repeat(64),
                codeSigned: false,
                signatureMode: "unsigned",
                trustedSignature: false,
              }
            : {
              portable: true,
              sha256: "b".repeat(64),
              sourceBinarySha256: "a".repeat(64),
              sourceArchiveSha256: "d".repeat(64),
              sourceRevision: "1".repeat(40),
              licenseSha256: "e".repeat(64),
              manifestSha256: "f".repeat(64),
              codeSigned: true,
              signatureMode: "adhoc",
              trustedSignature: false,
            },
      signing:
        definition.platform === "windows" || definition.platform === "linux"
          ? { mode: "unsigned", inspected: true, verified: false }
          : {
              mode: "adhoc",
              inspected: true,
              structureVerified: true,
              verified: false,
              developerId: false,
            },
      runtimeSmoke:
        definition.platform === "linux"
          ? { passed: true, displayServer: "xvfb" }
          : { passed: true },
      ...(definition.platform === "windows"
        ? {
            webview2: {
              offlineInstallerVerified: true,
              sourceUrl: "https://example.invalid/reviewed-webview2.exe",
              sha256: "c".repeat(64),
            },
          }
        : definition.packageKind === "deb"
          ? {
              deb: {
                packageName: "dohc-viewer",
                packageVersion: version,
                packageArchitecture: "amd64",
                hostMinimum: "ubuntu-22.04",
                verifiedHost: "ubuntu-22.04",
                dependencies: [
                  "libwebkit2gtk-4.1-0",
                  "libgtk-3-0",
                  "libayatana-appindicator3-1",
                  "librsvg2-2",
                ],
                installationMethod: "apt-local-deb",
                sandboxed: false,
              },
            }
          : definition.packageKind === "flatpak"
          ? {
              flatpak: {
                appId: "com.dohc.viewer",
                runtime: "org.gnome.Platform",
                runtimeVersion: "50",
                hostMinimum: "ubuntu-20.04",
                permissions: [
                  "--socket=wayland",
                  "--socket=fallback-x11",
                  "--device=dri",
                  "--share=ipc",
                  "--filesystem=/media:rw",
                  "--filesystem=/run/media:rw",
                  "--filesystem=/mnt:rw",
                ],
              },
            }
          : {
            notarization: { verified: false, stapled: false },
            gatekeeper:
              definition.architecture === "arm64"
                ? {
                    quarantineApplied: true,
                    assessment: "rejected-untrusted-adhoc-not-notarized",
                    adHocSignatureConfirmed: true,
                    notarizationTicketMissing: true,
                    policyServiceAvailable: true,
                    internalXprotectError: false,
                    controlAssessmentMatched: false,
                    structuralError: false,
                    userOverrideRequired: true,
                  }
                : {
                    quarantineApplied: true,
                    assessment: "rejected-not-notarized-xprotect-unavailable",
                    adHocSignatureConfirmed: true,
                    notarizationTicketMissing: true,
                    policyServiceAvailable: false,
                    internalXprotectError: true,
                    controlAssessmentMatched: true,
                    structuralError: false,
                    userOverrideRequired: true,
                  },
          }),
    });
  }

  const x64ReportPath = path.join(
    input,
    `DOHC-Viewer_${version}_macos-x64.verification.json`,
  );
  const x64Report = JSON.parse(await readFile(x64ReportPath, "utf8"));
  x64Report.gatekeeper.controlAssessmentMatched = false;
  await writeJson(x64ReportPath, x64Report);
  const unmatchedControl = spawnSync(
    process.execPath,
    [
      assembleScript,
      "--input",
      input,
      "--output",
      output,
      "--tag",
      tag,
      "--commit",
      commit,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(unmatchedControl.status, 0);
  assert.match(unmatchedControl.stderr, /unsupported macOS policy-service result/);

  x64Report.gatekeeper.controlAssessmentMatched = true;
  await writeJson(x64ReportPath, x64Report);

  const debReportPath = path.join(
    input,
    `DOHC-Viewer_${version}_linux-deb-x64.verification.json`,
  );
  const debReport = JSON.parse(await readFile(debReportPath, "utf8"));
  debReport.deb.verifiedHost = "ubuntu-24.04";
  await writeJson(debReportPath, debReport);
  const wrongDebHost = spawnSync(
    process.execPath,
    [
      assembleScript,
      "--input",
      input,
      "--output",
      output,
      "--tag",
      tag,
      "--commit",
      commit,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(wrongDebHost.status, 0);
  assert.match(wrongDebHost.stderr, /incomplete Debian install\/runtime evidence/);

  debReport.deb.verifiedHost = "ubuntu-22.04";
  await writeJson(debReportPath, debReport);

  run(
    process.execPath,
    [assembleScript, "--input", input, "--output", output, "--tag", tag, "--commit", commit],
    root,
  );
  const manifest = JSON.parse(await readFile(path.join(output, "release-manifest.json"), "utf8"));
  assert.equal(manifest.assets.length, 5);
  assert.equal(manifest.distribution.signingMode, "unsigned");
  assert.equal(manifest.distribution.trustedPublisher, false);
  assert.equal(
    manifest.assets.find((asset) => asset.key === "macos-arm64").verification
      .gatekeeperPolicyServiceAvailable,
    true,
  );
  assert.equal(
    manifest.assets.find((asset) => asset.key === "macos-x64").verification
      .gatekeeperAssessment,
    "rejected-not-notarized-xprotect-unavailable",
  );
  assert.equal(
    manifest.assets.find((asset) => asset.key === "ubuntu-deb-x64").packageKind,
    "deb",
  );
  assert.equal(
    manifest.assets.find((asset) => asset.key === "ubuntu-flatpak-x64").packageKind,
    "flatpak",
  );
  const checksumLines = (await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, 6);
});
