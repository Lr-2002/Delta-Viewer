import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INPUTS, downloadReviewed } from './download-reviewed-ffmpeg.mjs';

test('transient HTTP errors use the fixed official asset API and retain integrity checks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-reviewed-download-'));
  try {
    const urls = [];
    await assert.rejects(downloadReviewed(INPUTS[2], directory, async (url, options) => {
      urls.push(url);
      if (urls.length === 1) return new Response('gateway failure', { status: 504 });
      assert.equal(options.headers.Accept, 'application/octet-stream');
      assert.equal(options.headers.Authorization, undefined);
      return new Response('incorrect official bytes');
    }), /INTEGRITY_MISMATCH/);
    assert.equal(urls.length, 2);
    assert.equal(urls[1], 'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/316529965');
    assert.deepEqual(await readdir(directory), []);
    for (const status of [401, 403, 404]) {
      let calls = 0;
      await assert.rejects(downloadReviewed(INPUTS[2], directory, async () => {
        calls++; return new Response('denied', { status });
      }), new RegExp(`HTTP_${status}`));
      assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(downloadReviewed(INPUTS[2], directory, async () => {
      calls++; throw new Error('CERTIFICATE_ERROR');
    }), /CERTIFICATE_ERROR/);
    assert.equal(calls, 1);
    await assert.rejects(downloadReviewed(INPUTS[2], directory, async () => new Response('x'.repeat(39495))), /SIZE_MISMATCH/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(downloadReviewed({ ...INPUTS[2] }, directory), /UNREVIEWED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('successful pinned downloads preserve exact bytes', { skip: !process.env.FFMPEG_REVIEWED_NOTICE_FIXTURE }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-reviewed-download-'));
  try {
    const bytes = await readFile(process.env.FFMPEG_REVIEWED_NOTICE_FIXTURE);
    await downloadReviewed(INPUTS[2], directory, async () => new Response(bytes));
    assert.deepEqual(await readFile(path.join(directory, INPUTS[2].name)), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
