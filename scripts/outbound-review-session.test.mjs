import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserCenter, initializeUserCenter } from './user-center-server.mjs';

function call(port, ca, route, body, token) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = httpsRequest({ hostname: 'localhost', port, path: route, method: 'POST', ca,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }); });
    });
    request.on('error', reject); request.end(bytes);
  });
}

test('outbound review relay binds Manager identity and payload to one platform route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-outbound-session-'));
  const config = { schemaVersion: 1, listenHost: '::', listenPort: 17978,
    publicBaseUrl: 'https://10.1.11.200:17978', sessionTtlSeconds: 300 };
  const key = 'outbound-review-test-secret-'.repeat(3);
  let center, upstream;
  const claims = [];
  try {
    await initializeUserCenter(config, root);
    const ca = await readFile(path.join(root, 'tls/ca.crt'));
    const keyFile = path.join(root, 'outbound.key'); await writeFile(keyFile, key, { mode: 0o600 });
    upstream = createServer({ key: await readFile(path.join(root, 'tls/server.key')),
      cert: await readFile(path.join(root, 'tls/server.crt')) }, async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(request.url, '/api/platform/manager-outbound');
      assert.equal(request.headers.authorization, undefined);
      const encoded = request.headers['x-manager-assertion'];
      assert.equal(request.headers['x-manager-signature'], createHmac('sha256', key).update(encoded, 'ascii').digest('hex'));
      const claim = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      assert.equal(claim.path, request.url);
      assert.equal(claim.body_sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(!claims.some(row => row.nonce === claim.nonce));
      claims.push(claim);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ batches: [], actor: claim.sub }));
    });
    await new Promise(resolve => upstream.listen(0, resolve));
    center = await createUserCenter({ ...config, outboundReview: { origin: `https://localhost:${upstream.address().port}`,
      keyFile, certificateFile: path.join(root, 'tls/ca.crt') } }, root, { log() {}, error() {} });
    await center.start();
    const request = (route, body, token) => call(config.listenPort, ca, route, body, token);
    await request('/api/v1/setup', { username: 'bridge-admin', displayName: '管理员', password: 'isolated-password' });
    const admin = (await request('/api/v1/auth/login', { username: 'bridge-admin', password: 'isolated-password' })).body.token;
    const alice = (await request('/api/v1/auth/register', { username: 'bridge-alice', displayName: '审核员', password: 'isolated-password' })).body.token;
    const route = '/api/v1/outbound-review/proxy';
    assert.equal((await request(route, { action: 'list' })).status, 401);
    assert.equal((await request(route, { action: 'list' }, alice)).body.actor, 'bridge-alice');
    assert.equal((await request(route, { action: 'list' }, admin)).body.actor, 'bridge-admin');
    assert.equal(claims[0].role, 'reviewer');
    assert.equal(claims[1].role, 'admin');
    assert.equal((await request('/api/v1/auth/logout', {}, alice)).status, 204);
    assert.equal((await request(route, { action: 'list' }, alice)).status, 401);
    assert.equal(claims.length, 2);
  } finally {
    await center?.stop();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
