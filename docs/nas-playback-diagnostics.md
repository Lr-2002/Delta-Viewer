# NAS Playback Investigation

Investigation performed on Windows on 2026-09-07 against desktop 0.17.65.
The playback repair and native-clock changes are included in 0.17.66. The
measurements below describe local playback, not platform installation checks.

## Findings

- The running desktop executable predates the native presentation-clock changes
  in the working tree. The older player seeks against an independent UI timer
  when drift exceeds 80 ms, including during continuous primary playback.
- FramePanel started JPEG/FFmpeg fallback before native video discovery finished.
  Discovery/probing ran in synchronous Tauri commands, including NAS metadata
  operations and FFmpeg startup.
- MP4 responses used the small default `io::copy` buffer. The NAS catalog also
  rebuilt all row contents on every playback frame.
- The active `Oven_1` directory was no longer accessible during investigation.
  Tests therefore use the adjacent available `Oven_100`, not the original item.
- All five files in that sample decode completely with continuous video PTS.
  Camera 0 and T265 are 30 FPS; cameras 1 and 2 are natively 15 FPS. Their total
  video size is about 128.6 MB over 13 seconds, requiring about 79 Mbps.
- Source reads were variable: one 8 KiB read took about 909 ms, and a later
  6.46 MB T265 file read took 13.96 seconds. These are observations under the
  current workload, not a controlled cold-cache storage benchmark.
- Decoding the 13-second 4K stream from memory took 4.59 seconds, versus 29.0
  seconds including the earlier NAS access. This distinguishes source I/O from
  basic software decode capacity; it is not a GPU/WebView performance guarantee.
- Windows selected the 1 Gbps Ethernet adapter for the NAS. Other network
  traffic remained active; it was not stopped or reconfigured by this repair.

## Repair

- Wait for native discovery before starting fallback; move blocking discovery
  and probing to Tauri blocking workers.
- Use bounded 1 MiB transfers for the requested byte range, stop source reads
  when the player disconnects, and disable Nagle on the loopback response.
- Keep the native primary presentation clock, avoid redundant start/rate seeks,
  and handle segment endings and final completion explicitly. Older WebViews
  without presentation callbacks follow the video's own media time so their
  timeline also stops while the primary buffers.
- Require a short primary buffer runway at startup and after underflow.
  Auxiliary native streams pause while the primary buffers. Larger remaining
  secondary drift is corrected at most once per second and only into buffered
  content. Buffering does not write or copy source files to local storage.
- Memoize catalog rows while retaining current action handlers, keyboard
  activation, focus restoration, selection, and skip behavior.

## Reproduction

Run the synthetic native-video regression with an installed Chromium browser:

```powershell
node --test scripts/native-playback.test.mjs
```

For a read-only real sample, set `DOHC_MP4_SAMPLE_ROOT` to the episode directory.
The same test then checks actual five-camera videos and writes local evidence
under `artifacts/nas-playback/`. Its default media transport is a test Node
server; it must not be described as the production Rust transport.

To exercise the actual Rust range server, use a new local JSON path for
`DOHC_MEDIA_TEST_CONFIG` in both terminals, run the ignored
`serves_nas_sample_for_browser` Rust test, then the same JavaScript test. The
browser writes the matching `.done` file to stop the temporary Rust server.

`diagnose-nas-playback.py` accepts an episode path and `--output` local JSON
path. `--memory-decode` separates input reading from decoding and limits each
in-memory video to 256 MiB. No source files are modified.

## Local Verification Results

- `pnpm check`: passed, including frontend build, Clippy, 101 library tests,
  three example tests, and the configured JavaScript regression checks.
- Frame cache and clock: 29 tests passed. Delayed-frame rendering: two passed.
  Session selection/activation/focus: three passed.
- Native synthetic video: passed discovery, speed, seek, segment transition,
  end-of-recording, and replay checks with zero fallback requests.
- Real `Oven_100` through the production Rust loopback server: 7.0196 seconds
  of wall time advanced 7.0196 seconds of video, with zero primary underflows,
  zero seeks, and zero fallback requests in the measured playback interval.
  Camera 0 reported 222 total / 3 dropped frames; the other four streams
  reported 115/0, 115/0, 224/2, and 223/2. Media times differed by about 33 ms.
  This is a single local run with OS/browser caches and concurrent network
  workloads, not a guaranteed cold-NAS throughput result.

## Qualification Limits

The repair cannot eliminate stalls when sustained NAS throughput falls below
the combined video bitrate, or when a source directory is moved/disconnected.
The 15 FPS source streams cannot provide 30 distinct captured frames per second.
The private historical JPEG fixture used for full import/export qualification
is not present in this checkout. The 0.17.66 full check passed its shared build,
Clippy and unit-test stages but failed at private-sample availability. Full
import/export qualification is a release blocker until the fixture is supplied
and the check passes, or the maintainer explicitly accepts this missing-sample
exception. Platform installer checks remain the release workflow's responsibility.
