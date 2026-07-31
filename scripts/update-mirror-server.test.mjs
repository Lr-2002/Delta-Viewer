import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signEd25519,
} from "node:crypto";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdateMirror } from "./update-mirror-server.mjs";

const TARGETS = [
  {
    key: "windows-x64",
    target: "windows-x86_64-nsis",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_windows-x64-updater.exe`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_windows-x64-setup.exe`,
  },
  {
    key: "macos-arm64",
    target: "darwin-aarch64-app",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.app.tar.gz`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_macos-arm64.dmg`,
  },
  {
    key: "ubuntu-deb-x64",
    target: "linux-x86_64-deb",
    updaterName: (version) => `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
    installerName: (version) => `DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb`,
  },
];

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicRecord = Buffer.concat([
    Buffer.from([0x45, 0x64]),
    keyId,
    publicDer.subarray(-32),
  ]);
  const publicEnvelope =
    `untrusted comment: minisign public key: UPDATE MIRROR TEST\n${publicRecord.toString("base64")}\n`;
  return {
    wrappedPublicKey: Buffer.from(publicEnvelope).toString("base64"),
    sign(contents, fileName) {
      const digest = createHash("blake2b512").update(contents).digest();
      const primary = signEd25519(null, digest, privateKey);
      const trustedComment = `timestamp:1785379200\tfile:${fileName}\tprehashed`;
      const globalSignature = signEd25519(
        null,
        Buffer.concat([primary, Buffer.from(trustedComment)]),
        privateKey,
      );
      const signatureRecord = Buffer.concat([Buffer.from([0x45, 0x44]), keyId, primary]);
      const envelope = [
        "untrusted comment: signature from minisign secret key",
        signatureRecord.toString("base64"),
        `trusted comment: ${trustedComment}`,
        globalSignature.toString("base64"),
        "",
      ].join("\n");
      return Buffer.from(envelope).toString("base64");
    },
  };
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function createRelease(version, signer, upstreamBase, fillOffset = 0) {
  const files = new Map();
  const platforms = {};
  const assets = [];
  for (const [index, target] of TARGETS.entries()) {
    const updaterName = target.updaterName(version);
    const updater = Buffer.alloc(1024 * 1024 + index, 20 + fillOffset + index);
    files.set(updaterName, updater);
    platforms[target.target] = {
      url: `${upstreamBase}/repo/releases/download/v${version}/${encodeURIComponent(updaterName)}`,
      signature: signer.sign(updater, updaterName),
      size: updater.length,
      sha256: sha256(updater),
    };
    const installerName = target.installerName(version);
    const installer = installerName === updaterName
      ? updater
      : Buffer.alloc(1024 * 1024 + 100 + index, 40 + fillOffset + index);
    files.set(installerName, installer);
    assets.push({
      key: target.key,
      installer: installerName,
      sizeBytes: installer.length,
      sha256: sha256(installer),
      updater: { target: target.target, fileName: updaterName },
    });
  }
  return {
    latest: {
      version,
      notes: `- Mirrored v${version}.`,
      pub_date: "2026-07-30T00:00:00Z",
      platforms,
    },
    releaseManifest: {
      schemaVersion: 1,
      application: "DOHC Viewer",
      tag: `v${version}`,
      version,
      commit: "a".repeat(40),
      assets,
    },
    files,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fetchJsonWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      host: "127.0.0.1",
      port,
      path: "/latest.json",
      headers: { host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}

test("mirrors signed installers locally and retains the last good release after tampering", async () => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "dohc-update-mirror-test-"));
  const signer = createSigner();
  let currentRelease;
  let tamperedFile = null;
  let latestRouteMissing = false;
  let fallbackRequests = 0;
  let upstreamBase;
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, upstreamBase);
    let body;
    if (url.pathname === "/api/releases/latest") {
      fallbackRequests += 1;
      body = Buffer.from(JSON.stringify({ tag_name: `v${currentRelease.latest.version}` }));
      response.setHeader("content-type", "application/json");
    } else if (url.pathname === "/latest.json" && latestRouteMissing) {
      response.writeHead(404).end();
      return;
    } else if (url.pathname === "/latest.json" || url.pathname.endsWith("/latest.json")) {
      body = Buffer.from(JSON.stringify(currentRelease.latest));
      response.setHeader("content-type", "application/json");
    } else if (url.pathname.endsWith("/release-manifest.json")) {
      body = Buffer.from(JSON.stringify(currentRelease.releaseManifest));
      response.setHeader("content-type", "application/json");
    } else {
      let fileName;
      try {
        fileName = decodeURIComponent(url.pathname.split("/").at(-1));
      } catch {
        response.writeHead(400).end();
        return;
      }
      body = currentRelease.files.get(fileName);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      if (fileName === tamperedFile) {
        body = Buffer.from(body);
        body[0] ^= 0xff;
      }
      response.setHeader("content-type", "application/octet-stream");
    }
    response.setHeader("content-length", body.length);
    response.writeHead(200).end(body);
  });

  let mirror;
  try {
    const upstreamPort = await listen(upstream);
    upstreamBase = `http://127.0.0.1:${upstreamPort}`;
    currentRelease = createRelease("1.2.3", signer, upstreamBase);
    const loggedErrors = [];
    mirror = createUpdateMirror({
      schemaVersion: 1,
      listenHost: "127.0.0.1",
      listenPort: 0,
      publicBaseUrl: "http://127.0.0.1:0",
      fallbackBaseUrls: ["http://localhost:0"],
      upstreamManifestUrl: `${upstreamBase}/latest.json`,
      upstreamReleaseApiUrl: `${upstreamBase}/api/releases/latest`,
      upstreamAssetOrigin: upstreamBase,
      upstreamAssetPathPrefix: "/repo/releases/download/",
      refreshIntervalSeconds: 3600,
      retainedVersions: 2,
      updaterPublicKey: signer.wrappedPublicKey,
      cacheRoot,
      allowTestUpstream: true,
    }, {
      logger: { error: (message) => loggedErrors.push(message) },
    });
    const { address, publicBaseUrl, fallbackBaseUrls } = await mirror.start();
    await mirror.sync();

    const health = await fetch(`${publicBaseUrl}/healthz`).then((response) => response.json());
    assert.equal(health.status, "ready");
    assert.equal(health.version, "1.2.3");

    const latest = await fetch(`${publicBaseUrl}/latest.json`).then((response) => response.json());
    assert.equal(latest.version, "1.2.3");
    assert.deepEqual(Object.keys(latest.platforms).sort(), TARGETS.map(({ target }) => target).sort());
    for (const definition of TARGETS) {
      const entry = latest.platforms[definition.target];
      assert.match(entry.url, new RegExp(`^${publicBaseUrl}/releases/v1\\.2\\.3/`));
      const bytes = Buffer.from(await fetch(entry.url).then((response) => response.arrayBuffer()));
      assert.equal(sha256(bytes), entry.sha256);
    }
    const rangedEntry = latest.platforms[TARGETS[0].target];
    const rangedResponse = await fetch(rangedEntry.url, {
      headers: { range: "bytes=0-31" },
    });
    assert.equal(rangedResponse.status, 206);
    assert.equal(rangedResponse.headers.get("accept-ranges"), "bytes");
    assert.equal(rangedResponse.headers.get("content-range"), "bytes 0-31/1048576");
    assert.equal((await rangedResponse.arrayBuffer()).byteLength, 32);
    const invalidRange = await fetch(rangedEntry.url, {
      headers: { range: "bytes=1048576-1048600" },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), "bytes */1048576");

    const fallback = await fetchJsonWithHost(address.port, `localhost:${address.port}`);
    assert.equal(fallback.status, 200);
    for (const entry of Object.values(fallback.body.platforms)) {
      assert.equal(new URL(entry.url).origin, fallbackBaseUrls[0]);
    }
    const untrustedHost = await fetchJsonWithHost(address.port, `untrusted.example:${address.port}`);
    for (const entry of Object.values(untrustedHost.body.platforms)) {
      assert.equal(new URL(entry.url).origin, publicBaseUrl);
    }

    const indexResponse = await fetch(`${publicBaseUrl}/`);
    const index = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.match(index, /Windows 10\/11 x64/);
    assert.match(index, /macOS 12\+ Apple Silicon/);
    assert.match(index, /Ubuntu 22\.04\+ x86_64 deb/);
    assert.equal((await fetch(`${publicBaseUrl}/releases/v1.2.3/%2e%2e`)).status, 404);
    assert.equal((await fetch(`${publicBaseUrl}/latest.json`, { method: "POST" })).status, 405);

    latestRouteMissing = true;
    currentRelease = createRelease("1.2.4", signer, upstreamBase, 10);
    await mirror.sync();
    assert.equal(mirror.state.current.version, "1.2.4");
    assert.equal(fallbackRequests, 1);

    latestRouteMissing = false;
    currentRelease = createRelease("1.2.5", signer, upstreamBase, 20);
    tamperedFile = TARGETS[0].updaterName("1.2.5");
    await assert.rejects(mirror.sync(), /SHA-256 mismatch/);
    assert.equal(mirror.state.status, "degraded");
    assert.equal(mirror.state.current.version, "1.2.4");
    const retained = await fetch(`${publicBaseUrl}/latest.json`).then((response) => response.json());
    assert.equal(retained.version, "1.2.4");
    assert.ok(loggedErrors.some((message) => message.includes("SHA-256 mismatch")));

    tamperedFile = null;
    await mirror.sync();
    const previousUpdater = mirror.state.current.latest.platforms[TARGETS[0].target].url;
    assert.equal(mirror.state.current.version, "1.2.5");
    currentRelease = createRelease("1.2.6", signer, upstreamBase, 30);
    await mirror.sync();
    assert.equal(mirror.state.current.version, "1.2.6");
    assert.equal((await fetch(previousUpdater)).status, 200);
    assert.equal(
      (await fetch(`${publicBaseUrl}/releases/v1.2.4/${TARGETS[0].updaterName("1.2.4")}`)).status,
      404,
    );

    const cachedUpdater = path.join(
      cacheRoot,
      "versions",
      "v1.2.6",
      TARGETS[0].updaterName("1.2.6"),
    );
    const originalBytes = await readFile(cachedUpdater);
    const damagedBytes = Buffer.from(originalBytes);
    damagedBytes[0] ^= 0xff;
    await writeFile(cachedUpdater, damagedBytes);
    await mirror.sync();
    assert.equal(mirror.state.current.version, "1.2.6");
    assert.equal(
      sha256(Buffer.from(await fetch(mirror.state.current.latest.platforms[TARGETS[0].target].url)
        .then((response) => response.arrayBuffer()))),
      currentRelease.latest.platforms[TARGETS[0].target].sha256,
    );
  } finally {
    await mirror?.stop().catch(() => {});
    await close(upstream).catch(() => {});
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
