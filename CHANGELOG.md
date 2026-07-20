# DOHC Viewer Changelog

All application releases have a dedicated release commit and annotated Git tag.

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
