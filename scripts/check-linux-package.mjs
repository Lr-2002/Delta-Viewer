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
  const [tauriConfig, flatpakManifest, metainfo] = await Promise.all([
    readJson("src-tauri/tauri.linux.conf.json"),
    readJson("packaging/flatpak/com.dohc.viewer.json"),
    readFile(path.join(root, "packaging/flatpak/com.dohc.viewer.metainfo.xml"), "utf8"),
  ]);

  const bundle = tauriConfig.bundle;
  const deb = bundle?.linux?.deb;
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
    "/app/lib/dohc-viewer",
    "/app/share/applications/com.dohc.viewer.desktop",
    "/app/share/metainfo/com.dohc.viewer.metainfo.xml",
  ]) {
    requireCondition(commands.some((command) => command.includes(fragment)), `Flatpak install command is missing: ${fragment}`);
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
  console.log("Linux package configuration is valid (Ubuntu 20.04+ Flatpak, x86_64)");
}

try {
  await main();
} catch (error) {
  console.error(`[check-linux-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
