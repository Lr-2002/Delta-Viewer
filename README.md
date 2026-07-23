# DOHC Viewer

DOHC Viewer is a Tauri 2 desktop application for importing DOHC recordings from
an SD card, verifying the local copy, reviewing synchronized sensor data, and
exporting it through independent format adapters.

Official packaging targets Windows 10/11 x64, macOS 12 or later on Apple
Silicon and Intel, and Ubuntu 22.04 or later on x86_64 through a native deb.
An Ubuntu 20.04+ Flatpak remains available as the compatibility package. The
first field-acceptance target remains Windows. The frontend is React/TypeScript
and the data path is implemented in Rust so
directory scans, hashing, image checks, and exports do not block the UI.

Project documentation:

- [User guide on GitHub Wiki](https://github.com/Lr-2002/Delta-Viewer/wiki)
- [Product requirements](prd.md)
- [Development and agent guide](AGENTS.md)
- [Version history](CHANGELOG.md)

## Installation

Installers are published on [GitHub Releases](https://github.com/Lr-2002/Delta-Viewer/releases):

- `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`
- `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`
- `DOHC-Viewer_<version>_UNSIGNED_macos-x64.dmg`
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak`

The current release channel has no trusted publisher signature. Windows can
show an unknown-publisher or SmartScreen warning. The macOS app is ad-hoc sealed
so its nested code and resources can be verified, but it has no Developer ID or
notarization and therefore requires Apple's one-time Gatekeeper override. The
Ubuntu 22.04+ users should use the unsigned native deb; the unsigned Flatpak
uses the GNOME 50 runtime and requires the standard Flathub remote. A release
is made public only after all five installers pass dependency, resource,
install or mount, startup, and checksum gates. Verify
`SHA256SUMS.txt` before use; detailed installation and usage instructions live
in the Wiki.

## Workflow

1. Create or sign in to a local account. The account identifies who last
   processed an episode; it is not a cloud account or a remote permission system.
2. Select an SD card or a recording directory.
3. Scan every direct-child episode without modifying the source card, then
   automatically queue all discovered sessions for import without a second
   destination dialog or import button.
4. Create an isolated workspace under the current user's app-local data,
   preflight its capacity and filesystem support, and copy each session there.
   The first successful session opens automatically; the left list shows every
   session's import status and opens one with a double click.
5. Identify any safely cleanable incomplete imports before publishing a
   completed local copy.
6. Verify every destination file by size and BLAKE3, then write a format-v2
   `.dohc-manifest.json` with original and Windows-safe relative paths.
7. Decode-check each stream at fixed 1%, 25%, 50%, 73%, and 99% positions,
   validate the complete stream structure, parse every state, and check state
   frame IDs and timestamps.
8. Assign an episode task, editable task description, and a globally reserved
   trajectory code. The initial `close_oven` task defaults to `oven-001`, then
   increments for later trajectories.
9. Review five synchronized image streams and state telemetry, and optionally
   select one continuous inclusive frame range for playback and export.
10. Export the selected range as MCAP, HDF5, or LeRobot v2.1. Errors in that
   range are blocked in Rust; warnings require explicit confirmation.
11. Automatically persist warning/error health reports in the app-local data
   directory, or use **Export report** to choose another destination. Passing
   checks do not create a background report.
12. Persist user-visible scan, import, load, validation, and export failures in
    an append-only local operation history. Permission failures retain the raw
    platform message and are classified as `PERMISSION_DENIED`.

Interactive health reports use format v3 and explicitly identify sampled image
validation, the five percentages, and `autoReportPath`. Automatic reporting is
strictly local and never writes to the SD card or imported episode; repeated
checks of the same episode path and fingerprint reuse one report. Formal stress
and release smoke tests still decode every JPEG; a sampled result does not claim
that unsampled frames are free of encoding damage.

Managed imports, accounts, trajectory reservations, append-only annotation
revisions, and operation error history are stored under the operating system's
application-local data directory. Passwords
are stored as Argon2id PHC hashes with random salts, never as plaintext. Login
sessions last only for the current application process. This identity layer is
for processing attribution; it does not encrypt local files, provide roles,
recover forgotten passwords, or synchronize between computers.

The runtime has no SSH or other network data path. SSH was used only once to
retrieve the development sample from the current ext4 card. Ubuntu can mount
ext4 with the Linux kernel. The native deb can select any mounted path allowed
by the current user; the Flatpak can select cards under `/media`, `/run/media`,
or `/mnt`. The complete
command sequence is in the [Wiki installation guide](https://github.com/Lr-2002/Delta-Viewer/wiki/Installation).

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

For an annotated episode, all adapters use its trajectory code as the output
base name and embed the task and processor identity in format-native metadata.
MCAP uses `dohc.dataset` metadata, HDF5 uses root attributes plus `/annotation`,
and LeRobot uses `info.json.dohc_annotation` plus its task text. Unannotated
episodes retain their original recording-based names.

The source has no robot action field, so the LeRobot adapter exports the
available observation/state fields and images without inventing an action.
Its standard `timestamp` follows the constant-rate video timeline; the original
nanosecond clock is retained separately as `observation.capture_time_ns`.

Trim ranges are inclusive: a range of frames 10-19 contains ten states and the
matching frames from all five streams. Trimming never changes the imported
episode. Clipped output names include `_frames_10-19` after either the trajectory
code or legacy recording name, and each adapter records the bounds in metadata.

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

Frontend-only development uses an in-memory demo account and the checked-in
`public/demo/fixture.json` metadata fixture. It does not serve the private
`data/raw` recording or widen Vite filesystem access. Create the demo account
on the login screen; refreshing the page resets demo accounts and annotations:

```bash
pnpm dev
```

Run the browser-demo regression gate with `pnpm test:demo-flow`. CI requires a
Chrome executable for this command and fails rather than skipping the gate when
the browser is unavailable.

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
tested offline on clean Win10/Win11 x64 systems. The current public package is
explicitly unsigned; Authenticode remains a later production-hardening gate.

## GitHub release CD

`.github/workflows/release.yml` runs only for an existing annotated `vX.Y.Z`
tag (or a manual rerun of one). It builds Windows x64, macOS arm64, macOS x64,
and Ubuntu x64 on native GitHub-hosted runners. Windows uses reviewed,
hash-pinned FFmpeg and offline WebView2 inputs. Each macOS runner builds a
minimal LGPL FFmpeg from a pinned official source archive and commit. The
Ubuntu 22.04 runner installs and starts the generated deb. A downstream Ubuntu
24.04 job downloads that exact verified deb and builds/tests the GNOME 50
Flatpak compatibility package.

The Windows job verifies that DOHC assets have no Authenticode signature. The
macOS jobs apply and strictly verify a local ad-hoc seal, reject Developer ID or
notarization claims, and run a policy check under synthetic quarantine. If a
GitHub runner's XProtect service is unavailable, the job requires the same
result from an independently built minimal control app and records that state;
a product-only XProtect error still fails. Both paths also check bundled FFmpeg,
offline WebView2 on Windows, installer or DMG contents, and an installed-copy
startup smoke. The final job recomputes all SHA-256 values, emits a release
manifest and GitHub provenance attestations, and publishes the draft only when
the complete five-installer set matches. Release titles, asset names, notes,
reports, and the manifest all carry the `UNSIGNED` state because no trusted
publisher identity is present.

The hosted-runner smoke does not replace clean Win10/Win11 offline testing,
target-Mac testing, physical exFAT SD-card validation, or the formal
100 GB/100,000-file run. Signing, notarization, and release operations are
documented in the
[Wiki release guide](https://github.com/Lr-2002/Delta-Viewer/wiki/Release-Operations).

Wiki source is reviewed under `docs/wiki/` and synchronized by
`.github/workflows/wiki.yml`; do not maintain divergent instructions directly
in the GitHub web editor.
