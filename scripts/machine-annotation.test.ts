import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverReviewSegments, reviewVideoIntersection, addReviewSegment, splitReviewSegment, deleteReviewSegment, restoreReviewSegments, adjustReviewBoundary, machineSegmentRange, machineTimelineMapping } from "../src/lib/machine-annotation.ts";
import type { ReviewSegment } from "../src/types.ts";

test("explicit video intersection preserves original records and never rescales valid frames", () => {
  const original: ReviewSegment[] = [[0,9],[10,19],[20,29]].map(([startFrame,endFrame],sourceIndex) => ({ sourceIndex,startFrame,endFrame,description:`原动作 ${sourceIndex}`,deleted:false,decision:"approved" }));
  const snapshot = structuredClone(original);
  const repair = reviewVideoIntersection(original, 15)!;
  assert.deepEqual(original, snapshot, "proposing or cancelling cannot mutate raw records");
  assert.equal(repair.trimmed, 1);
  assert.equal(repair.excluded, 1);
  assert.deepEqual(repair.affected, snapshot.slice(1));
  assert.deepEqual(repair.segments.map(s => [s.startFrame,s.endFrame,s.deleted]), [[0,9,false],[10,14,false],[20,29,true]]);
  assert.equal(repair.segments[0], original[0]);
  assert.equal(repair.segments[1].decision, "pending");
  assert.equal(repair.segments[2].description, original[2].description);
  assert.deepEqual(recoverReviewSegments(repair.segments,15,30).segments, repair.segments);
  assert.equal(recoverReviewSegments(original,15,30).segments, null, "active overflow cannot be submitted as playable");
  assert.equal(recoverReviewSegments([{...repair.segments[2],endFrame:30}],15,30).segments, null);
  for (const invalid of [0,-1,NaN,Infinity,1.5]) assert.equal(reviewVideoIntersection(original,invalid),null);
  assert.deepEqual(reviewVideoIntersection(repair.segments,15)?.affected, []);
});

test("the first human segment covers the full video even when playback is in the middle", () => {
  const rows = addReviewSegment([], 578, 1065);
  assert.deepEqual(rows.map((row) => [row.startFrame, row.endFrame]), [[0, 1064]]);
  assert.deepEqual(splitReviewSegment(rows, 0, 578).map((row) => [row.startFrame, row.endFrame]), [[0, 577], [578, 1064]]);
  assert.deepEqual(addReviewSegment([], 0, 0), []);
});

test("deletion aligns actual frames, preserves the following end, and restores coverage", () => {
  const original: ReviewSegment[] = [[0,99],[100,199],[200,299]].map(([startFrame,endFrame], sourceIndex) => ({startFrame,endFrame,sourceIndex,description:`action ${sourceIndex}`,deleted:false,decision:"approved"}));
  const deleted = deleteReviewSegment(original, 1);
  assert.deepEqual(deleted.filter((item) => !item.deleted).map((item) => [item.startFrame,item.endFrame]), [[0,99],[100,299]]);
  assert.equal(deleted[2].decision, "pending");
  assert.deepEqual(restoreReviewSegments(deleted).map((item) => [item.startFrame,item.endFrame,item.deleted]), original.map((item) => [item.startFrame,item.endFrame,item.deleted]));
  assert.equal(deleteReviewSegment(original, 0)[1].startFrame, 0);
  assert.equal(deleteReviewSegment(original, 2)[1].endFrame, 199);
  const twice = deleteReviewSegment(deleted, 0);
  assert.equal(twice[2].startFrame, 0);
  assert.deepEqual(restoreReviewSegments(twice).map((item) => [item.startFrame,item.endFrame]), original.map((item) => [item.startFrame,item.endFrame]));
  assert.equal(deleteReviewSegment(deleted, 1), deleted);
});

test("boundaries span the whole video and preserve covered rows as recoverable history", () => {
  const segments: ReviewSegment[] = [[0,44],[45,112],[113,194],[210,220]].map(([startFrame,endFrame], sourceIndex) => ({ startFrame,endFrame,sourceIndex,description:"",deleted:false,decision:"approved" }));
  const moved = adjustReviewBoundary(segments, 1, "startFrame", 48, 221);
  assert.equal(moved[0].endFrame, 47);
  assert.equal(moved[1].startFrame, 48);
  assert.equal(moved[0].decision, "pending");
  assert.equal(moved[2].decision, "approved");
  const limited = adjustReviewBoundary(segments, 1, "startFrame", 0, 221);
  assert.equal(limited[0].deleted, true);
  assert.equal(limited[0].endFrame, 44);
  assert.equal(limited[1].startFrame, 0);
  const end = adjustReviewBoundary(segments, 1, "endFrame", 220, 221);
  assert.equal(end[1].endFrame, 220);
  assert.equal(end[2].deleted, true);
  assert.equal(end[3].deleted, true);
  const restored = restoreReviewSegments(end).filter(s => !s.deleted).sort((a,b) => a.startFrame-b.startFrame);
  for (let i=1;i<restored.length;i++) assert.ok(restored[i-1].endFrame < restored[i].startFrame, "restoring crossed rows cannot produce overlaps");
  const gap = adjustReviewBoundary(segments, 3, "startFrame", 209, 221);
  assert.equal(gap[2].endFrame, 194);
  assert.equal(gap[3].startFrame, 209);
  const acrossGap = adjustReviewBoundary(segments, 3, "startFrame", 150, 221);
  assert.equal(acrossGap[3].startFrame, 150);
  assert.equal(acrossGap[2].endFrame, 149);
  const afterDeletion = segments.map((item) => item.sourceIndex === 1 ? { ...item, deleted: true } : item);
  const expanded = adjustReviewBoundary(afterDeletion, 0, "endFrame", 219, 221);
  assert.equal(expanded[0].endFrame, 219);
  assert.equal(expanded[2].deleted, true);
  assert.equal(expanded[3].startFrame, 220);
  assert.deepEqual(segments.map(s => [s.startFrame,s.endFrame,s.deleted]), [[0,44,false],[45,112,false],[113,194,false],[210,220,false]]);
});
import type { MachineAnnotation, StreamSummary } from "../src/types.ts";

test("add and split preserve coverage, unique identities and deleted records", () => {
  const segments: ReviewSegment[] = [{ sourceIndex: 0, startFrame: 0, endFrame: 9, description: "动作", deleted: false, decision: "approved" },
    { sourceIndex: 8, startFrame: 10, endFrame: 19, description: "删除", deleted: true, decision: "pending" }];
  const split = splitReviewSegment(segments, 0, 4);
  assert.deepEqual(split.filter((item) => !item.deleted).map((item) => [item.sourceIndex, item.startFrame, item.endFrame]), [[0,0,3],[9,4,9]]);
  assert.equal(split[2].description, "动作");
  assert.equal(split[0].decision, "pending");
  assert.equal(split[1], segments[1]);
  assert.equal(splitReviewSegment(segments, 0, 0), segments);
  assert.equal(splitReviewSegment(segments, 0, 10), segments);
  const added = addReviewSegment(segments, 10, 20);
  assert.equal(added[2].sourceIndex, 9);
  assert.equal(added[2].startFrame, 10);
  assert.equal(addReviewSegment(segments, 20, 20), segments);
  assert.equal(addReviewSegment(segments, 0, 20)[0].endFrame, 0);
});

const annotation = { frameCount: 383 } as MachineAnnotation;
const stream = { firstFrame: 0, lastFrame: 765, frameCount: 383 } as StreamSummary;
test("Camera 0 media frames map to a 60 Hz timeline without stretching to state count", () => {
  const map = machineTimelineMapping(annotation, stream);
  assert.equal(map.error, null);
  assert.equal(map.step, 2);
  const segment = { startFrame: 23, endFrame: 104, label: "walk", description: "", attributes: {} };
  assert.deepEqual(machineSegmentRange(segment, map.offset, map.step), { startFrame: 46, endFrame: 209 });
});
test("hybrid timeline keeps its nonzero frame origin", () => {
  const map = machineTimelineMapping(annotation, { ...stream, firstFrame: 300, lastFrame: 682 });
  assert.equal(map.error, null);
  assert.deepEqual(machineSegmentRange({ startFrame: 0, endFrame: 22, label: "", description: "", attributes: {} }, map.offset, map.step), { startFrame: 300, endFrame: 322 });
});
test("mismatched media and missing camera cannot silently align", () => {
  assert.ok(machineTimelineMapping({ ...annotation, frameCount: 385 }, stream).error);
  assert.ok(machineTimelineMapping(annotation, undefined).error);
  assert.ok(machineTimelineMapping(annotation, { ...stream, lastFrame: 764 }).error);
});

import { REJECTION_REASONS, normalizeReasonOrder, reorderReason } from "../src/lib/rejection-reasons.ts";
test("reason order migrates valid labels, appends new reasons and pins other last", () => {
  const order = normalizeReasonOrder(["动作过快", "其他原因", "动作过快", "removed", null]);
  assert.equal(order[0], "动作过快");
  assert.equal(order.at(-1), "其他原因");
  assert.equal(order.length, REJECTION_REASONS.length);
  assert.ok(order.includes("动作失范"));
  assert.deepEqual(reorderReason(order, "其他原因", "骨架抖动"), order);
  assert.deepEqual(reorderReason(order, "骨架抖动", "其他原因"), order);
  assert.equal(reorderReason(order, "动作失范", "动作过快")[0], "动作失范");
  assert.deepEqual(normalizeReasonOrder({ invalid: true }), REJECTION_REASONS);
});


test("old emergency rows repair technical ids and statuses while preserving text and boundaries", () => {
  const rows = [{sourceIndex:0,startFrame:0,endFrame:9,description:"原文字",decision:"pending"}, {sourceIndex:0,startFrame:10,endFrame:19,description:"人工文字",decision:"legacy"}];
  const restored = recoverReviewSegments(rows, 30);
  assert.equal(restored.repaired, true);
  assert.equal(new Set(restored.segments!.map(s => s.sourceIndex)).size, 2);
  assert.deepEqual(restored.segments!.map(s => [s.startFrame,s.endFrame,s.description]), [[0,9,"原文字"],[10,19,"人工文字"]]);
  assert.equal(restored.segments![1].decision,"pending");
  assert.equal(rows[1].sourceIndex,0);
  assert.equal(rows[1].decision,"legacy");
});

test("old emergency invalid ranges and formats never overwrite the loaded source", () => {
  for (const value of [null, {}, [null], [{sourceIndex:0,startFrame:0,endFrame:30,description:"旧草稿"}], [{sourceIndex:0,startFrame:10,endFrame:5,description:"旧草稿"}], [{sourceIndex:0,startFrame:-1,endFrame:2,description:"旧草稿"}]]) {
    assert.equal(recoverReviewSegments(value,30).segments,null);
  }
});


import { createReviewBoundaryEditor } from "../src/lib/machine-annotation.ts";
for (const kind of ["startFrame", "endFrame"] as const) test(`${kind}: saved expansion reverses progressively across multiple rows without losing descriptions`, () => {
  const editor = createReviewBoundaryEditor();
  const original: ReviewSegment[] = [[0,9],[10,19],[20,29],[30,39]].map(([startFrame,endFrame],sourceIndex) => ({sourceIndex,startFrame,endFrame,description:`人工动作 ${sourceIndex}`,deleted:false,decision:"approved"}));
  const selected = kind === "endFrame" ? 0 : 3;
  let rows = original;
  for (const value of kind === "endFrame" ? [39,24,14,9,4,34,9] : [0,15,25,30,35,5,30]) {
    const preview = editor.preview(rows,selected,kind,value,40);
    const before = structuredClone(rows);
    const committed = editor.commit(rows,selected,kind,value,40);
    assert.deepEqual(committed,preview,"release must save exactly the visible preview");
    assert.deepEqual(rows,before,"the prior saved snapshot remains immutable");
    rows = committed;
    const retained = rows.filter(s=>!s.deleted).sort((a,b)=>a.startFrame-b.startFrame);
    assert.equal(retained[0].startFrame,0);
    assert.equal(retained.at(-1)!.endFrame,39);
    for(let i=1;i<retained.length;i++) assert.equal(retained[i-1].endFrame+1,retained[i].startFrame,"no overlap or gap during reversal");
    assert.deepEqual(rows.map(s=>s.description),original.map(s=>s.description));
  }
  assert.deepEqual(rows.map(s=>[s.startFrame,s.endFrame,s.deleted]),original.map(s=>[s.startFrame,s.endFrame,s.deleted]));
  assert.ok(rows.every(s=>s.decision==="pending"),"restoration cannot resurrect invalid approvals");
  assert.deepEqual(original.map(s=>s.decision),["approved","approved","approved","approved"]);
});

test("boundary preview cancellation and no-op preserve the last saved adjustment", () => {
  const editor=createReviewBoundaryEditor();
  const original: ReviewSegment[] = [[0,9],[10,19],[20,29]].map(([startFrame,endFrame],sourceIndex)=>({sourceIndex,startFrame,endFrame,description:String(sourceIndex),deleted:sourceIndex===2,decision:"pending"}));
  const expanded=editor.commit(original,0,"endFrame",29,30);
  const preview=editor.preview(expanded,0,"endFrame",9,30);
  assert.equal(preview[1].deleted,false);
  assert.equal(preview[2].deleted,true,"explicitly deleted rows stay deleted");
  assert.equal(expanded[1].deleted,true,"cancelled preview does not change committed rows");
  assert.equal(editor.commit(expanded,0,"endFrame",29,30),expanded);
  for(const value of [NaN,Infinity,1.5]) assert.equal(editor.commit(expanded,0,"endFrame",value,30),expanded);
  assert.deepEqual(editor.commit(expanded,0,"endFrame",9,30),preview);
});

test("other edits, reloads, different handles and separate editors never restore stale snapshots", () => {
  const original: ReviewSegment[] = [[0,9],[10,19],[20,29]].map(([startFrame,endFrame],sourceIndex)=>({sourceIndex,startFrame,endFrame,description:String(sourceIndex),deleted:false,decision:"pending"}));
  const editor=createReviewBoundaryEditor();
  const expanded=editor.commit(original,0,"endFrame",29,30);
  const edited=expanded.map(s=>s.sourceIndex===0?{...s,description:"新描述"}:s);
  const changed=editor.commit(edited,0,"endFrame",9,30);
  assert.equal(changed[0].description,"新描述");
  assert.ok(changed.slice(1).every(s=>s.deleted),"another edit establishes a new baseline");
  const isolated=createReviewBoundaryEditor().commit(expanded,0,"endFrame",9,30);
  assert.ok(isolated.slice(1).every(s=>s.deleted),"another account/channel has no prior adjustment");
  const opposite=editor.commit(expanded,0,"startFrame",3,30);
  assert.equal(opposite[0].startFrame,3);
  assert.ok(opposite.slice(1).every(s=>s.deleted));
  editor.reset();
  assert.ok(editor.commit(expanded,0,"endFrame",9,30).slice(1).every(s=>s.deleted));
});
