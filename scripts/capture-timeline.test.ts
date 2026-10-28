import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFrameIndex, captureVideoPosition, captureTimelinePosition, capturePlaybackRate } from '../src/lib/capture-timeline.ts';
test('dropped captures and split boundaries use source indices instead of wall seconds', () => {
  const times = [0, 1, 2, 5, 6, 7];
  assert.equal(captureFrameIndex(times, 4), 2);
  assert.deepEqual(captureVideoPosition(times, 5, 1, 3), {segment: 1, seconds: 0.5});
  assert.equal(captureTimelinePosition(times, 0, 1, 1, 3), 5);
  assert.equal(captureTimelinePosition(times, 3, 0, 1, 3), 5);
  assert.equal(captureTimelinePosition(times, 1.5, 0, 1, 3), 1.5);
  assert.equal(captureTimelinePosition(times, 100, 1, 1, 3), 7);
});
test('compensates 29.735 fps capture on encoded 30 fps clock', () => {
  const times=Array.from({length:120000},(_,i)=>i*30/29.735);
  const target=100000;
  const mapped=captureVideoPosition(times,target,30,300);
  const actual=captureTimelinePosition(times,mapped.seconds-0.5/30,mapped.segment,30,300);
  assert.ok(target-actual>=-1e-6 && target-actual<1.1);
  assert.ok(Math.abs(capturePlaybackRate(times,2,30,300,30)-29.735/30)<1e-8);
});
