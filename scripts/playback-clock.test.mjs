import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPlaybackFrame,
  nextFrameRenderProgress,
  nextPlaybackFrame,
  playbackAdvanceTimestamp,
  playbackBufferRatio,
  playbackBufferRequirement,
  playbackFrameDue,
  playbackFrameDurationMs,
  primaryPlaybackFrameStep,
  playbackStartFrame,
  secondaryPlaybackFrame,
  sequentialFallbackFrame,
  sourceAlignedTimelineFrame,
} from "../src/lib/playback-clock.ts";

test("ignores duplicate native-video settlement reports", () => {
  const current = { root: "/episode", frameId: 27, settled: 3, total: 3 };
  assert.equal(nextFrameRenderProgress(current, { ...current }), current);
  assert.notEqual(nextFrameRenderProgress(current, { ...current, frameId: 28 }), current);
});

test("keeps every timeline frame in MP4 compatibility fallback", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(sequentialFallbackFrame),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(sequentialFallbackFrame(61), 61);
});

test("aligns lower-FPS camera frames without changing real-time playback", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((frameId) => sourceAlignedTimelineFrame(frameId, 0, 60, 30)),
    [0, 0, 2, 2, 4, 4, 6],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((frameId) => sourceAlignedTimelineFrame(frameId, 0, 60, 15)),
    [0, 0, 0, 0, 4, 4],
  );
  assert.equal(sourceAlignedTimelineFrame(61, 60, 60, 30), 60);
  assert.equal(sourceAlignedTimelineFrame(61, 60, 60, 60), 61);
  assert.equal(primaryPlaybackFrameStep(60, 30), 2);
  assert.equal(primaryPlaybackFrameStep(60, 15), 4);
  assert.equal(primaryPlaybackFrameStep(30, 30), 1);
  assert.equal(nextPlaybackFrame(20, 99, true, 2), 22);
  assert.equal(nextPlaybackFrame(98, 99, true, 2), 99);
});

test("throttles secondary playback previews while preserving exact paused frames", () => {
  assert.deepEqual(
    [500, 502, 504, 506, 508, 510, 512].map((frameId) => (
      secondaryPlaybackFrame(frameId, 500, 60, 10)
    )),
    [500, 500, 500, 506, 506, 506, 512],
  );
  assert.equal(secondaryPlaybackFrame(509, 500, 60, 60), 509);
});

test("advances when the next frame deadline is due", () => {
  assert.equal(nextPlaybackFrame(27, 152, true), 28);
});

test("holds the frame before its playback deadline", () => {
  assert.equal(nextPlaybackFrame(27, 152, false), 27);
});

test("stops at the playback end", () => {
  assert.equal(nextPlaybackFrame(152, 152, true), 152);
});

test("uses the selected speed as the sequential frame duration", () => {
  assert.equal(playbackFrameDurationMs(30, 0.25), 1000 / 7.5);
  assert.equal(playbackFrameDurationMs(30, 2), 1000 / 60);
  assert.equal(nextPlaybackFrame(20, 99, true), 21);
});

test("tolerates display-refresh jitter at sixty frames per second", () => {
  const duration = playbackFrameDurationMs(60, 1);
  assert.equal(playbackFrameDue(16, duration), true);
  assert.equal(playbackFrameDue(14, duration), false);
});

test("drops catch-up bursts after the UI misses multiple frame deadlines", () => {
  assert.equal(playbackAdvanceTimestamp(34, 0, 33), 33);
  assert.equal(playbackAdvanceTimestamp(120, 0, 33), 120);
});

test("prebuffers each stream only through its own actual final frame", () => {
  assert.equal(playbackBufferRequirement(900, 1054, 1053, 180), 153);
  assert.equal(playbackBufferRequirement(900, 1054, 1051, 180), 151);
  assert.equal(playbackBufferRequirement(700, 1054, 1051, 180), 180);
  assert.equal(playbackBufferRequirement(1052, 1054, 1051, 180), 0);
  assert.equal(playbackBufferRatio(151, 151), 1);
  assert.equal(playbackBufferRatio(75, 150), 0.5);
  assert.equal(playbackBufferRatio(0, 0), 1);
});

test("starts from a synchronous middle seek even when rendered state is stale", () => {
  assert.equal(playbackStartFrame(73, 1, 99), 73);
});

test("restarts from the clip beginning only when the live frame reached the end", () => {
  assert.equal(playbackStartFrame(99, 1, 99), 1);
});

test("keeps a live middle position when background validation finishes", () => {
  assert.equal(clampPlaybackFrame(73, 1, 99), 73);
});

test("clamps a live preview position to a restored annotation range", () => {
  assert.equal(clampPlaybackFrame(12, 25, 75), 25);
  assert.equal(clampPlaybackFrame(90, 25, 75), 75);
});
