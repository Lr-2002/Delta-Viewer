// Existing Manager sessions authorize every request. Only the server owns the bridge key.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { request as httpsRequest, Agent } from "node:https";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const problem = (status, code) => Object.assign(new Error(code), { status });
const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const READ = /^\/api\/review\/v1\/(?:identity|tasks|admin\/(?:batches|policy)|jobs\/[a-f0-9]{32}\/recordings\/[a-f0-9]{32})$/;
const WRITE = /^\/api\/review\/v1\/(?:admin\/(?:policy|batches\/backfill)|(?:admin\/)?jobs\/[a-f0-9]{32}\/plans\/[a-f0-9]{32}\/(?:claim|full-review)|jobs\/[a-f0-9]{32}\/recordings\/[a-f0-9]{32}\/(?:files|decision|revoke))$/;

async function privateFile(file, secret = true) {
  if (!path.isAbsolute(file)) throw problem(503, "CLOUD_QC_BRIDGE_CONFIGURATION_INVALID");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024
    || secret && process.platform !== "win32" && (info.mode & 0o027) !== 0) throw problem(503, "CLOUD_QC_BRIDGE_CONFIGURATION_INVALID");
  return readFile(file);
}

export async function createCloudQcBridge(config, serviceId, clock = Date.now) {
  if (!config) return null;
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.origin !== config.origin || origin.username || origin.password
    || !Array.isArray(config.downloadHosts) || !config.downloadHosts.length
    || config.downloadHosts.some(host => typeof host !== "string" || !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw problem(503, "CLOUD_QC_BRIDGE_CONFIGURATION_INVALID");
  }
  const key = (await privateFile(config.keyFile)).toString("utf8").trim();
  if (Buffer.byteLength(key) < 32) throw problem(503, "CLOUD_QC_BRIDGE_CONFIGURATION_INVALID");
  const agent = new Agent({ ca: await privateFile(config.certificateFile, false), keepAlive: true, maxSockets: 8 });
  let active = 0;
  return {
    metadata: { origin: config.origin, download_hosts: config.downloadHosts },
    close() { agent.destroy(); },
    async request(user, input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join(",") !== "path,payload,tenant"
        || typeof input.path !== "string" || typeof input.tenant !== "string" || !NAME.test(input.tenant)
        || !(input.payload === null ? READ : WRITE).test(input.path)
        || input.payload !== null && (typeof input.payload !== "object" || Array.isArray(input.payload))) {
        throw problem(422, "CLOUD_QC_REQUEST_INVALID");
      }
      const admin = user.canManage === true;
      if (input.path.includes("/admin/") && !admin) throw problem(403, "QC_ADMIN_REQUIRED");
      const body = input.payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input.payload));
      if (body.length > MAX_BYTES) throw problem(413, "CLOUD_QC_REQUEST_TOO_LARGE");
      if (active >= 8) throw problem(503, "CLOUD_QC_BRIDGE_BUSY");
      const method = input.payload === null ? "GET" : "POST";
      const target = `${input.path}?tenant=${encodeURIComponent(input.tenant)}`;
      const now = Math.floor(clock() / 1000);
      const assertion = Buffer.from(JSON.stringify({ v: 1, iss: serviceId,
        sub: user.username, name: user.displayName, role: admin ? "admin" : "reviewer",
        method, path: target, body_sha256: createHash("sha256").update(body).digest("hex"),
        iat: now, exp: now + 25, nonce: randomUUID(),
      })).toString("base64url");
      const signature = createHmac("sha256", key).update(assertion, "ascii").digest("hex");
      active++;
      try {
        return await new Promise((resolve, reject) => {
          const request = httpsRequest(new URL(target, origin), { method, agent,
            headers: { "X-Manager-Assertion": assertion, "X-Manager-Signature": signature,
              ...(body.length ? { "content-type": "application/json", "content-length": body.length } : {}) },
          }, response => {
            const chunks = []; let size = 0;
            response.on("data", chunk => {
              size += chunk.length;
              if (size > MAX_BYTES) request.destroy(problem(502, "CLOUD_QC_RESPONSE_TOO_LARGE"));
              else chunks.push(chunk);
            });
            response.on("error", () => reject(problem(502, "CLOUD_QC_NETWORK_UNAVAILABLE")));
            response.on("end", () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                // Never follow redirects or relay upstream headers / signed URLs in diagnostics.
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                  const code = value?.error?.code;
                  reject(problem(response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502,
                    typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "CLOUD_QC_REQUEST_FAILED"));
                } else resolve(value);
              } catch { reject(problem(502, "CLOUD_QC_RESPONSE_INVALID")); }
            });
          });
          request.setTimeout(20_000, () => request.destroy(problem(504, "CLOUD_QC_NETWORK_UNAVAILABLE")));
          request.on("error", () => reject(problem(502, "CLOUD_QC_NETWORK_UNAVAILABLE")));
          request.end(body);
        });
      } finally { active--; }
    },
  };
}
