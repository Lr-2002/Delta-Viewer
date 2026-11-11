import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request as httpsRequest, Agent } from 'node:https';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const problem = (status, code) => Object.assign(new Error(code), { status });
const target = '/api/platform/manager-outbound';

async function privateFile(file, secret) {
  if (!path.isAbsolute(file)) throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024
    || secret && process.platform !== 'win32' && (info.mode & 0o077)) throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  return readFile(file);
}

export async function createOutboundReviewBridge(config, serviceId, clock = Date.now) {
  if (!config) return null;
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || origin.username || origin.password)
    throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  const key = (await privateFile(config.keyFile, true)).toString('utf8').trim();
  if (Buffer.byteLength(key) < 32) throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  const agent = new Agent({ ca: await privateFile(config.certificateFile, false), keepAlive: true, maxSockets: 8 });
  let active = 0;
  return {
    close() { agent.destroy(); },
    async request(user, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !['list', 'claim', 'release', 'decide', 'video-url', 'save-reason-option'].includes(input.action)) throw problem(422, 'OUTBOUND_REQUEST_INVALID');
      const body = Buffer.from(JSON.stringify(input));
      if (body.length > 4096 || active >= 8) throw problem(503, 'OUTBOUND_BRIDGE_BUSY');
      const now = Math.floor(clock() / 1000);
      const assertion = Buffer.from(JSON.stringify({ v: 1, iss: serviceId,
        sub: user.username, name: user.displayName, role: user.canManage ? 'admin' : 'reviewer',
        method: 'POST', path: target, body_sha256: createHash('sha256').update(body).digest('hex'),
        iat: now, exp: now + 25, nonce: randomUUID(),
      })).toString('base64url');
      const signature = createHmac('sha256', key).update(assertion, 'ascii').digest('hex');
      active++;
      try {
        return await new Promise((resolve, reject) => {
          const request = httpsRequest(new URL(target, origin), { method: 'POST', agent,
            headers: { 'X-Manager-Assertion': assertion, 'X-Manager-Signature': signature,
              'Content-Type': 'application/json', 'Content-Length': body.length },
          }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) request.destroy(problem(502, 'OUTBOUND_RESPONSE_TOO_LARGE'));
              else chunks.push(chunk);
            });
            response.on('error', () => reject(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')));
            response.on('end', () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                  const code = value?.error?.code;
                  reject(problem(response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502,
                    typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'OUTBOUND_REQUEST_FAILED'));
                } else if (input.action === 'video-url') {
                  if (typeof value?.path !== 'string' || !/^\/api\/platform\/manager-outbound\/media\/[a-f0-9]{64}$/.test(value.path))
                    reject(problem(502, 'OUTBOUND_RESPONSE_INVALID'));
                  else resolve({ url: new URL(value.path, origin).toString() });
                } else resolve(value);
              } catch { reject(problem(502, 'OUTBOUND_RESPONSE_INVALID')); }
            });
          });
          request.setTimeout(30_000, () => request.destroy(problem(504, 'OUTBOUND_NETWORK_UNAVAILABLE')));
          request.on('error', () => reject(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')));
          request.end(body);
        });
      } finally { active--; }
    },
  };
}
