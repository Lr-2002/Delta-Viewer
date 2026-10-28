import assert from 'node:assert/strict';
import test from 'node:test';
import { PreviewPriority } from '../src/lib/preview-priority.ts';
test('only the selected recording and all expected cameras release the initial IO priority', async () => {
  const priority = new PreviewPriority('new', ['cam0', 'cam1'], 500);
  let done = false; void priority.ready.then(() => { done = true; });
  priority.presented('old', 'cam0'); priority.presented('old', 'cam1');
  priority.presented('new', 'cam0'); await Promise.resolve(); assert.equal(done, false);
  priority.presented('new', 'cam1'); await priority.ready; assert.equal(done, true);
});
test('a missing camera cannot prevent complete validation and cancellation releases the wait', async () => {
  const timeout = new PreviewPriority('root', ['missing'], 10);
  await timeout.ready;
  const cancelled = new PreviewPriority('root', ['cam0'], 10000);
  cancelled.close(); await cancelled.ready;
});
