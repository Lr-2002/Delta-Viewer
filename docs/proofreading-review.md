# Proofreading 1.0.8

Selected action segments set the existing player's continuous-playback bounds.
Playback stops at the selected end and restarts at its beginning. Boundary
edits, deletion and source changes refresh or clear the bounds; paused seeking
remains available across the recording. No decoder or clock is duplicated.

## Unified Workspace

Playback and proofreading now share the default proofreading tab. The original
five-camera grid, adjacent skeleton, frame-render progress, telemetry, speed
and FPS controls remain. Manual annotation and segment creation are replaced
with the machine-review timeline and action segments. UI frame conversion
connects those controls to the existing playback clock; decoder, buffering and
skeleton presenter implementations are unchanged. Old human trim metadata does
not limit proofreading playback. Missing machine JSON still permits seeking.

Readable recordings load directly without a quality-warning confirmation page.
Existing quality reports and export validation remain available.

## Flash Compatibility

The source selector supports `bailian_annotation.json` and
`bailian_annotation.qwen3.8-flash.json`. Automatic selection prefers Flash when
present; an invalid Flash file produces an error instead of silently selecting
another result. Explicit selection is restricted to these two ordinary files.
Both schema v3 and v4 support object attributes and `T`/`value` attribute arrays.
Chinese `attributes_zh` action descriptions take precedence when available.
Editing patches that same language and preserves the other language, attribute
order, unknown fields and task metadata. Pipeline status and model-generated
warnings are omitted from the workspace; the original JSON retains them.

Available episode skeletons appear alongside the proofreading video and stack
below it on narrow windows. Seeking, segment selection and playback share the
video-to-backend frame mapping, including offsets and differing state cadence.
Orbit controls remain available. Missing skeletons take no space; unreadable
skeletons show a local error without blocking video or editing.

Flash drafts, pending-write journals and locks are independent of the original
source. Flash results use `review.3.8flash.json`; original results use
`review.3.8max.json`. Neither source file is modified.
Changing source waits for autosave; a failed save must be resolved before
switching. Browser recovery drafts also use a separate Flash key.

## Playback and Saving

The same release supports new recording layouts with the MP4 manifest under
`.session_meta`. It reads the original stream declarations, measures state batch
cadence from a bounded prefix and uses per-camera availability to locate startup
offsets. Quality findings no longer discard readable streams or the loaded
workspace. A primary-frame failure pauses playback and allows another seek;
export validation remains enforced independently. The nested-layout regression
loads all five streams without creating a replacement manifest. A selected NAS
recording was also checked by decoding each camera's first and last frame and
confirming the capture fingerprint stayed unchanged.

The proofreading player uses zero-based Camera 0 video frames independently of
state samples and manual annotation trims. The backend can expose a 60 Hz frame
address for a 30 FPS MP4, so only frame requests use the integer stream mapping.
Native playback uses the mapped FPS; source frame counters, controls and interval
coverage remain on the video axis. Native paused seeks sample halfway through a
frame because seeking exactly on a rounded PTS can present the preceding frame.

Rapid paused seeks coalesce while the decoder is seeking. A segment play request
first commits its paused target, then starts playback. Stable presentation
callbacks avoid rebuilding the native clock. Memoized segment lists and colored
strip entries do not reconcile on every presented frame. Buffering still follows
the native media clock; these changes cannot guarantee a NAS throughput floor.

Every edit writes the reviewed JSON with revision checks and a unique version
ID linked to the previous version. Whole-episode approval/rejection saves before
advancing to the next episode. Subsequent edits return the result to pending.
Failed writes retain recovery drafts and prevent navigation. The output clones
the entire original document, patches the selected
episode by original annotation index, synchronizes linked segment boundaries and
deletions, preserves unknown fields, and adds `_human_review` provenance. It never
rewrites the original machine JSON or contributes to manual completion metrics.

The writer uses ordinary bounded files, source/output hashes, OS file locks,
readback of partial bytes, and atomic replacement. A local pending-write journal
recovers a committed NAS output if the local draft update was interrupted.
Conflicting edits remain local and are rejected instead of overwriting another
host's result. Lock files remain in place, with locks released by the OS even
after process termination. Application review metadata is excluded from capture
fingerprints and statistics.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml machine_review --lib` covers
  approval gating, autosave/reopen, all 0/1-based inclusive/exclusive conventions,
  original-field preservation, linked deletion despite sorted display order,
  stale revisions, source changes, foreign output conflicts, capture identity,
  and recovery after an interrupted local update.
- `pnpm test:proofreading` covers continuous shared-boundary edits and real
  Chromium MP4 playback with source frame count 90, backend range 0..179 and a
  state endpoint of 89. It compares main/start-preview pixels, checks actual
  presented frame IDs, seeks to the last frame, switches segments while playing,
  rapidly scrubs, and verifies that playback does not mutate the segment list.
  Both presentation-callback and legacy media-clock paths run. Screenshots at
  1440/960/390 px and timing evidence stay in ignored artifacts.
- `node --test scripts/unified-proofreading.test.mjs` covers five-camera seeking,
  skeleton interaction, direct warning loading, review autosave/reload, missing
  machine JSON, and responsive layout. Older demo tests for manual annotation
  panels describe the removed workflow.

Synthetic/browser evidence does not replace real SD-card, large-volume or
target-machine qualification. Existing GAP-003/GAP-007 remain applicable.
