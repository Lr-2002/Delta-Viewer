#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function main() {
  const [baseTauriConfig, tauriConfig, metainfo, debVerificationScript] = await Promise.all([
    readJson("src-tauri/tauri.conf.json"),
    readJson("src-tauri/tauri.linux.conf.json"),
    readFile(path.join(root, "packaging/linux/com.dohc.viewer.metainfo.xml"), "utf8"),
    readFile(path.join(root, "scripts/verify-release-deb.sh"), "utf8"),
  ]);

  const bundle = tauriConfig.bundle;
  const deb = bundle?.linux?.deb;
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
  requireCondition(
    Array.isArray(bundle?.targets) && bundle.targets.length === 1 && bundle.targets[0] === "deb",
    "Linux Tauri config must build only deb",
  );
  requireCondition(deb && Array.isArray(deb.depends), "Linux deb dependencies are missing");
  for (const dependency of [
    "libwebkit2gtk-4.1-0",
    "libgtk-3-0",
    "libayatana-appindicator3-1",
    "librsvg2-2",
  ]) {
    requireCondition(deb.depends.includes(dependency), `Linux deb dependency is missing: ${dependency}`);
  }
  requireCondition(
    bundle.resources?.["resources/bin/ffmpeg"] === "bin/ffmpeg" &&
      bundle.resources?.["resources/licenses/FFmpeg.txt"] === "licenses/FFmpeg.txt" &&
      bundle.resources?.["resources/ffmpeg-manifest.json"] === "ffmpeg-manifest.json",
    "Linux FFmpeg resource mappings are incomplete",
  );
  requireCondition(
    deb.files?.["/usr/share/metainfo/com.dohc.viewer.metainfo.xml"] ===
      "../packaging/linux/com.dohc.viewer.metainfo.xml",
    "Linux AppStream metainfo must be included in the deb",
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

  requireCondition(
    !metainfo.includes("<!DOCTYPE"),
    "AppStream metadata must not contain an external entity declaration",
  );
  for (const [tag, value] of [
    ["id", "com.dohc.viewer"],
    ["name", "DOHC Viewer"],
    ["launchable", "com.dohc.viewer.desktop"],
  ]) {
    requireCondition(
      metainfo.includes(`<${tag}>${value}</${tag}>`) ||
        metainfo.includes(`type=\"desktop-id\">${value}</launchable>`),
      `AppStream metadata is missing ${tag}`,
    );
  }
  console.log("Linux package configuration is valid (Ubuntu 22.04+ deb, x86_64)");
}

try {
  await main();
} catch (error) {
  console.error(`[check-linux-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
