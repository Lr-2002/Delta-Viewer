# DOHC Viewer

DOHC Viewer is a Tauri 2 desktop application for importing DOHC recordings from
an SD card, verifying the local copy, reviewing synchronized sensor data, and
exporting it through independent format adapters.

The first supported release target is Windows 10 or later. The frontend is
React/TypeScript and the data path is implemented in Rust so directory scans,
hashing, image checks, and exports do not block the UI.

Project documentation:

- [Product requirements](prd.md)
- [Development and agent guide](AGENTS.md)
- [Version history](CHANGELOG.md)

## Workflow

1. Select an SD card or a recording directory.
2. Scan one or more episodes without modifying the source card.
3. Copy the selected episode to local storage.
4. Preflight local capacity and filesystem support, then identify any safely
   cleanable incomplete imports.
5. Verify every destination file by size and BLAKE3, then write
   `.dohc-manifest.json`.
6. Decode-check all JPEG frames, validate stream continuity, parse every state,
   and check state frame IDs and timestamps.
7. Review five synchronized image streams and state telemetry.
8. Export MCAP, HDF5, or LeRobot v2.1. Errors are blocked in Rust; warnings
   require explicit confirmation.

The runtime has no SSH or other network data path. SSH was used only once to
retrieve the development sample from the current ext4 card.

## Data layout

An episode is a directory containing `states.jsonl` and these frame directories:

```text
episode/
  cam0/{frame_id}.jpg
  cam1/{frame_id}.jpg
  cam2/{frame_id}.jpg
  t265_left/{frame_id}.jpg
  t265_right/{frame_id}.jpg
  states.jsonl
```

Adapter output:

| Format | Output |
| --- | --- |
| MCAP | Six timestamped channels: JSON state plus five raw JPEG streams |
| HDF5 | Typed state datasets and per-stream concatenated JPEG bytes, offsets, sizes, and frame IDs |
| LeRobot v2.1 | Parquet data, five MP4 streams, tasks/episodes/stats metadata, and `info.json` |

The source has no robot action field, so the LeRobot adapter exports the
available observation/state fields and images without inventing an action.
Its standard `timestamp` follows the constant-rate video timeline; the original
nanosecond clock is retained separately as `observation.capture_time_ns`.

## exFAT decision

exFAT solves Windows/macOS readability for future cards and supports files over
4 GB. It does not convert the current ext4 card: existing data must be copied
off before reformatting, and formatting erases the card. The recorder must first
be tested for exFAT support and sudden-power-loss behavior because exFAT is not
journaled.

Recording directory names must also be Windows-safe. Use a form such as
`2026-07-13_07-34-12`; the current source name `2026-07-13 07:34:12` contains
colons that are invalid on Windows and exFAT. The importer sanitizes legacy
names automatically.

## Development

Prerequisites: Node.js, pnpm, and a current stable Rust toolchain.

```bash
pnpm install
pnpm tauri:dev
```

Frontend-only development uses the local sample automatically:

```bash
pnpm dev
```

Run the normal checks with:

```bash
pnpm check
```

The private sample is excluded from Git. Its full smoke tests are explicit:

```bash
export DOHC_SAMPLE_ROOT="$PWD/data/raw/2026-07-13_07-34-12"
cargo test --manifest-path src-tauri/Cargo.toml \
  imports_real_sample_and_verifies_hashes -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml \
  validates_and_exports_real_sample -- --ignored
```

## Windows package

Build on Windows x64. Stage a reviewed FFmpeg build and its matching notices,
then build the offline NSIS installer:

```powershell
pnpm install --frozen-lockfile
.\scripts\stage-ffmpeg.ps1 -Source C:\path\to\ffmpeg.exe
pnpm tauri:build
```

The Windows-specific Tauri config bundles `ffmpeg.exe`, embeds the offline
WebView2 installer, blocks downgrades, and refuses installation below Windows
10. Code signing credentials are intentionally not stored in this repository.
