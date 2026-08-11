# DOHC Viewer

DOHC Viewer is a Tauri 2 desktop application for reading DOHC recordings
directly from a mounted, read-only SD card, reviewing synchronized sensor data,
and exporting it through independent format adapters without an automatic local
episode copy.

Official packaging targets Windows 10/11 x64, macOS 12 or later on Apple
Silicon, and Ubuntu 22.04 or later on x86_64 through a native deb. New Intel
Mac packages are not published.
The first field-acceptance target remains Windows. The frontend is React/TypeScript
and the data path is implemented in Rust so
directory scans, hashing, image checks, and exports do not block the UI.

Project documentation:

- [User guide on GitHub Wiki](https://github.com/Lr-2002/Delta-Viewer/wiki)
- [Product requirements](prd.md)
- [Development and agent guide](AGENTS.md)
- [Version history](CHANGELOG.md)

## Installation

User-facing installers are mirrored at
[http://39.155.172.162:17879/](http://39.155.172.162:17879/); users do not need GitHub
access. GitHub Releases remains the build and signed upstream source:

- `DOHC-Viewer_<version>_UNSIGNED_windows-x64-setup.exe`
- `DOHC-Viewer_<version>_UNSIGNED_macos-arm64.dmg`
- `DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb`

The current release channel has no trusted publisher signature. Windows can
show an unknown-publisher or SmartScreen warning. The macOS app is ad-hoc sealed
so its nested code and resources can be verified, but it has no Developer ID or
notarization and therefore requires Apple's one-time Gatekeeper override.
Ubuntu 22.04+ users should use the unsigned native deb. A release is made
public only after all three installers pass dependency, resource, install or
mount, startup, and checksum gates. Verify
`SHA256SUMS.txt` before use; detailed installation and usage instructions live
in the Wiki.

Starting with `0.17.12`, unified management mode checks the fixed public update mirror at
`http://39.155.172.162:17879` after local login, then falls back only to
`http://10.1.11.36:17879` for clients on the mirror LAN. The mirror host reads GitHub once,
verifies and atomically caches the complete release, and serves clients over the
reachable fixed IP. When a newer version exists the app waits for the current
data task, downloads the matching updater, verifies its dedicated
Ed25519/Minisign signature, installs it, and restarts. Mirror failures are
visible and retryable but never block the offline data workflow. Installations
on `0.17.8` or earlier need one manual `0.17.12` install from the mirror page;
later releases update automatically. Linux may show a system authorization
prompt while installing the replacement deb.

## Workflow

1. Choose a workspace mode. **Unified management** imports the
   administrator-provided LAN user-center configuration and signs in with an
   administrator-created account. **Offline** enters directly without an account,
   user-center request, or automatic update check; local annotations use an
   offline-local provenance marker rather than a user account.
2. Select an SD card or a recording directory.
3. Scan every direct-child episode without modifying captured files. The first
   session opens directly from the source; no automatic app-local copy is
   created. Keep the source volume mounted while viewing or exporting.
4. The left list shows every discovered session. A single click selects it;
   double-click it or press Enter/Space while it has keyboard focus to read and
   check it on demand.
5. Decode-check each stream at fixed 1%, 25%, 50%, 73%, and 99% positions,
   validate the complete stream structure, parse every state, and check state
   frame IDs and timestamps.
6. Select an episode task or create one by entering its name, then edit the task
   description as needed. Rust assigns the next `{task-prefix}-{NNN}` trajectory
   code atomically when the annotation is saved; the UI cannot set the number.
   Saving also atomically creates or updates `description.json` in the episode
   root, so annotation requires a writable source. Unused custom tasks can be
   deleted; built-in or referenced tasks are preserved.
7. Review five synchronized image streams and colored state telemetry. If the episode
   includes an optional `smpl_skeleton.npz`, a synchronized interactive 3D skeleton is
   shown to the right of the images on desktop and below them in a narrow window. Select
   one continuous inclusive frame range for playback and export when needed.
8. Export the selected range as MCAP, HDF5, or LeRobot v2.1. Errors in that
   range are blocked in Rust; warnings require explicit confirmation.
9. Open **Batch** to select multiple locally annotated full episodes and export
   them sequentially with one format and destination. Every item is rechecked;
   one failure does not stop later items, and cancellation keeps completed outputs.
10. Automatically persist warning/error health reports in the app-local data
   directory, or use **Export report** to choose another destination. Passing
   checks do not create a background report.
11. Persist user-visible scan, load, validation, and export failures in
    an append-only local operation history. Permission failures retain the raw
    platform message and are classified as `PERMISSION_DENIED`.

Interactive health reports use format v5 and explicitly identify sampled image
validation, the five percentages, median FPS, interval stability, black-screen
warnings, and `autoReportPath`. Automatic reporting is
strictly local and never writes to the SD card or source episode; repeated
checks of the same episode path and fingerprint reuse one report. Formal stress
and release smoke tests still decode every JPEG; a sampled result does not claim
that unsampled frames are free of encoding damage.

User-created tasks, trajectory reservations, append-only annotation revisions,
reports, and operation error history are stored under the operating system's
application-local data directory. Normal UI use does not copy episode payloads
there. The saved task description is additionally written as format-v1
`description.json` in the source episode; captured JPEG/state/skeleton files
remain unchanged. A batch candidate therefore still requires its original source path to
be mounted and its fingerprint to match the saved annotation. In unified
management mode, password hashes are stored only by the LAN user center; the
client never stores passwords and keeps login sessions only in the current
process. Offline mode has no account or user-center request. The user center is
for processing attribution; it does not encrypt local files, provide
organization IAM, recover forgotten passwords, or synchronize annotation data.

The runtime has no SSH or network recording-data path. Unified management mode
connects only to the configured LAN user center for login and to the automatic
update mirror at fixed `39.155.172.162:17879`, with `10.1.11.36:17879` as its
only LAN fallback; offline mode makes neither request. Clients never contact
GitHub or send account, source path, annotation, report, hash, or telemetry
data. The updater accepts only those configured origins and exact version paths,
then verifies the signed bytes independently. SSH was used only once to retrieve
the development sample from the current ext4 card. Ubuntu can mount
ext4 with the Linux kernel. The native deb can select any mounted path allowed
by the current user. The complete
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
  smpl_skeleton.npz       # optional local SMPL/skeleton coordinates
```

When present, the optional NPZ is read directly from the mounted source in Rust. Common
floating-point joint arrays shaped as `(frames,joints,XYZ)` or `(frames,XYZ,joints)` and
matching frame-ID arrays are supported. The viewer never copies or modifies this file;
invalid optional data is reported beside the viewer without blocking camera playback.

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
matching frames from all five streams. Trimming never changes captured data;
saving the associated annotation may refresh `description.json`. Clipped output names include `_frames_10-19` after either the trajectory
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

The importer retained for formal/development stress sanitizes every path
component and stops before copying when two source paths would collide after
Windows case folding or filename replacement. Its manifest keeps `sourcePath`
for the original relative path and `path` for the local Windows-safe path; the
stable dataset BLAKE3 remains based on source paths. The normal UI does not run
this importer.

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
on the login screen; refreshing the page resets demo accounts, tasks, and
annotations:

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

This runs the frontend production build, operation-ownership and issue-location
regression fixtures, Rust format check, Clippy with warnings denied, and the
regular Rust suite. Every run writes an ignored JSON evidence report under
`artifacts/release-check/`.

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

`.github/workflows/release.yml` runs after CI succeeds on `main`. A coordinated
release-ready commit updates `package.json`, Cargo, Tauri, and Changelog; the
workflow creates the missing annotated `vX.Y.Z` tag with the repository
`GITHUB_TOKEN`. Every commit entering `main` must carry one new version, and no
separate feature or release commit is used. It builds Windows x64, macOS arm64,
and Ubuntu x64 on native GitHub-hosted runners. Windows uses reviewed,
hash-pinned FFmpeg and offline WebView2 inputs. The WebView2 evergreen redirect
only selects Tauri's cache key; the bytes placed there and embedded in NSIS are
the exact reviewed payload. The macOS runner builds a minimal LGPL FFmpeg from
a pinned official source archive and commit.
The Ubuntu 22.04 runner installs and starts the generated deb.

The exact commit runs the full code and release-workflow gate once in CI. After
that succeeds, the release controller rechecks the immutable tag, main HEAD,
versions, and Changelog without repeating the full gate, so all three native
package jobs can start immediately. CI and package jobs use isolated Cargo
dependency caches keyed by platform, target, Rust toolchain, and Cargo inputs.
Workspace crates, incremental outputs, installers, seals, and verification
reports are not cached; every installer is rebuilt, packaged, and verified.

Every release requires a unique, dated, non-empty entry for the current version
at the top of the dated entries in `CHANGELOG.md`. The release gate rejects
missing, duplicate, stale, invalid-date, empty, or placeholder entries before
tag creation, and the publish job includes the curated entry directly in the
GitHub Release body.

The Windows job verifies that DOHC assets have no Authenticode signature. The
macOS jobs apply and strictly verify a local ad-hoc seal, reject Developer ID or
notarization claims, and run a policy check under synthetic quarantine. If a
GitHub runner's XProtect service is unavailable, the job requires the same
result from an independently built minimal control app and records that state;
a product-only XProtect error still fails. Both paths also check bundled FFmpeg,
offline WebView2 on Windows, installer or DMG contents, and an installed-copy
startup smoke. The final job recomputes all SHA-256 values, emits a release
manifest and GitHub provenance attestations, and publishes the draft only when
the complete three-installer set and all updater signatures match. Release
titles, asset names, notes,
reports, and the manifest all carry the `UNSIGNED` state because no trusted
publisher identity is present.

Each platform job also signs a bounded updater payload with a dedicated
Ed25519/Minisign key. The final job verifies those signatures with the public
key embedded in the application and emits `latest.json` only when all three
targets, payloads, signatures, sizes, and hashes agree. This updater signature
protects update integrity; it is distinct from Authenticode, Developer ID, or a
trusted Linux package signature, so the outer installers remain `UNSIGNED`.
Automatic tagging still uses only `GITHUB_TOKEN`; the updater signing secrets
are not GitHub App credentials.

The macOS host runs `scripts/update-mirror-server.mjs` as a `launchd` service on
`0.0.0.0:17879`. Every five minutes it synchronizes the immutable GitHub
release, verifies updater signatures and all installer hashes, then atomically
activates the version. Clients receive mirror URLs in `latest.json`; a partial
or tampered sync leaves the previous verified version available. The mirror
exposes only GET/HEAD and does not retain client identity or application data.
When an update is available, the application concurrently fetches a bounded
32 KiB range sample from the public and LAN mirror addresses, then downloads
from the faster successful path. The complete payload still passes the existing
exact-size and Minisign checks before installation.

The hosted-runner smoke does not replace clean Win10/Win11 offline testing,
target-Mac testing, physical exFAT SD-card validation, or the formal
100 GB/100,000-file run. Signing, notarization, and release operations are
documented in the
[Wiki release guide](https://github.com/Lr-2002/Delta-Viewer/wiki/Release-Operations).

Wiki source is reviewed under `docs/wiki/` and synchronized by
`.github/workflows/wiki.yml`; do not maintain divergent instructions directly
in the GitHub web editor.
