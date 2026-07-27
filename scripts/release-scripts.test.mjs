import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatReleaseChangelog, parseReleaseChangelog } from "./release-changelog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyScript = path.join(root, "scripts/verify-release.mjs");
const assembleScript = path.join(root, "scripts/assemble-release.mjs");

test("release changelog requires a unique, first, dated, non-empty version entry", () => {
  const valid = `# Changelog

## Unreleased

- Work planned for a later release.

## 1.2.3 - 2026-07-21

- Added the required release notes.
- Fixed the installer check.

## 1.2.2 - 2026-07-20

- Previous release.
`;
  const entry = parseReleaseChangelog(valid, "1.2.3");
  assert.deepEqual(entry, {
    version: "1.2.3",
    date: "2026-07-21",
    body: "- Added the required release notes.\n- Fixed the installer check.",
    changeCount: 2,
  });
  assert.equal(
    formatReleaseChangelog(entry),
    "## Changelog\n\n### 1.2.3 - 2026-07-21\n\n- Added the required release notes.\n- Fixed the installer check.\n",
  );

  assert.throws(
    () => parseReleaseChangelog("# Changelog\n\n## 1.2.3 - 2026-07-21\n", "1.2.3"),
    /must contain at least one change bullet/,
  );
  assert.throws(
    () =>
      parseReleaseChangelog(
        "# Changelog\n\n## 1.2.2 - 2026-07-20\n\n- Old.\n\n## 1.2.3 - 2026-07-21\n\n- New.\n",
        "1.2.3",
      ),
    /must list 1\.2\.3 as its first dated release entry/,
  );
  assert.throws(
    () =>
      parseReleaseChangelog(
        "# Changelog\n\n## 1.2.3 - 2026-07-21\n\n- One.\n\n## 1.2.3 - 2026-07-22\n\n- Two.\n",
        "1.2.3",
      ),
    /must contain exactly one dated 1\.2\.3 release heading/,
  );
  assert.throws(
    () => parseReleaseChangelog("# Changelog\n\n## 1.2.3 - 2026-02-30\n\n- Change.\n", "1.2.3"),
    /invalid calendar date/,
  );
  assert.throws(
    () => parseReleaseChangelog("# Changelog\n\n## 1.2.3 - 2026-07-21\n\n- TODO\n", "1.2.3"),
    /contains a placeholder/,
  );
});

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("verify-release accepts only a clean trusted-main annotated version tag", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "dohc-release-tag-"));
  await mkdir(path.join(testRoot, "src-tauri"), { recursive: true });
  await mkdir(path.join(testRoot, "packaging/linux"), { recursive: true });
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
              "../packaging/linux/com.dohc.viewer.metainfo.xml",
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
  await writeFile(
    path.join(testRoot, "packaging/linux/com.dohc.viewer.metainfo.xml"),
    "<component><id>com.dohc.viewer</id></component>\n",
  );
  await writeFile(
    path.join(testRoot, "CHANGELOG.md"),
    "# Changelog\n\n## 1.2.3 - 2026-07-21\n\n- Added a tested release change.\n",
  );

  run("git", ["init", "-q"], testRoot);
  run("git", ["config", "user.name", "Release Test"], testRoot);
  run("git", ["config", "user.email", "release-test@example.invalid"], testRoot);
  run("git", ["add", "--all"], testRoot);
  run("git", ["commit", "-qm", "release fixture"], testRoot);
  const mainCommit = run("git", ["rev-parse", "HEAD"], testRoot);
  run("git", ["update-ref", "refs/remotes/origin/main", mainCommit], testRoot);
  run("git", ["tag", "-a", "v1.2.3", "-m", "DOHC Viewer v1.2.3"], testRoot);

  const output = path.join(path.dirname(testRoot), `${path.basename(testRoot)}-metadata.json`);
  run(
    process.execPath,
    [
      verifyScript,
      "--root",
      testRoot,
      "--tag",
      "v1.2.3",
      "--trusted-main-ref",
      "origin/main",
      "--expected-trusted-main-commit",
      mainCommit,
      "--output",
      output,
    ],
    root,
  );
  const metadata = JSON.parse(await readFile(output, "utf8"));
  assert.equal(metadata.version, "1.2.3");
  assert.equal(metadata.commit, mainCommit);
  assert.equal(metadata.trustedMainRef, "origin/main");
  assert.equal(metadata.trustedMainCommit, mainCommit);
  assert.equal(metadata.tagObject, run("git", ["rev-parse", "refs/tags/v1.2.3"], testRoot));
  assert.deepEqual(metadata.changelog, { date: "2026-07-21", changeCount: 1 });
  const originalTagObject = metadata.tagObject;

  run("git", ["commit", "--allow-empty", "-qm", "advance protected main fixture"], testRoot);
  const advancedMainCommit = run("git", ["rev-parse", "HEAD"], testRoot);
  run("git", ["checkout", "--detach", "-q", mainCommit], testRoot);
  run("git", ["update-ref", "refs/remotes/origin/main", advancedMainCommit], testRoot);
  const advancedMain = spawnSync(
    process.execPath,
    [
      verifyScript,
      "--root",
      testRoot,
      "--tag",
      "v1.2.3",
      "--expected-commit",
      mainCommit,
      "--trusted-main-ref",
      "origin/main",
      "--expected-trusted-main-commit",
      mainCommit,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(advancedMain.status, 0);
  assert.match(advancedMain.stderr, /trusted main ref origin\/main .* does not match expected protected main commit/);
  run("git", ["update-ref", "refs/remotes/origin/main", mainCommit], testRoot);

  run("git", ["commit", "--allow-empty", "-qm", "retarget fixture"], testRoot);
  run("git", ["tag", "-f", "-a", "v1.2.3", "-m", "retargeted tag"], testRoot);
  const retargeted = spawnSync(process.execPath, [verifyScript, "--root", testRoot, "--tag", "v1.2.3", "--expected-tag-object", originalTagObject], { cwd: root, encoding: "utf8" });
  assert.notEqual(retargeted.status, 0);
  assert.match(retargeted.stderr, /tag object .* does not match expected/);
  const retargetedCommit = spawnSync(
    process.execPath,
    [
      verifyScript,
      "--root",
      testRoot,
      "--tag",
      "v1.2.3",
      "--expected-commit",
      metadata.commit,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(retargetedCommit.status, 0);
  assert.match(retargetedCommit.stderr, /tag commit .* does not match expected/);

  const nonMainTag = spawnSync(
    process.execPath,
    [
      verifyScript,
      "--root",
      testRoot,
      "--tag",
      "v1.2.3",
      "--trusted-main-ref",
      "origin/main",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(nonMainTag.status, 0);
  assert.match(nonMainTag.stderr, /is not reachable from trusted main ref origin\/main/);
  run("git", ["tag", "-d", "v1.2.3"], testRoot);
  run("git", ["tag", "-a", "v1.2.3", mainCommit, "-m", "DOHC Viewer v1.2.3"], testRoot);
  assert.deepEqual(metadata.packaging.macos, [
    "untrusted-adhoc-sealed-dmg-arm64",
    "untrusted-adhoc-sealed-dmg-x64",
  ]);
  assert.deepEqual(metadata.packaging.linux, ["unsigned-deb-ubuntu-22.04+-x64"]);
  assert.equal(metadata.packaging.linuxDebMinimum, "ubuntu-22.04");
  assert.equal(metadata.packaging.linuxDebBuildHost, "ubuntu-22.04");

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

test("release controller auto-tags the successful main commit with GITHUB_TOKEN", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");

  assert.match(
    workflow,
    /^on:\n  workflow_run:\n    workflows:\n      - CI\n    types:\n      - completed\n    branches:\n      - main\n\npermissions:/m,
  );
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run\.head_branch/);
  assert.match(workflow, /group: release-main/);
  assert.match(workflow, /controller:[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /if: \$\{\{ github\.event\.workflow_run\.conclusion == 'success' \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /release_commit="\$RELEASE_COMMIT"/);
  assert.match(workflow, /git tag -a \"\$tag\" \"\$release_commit\"/);
  assert.match(workflow, /git push origin \"refs\/tags\/\$tag\"/);
  assert.ok(
    workflow.indexOf("node scripts/verify-release.mjs") <
      workflow.indexOf('git push origin "refs/tags/$tag"'),
    "release metadata must be verified before the immutable tag is pushed",
  );
  assert.doesNotMatch(workflow, /RELEASE_APP_ID|RELEASE_APP_PRIVATE_KEY|RELEASE_APP_TOKEN/);
  assert.doesNotMatch(workflow, /create-github-app-token|create-release-tag\.mjs/);
  assert.doesNotMatch(workflow, /environment: release/);
  assert.match(workflow, /publish:[\s\S]*?contents: write/);
  assert.match(workflow, /node scripts\/release-changelog\.mjs/);
  assert.match(workflow, /--notes-file "\$notes_file"/);
  assert.match(workflow, /grep -Fq "### \$VERSION - " <<< "\$release_body"/);
  assert.ok(
    workflow.indexOf("node scripts/release-changelog.mjs") <
      workflow.indexOf('gh release create "${create_args[@]}"'),
    "the required changelog must be rendered before a draft release is created",
  );
  assert.ok(
    workflow.indexOf('grep -Fq "### $VERSION - " <<< "$release_body"') <
      workflow.indexOf('gh release edit "${edit_args[@]}"'),
    "the release body must contain the required changelog before publication",
  );
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
  assert.equal(manifest.assets.length, 4);
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
  assert.equal(manifest.assets.some((asset) => asset.key === "ubuntu-flatpak-x64"), false);
  const checksumLines = (await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, 5);

  const flatpakInstaller = path.join(
    input,
    `DOHC-Viewer_${version}_UNSIGNED_ubuntu-x64.flatpak`,
  );
  await writeFile(flatpakInstaller, Buffer.alloc(1_000_001));
  const flatpakOutput = path.join(testRoot, "flatpak-output");
  const unexpectedFlatpak = spawnSync(
    process.execPath,
    [assembleScript, "--input", input, "--output", flatpakOutput, "--tag", tag, "--commit", commit],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(unexpectedFlatpak.status, 0);
  assert.match(unexpectedFlatpak.stderr, /unexpected installer artifacts/);
});
