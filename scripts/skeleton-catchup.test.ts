import assert from "node:assert/strict";
import test from "node:test";
import { skeletonCatchupFrame } from "../src/lib/skeleton-catchup.ts";

test("source-time mode stays exact and catchup never accumulates past its cap", () => {
  assert.equal(skeletonCatchupFrame(300, 0, 900, 30, 1), 300);
  assert.equal(skeletonCatchupFrame(60, 0, 900, 30, 1.1), 66);
  assert.equal(skeletonCatchupFrame(600, 0, 900, 30, 1.1), 624);
  assert.equal(skeletonCatchupFrame(800, 0, 900, 30, 1.1), 824);
});

test("pause/repeat/seek are deterministic; a segment restarts its own ramp", () => {
  assert.equal(skeletonCatchupFrame(450, 0, 900, 30, 1.1), 474);
  assert.equal(skeletonCatchupFrame(450, 0, 900, 30, 1.1), 474);
  assert.equal(skeletonCatchupFrame(60, 0, 900, 30, 1.1), 66);
  assert.equal(skeletonCatchupFrame(450, 450, 600, 30, 1.1), 450);
  assert.equal(skeletonCatchupFrame(480, 450, 600, 30, 1.1), 483);
  assert.equal(skeletonCatchupFrame(598, 450, 600, 30, 1.1), 600);
  assert.equal(skeletonCatchupFrame(300, 450, 600, 30, 1), 300);
  assert.equal(skeletonCatchupFrame(700, 450, 600, 30, 1), 700);
  assert.equal(skeletonCatchupFrame(300, 450, 600, 30, 1.1), 300);
});

test("the cap uses timeline units and refuses unsupported rates or invalid clocks", () => {
  assert.equal(skeletonCatchupFrame(600, 0, 1800, 60, 1.1), 648);
  assert.equal(skeletonCatchupFrame(600, 0, 1800, 30, 1.05), 624);
  assert.equal(skeletonCatchupFrame(600, 0, 1800, 30, 2), 600);
  assert.equal(skeletonCatchupFrame(600, 0, 1800, 0, 1.1), 600);
});
