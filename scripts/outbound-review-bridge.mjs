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

export async function createOutboundReviewBridge(config, serviceId, clock = Date.now, { timeoutMs = 30_000 } = {}) {
  if (!config) return null;
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || origin.username || origin.password)
    throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  const key = (await privateFile(config.keyFile, true)).toString('utf8').trim();
  if (Buffer.byteLength(key) < 32) throw problem(503, 'OUTBOUND_CONFIG_INVALID');
  const agent = new Agent({ ca: await privateFile(config.certificateFile, false), keepAlive: true, maxSockets: 8 });
  let active = 0, mediaActive = 0, closed = false;
  const queue = [], running = new Set();
  function pump() {
    while (!closed && active < 8) {
      // Keep two slots available for task controls when camera requests are slow.
      const index = queue.findIndex(row => !row.media || mediaActive < 6);
      if (index < 0) return;
      const row = queue.splice(index, 1)[0];
      active++; if (row.media) mediaActive++;
      running.add(row); row.started = true; row.start();
    }
  }
  return {
    close() {
      closed = true;
      for (const row of [...queue, ...running]) row.finish(problem(503, 'OUTBOUND_NETWORK_UNAVAILABLE'));
      agent.destroy();
    },
    async request(user, input, { signal } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !['list', 'claim', 'release', 'decide', 'video-url', 'save-reason-option', 'trim', 'trim-status', 'trim-resume'].includes(input.action)) throw problem(422, 'OUTBOUND_REQUEST_INVALID');
      const body = Buffer.from(JSON.stringify(input));
      if (body.length > 16384) throw problem(422, 'OUTBOUND_REQUEST_INVALID');
      if (closed || signal?.aborted) throw problem(503, 'OUTBOUND_NETWORK_UNAVAILABLE');
      if (queue.length >= 64) throw problem(503, 'OUTBOUND_BRIDGE_BUSY');
      return new Promise((resolve, reject) => {
        let request, timer, done = false;
        const aborted = () => row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE'));
        const row = { media: input.action === 'video-url', started: false,
          finish(error, value) {
            if (done) return; done = true;
            clearTimeout(timer); signal?.removeEventListener('abort', aborted);
            const index = queue.indexOf(row); if (index >= 0) queue.splice(index, 1);
            if (row.started) { running.delete(row); active--; if (row.media) mediaActive--; }
            if (error) { request?.destroy(); reject(error); } else resolve(value);
            pump();
          },
          start() {
            // Assertions are created at dispatch, after bounded queueing.
            const now = Math.floor(clock() / 1000);
            const assertion = Buffer.from(JSON.stringify({ v: 1, iss: serviceId,
              sub: user.username, name: user.displayName, role: user.canManage ? 'admin' : 'reviewer',
              method: 'POST', path: target, body_sha256: createHash('sha256').update(body).digest('hex'),
              iat: now, exp: now + 25, nonce: randomUUID(),
            })).toString('base64url');
            const signature = createHmac('sha256', key).update(assertion, 'ascii').digest('hex');
            try {
                request = httpsRequest(new URL(target, origin), { method: 'POST', agent,
                  headers: { 'X-Manager-Assertion': assertion, 'X-Manager-Signature': signature,
                    'Content-Type': 'application/json', 'Content-Length': body.length },
                }, response => {
                  const chunks = []; let size = 0;
                  response.on('data', chunk => {
                    size += chunk.length;
                    if (size > 2 * 1024 * 1024) row.finish(problem(502, 'OUTBOUND_RESPONSE_TOO_LARGE'));
                    else chunks.push(chunk);
                  });
                  response.on('error', () => row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')));
                  response.on('aborted', () => row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')));
                  response.on('close', () => { if (!response.complete) row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')); });
                  response.on('end', () => {
                    try {
                      const successful = response.statusCode >= 200 && response.statusCode < 300;
                      let value;
                      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                      catch {
                        // A gateway outage commonly returns HTML. Preserve its
                        // HTTP failure instead of calling it a successful but
                        // malformed application response. Never expose its body.
                        if (successful) throw problem(502, 'OUTBOUND_RESPONSE_INVALID');
                      }
                      if (!successful) {
                        const code = value?.error?.code;
                        row.finish(problem(response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502,
                          typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code
                            : `OUTBOUND_HTTP_${response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502}`));
                      } else if (input.action === 'video-url') {
                        if (typeof value?.path !== 'string' || !/^\/api\/platform\/manager-outbound\/media\/[a-f0-9]{64}$/.test(value.path))
                          row.finish(problem(502, 'OUTBOUND_RESPONSE_INVALID'));
                        else row.finish(null, { url: new URL(value.path, origin).toString() });
                      } else row.finish(null, value);
                    } catch { row.finish(problem(502, 'OUTBOUND_RESPONSE_INVALID')); }
                  });
                });
                request.on('error', () => row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')));
                request.end(body);
            } catch { row.finish(problem(502, 'OUTBOUND_NETWORK_UNAVAILABLE')); }
          },
        };
        // Total wall time includes queueing, connection and a dripping response.
        timer = setTimeout(() => row.finish(problem(504, 'OUTBOUND_NETWORK_UNAVAILABLE')), timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        queue.push(row); pump();
      });
    },
  };
}
