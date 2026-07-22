#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function workflowJob(workflow, jobName) {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  requireCondition(start >= 0, `Workflow job is missing: ${jobName}`);
  const bodyStart = start + marker.length;
  const remaining = workflow.slice(bodyStart);
  const nextJob = remaining.search(/\n  [A-Za-z0-9_]+:\n/);
  return nextJob >= 0 ? remaining.slice(0, nextJob) : remaining;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function main() {
  const [
    baseTauriConfig,
    tauriConfig,
    flatpakManifest,
    metainfo,
    smokeWorkflow,
    releaseWorkflow,
    debVerificationScript,
  ] = await Promise.all([
    readJson("src-tauri/tauri.conf.json"),
    readJson("src-tauri/tauri.linux.conf.json"),
    readJson("packaging/flatpak/com.dohc.viewer.json"),
    readFile(path.join(root, "packaging/flatpak/com.dohc.viewer.metainfo.xml"), "utf8"),
    readFile(path.join(root, ".github/workflows/linux-package.yml"), "utf8"),
    readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    readFile(path.join(root, "scripts/verify-release-deb.sh"), "utf8"),
  ]);

  const bundle = tauriConfig.bundle;
  const deb = bundle?.linux?.deb;
  const smokeDebJob = workflowJob(smokeWorkflow, "deb");
  const smokeFlatpakJob = workflowJob(smokeWorkflow, "flatpak");
  const releaseDebJob = workflowJob(releaseWorkflow, "linux_deb");
  const releaseFlatpakJob = workflowJob(releaseWorkflow, "linux_flatpak");
  const releasePublishJob = workflowJob(releaseWorkflow, "publish");
  requireCondition(
    baseTauriConfig.bundle?.category === "Utility",
    "Tauri bundle category must produce a valid Freedesktop desktop category",
  );
  for (const icon of ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"]) {
    requireCondition(
      baseTauriConfig.bundle?.icon?.includes(icon),
      `Tauri bundle icon is missing: ${icon}`,
    );
  }
  requireCondition(Array.isArray(bundle?.targets) && bundle.targets.length === 1 && bundle.targets[0] === "deb", "Linux Tauri config must build only deb");
  requireCondition(deb && Array.isArray(deb.depends), "Linux deb dependencies are missing");
  for (const dependency of ["libwebkit2gtk-4.1-0", "libgtk-3-0", "libayatana-appindicator3-1", "librsvg2-2"]) {
    requireCondition(deb.depends.includes(dependency), `Linux deb dependency is missing: ${dependency}`);
  }
  requireCondition(
    bundle.resources?.["resources/bin/ffmpeg"] === "bin/ffmpeg" &&
      bundle.resources?.["resources/licenses/FFmpeg.txt"] === "licenses/FFmpeg.txt" &&
      bundle.resources?.["resources/ffmpeg-manifest.json"] === "ffmpeg-manifest.json",
    "Linux FFmpeg resource mappings are incomplete",
  );
  requireCondition(
    deb.files?.["/usr/share/metainfo/com.dohc.viewer.metainfo.xml"] === "../packaging/flatpak/com.dohc.viewer.metainfo.xml",
    "Linux AppStream metainfo must be included in the deb",
  );

  requireCondition(flatpakManifest["app-id"] === "com.dohc.viewer", "Flatpak app id is incorrect");
  requireCondition(flatpakManifest.runtime === "org.gnome.Platform", "Flatpak runtime must be GNOME Platform");
  requireCondition(flatpakManifest["runtime-version"] === "50", "Flatpak runtime version must be pinned to GNOME 50");
  requireCondition(flatpakManifest.sdk === "org.gnome.Sdk", "Flatpak SDK must match the GNOME runtime");
  requireCondition(flatpakManifest.branch === "stable", "Flatpak branch must be stable");
  requireCondition(flatpakManifest.command === "dohc-viewer", "Flatpak command is incorrect");
  const finishArgs = new Set(flatpakManifest["finish-args"] ?? []);
  for (const permission of [
    "--socket=wayland",
    "--socket=fallback-x11",
    "--device=dri",
    "--share=ipc",
    "--filesystem=/media:rw",
    "--filesystem=/run/media:rw",
    "--filesystem=/mnt:rw",
  ]) {
    requireCondition(finishArgs.has(permission), `Flatpak permission is missing: ${permission}`);
  }
  requireCondition(![...finishArgs].some((permission) => permission.includes("network")), "Flatpak must not request network access");
  const module = flatpakManifest.modules?.find((item) => item.name === "dohc-viewer");
  requireCondition(module?.buildsystem === "simple", "Flatpak application module must use simple buildsystem");
  requireCondition(
    module.sources?.some((source) => source.type === "file" && source.path === "dohc-viewer.deb"),
    "Flatpak manifest must consume the generated deb",
  );
  const commands = module["build-commands"] ?? [];
  for (const fragment of [
    "ar -x dohc-viewer.deb",
    "/app/bin/dohc-viewer",
    "/app/lib/DOHC Viewer",
    "/app/share/applications/com.dohc.viewer.desktop",
    "/app/share/metainfo/com.dohc.viewer.metainfo.xml",
  ]) {
    requireCondition(commands.some((command) => command.includes(fragment)), `Flatpak install command is missing: ${fragment}`);
  }
  requireCondition(
    commands.some((command) => command.includes("test -n") && command.includes("*.png")),
    "Flatpak build must reject a package with no application icon",
  );
  for (const [job, label, artifactName] of [
    [smokeDebJob, "Linux smoke deb", "linux-deb-smoke"],
    [releaseDebJob, "Linux release deb", "release-ubuntu-deb-x64"],
  ]) {
    requireCondition(job.includes("runs-on: ubuntu-22.04"), `${label} job must run on Ubuntu 22.04`);
    requireCondition(job.includes("verify-release-deb.sh"), `${label} job must install and verify the deb`);
    requireCondition(job.includes("UNSIGNED_ubuntu-22.04+-x64.deb"), `${label} job must stage the formal deb asset`);
    requireCondition(job.includes(artifactName), `${label} job must upload named deb evidence`);
  }
  for (const [job, label, dependency, artifactName] of [
    [smokeFlatpakJob, "Linux smoke Flatpak", "needs: deb", "linux-deb-smoke"],
    [
      releaseFlatpakJob,
      "Linux release Flatpak",
      "needs: [prepare, linux_deb]",
      "release-ubuntu-deb-x64",
    ],
  ]) {
    requireCondition(job.includes("runs-on: ubuntu-24.04"), `${label} job must run on Ubuntu 24.04`);
    requireCondition(job.includes(dependency), `${label} job must depend on verified deb evidence`);
    requireCondition(job.includes("verify-release-linux.sh"), `${label} job must verify the Flatpak runtime`);
    requireCondition(job.includes("ubuntu-22.04+-x64.deb"), `${label} job must consume the verified deb`);
    requireCondition(job.includes(artifactName), `${label} job must download named deb evidence`);
  }
  requireCondition(
    releasePublishJob.includes("linux_deb") && releasePublishJob.includes("linux_flatpak"),
    "Release publication must depend on both Linux package jobs",
  );
  for (const fragment of [
    'host_version" == "22.04"',
    "sudo apt-get install --yes",
    'package_architecture" == "amd64"',
    'hostMinimum: "ubuntu-22.04"',
  ]) {
    requireCondition(
      debVerificationScript.includes(fragment),
      `Debian verification script is missing: ${fragment}`,
    );
  }

  requireCondition(!metainfo.includes("<!DOCTYPE"), "AppStream metadata must not contain an external entity declaration");
  for (const field of [
    ["id", "com.dohc.viewer"],
    ["name", "DOHC Viewer"],
    ["launchable", "com.dohc.viewer.desktop"],
  ]) {
    const [tag, value] = field;
    requireCondition(metainfo.includes(`<${tag}>${value}</${tag}>`) || metainfo.includes(`type=\"desktop-id\">${value}</launchable>`), `AppStream metadata is missing ${tag}`);
  }
  console.log(
    "Linux package configuration is valid (Ubuntu 22.04+ deb and Ubuntu 20.04+ Flatpak, x86_64)",
  );
}

try {
  await main();
} catch (error) {
  console.error(`[check-linux-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
