import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_CACHE_MAX_ENTRIES,
  FRAME_CACHE_MAX_PER_STREAM,
  FRAME_READ_AHEAD_FRAMES,
  FrameCache,
} from "../src/lib/frame-cache.ts";

test("coalesces matching frame reads and keeps recent entries per stream", async () => {
  let reads = 0;
  const cache = new FrameCache(async ({ stream, frameId }) => {
    reads += 1;
    return `${stream}-${frameId}`;
  });
  const request = { root: "/episode", stream: "cam0", frameId: 0 };

  const [first, second] = await Promise.all([cache.request(request), cache.request(request)]);
  assert.equal(reads, 1);
  assert.equal(first.source, "cam0-0");
  assert.equal(second.source, "cam0-0");

  for (let frameId = 1; frameId <= FRAME_CACHE_MAX_PER_STREAM; frameId += 1) {
    await cache.request({ ...request, frameId });
  }
  await cache.request(request);

  assert.equal(reads, FRAME_CACHE_MAX_PER_STREAM + 2);
  assert.equal(cache.cachedFrameCount, FRAME_CACHE_MAX_PER_STREAM);
});

test("enforces a global decoded-frame cache cap and documents read-ahead", async () => {
  let reads = 0;
  const cache = new FrameCache(async ({ root, frameId }) => {
    reads += 1;
    return `${root}-${frameId}`;
  });

  for (let frameId = 0; frameId <= FRAME_CACHE_MAX_ENTRIES; frameId += 1) {
    await cache.request({ root: `/episode-${frameId}`, stream: "cam0", frameId });
  }
  await cache.request({ root: "/episode-0", stream: "cam0", frameId: 0 });

  assert.equal(cache.cachedFrameCount, FRAME_CACHE_MAX_ENTRIES);
  assert.equal(reads, FRAME_CACHE_MAX_ENTRIES + 2);
  assert.equal(FRAME_READ_AHEAD_FRAMES, 2);
});
