import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_CACHE_MAX_ENTRIES,
  FRAME_CACHE_MAX_PER_STREAM,
  FRAME_MAX_IN_FLIGHT_PER_STREAM,
  FRAME_MAX_PENDING_PER_STREAM,
  FRAME_READ_AHEAD_FRAMES,
  FrameCache,
} from "../src/lib/frame-cache.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function flushScheduler() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("coalesces matching current reads and keeps decoded entries per stream", async () => {
  let reads = 0;
  const cache = new FrameCache(async ({ stream, frameId }) => {
    reads += 1;
    return `${stream}-${frameId}`;
  });
  const request = { root: "/episode", stream: "cam0", frameId: 0 };

  const [first, second] = await Promise.all([cache.requestCurrent(request), cache.requestCurrent(request)]);
  assert.equal(reads, 1);
  assert.equal(first.source, "cam0-0");
  assert.equal(second.source, "cam0-0");

  for (let frameId = 1; frameId <= FRAME_CACHE_MAX_PER_STREAM; frameId += 1) {
    await cache.requestCurrent({ ...request, frameId });
  }
  await cache.requestCurrent(request);

  assert.equal(reads, FRAME_CACHE_MAX_PER_STREAM + 2);
  assert.equal(cache.cachedFrameCount, FRAME_CACHE_MAX_PER_STREAM);
});

test("bounds delayed playback and promotes the latest rapid seek", async () => {
  const loads = [];
  const cache = new FrameCache((request) => {
    const next = deferred();
    loads.push({ next, request });
    return next.promise;
  });
  const root = "/episode";
  const streams = ["cam0", "cam1", "cam2", "t265_left", "t265_right"];
  const first = new Map();
  const latest = new Map();
  for (const stream of streams) {
    first.set(stream, cache.requestCurrent({ root, stream, frameId: 0 }));
    cache.scheduleReadAhead({ root, stream, frameId: 0, endFrame: 195 });
  }
  await flushScheduler();

  assert.deepEqual(loads.map(({ request }) => request.frameId), [0, 0, 0, 0, 0]);
  for (const stream of streams) {
    assert.equal(cache.pendingWorkCountForStream(root, stream), 1 + FRAME_READ_AHEAD_FRAMES);
  }

  for (let frameId = 1; frameId <= 195; frameId += 1) {
    for (const stream of streams) {
      const target = cache.requestCurrent({ root, stream, frameId });
      latest.set(stream, target);
      void target.catch(() => undefined);
      cache.scheduleReadAhead({ root, stream, frameId, endFrame: 195 });
      assert.ok(cache.pendingWorkCountForStream(root, stream) <= FRAME_MAX_PENDING_PER_STREAM);
    }
    assert.ok(cache.pendingWorkCount <= streams.length * FRAME_MAX_PENDING_PER_STREAM);
  }

  assert.equal(FRAME_MAX_IN_FLIGHT_PER_STREAM, 1);
  assert.equal(cache.pendingWorkCount, streams.length * 2);
  for (const load of loads.filter(({ request }) => request.frameId === 0)) {
    load.next.resolve(`${load.request.stream}-0`);
  }
  await Promise.all(first.values());
  await flushScheduler();
  assert.equal(loads.filter(({ request }) => request.frameId === 195).length, streams.length);
  assert.ok(loads.every(({ request }) => request.frameId === 0 || request.frameId === 195));

  for (const load of loads.filter(({ request }) => request.frameId === 195)) {
    load.next.resolve(`${load.request.stream}-195`);
  }
  const frames = await Promise.all(latest.values());
  assert.ok(frames.every((frame) => frame.frameId === 195));
  for (const stream of streams) {
    assert.equal(cache.pendingWorkCountForStream(root, stream), 0);
  }
});

test("drops queued read-ahead when playback pauses", async () => {
  const loads = [];
  const cache = new FrameCache((request) => {
    const next = deferred();
    loads.push({ next, request });
    return next.promise;
  });
  const root = "/episode";
  const stream = "cam0";
  const current = cache.requestCurrent({ root, stream, frameId: 0 });
  cache.scheduleReadAhead({ root, stream, frameId: 0, endFrame: 8 });
  await flushScheduler();
  assert.equal(cache.pendingWorkCountForStream(root, stream), 1 + FRAME_READ_AHEAD_FRAMES);

  cache.discardReadAhead(root, stream);
  assert.equal(cache.pendingWorkCountForStream(root, stream), 1);
  loads[0].next.resolve("cam0-0");
  await current;
  await flushScheduler();
  assert.deepEqual(loads.map(({ request }) => request.frameId), [0]);
});

test("drops queued read-ahead when a cached frame becomes current", async () => {
  const loads = [];
  const cache = new FrameCache((request) => {
    if (request.frameId === 3) return Promise.resolve("cam0-3");
    const next = deferred();
    loads.push({ next, request });
    return next.promise;
  });
  const root = "/episode";
  const stream = "cam0";
  await cache.requestCurrent({ root, stream, frameId: 3 });

  const current = cache.requestCurrent({ root, stream, frameId: 0 });
  cache.scheduleReadAhead({ root, stream, frameId: 0, endFrame: 2 });
  await flushScheduler();
  assert.equal(cache.pendingWorkCountForStream(root, stream), 1 + FRAME_READ_AHEAD_FRAMES);

  await cache.requestCurrent({ root, stream, frameId: 3 });
  assert.equal(cache.pendingWorkCountForStream(root, stream), 1);
  loads[0].next.resolve("cam0-0");
  await current;
  await flushScheduler();
  assert.deepEqual(loads.map(({ request }) => request.frameId), [0]);
});

test("never schedules read-ahead beyond the clip end", async () => {
  const loads = [];
  const cache = new FrameCache((request) => {
    const next = deferred();
    loads.push({ next, request });
    return next.promise;
  });
  const request = { root: "/episode", stream: "cam0", frameId: 10 };
  const current = cache.requestCurrent(request);
  cache.scheduleReadAhead({ ...request, endFrame: 11 });
  await flushScheduler();
  assert.equal(cache.pendingWorkCountForStream(request.root, request.stream), 2);

  loads[0].next.resolve("cam0-10");
  await current;
  await flushScheduler();
  assert.deepEqual(loads.map(({ request: loaded }) => loaded.frameId), [10, 11]);
  loads[1].next.resolve("cam0-11");
  await flushScheduler();
  assert.equal(cache.pendingWorkCountForStream(request.root, request.stream), 0);
});

test("enforces the global decoded-frame cache cap", async () => {
  let reads = 0;
  const cache = new FrameCache(async ({ root, frameId }) => {
    reads += 1;
    return `${root}-${frameId}`;
  });

  for (let frameId = 0; frameId <= FRAME_CACHE_MAX_ENTRIES; frameId += 1) {
    await cache.requestCurrent({ root: `/episode-${frameId}`, stream: "cam0", frameId });
  }
  await cache.requestCurrent({ root: "/episode-0", stream: "cam0", frameId: 0 });

  assert.equal(cache.cachedFrameCount, FRAME_CACHE_MAX_ENTRIES);
  assert.equal(reads, FRAME_CACHE_MAX_ENTRIES + 2);
});
