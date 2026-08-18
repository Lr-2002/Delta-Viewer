import assert from "node:assert/strict";
import test from "node:test";
import { clampPlaybackFrame, nextPlaybackFrame, playbackFrameDurationMs, playbackStartFrame } from "../src/lib/playback-clock.ts";

test("advances after every stream settles the current frame", () => {
  assert.equal(nextPlaybackFrame(27, 152, true), 28);
});

test("holds the synchronized frame while any image is still loading", () => {
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
