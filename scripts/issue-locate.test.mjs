import assert from "node:assert/strict";
import test from "node:test";
import { resolveIssueLocation } from "../src/lib/issue-locate.ts";

function createStream({
  name = "cam0",
  label = "Camera 0",
  firstFrame = 10,
  lastFrame = 20,
} = {}) {
  return {
    name,
    label,
    frameCount: firstFrame === null || lastFrame === null ? 0 : lastFrame - firstFrame + 1,
    firstFrame,
    lastFrame,
    missingFrames: [],
    missingFrameCount: 0,
    totalBytes: 0,
    width: null,
    height: null,
    channels: null,
  };
}

function createData({ states = [], streams = [createStream()] } = {}) {
  return {
    summary: {
      root: "/fixture/episode",
      name: "fixture",
      totalFiles: 0,
      totalBytes: 0,
      stateCount: states.length,
      startTimeNs: null,
      endTimeNs: null,
      streams,
    },
    states: states.map((frameId) => ({ frameId })),
  };
}

function createIssue({ scope, frameId }) {
  return {
    severity: "warning",
    code: "FIXTURE_ISSUE",
    scope,
    message: "fixture",
    frameId,
  };
}

test("locates a stream issue at its exact synchronized frame", () => {
  const location = resolveIssueLocation(
    createData({ states: [10, 12, 20] }),
    createIssue({ scope: "cam0", frameId: 12 }),
  );

  assert.deepEqual(location, { kind: "target", frameId: 12 });
});

test("reports a stream-only issue instead of snapping to a neighboring state", () => {
  const location = resolveIssueLocation(
    createData({ states: [10, 20] }),
    createIssue({ scope: "cam0", frameId: 15 }),
  );

  assert.equal(location.kind, "unavailable");
  assert.equal(location.code, "NO_SYNCHRONIZED_STATE");
  assert.match(location.message, /未跳转到相邻状态帧/);
});

test("keeps state-scoped issue behavior by clamping to the playback state bounds", () => {
  const location = resolveIssueLocation(
    createData({ states: [10, 20] }),
    createIssue({ scope: "states", frameId: 99 }),
  );

  assert.deepEqual(location, { kind: "target", frameId: 20 });
});

test("rejects a stream issue outside the affected stream bounds", () => {
  const location = resolveIssueLocation(
    createData({ states: [10, 20] }),
    createIssue({ scope: "cam0", frameId: 21 }),
  );

  assert.equal(location.kind, "unavailable");
  assert.equal(location.code, "STREAM_FRAME_OUT_OF_BOUNDS");
  assert.match(location.message, /10–20/);
});

test("reports an empty stream-bound fixture without choosing a state frame", () => {
  const location = resolveIssueLocation(
    createData({ streams: [createStream({ firstFrame: null, lastFrame: null })] }),
    createIssue({ scope: "cam0", frameId: 10 }),
  );

  assert.equal(location.kind, "unavailable");
  assert.equal(location.code, "STREAM_BOUNDS_UNAVAILABLE");
});
