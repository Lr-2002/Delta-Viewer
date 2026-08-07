import assert from "node:assert/strict";
import test from "node:test";
import { nextPlaybackFrame } from "../src/lib/playback-clock.ts";

test("advances after every stream settles the current frame", () => {
  assert.equal(nextPlaybackFrame(27, 152, true), 28);
});

test("holds the synchronized frame while any image is still loading", () => {
  assert.equal(nextPlaybackFrame(27, 152, false), 27);
});

test("stops at the playback end", () => {
  assert.equal(nextPlaybackFrame(152, 152, true), 152);
});
