# DOHC Viewer Changelog

All application releases have a dedicated release commit and annotated Git tag.

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
