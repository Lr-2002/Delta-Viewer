#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zeroObjectId = "0".repeat(40);
const shaPattern = /^[0-9a-f]{40}$/;

function usage() {
  console.log(`Usage: node scripts/create-release-tag.mjs --tag <vX.Y.Z> --commit <sha> --expected-main <sha> --repository <owner/repo> [options]

Creates an annotated release tag with a server-side atomic comparison of refs/heads/main.

Options:
  --server-url <url>  GitHub server URL (default: https://github.com).
  --root <path>       Repository checkout root (used by tests).
  --help              Show this help.

Requires RELEASE_APP_TOKEN in the environment. The token is never accepted on the command line.
`);
}

function assertSha(value, label) {
  if (!shaPattern.test(value)) throw new Error(`${label} must be a lowercase 40-character SHA`);
}

function assertTag(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`release tag must be v<semver>, got ${tag}`);
  }
}

function parseArguments(argv) {
  const options = {
    root: defaultRoot,
    tag: null,
    commit: null,
    expectedMain: null,
    repository: null,
    serverUrl: "https://github.com",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (!Object.hasOwn({ "--tag": true, "--commit": true, "--expected-main": true, "--repository": true, "--server-url": true, "--root": true }, argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--tag") options.tag = value;
    if (argument === "--commit") options.commit = value;
    if (argument === "--expected-main") options.expectedMain = value;
    if (argument === "--repository") options.repository = value;
    if (argument === "--server-url") options.serverUrl = value;
    if (argument === "--root") options.root = path.resolve(value);
  }
  for (const [label, value] of Object.entries({ tag: options.tag, commit: options.commit, expectedMain: options.expectedMain, repository: options.repository })) {
    if (!value) throw new Error(`--${label.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  assertTag(options.tag);
  assertSha(options.commit, "commit");
  assertSha(options.expectedMain, "expected main");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new Error(`repository must be owner/repo, got ${options.repository}`);
  }
  return options;
}

function packetLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = body.length + 4;
  if (length > 0xffff) throw new Error("git protocol packet is too large");
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, "0"), "ascii"), body]);
}

export function decodePktLines(input) {
  const buffer = Buffer.from(input);
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error("truncated git protocol packet header");
    const rawLength = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(rawLength)) throw new Error("invalid git protocol packet header");
    const length = Number.parseInt(rawLength, 16);
    offset += 4;
    if (length === 0) {
      packets.push(null);
      continue;
    }
    if (length < 4 || offset + length - 4 > buffer.length) {
      throw new Error("truncated git protocol packet body");
    }
    packets.push(buffer.subarray(offset, offset + length - 4));
    offset += length - 4;
  }
  return packets;
}

export function parseReceivePackAdvertisement(input) {
  const references = new Map();
  const capabilities = new Set();
  for (const packet of decodePktLines(input)) {
    if (!packet) continue;
    const nul = packet.indexOf(0);
    const reference = packet.subarray(0, nul === -1 ? packet.length : nul).toString("utf8").trim();
    if (reference.startsWith("# service=")) continue;
    const separator = reference.indexOf(" ");
    if (separator === -1) continue;
    const objectId = reference.slice(0, separator);
    const refName = reference.slice(separator + 1);
    if (!shaPattern.test(objectId) || !refName.startsWith("refs/")) continue;
    references.set(refName, objectId);
    if (nul !== -1) {
      for (const capability of packet.subarray(nul + 1).toString("utf8").trim().split(/\s+/)) {
        if (capability) capabilities.add(capability);
      }
    }
  }
  return { references, capabilities };
}

export function requireExactProtectedMain(advertisement, expectedMainCommit) {
  assertSha(expectedMainCommit, "expected main");
  const remoteMain = advertisement.references.get("refs/heads/main");
  if (remoteMain !== expectedMainCommit) {
    throw new Error(
      `protected main advanced or differs: expected ${expectedMainCommit}, remote advertised ${remoteMain ?? "missing"}`,
    );
  }
  if (!advertisement.capabilities.has("atomic")) {
    throw new Error("GitHub receive-pack does not advertise atomic ref transactions");
  }
}

export function buildAtomicTagRequest({ expectedMainCommit, tag, tagObject, capabilities, pack }) {
  assertSha(expectedMainCommit, "expected main");
  assertSha(tagObject, "tag object");
  assertTag(tag);
  if (!capabilities.has("atomic")) throw new Error("server does not support atomic ref transactions");
  const reportStatus = capabilities.has("report-status-v2")
    ? "report-status-v2"
    : capabilities.has("report-status")
      ? "report-status"
      : null;
  if (!reportStatus) throw new Error("server does not support receive-pack status reporting");

  const requestedCapabilities = [reportStatus];
  if (capabilities.has("side-band-64k")) requestedCapabilities.push("side-band-64k");
  requestedCapabilities.push("atomic");
  if (capabilities.has("object-format=sha1")) requestedCapabilities.push("object-format=sha1");

  const mainCompare = `${expectedMainCommit} ${expectedMainCommit} refs/heads/main\0${requestedCapabilities.join(" ")}\n`;
  const createTag = `${zeroObjectId} ${tagObject} refs/tags/${tag}\n`;
  return Buffer.concat([packetLine(mainCompare), packetLine(createTag), Buffer.from("0000", "ascii"), Buffer.from(pack)]);
}

export function parseReceivePackResult(input) {
  const packets = decodePktLines(input);
  const sidebandPackets = packets.filter((packet) => packet && [1, 2, 3].includes(packet[0]));
  if (sidebandPackets.length > 0) {
    const errors = sidebandPackets
      .filter((packet) => packet[0] === 3)
      .map((packet) => packet.subarray(1).toString("utf8").trim())
      .filter(Boolean);
    const statusPayload = Buffer.concat(
      sidebandPackets.filter((packet) => packet[0] === 1).map((packet) => packet.subarray(1)),
    );
    if (statusPayload.length === 0) return errors;
    const nestedHeader = statusPayload.subarray(0, 4).toString("ascii");
    if (/^[0-9a-fA-F]{4}$/.test(nestedHeader)) {
      return [...errors, ...parseReceivePackResult(statusPayload)];
    }
    return [...errors, ...statusPayload.toString("utf8").split("\n").filter(Boolean)];
  }
  const lines = [];
  for (const packet of packets) {
    if (!packet || packet.length === 0) continue;
    for (const line of packet.toString("utf8").split("\n")) {
      if (line) lines.push(line);
    }
  }
  return lines;
}

function runGitText(root, args) {
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

function makeTagPack(root, tagObject, commit) {
  const result = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd: root,
    input: `${tagObject}\n^${commit}\n`,
    encoding: null,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`git pack-objects failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git pack-objects failed: ${result.stderr?.toString().trim() || "unknown error"}`);
  }
  return result.stdout;
}

function smartHttpUrl(serverUrl, repository, endpoint) {
  const server = new URL(serverUrl);
  if (server.protocol !== "https:") throw new Error("release tag creation requires an HTTPS GitHub server URL");
  const prefix = server.pathname.replace(/\/$/, "");
  return `${server.origin}${prefix}/${repository}.git/${endpoint}`;
}

function authorizationHeader(token) {
  return `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

async function gitHttpRequest(url, token, init) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      Authorization: authorizationHeader(token),
      "User-Agent": "dohc-viewer-release-controller",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub smart-HTTP ${init.method} ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function createAtomicReleaseTag(options, request = gitHttpRequest) {
  const { root, tag, commit, expectedMain, repository, serverUrl } = options;
  assertTag(tag);
  assertSha(commit, "commit");
  assertSha(expectedMain, "expected main");
  if (commit !== expectedMain) {
    throw new Error(`release commit ${commit} does not equal recorded protected main ${expectedMain}`);
  }
  const token = process.env.RELEASE_APP_TOKEN;
  if (!token) throw new Error("RELEASE_APP_TOKEN is required for atomic release tag creation");

  const advertised = await request(
    `${smartHttpUrl(serverUrl, repository, "info/refs")}?service=git-receive-pack`,
    token,
    {
      method: "GET",
      headers: { Accept: "application/x-git-receive-pack-advertisement" },
    },
  );
  const advertisement = parseReceivePackAdvertisement(advertised);
  requireExactProtectedMain(advertisement, expectedMain);
  const tagRef = `refs/tags/${tag}`;
  const existingTagObject = advertisement.references.get(tagRef);
  if (existingTagObject) {
    return {
      created: false,
      tag,
      commit,
      protectedMainCommit: expectedMain,
      tagObject: existingTagObject,
    };
  }

  const localTag = spawnSync("git", ["show-ref", "--verify", "--quiet", tagRef], {
    cwd: root,
    stdio: "ignore",
  });
  if (localTag.status === 0) throw new Error(`local ${tagRef} already exists before atomic creation`);
  if (localTag.status !== 1) throw new Error(`could not inspect local ${tagRef}`);

  runGitText(root, ["tag", "-a", tag, commit, "-m", `DOHC Viewer ${tag}`]);
  const tagObject = runGitText(root, ["rev-parse", tagRef]);
  const pack = makeTagPack(root, tagObject, commit);
  const requestBody = buildAtomicTagRequest({
    expectedMainCommit: expectedMain,
    tag,
    tagObject,
    capabilities: advertisement.capabilities,
    pack,
  });
  const result = await request(
    smartHttpUrl(serverUrl, repository, "git-receive-pack"),
    token,
    {
      method: "POST",
      headers: {
        Accept: "application/x-git-receive-pack-result",
        "Content-Type": "application/x-git-receive-pack-request",
      },
      body: requestBody,
    },
  );
  const statusLines = parseReceivePackResult(result);
  const failed = statusLines.filter((line) => line.startsWith("ng "));
  if (failed.length > 0) throw new Error(`atomic release tag transaction failed: ${failed.join("; ")}`);
  for (const refName of ["refs/heads/main", tagRef]) {
    if (!statusLines.includes(`ok ${refName}`)) {
      throw new Error(`atomic release tag transaction did not confirm ${refName}`);
    }
  }
  return {
    created: true,
    tag,
    commit,
    protectedMainCommit: expectedMain,
    tagObject,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await createAtomicReleaseTag(options);
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[create-release-tag] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
