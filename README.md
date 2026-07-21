# DOHC Viewer

DOHC Viewer is a Tauri 2 desktop application for importing DOHC recordings from
an SD card, verifying the local copy, reviewing synchronized sensor data, and
exporting it through independent format adapters.

Development and packaging prioritize macOS and Windows; the first formal
release target remains Windows 10 or later. The frontend is React/TypeScript
and the data path is implemented in Rust so directory scans, hashing, image
checks, and exports do not block the UI.

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
5. Verify every destination file by size and BLAKE3, then write a format-v2
   `.dohc-manifest.json` with original and Windows-safe relative paths.
6. Decode-check all JPEG frames, validate stream continuity, parse every state,
   and check state frame IDs and timestamps.
7. Review five synchronized image streams and state telemetry, and optionally
   select one continuous inclusive frame range for playback and export.
8. Export the selected range as MCAP, HDF5, or LeRobot v2.1. Errors in that
   range are blocked in Rust; warnings require explicit confirmation.
9. Export a versioned JSON health report or reveal completed adapter output in
   the system file manager.

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
| MCAP | Seven timestamped topics: JSON state, official Foxglove PoseInFrame, and five official Foxglove CompressedImage streams |
| HDF5 | Typed state datasets and per-stream concatenated JPEG bytes, offsets, sizes, and frame IDs |
| LeRobot v2.1 | Parquet data, five MP4 streams, tasks/episodes/stats metadata, and `info.json` |

The source has no robot action field, so the LeRobot adapter exports the
available observation/state fields and images without inventing an action.
Its standard `timestamp` follows the constant-rate video timeline; the original
nanosecond clock is retained separately as `observation.capture_time_ns`.

Trim ranges are inclusive: a range of frames 10-19 contains ten states and the
matching frames from all five streams. Trimming never changes the imported
episode. Clipped output names include `_frames_10-19`, and each adapter records
the bounds in its metadata.

The MCAP adapter has been exercised with Foxglove Desktop 2.57.0: all five
image topics decode in Image panels, `/dohc/pose` is recognized as
`foxglove.PoseInFrame`, and `/dohc/state` is readable as JSON. On macOS,
Foxglove may show `Permission denied` when a persisted recent-file handle has
expired. Use **Open local file(s)** and select the MCAP again instead of opening
the stale recent item; this is a Foxglove file-handle permission, not an MCAP
parse error.

Playback estimates the recorded FPS from the median positive state timestamp
delta and supports explicit 15, 24, 30, or 60 FPS overrides. Health issues that
identify a frame can jump directly back to synchronized playback.

Import sanitizes every path component and stops before copying when two source
paths would collide after Windows case folding or filename replacement. The
manifest keeps `sourcePath` for the original relative path and `path` for the
local Windows-safe path; the stable dataset BLAKE3 remains based on source paths.

The HDF5 adapter streams concatenated JPEG payloads through fixed 1 MiB chunks;
it retains frame paths and index metadata but never stages a complete camera
stream in memory. The repository pins `hdf5-pure` 0.21.2 and carries a narrow,
documented patch that exposes its existing lazy chunk writer. Cross-file reads,
tail padding, cancellation, a 100 GiB logical staging case, and the private
80.5 MB sample are covered. A physical 100 GB/100,000-file stress run remains a
release gate and must not be inferred from the logical-size test.

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

Run the fast local gate with:

```bash
pnpm check
```

This runs the frontend production build, Rust format check, Clippy with warnings
denied, and the regular Rust suite. Every run writes an ignored JSON evidence
report under `artifacts/release-check/`.

The private sample is excluded from Git. Run both real-data tests plus a Tauri
debug application build with:

```bash
DOHC_SAMPLE_ROOT="$PWD/data/raw/2026-07-13_07-34-12" pnpm check:full
```

`pnpm check:bundle` adds an unsigned debug platform package. On macOS in a
headless environment it uses `scripts/make-dmg.sh` to create a content-equivalent
DMG without Finder window cosmetics. It is build verification, not a signed
release.

Two optional platform preflight commands provide narrower evidence. From macOS,
install the MSVC Rust target once and run the all-target conditional compile:

```bash
rustup target add x86_64-pc-windows-msvc --toolchain stable
pnpm check:windows-cross
```

The command requires `llvm-rc` on `PATH`, `DOHC_LLVM_RC`, or the Homebrew LLVM
prefix. It uses a single rustup-resolved toolchain and writes an ignored report
under `artifacts/windows-cross-check/`. It does not link an executable, include
bundle resources, build an installer, or run on Windows.

On macOS, exercise the production data path from an actual read-only ExFAT
filesystem with the private fixture:

```bash
DOHC_SAMPLE_ROOT="$PWD/data/raw/2026-07-13_07-34-12" \
DOHC_FFMPEG=/absolute/path/to/ffmpeg \
pnpm check:exfat-macos
```

This creates a temporary sparse image, copies the fixture while writable,
remounts it read-only, runs the development stress profile, verifies all three
adapter readbacks and source hashes, then detaches and cleans marker-owned
temporary data. Its ignored `artifacts/exfat-smoke/` report identifies the
source as a virtual volume and cannot qualify a physical SD-card release gate.

## Large-data qualification

The stress runner executes the production data path in order: source scan,
cancel-and-clean import probe, verified local import, full validation, MCAP,
HDF5 and LeRobot export/readback, then a fresh BLAKE3 pass over the source. A
development fixture run is explicit and cannot qualify a release:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example stress-check -- \
  --source "$PWD/data/raw/2026-07-13_07-34-12" \
  --work-root /tmp/dohc-viewer-stress-development \
  --development-fixture
```

Formal mode is the default. Run it from a clean, exactly tagged release build
with an explicit reviewed FFmpeg path. The source episode must be on exFAT,
contain at least 100,000 files and 100,000,000,000 bytes, and be on a different
volume from the new work directory. The work volume needs four source copies
plus a 25% reserve (425 GB for a 100 GB source).

```bash
export DOHC_FFMPEG=/absolute/path/to/reviewed/ffmpeg
cargo run --release --manifest-path src-tauri/Cargo.toml --example stress-check -- \
  --source /Volumes/DOHC_CARD/episode \
  --work-root /Volumes/LOCAL_WORK/dohc-stress-v0.9.0
```

On Windows, set `$env:DOHC_FFMPEG` to an absolute reviewed `ffmpeg.exe`, use the
SD card episode as `--source`, and place `--work-root` on a different local NTFS
or exFAT volume. The work directory must not already exist. Every started run
writes `stress-report.json` atomically inside it; a nonzero exit or
`"formal": false` is not release evidence.

## Controlled FFmpeg staging

Do not copy FFmpeg into `src-tauri/resources` manually. Both staging scripts
require an expected SHA-256, HTTPS source, build ID, one or more license files,
the native `mpeg4` encoder, and a build without `--enable-nonfree`. They publish
the ignored binary, combined notices, and `ffmpeg-manifest.json` only after all
checks pass.

On macOS, use a reviewed binary that links only system libraries:

```bash
scripts/stage-ffmpeg.sh \
  --source /path/to/ffmpeg \
  --expected-sha256 "$FFMPEG_SHA256" \
  --license /path/to/LICENSE \
  --source-url https://publisher.example/ffmpeg \
  --build-id reviewed-build-id
pnpm check:bundle
```

Homebrew FFmpeg is dynamically linked to Homebrew libraries and is therefore
not portable. `--allow-nonportable` together with release-check's
`--allow-nonportable-bundle` may be used for a local debug package only; the
normal bundle gate rejects that manifest.

## Windows package

Build on Windows x64. Stage a reviewed FFmpeg build and its matching notices,
run the full gate, and then build the offline NSIS installer:

```powershell
pnpm install --frozen-lockfile
$env:DOHC_SAMPLE_ROOT = "C:\path\to\2026-07-13_07-34-12"
.\scripts\stage-ffmpeg.ps1 `
  -Source C:\path\to\ffmpeg.exe `
  -ExpectedSha256 $FfmpegSha256 `
  -LicenseFile C:\path\to\COPYING.txt `
  -SourceUrl https://publisher.example/ffmpeg `
  -BuildId reviewed-build-id `
  -ReviewedPortable
pnpm check:full
pnpm tauri:build
```

The Windows-specific Tauri config bundles the verified FFmpeg resources,
embeds the offline WebView2 installer, blocks downgrades, and refuses
installation below Windows 10. The final NSIS application and installer must be
signed and tested offline on clean Win10/Win11 x64 systems. Code signing
credentials are intentionally not stored in this repository.
