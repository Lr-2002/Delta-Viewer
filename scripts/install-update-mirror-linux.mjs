#!/usr/bin/env node
// Independent user service; never restarts Viewer business services.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("This installer requires Linux/systemd");
execFileSync(process.execPath, ["--use-env-proxy", "--version"], { stdio: "ignore" });
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceRoot = path.join(homedir(), ".local/share/delta-viewer-update-service");
const appRoot = path.join(serviceRoot, "app");
const cacheRoot = path.join(serviceRoot, "cache");
const unitRoot = path.join(homedir(), ".config/systemd/user");
for (const directory of [serviceRoot, cacheRoot, unitRoot]) await mkdir(directory, { recursive: true, mode: 0o700 });
for (const file of ["scripts/update-mirror-server.mjs", "scripts/updater-signature.mjs",
  "src-tauri/tauri.conf.json", "update-service.lan.config.json"]) {
  const destination = path.join(appRoot, file);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(path.join(repository, file), destination);
}
// Proxy configuration is server-local and optional. Reviewers always connect directly.
const escape = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n") + '"';
const proxyEnvironment = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
  .filter(key => process.env[key]).map(key => `${key}=${escape(process.env[key])}`).join("\n");
const environmentFile = path.join(serviceRoot, "upstream.env");
await writeFile(environmentFile, proxyEnvironment + "\n", { mode: 0o600 });
const unitPath = path.join(unitRoot, "delta-viewer-update-mirror.service");
const directivePath = value => value.replaceAll("%", "%%").replaceAll(" ", "\\x20");
const unitQuote = value => escape(value.replaceAll("%", "%%").replaceAll("$", "$$"));
await writeFile(unitPath, `[Unit]
Description=Delta Viewer verified LAN update mirror
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${directivePath(appRoot)}
EnvironmentFile=${directivePath(environmentFile)}
ExecStart=${unitQuote(process.execPath)} --use-env-proxy ${unitQuote(path.join(appRoot, "scripts/update-mirror-server.mjs"))} --config ${unitQuote(path.join(appRoot, "update-service.lan.config.json"))} --cache-root ${unitQuote(cacheRoot)}
Restart=on-failure
RestartSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`, { mode: 0o600 });
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", "delta-viewer-update-mirror.service"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "is-active", "--quiet", "delta-viewer-update-mirror.service"]);
console.log("LAN update mirror installed. Reinstalling copies files; restart only this service to load updated code.");
console.log("Health: http://10.1.41.17:17879/healthz · Download: http://10.1.41.17:17879/");
