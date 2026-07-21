# DOHC Viewer Changelog

All application releases have a dedicated release commit and annotated Git tag.

## 0.14.0 - 2026-07-21

- Added offline local account creation, login, and logout so every annotation
  revision records the operator who processed the episode.
- Stored passwords only as Argon2id PHC hashes with random salts, kept sessions
  process-local, and gated data commands in Rust when no account is signed in.
- Added episode-level task annotation with an editable auto-filled description,
  starting with `close_oven`, plus globally reserved codes such as `oven-001`.
- Preserved append-only annotation revisions outside the SD card, bound to the
  canonical episode path and fingerprint.
- Made annotated MCAP, HDF5, and LeRobot exports use the trajectory code as the
  base name and carry task and processor metadata, while preserving legacy names
  for unannotated recordings.

## 0.13.0 - 2026-07-21

- Added offline background reports for warning and error validation results in
  the application-local data directory; passing checks do not generate one.
- Made automatic report names stable per episode path, data fingerprint, and
  report version, with atomic publication, readback verification, and deduplication.
- Upgraded health reports to format v3 with `autoReportPath`, and kept stale
  formats outside the trusted export cache.
- Ordered check rows and issues by error, warning, then pass, and fixed state
  results so `TIMESTAMP_GAP` makes `states.jsonl` visibly report a warning.
- Renamed the check-page action from "Export JSON" to "Export report" and added
  visible local background-report status across desktop and narrow layouts.

## 0.12.0 - 2026-07-21

- Made SD-card selection automatically scan and load the first session through
  local destination selection, verified import, health checking, and playback;
  removed both manual "Import and check" controls.
- Replaced interactive all-frame JPEG decoding with deterministic per-stream
  samples at 1%, 25%, 50%, 73%, and 99%, while retaining complete structural,
  state, frame-ID, and timestamp checks.
- Kept formal stress and real release smoke validation on full JPEG decoding,
  with fixtures proving that full mode still detects damage outside the sampled
  positions.
- Upgraded health reports to format v2 with image validation mode, sampling
  percentages, and actual checked-frame counts; stale reports are rejected by
  the trusted export cache.
- Updated the checks view to distinguish total and sampled frames, including
  compact narrow-viewport table tracks and a matching browser demo.

## 0.11.0 - 2026-07-21

- Reworked the complete application chrome into a black, white, and neutral-gray
  system across navigation, session selection, controls, progress, status, and
  export feedback.
- Converted telemetry axes, grids, and markers to distinct grayscale values while
  preserving the original color of camera recordings.
- Kept warning and error states identifiable through labels, icons, borders, and
  luminance instead of relying on hue alone.
- Verified playback, checks, and export at 1440x920, 960x680, and 390x844 with
  five decoded images, no horizontal overflow, and no browser runtime errors.

## 0.10.0 - 2026-07-21

- Made the left episode list a session selector: a single click only changes
  selection, while a double click enters normal playback.
- Double-clicking an unloaded session runs the existing local import, capacity
  preflight, size/BLAKE3 verification, and health-check workflow before playback.
- Double-clicking an already loaded session returns to playback without copying
  again, and source-session selection remains highlighted after local import.
- Kept generated recordings and exports under `data/` ignored except for the
  tracked inventory document, preventing local test output from entering a release.

## 0.9.0 - 2026-07-21

- Added inclusive single-trajectory frame trimming with start/end sliders,
  numeric inputs, current-frame markers, range playback, and shared range-aware
  export controls.
- Applied the selected range in Rust across state rows and all five image
  streams, with backend boundary validation and range-aware warning/error gates.
- Recorded clip bounds in MCAP, HDF5, and LeRobot v2.1 metadata and clipped
  output names; real frames 10-19 pass all three adapter readbacks.
- Upgraded MCAP to seven topics and three schemas using official Foxglove
  `CompressedImage` and `PoseInFrame` protobuf messages while retaining JSON
  state and bounded production summary readback.
- Opened the full 196-frame sample in Foxglove Desktop 2.57.0: all five image
  panels decoded, state JSON was readable, and all seven topics were recognized
  at 196 messages each.
- Re-ran the complete 80,531,730-byte APFS development workflow in 72.726
  seconds with stable source BLAKE3; formal Windows, physical SD-card, and
  100 GB/100,000-file gates remain open.

## 0.8.0 - 2026-07-21

- Added a repeatable macOS-hosted Windows x64 MSVC all-target compile check with
  rustup toolchain consistency, LLVM resource compilation, and atomic JSON
  evidence that explicitly excludes linking, packaging, and Windows runtime.
- Added an opt-in BLAKE3 intrinsic feature for that cross-host check so the
  normal Windows release build retains BLAKE3's default optimized backend.
- Added a macOS ExFAT smoke command that creates a sparse image, stages the
  private fixture, remounts the source read-only, runs the full production
  stress workflow, and only removes marker-verified temporary data after detach.
- The read-only virtual ExFAT fixture passed all 981 files and 80,531,730 bytes
  in 75.662 seconds of stress execution with 5 ms cancellation and 27,213,824
  bytes peak RSS; all three adapters read back and source hashes remained stable.
- Kept signed Windows packaging, clean Win10/Win11 offline runtime, a physical
  ExFAT SD card, and the 100 GB/100,000-file run as explicit release gates.

## 0.7.0 - 2026-07-21

- Added a cross-platform `stress-check` CLI that drives source scan, cancellable
  import, verified local copy, full validation, all three adapter readbacks, and
  a final source-side BLAKE3 pass through the production Rust implementations.
- Made formal mode require a release build, clean exact annotated version tag, explicit
  reviewed FFmpeg, an exFAT source on a separate volume, at least 100 GB and
  100,000 files, and a conservative local-work capacity budget.
- Added an import cancellation probe that waits for a marked partial, requires
  cancellation within one second, rejects published output, and uses guarded
  partial cleanup.
- Added atomic schema-v1 stress reports with host, Git, volume, FFmpeg hash,
  threshold, validation, output, phase duration/throughput, cancellation, and
  peak-RSS evidence on macOS/Linux/Windows.
- Re-read every source file against the format-v2 import manifest after the
  workflow, with a regression test for same-size source tampering.
- The 80.5 MB APFS development fixture passed in 72.551 seconds with 1 ms
  cancellation and 27,394,048-byte peak RSS. It is deliberately recorded as
  `formal:false`; physical exFAT/100 GB and Windows gates remain open.

## 0.6.0 - 2026-07-21

- Replaced whole-stream HDF5 JPEG staging and the 512 MiB rejection ceiling
  with cancellable fixed-size 1 MiB chunk streaming.
- Pinned and vendored `hdf5-pure` 0.21.2 with a documented minimal API patch
  exposing its existing lazy chunk writer; no native HDF5 DLL was introduced.
- Added HDF5 progress during payload writes, source-size drift detection,
  failure/cancellation partial cleanup, and stronger frame-index and byte-shape
  readback checks.
- Added tests for cross-file chunks, padded final chunks, cancellation, and a
  100 GiB logical dataset without payload allocation; the 80.5 MB private
  sample still passes all three adapter readbacks in 69.65 seconds.
- Kept the physical 100 GB/100,000-file performance run as an open release gate;
  logical staging coverage is not recorded as field-test completion.

## 0.5.0 - 2026-07-21

- Added cross-platform quick, full, and debug-bundle verification profiles with
  atomic machine-readable JSON evidence reports.
- Made the default check include frontend build, Rust formatting, Clippy with
  warnings denied, and the regular Rust test suite; the full profile also runs
  both private-sample tests and a Tauri application build.
- Hardened Windows FFmpeg staging with expected SHA-256, PE x64, `mpeg4`
  encoder, nonfree-build, source, build-ID, portability-review, and license
  gates.
- Added equivalent macOS FFmpeg staging with architecture and dynamic-library
  portability inspection, plus explicit local-only non-portable debug mode.
- Added platform resource manifests so app/DMG and NSIS packages carry the
  exact staged FFmpeg binary, combined notices, and provenance metadata; normal
  bundle checks reject hash drift and non-portable dependencies.
- Added repeatable headless macOS DMG generation and read-only mount validation
  for CI environments where Finder AppleScript is unavailable.

## 0.4.0 - 2026-07-20

- Made source traversal cancellable and read-only, ignored file/directory
  symlinks, bounded sparse-frame reporting, and added macOS volume details.
- Upgraded import manifests to format v2 with original-to-Windows-safe path
  mappings, collision detection, source-change detection, and target readback
  checks that catch same-size corruption.
- Added atomic no-overwrite publication on Windows, macOS, and Linux and
  tightened Tauri dialog permissions to the two required operations.
- Added validation for negative timestamps, invalid/duplicate frame names, and
  equal-count frame-ID mismatches, with exact missing-frame totals.
- Strengthened MCAP, HDF5, and LeRobot readback checks and made FFmpeg encoding
  cancellation responsive without blocking on child-process pipes.
- Prevented stale frames and stale telemetry from representing the selected
  frame, and bounded chart rendering work for long recordings.
- Added a 512 MiB HDF5 JPEG safety ceiling until the large-data adapter can use
  a genuinely streaming writer.

## 0.3.0 - 2026-07-20

- Added trusted in-process validation records bound to source directory
  fingerprints; stale or missing validation blocks export.
- Reduced the real three-adapter debug smoke test from 276.01 seconds to 70.00
  seconds by reusing an unchanged Rust validation result.
- Added versioned JSON health report export with partial write, readback, and
  no-overwrite publication.
- Added issue-to-frame navigation and tolerant loading of valid states around
  malformed JSON lines while validation retains the blocking error.
- Added timestamp-derived playback FPS with 15/24/30/60 FPS overrides.
- Added reveal-in-file-manager for completed exports using a local-path-only
  Tauri capability.

## 0.2.0 - 2026-07-20

- Added import capacity and filesystem preflight with Windows volume detection.
- Blocked local import/export destinations inside the source recording, network
  drives, FAT/FAT32 volumes, and destinations without sufficient free space.
- Added marked partial import discovery and guarded cleanup; unmarked directories
  cannot be removed through the cleanup command.
- Re-ran full validation in the Rust export entry point so IPC cannot bypass
  error blocking, and required explicit acknowledgement for warning exports.
- Enforced one active long-running task across scan, load, validation, import,
  preflight, and export commands.

## 0.1.0 - 2026-07-20

- Established the Tauri 2, Rust, React, and TypeScript desktop application.
- Added SD/local directory scanning, verified BLAKE3 import, full JPEG and state
  validation, synchronized playback, and telemetry charts.
- Added MCAP, HDF5, and LeRobot v2.1 adapters with real-sample readback tests.
- Added Windows 10 NSIS configuration, offline WebView2 setup, and FFmpeg staging.
