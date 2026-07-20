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
7. Review five synchronized image streams and state telemetry.
8. Export MCAP, HDF5, or LeRobot v2.1. Errors are blocked in Rust; warnings
   require explicit confirmation.
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
| MCAP | Six timestamped channels: JSON state plus five raw JPEG streams |
| HDF5 | Typed state datasets and per-stream concatenated JPEG bytes, offsets, sizes, and frame IDs |
| LeRobot v2.1 | Parquet data, five MP4 streams, tasks/episodes/stats metadata, and `info.json` |

The source has no robot action field, so the LeRobot adapter exports the
available observation/state fields and images without inventing an action.
Its standard `timestamp` follows the constant-rate video timeline; the original
nanosecond clock is retained separately as `observation.capture_time_ns`.

Playback estimates the recorded FPS from the median positive state timestamp
delta and supports explicit 15, 24, 30, or 60 FPS overrides. Health issues that
identify a frame can jump directly back to synchronized playback.

Import sanitizes every path component and stops before copying when two source
paths would collide after Windows case folding or filename replacement. The
manifest keeps `sourcePath` for the original relative path and `path` for the
local Windows-safe path; the stable dataset BLAKE3 remains based on source paths.

The current pure-Rust HDF5 writer stages JPEG payloads in memory. HDF5 export is
therefore blocked with `HDF5_STREAMING_REQUIRED` above 512 MiB of JPEG data;
MCAP and LeRobot are unaffected. A streaming HDF5 writer and the 100 GB stress
gate remain release work.

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
