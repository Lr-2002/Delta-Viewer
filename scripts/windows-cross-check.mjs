#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "x86_64-pc-windows-msvc";
const toolchain = "stable";

function usage() {
  console.log(`Usage: node scripts/windows-cross-check.mjs [options]

Checks every Rust target against Windows x64 MSVC without linking or packaging.

Options:
  --report <path>  Set the JSON evidence report path
  --help           Show this help

Prerequisites:
  rustup target add ${target} --toolchain ${toolchain}
  llvm-rc on PATH, DOHC_LLVM_RC, or the Homebrew LLVM prefix
`);
}

function parseArguments(argv) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  let reportPath = path.join(
    root,
    "artifacts/windows-cross-check",
    `${timestamp}-${process.platform}-${process.arch}.json`,
  );

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (argument === "--report") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--report requires a value");
      }
      reportPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return { reportPath };
}

function capture(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function captureRequired(command, args) {
  const output = capture(command, args);
  if (output === null) {
    throw new Error(`command failed: ${printableCommand(command, args)}`);
  }
  return output;
}

function printableCommand(command, args) {
  const quote = (value) => (/^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value));
  return [command, ...args].map(quote).join(" ");
}

async function isExecutable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findLlvmRc() {
  const candidates = [];
  if (process.env.DOHC_LLVM_RC) {
    candidates.push(path.resolve(process.env.DOHC_LLVM_RC));
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory) {
      candidates.push(path.join(directory, "llvm-rc"));
    }
  }
  candidates.push(
    "/opt/homebrew/opt/llvm/bin/llvm-rc",
    "/usr/local/opt/llvm/bin/llvm-rc",
  );

  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "llvm-rc was not found; install LLVM or set DOHC_LLVM_RC to its absolute path",
  );
}

async function runCargo(report, command, args, environment) {
  const started = Date.now();
  console.log(`[windows-cross-check] $ ${printableCommand(command, args)}`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => resolve({ exitCode: null, error: error.message }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  report.command = {
    value: printableCommand(command, args),
    startedAtUtc: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    status: result.exitCode === 0 ? "passed" : "failed",
  };
  if (result.error) {
    report.command.error = result.error;
  }
  if (result.exitCode !== 0) {
    throw new Error(result.error ?? `cargo check exited with ${result.exitCode ?? "unknown"}`);
  }
}

async function publishReport(reportPath, report) {
  const directory = path.dirname(reportPath);
  await mkdir(directory, { recursive: true });
  try {
    await access(reportPath, fsConstants.F_OK);
    throw new Error(`report path already exists: ${reportPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const temporary = path.join(
    directory,
    `.${path.basename(reportPath)}.partial-${process.pid}-${Date.now()}`,
  );
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  try {
    await link(temporary, reportPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = Date.now();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const report = {
    schemaVersion: 1,
    kind: "windows-msvc-cross-check",
    appVersion: packageJson.version,
    status: "running",
    startedAtUtc: new Date(started).toISOString(),
    host: { platform: process.platform, arch: process.arch },
    target,
    toolchain,
    scope: {
      rustTargets: "all",
      linksExecutable: false,
      buildsInstaller: false,
      runsOnWindows: false,
      bundleResourcesOmitted: true,
    },
    git: {
      head: capture("git", ["rev-parse", "HEAD"]),
      clean: capture("git", ["status", "--porcelain=v1"]) === "",
    },
  };

  try {
    if (process.platform === "win32") {
      throw new Error("this command is for cross-host checks; use pnpm check on Windows");
    }

    const rustup = process.env.RUSTUP ?? "rustup";
    const installedTargets = captureRequired(rustup, [
      "target",
      "list",
      "--installed",
      "--toolchain",
      toolchain,
    ]).split(/\r?\n/);
    if (!installedTargets.includes(target)) {
      throw new Error(
        `missing Rust target; run: rustup target add ${target} --toolchain ${toolchain}`,
      );
    }

    const cargo = captureRequired(rustup, ["which", "cargo", "--toolchain", toolchain]);
    const rustc = captureRequired(rustup, ["which", "rustc", "--toolchain", toolchain]);
    const rustdoc = captureRequired(rustup, ["which", "rustdoc", "--toolchain", toolchain]);
    const llvmRc = await findLlvmRc();
    const llvmConfig = path.join(path.dirname(llvmRc), "llvm-config");
    report.tools = {
      rustup,
      cargo: { path: cargo, version: captureRequired(cargo, ["--version"]) },
      rustc: { path: rustc, version: captureRequired(rustc, ["--version", "--verbose"]) },
      rustdoc,
      llvmRc,
      llvmVersion: (await isExecutable(llvmConfig)) ? capture(llvmConfig, ["--version"]) : null,
    };

    const args = [
      "check",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--target",
      target,
      "--all-targets",
      "--features",
      "windows-cross-check",
    ];
    await runCargo(report, cargo, args, {
      CARGO_INCREMENTAL: "0",
      PATH: `${path.dirname(llvmRc)}${path.delimiter}${process.env.PATH ?? ""}`,
      RUSTC: rustc,
      RUSTDOC: rustdoc,
      TAURI_CONFIG: JSON.stringify({ bundle: { resources: null } }),
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAtUtc = new Date().toISOString();
    report.durationMs = Date.now() - started;
    await publishReport(options.reportPath, report);
    console.log(`[windows-cross-check] ${report.status.toUpperCase()}`);
    console.log(`[windows-cross-check] report: ${path.relative(root, options.reportPath)}`);
  }

  if (report.status !== "passed") {
    console.error(`[windows-cross-check] ${report.failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `[windows-cross-check] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
