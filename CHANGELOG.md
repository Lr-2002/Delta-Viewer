# DOHC Viewer Changelog

Application releases use immutable annotated Git tags created automatically
after `main` CI succeeds for a coordinated version change.

## Unreleased

## 0.17.62 - 2026-08-25

- Add a login-page action for re-importing a refreshed LAN user-center
  configuration after the service host address changes, while preserving the
  existing TLS health and same-service-ID migration gates.
- Keep the configuration refresh action with the secondary login links below
  the form, including wrapping behavior for narrow diagnostic viewports.

## 0.17.61 - 2026-08-24

- Route every manifest-backed MP4 stream through its own tokenized,
  loopback-only HTTP Range source so Camera 1, Camera 2 and both T265 views use
  continuous native decoding instead of the throttled frame-preview fallback.
- Retry initial secondary-stream playback after the first seek or readiness
  transition, fixing Camera 1 and Camera 2 remaining paused until the operator
  manually paused and resumed the timeline.
- Keep Camera 0's established player, priming gate and fallback behavior
  unchanged; streams without native MP4 data continue to use the bounded,
  read-only per-frame compatibility path.

## 0.17.60 - 2026-08-24

- Refine the existing supervision cockpit without adding duplicate workflows:
  introduce a restrained operations palette, stronger navigation and data
  hierarchy, and clearer connected, success, warning and error states.
- Improve dense management surfaces across overview, assignment, alerts,
  quality and reports with consistent tables, charts, controls and responsive
  layouts for the supported desktop and narrow diagnostic viewports.
- Fix Windows source responsiveness probes by passing the selected path through
  a dedicated process environment value instead of appending it to PowerShell
  command text.
- Restore the Windows Rust release gate by embedding the Common Controls v6
  dependency in crate targets and making platform-specific test imports and
  collision fixtures portable.

## 0.17.59 - 2026-08-24

- Keep manually selected removable recordings visible for managed operators,
  while preserving assignment filtering for fixed/NAS roots, and support
  same-service user-center endpoint migration plus certificate-covered private
  LAN aliases for login without Internet access.
- Correct lower-FPS MP4 stream bounds on the shared timeline and make middle
  seeks reset and rebuild their own Camera 0 runway without waiting forever for
  nonexistent tail frames or secondary streams.
- Give Camera 0 a loopback-only, tokenized, read-only HTTP Range path for true
  continuous MP4 decoding without copying or modifying the mounted recording;
  retain bounded FFmpeg batch fallback with longer primary read-ahead,
  source-FPS cadence, secondary preview throttling, and catch-up-burst removal.
- Reduce playback main-thread work by deduplicating frame requests and native
  settlement state, memoizing frame tiles, and separating the telemetry trace
  from its per-frame playhead.

## 0.17.58 - 2026-08-21

- Load dated `hybrid-h264-jpeg-segment-v1` recording folders directly by
  combining their top-level camera MP4 manifest with nested T265 segment BIN
  images and poses on one batch-ID timeline.
- Carry the hybrid timeline's first batch ID into native MP4 playback and
  frame-extraction fallback, including 15 FPS streams on the 30 Hz pose clock,
  while preserving the existing legacy MP4 and standalone segment loaders.
- Validate the complete mounted `/media/descfly/DOHC1TB` batch: all 15 sealed
  hybrid recordings scan, load and sample without format errors; the legacy MP4
  remains discoverable, and three interrupted `jpeg-stream-v1` recordings that
  contain only partial/zero-length outputs are reported as invalid data without
  crashing.

## 0.17.57 - 2026-08-21

- Recognize folders containing any positive number of `segment-*.bin` files,
  sort their numeric suffixes numerically, and load all records as one
  continuous T265 episode while ignoring unrelated files.
- Parse the observed `DHSG`/`DHSC` little-endian record container, reuse the
  existing pose/JPEG models, and read JPEG frames on demand by indexed offset
  with payload and whole-record CRC32 verification.
- Report invalid names, sequence gaps, duplicate segment/frame numbers,
  truncation, malformed pose JSON, CRC failures and JPEG decode failures
  without crashing. Empty non-applicable camera streams no longer enter the
  segment playback wait set.
- Verify the loader against the mounted six-segment 1.385 GB production sample:
  10,229 poses and 10,229 frames per T265 eye, including first/last frame reads
  and fixed-percentile health validation.

## 0.17.56 - 2026-08-21

- Probe source directories in a bounded child process before scanning, loading,
  validation or supervision task discovery. An unresponsive hard NFS/SMB mount
  now fails after five seconds without trapping the desktop process in a
  filesystem syscall.
- Release the frontend operation state after source-probe failures so operator
  logout, source reconfiguration, local imports and retries remain available.
- Classify and display unresponsive network sources separately in local
  operation history without changing or uploading source data.

## 0.17.55 - 2026-08-21

- Add two batch assignment modes: allocate every episode from multiple selected
  task folders in one operation, or select multiple tasks and set an independent
  total quantity for each task before even or speed-weighted distribution.
- Validate batch totals against folder capacity and assignments held by
  unselected operators, and submit each selected operator's complete updated
  queue once per batch operation.
- Replace assignment deadline time points with date-only deadlines. Store the
  selected local date through the end of that day and label same-day deadlines
  as `今天` in administrator and operator views.

## 0.17.54 - 2026-08-20

- Add a privacy-bounded task operations cockpit with daily/cumulative/remaining
  totals, per-task and per-operator throughput, hourly and seven-day trends,
  completion estimates, connection freshness, and non-accusatory stagnation
  indicators. Segment and frame totals remain local to imported annotation JSON.
- Extend assignments with ordered, non-overlapping ranges, priority, deadline and
  pause state; add drag ordering, even or speed-weighted batch previews, and an
  atomic cross-account transfer operation protected by serialized state updates.
- Add an exception center with acknowledgement, notes, reassignment entry points
  and closure, plus administrator-only quality reviews and pass/rework history.
- Add privacy-safe JSON, CSV and printable HTML reports; improve the operator
  task drawer with current/next/remaining groups, continue/next actions, paused
  task filtering, playback shortcuts, and an explicit local-not-uploaded state.
- Cover concurrent range allocation, atomic transfer, alert lifecycle, quality
  persistence, allocation math and the full cockpit browser flow with regression
  tests.

## 0.17.53 - 2026-08-20

- Added rate-limited operator self-registration to the managed login screen;
  self-registration cannot request or create an administrator role, and
  concurrent account/state updates are serialized to prevent lost writes.
- Warn before assigning a task already held by another operator, and default
  scanned task quantities to all episodes currently available in the folder.
- Let a signed-in operator update their current display name while preserving
  the stable username used for assignments, audit ownership and supervision.

## 0.17.52 - 2026-08-19

- Add an operator task drawer with local source-folder setup, assigned task
  details and date-filtered personal annotation activity without uploading paths.
- Reuse existing task definitions when assignment names share their generated
  code prefix, preventing assigned tasks such as `oven` from failing at login.
- Show scanned folder totals in supervision assignment cards and add per-folder
  and per-task controls that safely fill the complete available quantity.
- Keep annotation descriptions on one aligned native selector, with an optional
  custom text field that saves on Enter or focus loss.

## 0.17.51 - 2026-08-19

- Advertise structured task-assignment support from the LAN user center and
  reject legacy services before assignment reads or writes.
- Verify that assignment save responses preserve every task name, quantity and
  total so an old server can no longer report a misleading successful save.

## 0.17.50 - 2026-08-19

- Fixed supervision assignments imported from task JSON being silently blocked
  unless the administrator also scanned a NAS task directory.
- Show assignment save errors and confirmations beside the save control, update
  the overview from the persisted server response, and keep NAS quantity bounds.

## 0.17.49 - 2026-08-18

- Anchor the three-dimensional skeleton heading to the initially displayed pose
  so later turns remain visible instead of changing the viewer's reference frame.
- Detect SMPL facing direction from the feet and COCO facing direction from the
  nose, including mirrored source coordinates and a corrected axis fallback.

## 0.17.48 - 2026-08-18

- Allocate non-overlapping per-task episode ordinal ranges centrally without
  transmitting NAS paths or episode identifiers to the user center.
- Store the mounted NAS task root only on each workstation; after its one-time
  setup, operator login automatically scans and opens only assigned episodes.
- Automatically select the matching assigned task when an operator moves between
  assigned video entries, while retaining imported descriptions as annotations.

## 0.17.47 - 2026-08-18

- Added an administrator-only, local JSON import for annotation supervision.
  The dashboard groups the latest annotation revision per episode by person and
  shows each person's tasks, trajectories, segments, and inclusive frame totals.
- Kept full annotation details out of the user-center audit API: imported JSON
  is parsed locally, bounded to 8 MiB and 20,000 records, and returns no source
  roots, fingerprints, descriptions, or segment text to the interface.

## 0.17.46 - 2026-08-18

- Made JPEG playback lossless and sequential: all five streams finish the
  current frame before the transport advances exactly one frame, allowing
  playback to slow down under I/O pressure instead of skipping images.
- Kept native MP4 playback continuous while retaining synchronized pause,
  seek, speed and timeline state.
- Replaced numeric-only supervision assignments with a detailed operator and
  task workbench that directly assigns scanned or imported named tasks, shows
  completion progress and overlapping assignees, and persists the exact list.
- Kept the existing task-completion catalog unchanged and made the detailed
  assignment workbench open only after selecting an operator, with an explicit
  close action returning to the normal supervision overview.
- Removed display of legacy numeric-only assignment totals and added a bounded
  quantity field to every selected task, persisting per-task allocation counts.
- Made task names dynamic from the selected JSON `tasks` array (`label`) or the
  scanned directory, and treat each imported `description` as its task annotation;
  selecting a directory remains optional and only adds completion counts.
- Keep the current imported task list session-local and replace it on every file
  import, so persisted annotations do not make tasks appear before a file is chosen.
- Added assigned-task frame totals to the account overview: `states.jsonl` rows
  provide total frames, while frames in episodes with `description.json` count
  as completed, filtered to each operator's assigned task names.
- Unified the account overview layout with fixed column proportions, centered
  metric values, and the date/frame-count explanation grouped under its title.
- Operators now load only their centrally assigned tasks on the normal work
  screen; missing local definitions are synchronized from the assigned task name
  and imported `description` so the tasks can be selected and saved immediately.

## 0.17.45 - 2026-08-17

- Added read-only discovery and synchronized preview-frame decoding for recorder
  sessions using `h264-split-mp4-v1`, including nested `pose` state records and
  the five different per-stream frame rates found on the `DOHC1TB` exFAT sample.
- Excluded hidden recorder benchmark/QC directories from source-root discovery
  and explicitly blocked the still-JPEG-only export adapters for MP4 sources.
- Stopped treating the expected 60 Hz state-axis versus per-stream MP4 frame-rate
  ratios as JPEG-style `COUNT_MISMATCH` warnings.
- Made MP4 preview try each available FFmpeg decoder and fall back from the
  bundled JPEG-focused binary when it cannot open H.264 MP4 input.
- Replaced per-frame FFmpeg process spawning during MP4 playback with five
  persistent native video elements synchronized to the shared state timeline;
  only manifest-listed canonical segment files enter the runtime media scope.
- Advanced health reports to format v7 after MP4 validation semantics changed,
  preventing stale v6 reports from failing atomic readback, and added a bounded
  10 FPS FFmpeg preview fallback for Linux WebKit installations without H.264.
- Added Ubuntu deb dependency and release gates for `gstreamer1.0-libav`, so apt
  installs WebKitGTK's H.264 decoder together with DOHC Viewer.
- Added `gstreamer1.0-vaapi` to Ubuntu installs while retaining libav fallback;
  decoder choice remains with WebKitGTK because globally forcing VA-API can break its renderer.
- Fixed native MP4 playback being immediately paused by an inverted condition,
  stopped background JPEG extraction while native video is active, and limited
  native seeking to paused timeline changes.
- Decoupled continuous MP4 decoding from React's state timeline by refreshing
  the surrounding review UI at 10 Hz while each native video retains its source FPS.
- Exposed each MP4 tile's actual native/buffering/fallback state and stopped a
  transient WebKit `play()` rejection from silently enabling frame extraction.
- Restored the original per-frame clock for JPEG recordings and made native MP4
  playback apply the selected timeline position both at play start and after metadata loads.

## 0.17.44 - 2026-08-17

- Added an administrator-only supervision dashboard for task assignments and completion metrics, plus an in-app history view for installed and prior release versions.

## 0.17.43 - 2026-08-17

- Updated browser regression flows to select the renamed “登录工作区” entry and assert that the retired offline entry stays unavailable, restoring CI coverage after unified login became mandatory.

## 0.17.42 - 2026-08-12

- Require every data user to sign in through the pinned-certificate LAN user center, upload an idempotent annotation audit event after each save, and expose administrator-only per-user task-count, operation-count, and annotation-duration totals for later KPI quality scoring.

## 0.17.41 - 2026-08-11

- Added local task-template JSON import with selectable, editable task descriptions
  and reusable segment-title choices; browser preview now selects the actual JSON
  file and imports every configured task.
- Kept segment timing entirely manual: templates no longer split an episode into
  inferred ranges, and operators apply titles after placing their own splits.
- Added `TRAJECTORY_POSITION_UNAVAILABLE` for state streams whose position is
  absent or entirely null, upgraded health reports to v6, and automatically
  skipped those records before annotation.

## 0.17.40 - 2026-08-11

- Updated browser regression flows to explicitly accept the annotation warning
  decision and to distinguish browser-demo saves from source `description.json`
  persistence.
- Restored focus to the session that opened the annotation warning after the
  operator continues or the confirmation load fails.

## 0.17.39 - 2026-08-11

- Mounted the read-only episode preview immediately after loading its states and
  stream index, allowing frame inspection while the health check continues.
- Kept validation as the gate for annotation and export, with failed or
  cancelled checks clearing the provisional preview.

## 0.17.38 - 2026-08-11

- Corrected the playback regression assertion for an unavailable current frame:
  it now verifies the immediate `FRAME_UNAVAILABLE` block instead of waiting
  for a frame counter that is intentionally unmounted with the session.

## 0.17.37 - 2026-08-11

- Updated playback regression coverage to verify that a runtime unavailable
  frame stops the session and records `FRAME_UNAVAILABLE`.

## 0.17.36 - 2026-08-11

- Updated browser playback regression coverage to accept the new warning gate
  before asserting synchronized image loading and playback behavior.

## 0.17.35 - 2026-08-11

- Persisted clip ranges and every segment's frame range, title and note in the
  source episode `description.json` alongside the overall task description.
- Upgraded source annotation metadata to format-v2 without changing capture
  fingerprints or the atomic write boundary.
- Blocked playback when the per-stream image precheck finds unavailable frames,
  added a reversible source-list skip action, and report runtime frame failures.
- Added a right-side annotation decision for every warning except
  `STATE_FRAME_GAP`; declining skips to the next record, while
  `TRAJECTORY_STATIC` skips annotation automatically.
- Added `TRAJECTORY_STATIC` state validation for trajectories with no position
  movement, and show the exact source metadata path after annotation saves.

## 0.17.34 - 2026-08-11

- Moved the fixed LAN update-mirror and user-center endpoints to `10.1.11.200`.
- Kept the public update mirror, ports, origin and signature verification gates unchanged.

## 0.17.33 - 2026-08-11

- Saved the editable task description to a format-v1 `description.json` in the
  episode root using verified, cross-platform atomic replacement.
- Kept `description.json` outside capture statistics and fingerprints so saving
  metadata does not invalidate health checks or annotation identity, while
  preserving it in explicit verified imports.
- Restricted source writes to the managed description file and report explicit
  failures when the source episode is not writable.

## 0.17.32 - 2026-08-10

- Changed source selection to a shallow session catalog that inspects each
  immediate directory once without walking image trees or collecting file
  metadata for every session.
- Added a fast annotation preview path that reads states and five stream file
  names first, then builds one reusable deep index during the health check.
- Added explicit pending, preview, and indexed list states while preserving the
  read-only source, source-change detection, and validation-gated export rules.

## 0.17.31 - 2026-08-10

- Added a bounded in-memory source index for mounted directories. Directory
  summaries, frame indexes, and their metadata fingerprint are reused only
  within the current process; validation and export still enforce a current
  source fingerprint.
- Started the read-only episode preview as soon as states and optional skeleton
  data load, while the health check continues in the background. The export
  action stays disabled until that check completes.
- Added browser coverage proving that five camera frames render during a
  pending validation task, without invoking the importer or copying source data.

## 0.17.30 - 2026-08-10

- Aligned SMPL and COCO source coordinates to a stable Y-up playback view so
  Z-up skeleton captures open standing instead of lying on their side.
- Added unit and browser regression coverage for upright framing, synchronized
  skeleton motion, orbit interaction, nonblank canvas pixels, and narrow layout.

## 0.17.29 - 2026-08-10

- Added guarded deletion for unused custom tasks while preserving built-in and
  referenced task definitions.
- Added full pre-copy validation to explicit imports, bounded black-screen
  detection, and report v5 median-FPS and frame-interval stability statistics.
- Embedded clipped segment annotations in MCAP, HDF5, and LeRobot outputs,
  returned the verified companion Metadata path, and enlarged the cam0 view.

## 0.17.28 - 2026-08-10

- Restored episode-list focus only after React commits the loading state that
  re-enables the target button, removing an intermittent activation race.
- Invalidated pending focus restoration when the workspace resets so an old
  session cannot receive focus after a mode or identity transition.

## 0.17.27 - 2026-08-10

- Persisted continuous segment ranges, editable names, notes, and clip bounds in
  append-only app-local annotation revisions without writing to source episodes.
- Added atomically published, read-back-verified Metadata JSON companions for
  annotated MCAP, HDF5, and LeRobot exports while preserving one video timeline.
- Kept normal session activation on the direct read-only source path and added
  browser coverage for segment save/restore, playback, and narrow-view overflow.

## 0.17.26 - 2026-08-07

- Replaced unconditional interval-based frame stepping with a render-aware
  playback clock that advances only after all five current camera frames have
  loaded or reported an error, keeping video and skeleton motion synchronized.
- Added regression coverage for ready-frame advancement, delayed-image holding,
  and clip-end clamping.

## 0.17.25 - 2026-08-06

- Allowed operating-system-mounted network volumes, including Windows mapped
  drives and SMB/NFS mounts, as read-only data sources for scanning, loading,
  fingerprinting, and explicit-import source validation.
- Kept source data read-only with no automatic copies or application-managed
  SSH, HTTP, cloud-storage, or NAS protocol connections.
- Kept import and export destinations on local filesystems so their capacity
  preflight and atomic no-replace publication guarantees remain unchanged.

## 0.17.24 - 2026-08-06

- Added a persisted workspace-mode choice for unified LAN account management or
  account-free offline work.
- Offline mode enters the local workspace without user-center requests, account
  controls, processor display, or automatic update checks; local annotations
  retain an internal offline-local provenance marker instead of a user account.
- Switching modes clears the active source, loaded episode, task state, and
  operation notices before entering the new workflow.
- Updated the playback browser regression to select unified management before
  registering its demo account.
- Updated the browser operation-ownership and dialog-recovery mocks to report
  their selected unified-management workspace mode before loading the workspace.
- Updated session-activation browser coverage to select unified management before
  opening its registration form.

## 0.17.20 - 2026-08-06

- Added optional local SMPL/skeleton NPZ loading with bounded Rust parsing,
  frame-ID synchronization, and non-blocking visible parse errors.
- Added an interactive Three.js skeleton viewer beside the five synchronized
  camera images on desktop, with a stacked layout on narrow windows.

## 0.17.19 - 2026-08-06

- Restored the continuous single-track time-trim controls after the compact
  segment workflow accidentally removed the export clip editor and its
  playback boundary behavior.
- Kept session-only segment drafting and its compact playback controls while
  making it explicit that segment notes do not replace the closed interval
  used by playback and export.

## 0.17.18 - 2026-08-04

- Integrated current-session segment drafting directly below synchronized
  playback, with timeline seeking, sequential “create to current frame” ranges,
  immediate note editing, deletion, and no source-card writes.
- Compacted episode annotation into the playback page with task, trajectory,
  description, processor, save status, and save action in a scan-friendly layout.
- Reused the main playback transport in the segment timeline and removed the
  separate segment tab, duplicate preview, trim control block, and playback rail.
- Added responsive browser regression coverage for segment creation, notes,
  camera rendering, console errors, and horizontal overflow.

## 0.17.17 - 2026-07-31

- Added a 30 FPS state-timeline health gate. It measures the median raw-nanosecond
  period per frame-ID-normalized adjacent state interval, accepts a ±5% tolerance, records the result in
  health report v4, and reports `FRAME_RATE_MISMATCH` for stable off-rate data.

## 0.17.16 - 2026-07-31

- Fixed the update mirror when GitHub's `releases/latest/download/latest.json`
  shortcut returns 404. The mirror now resolves only the fixed official latest
  Release API, derives the immutable semver tag, and retains the existing
  three-platform, size, SHA-256, and Minisign verification gates.

## 0.17.15 - 2026-07-31

- Added a LAN-only HTTPS user center on the current host at `10.1.11.36:17880`.
  The host administrator initializes the first admin and creates operator
  accounts; desktop clients import a pinned certificate configuration and do
  not store passwords.
- Added annotation and export provenance for capture time, annotation edits,
  edit duration, operator identity, export time, and exporter identity across
  MCAP, HDF5, and LeRobot metadata with readback verification.
- Added a one-command macOS LaunchAgent installer and deployment documentation
  for the user center, and removed the old client-side account creation path
  from the real desktop runtime.

## 0.17.14 - 2026-07-31

- Measured the fixed public and LAN update mirrors concurrently with a bounded
  32 KiB range request, then downloaded through the faster path while retaining
  the existing size and Minisign verification gates.

## 0.17.13 - 2026-07-31

- Aligned the time-trim selection rail with both range sliders on desktop and
  narrow layouts, including a regression check for the shared pixel bounds.

## 0.17.12 - 2026-07-30

- Moved automatic updates to the fixed public mirror and added a fixed LAN
  fallback with host-bound manifest rewriting, so internal clients do not
  depend on NAT loopback while all updater bytes remain size- and
  Minisign-verified.

## 0.17.11 - 2026-07-30

- Fixed Linux release startup by explicitly permitting the fixed local HTTP
  mirror in Tauri while retaining the fixed origin, bounded payload, and
  Minisign verification gates before installation.

## 0.17.10 - 2026-07-30

- Added an authenticated startup check that automatically downloads, verifies,
  installs, and restarts into a newer release through the fixed local mirror at
  `10.1.11.36:17879` on Windows x64, macOS arm64, and Ubuntu x86_64; clients no
  longer need GitHub access and mirror failures do not block local data work.
- Added a strict 64 MiB download bound, fixed-mirror URL validation, and a
  dedicated Ed25519/Minisign signature check before any update is installed.
- Extended Release CD to produce signed platform updater payloads and
  `latest.json`, plus a read-only mirror service that verifies and atomically
  caches the complete release while retaining the previous version on sync
  failure. Existing `0.17.8` installations require one manual `0.17.10` install
  from the mirror page before later versions can update automatically.
- Fixed the browser test Tauri contracts so their mocks include the
  automatic-update commands invoked after local login.
- Fixed the browser regression locator so the new update control cannot be
  mistaken for the data-health-check command.

## 0.17.8 - 2026-07-28

- Fixed Windows release packaging so Tauri's moving WebView2 cache key is
  populated with the exact reviewed offline installer instead of silently
  downloading a different upstream payload.
- Kept the embedded WebView2 SHA-256 and Microsoft Authenticode gates, and made
  hash mismatch failures report both expected and actual values.
- Superseded the unpublished `v0.17.7` release attempt, whose Windows payload
  gate correctly prevented a partial GitHub Release.

## 0.17.7 - 2026-07-28

- Added per-item failure logs for batch export, with an in-app error view and a
  direct action to reveal each log in the local file manager.
- Added an explicit “打开文件所在位置” action for every successful batch
  export, and documented the one-commit/one-tag release workflow.

## 0.17.6 - 2026-07-27

- Retired macOS Intel/x64 from future releases; CD now publishes Windows x64,
  macOS arm64, and the Ubuntu 22.04+ x86_64 deb as one verified set.
- Added authenticated batch export for locally annotated full episodes, with
  backend-trusted annotation selection, source fingerprint revalidation,
  per-item health gates and results, cancellation, and MCAP/HDF5/LeRobot support.

## 0.17.5 - 2026-07-27

- Made a unique, dated, non-empty `CHANGELOG.md` entry mandatory for every
  release and publish that curated entry directly in the GitHub Release notes.
- Ignore macOS AppleDouble `._*` and `.DS_Store` metadata consistently during
  source statistics, fingerprinting, frame validation, and explicit imports,
  while retaining errors for actual malformed JPEG frame names.
- Reduced repeat CI from 5 minutes 54 seconds to 2 minutes 59 seconds with
  isolated Rust dependency caches, and removed the duplicate full gate from CD
  while preserving every platform packaging and runtime verification.

## 0.17.4 - 2026-07-27

- Read and validate sessions directly from the mounted read-only source in the
  normal UI, without automatically creating app-local episode copies.
- Added locally creatable annotation tasks with editable descriptions and
  Rust-only atomic `{task-prefix}-{NNN}` trajectory assignment.
- Changed telemetry dimensions to stable red, green, blue, and purple series,
  while retaining labels and distinct line patterns for non-color distinction.

## 0.17.3 - 2026-07-27

- Refreshed the reviewed Microsoft WebView2 x64 offline-installer URL and
  SHA-256 after the upstream fixed link moved to a new signed payload.
- Superseded the unpublished `v0.17.2` tag, whose macOS and Ubuntu packages
  passed but whose Windows embedded-payload hash gate correctly blocked the
  complete GitHub Release.

## 0.17.2 - 2026-07-27

- Simplified Release CD to use the repository `GITHUB_TOKEN`, automatically
  create the immutable annotated version tag after successful `main` CI, and
  publish the complete four-installer draft without a dedicated release commit,
  GitHub App credentials, or release Environment.
- Routed rejected native export confirmations and destination pickers through the
  visible error and operation-history recovery path, while preserving successful
  export and report-export behavior.
- Made the mocked-Tauri dialog recovery suite a required browser CI gate so a
  missing browser cannot silently skip the regression coverage.
- Corrected stream-scoped issue locating so valid stream frames are selected
  without clamping to unrelated state bounds.
- Removed the Flatpak manifest, build script, verification script, and active
  packaging references. The Ubuntu 22.04+ x86_64 deb is the only supported
  Linux release asset, Ubuntu 20.04 has no v0.17.2 binary, and release assembly
  rejects unexpected Flatpak assets.

## 0.17.1 - 2026-07-22

- Kept native deb construction, `apt` installation, and startup verification on
  Ubuntu 22.04, while moving only the downstream GNOME 50 Flatpak packaging to
  Ubuntu 24.04's compatible `flatpak-builder`.
- Passed the verified Ubuntu 22.04 deb between isolated jobs and retained
  independent deb/Flatpak reports, attestations, and the five-installer atomic
  publication gate.
- Superseded the unpublished `0.17.0` tag, whose deb checks passed but whose
  combined Ubuntu 22.04 job was blocked when its older Flatpak builder could not
  invoke `appstream-compose` from the GNOME 50 SDK.

## 0.17.0 - 2026-07-22

- Added an unsigned native x86_64 deb as the preferred installer for Ubuntu
  22.04 and later, while retaining the GNOME 50 Flatpak for Ubuntu 20.04+
  compatibility.
- Fixed Linux release builds on Ubuntu 22.04 and added a real `apt` install,
  package/dependency inspection, bundled-resource validation, unresolved-library
  check, and 10-second Xvfb startup smoke for the generated deb.
- Expanded the atomic GitHub Release gate to require five verified installers,
  with independent deb and Flatpak reports, checksums, manifests, and build
  provenance before publication.

## 0.16.1 - 2026-07-22

- Hid the per-frame loading overlay while synchronized playback is running, so
  repeated `解码中` messages no longer obscure video. Paused loading feedback
  and explicit unavailable-frame errors remain visible.

## 0.16.0 - 2026-07-22

- Added Ubuntu 20.04+ x86_64 support through an unsigned Flatpak bundle using
  the pinned GNOME 50 runtime; the Ubuntu 24.04 `.deb` is retained only as the
  Flatpak build input.
- Added Linux `/proc/self/mountinfo` volume detection, removable-device
  classification, remote-volume rejection, and `vfat`/`msdos` FAT32 safeguards.
- Added reproducible Linux FFmpeg staging, Flatpak build/verification scripts,
  AppStream metadata, runtime permission checks, Xvfb startup smoke, and a
  four-installer release completeness gate.

## 0.15.3 - 2026-07-22

- Removed the second local-destination dialog. Selecting an SD card now creates
  a managed app-local-data workspace and automatically imports every discovered
  session, while preserving the source-path identity and per-session status in
  the left list.
- Added append-only local operation error history with the original platform
  message, stable error classification, source path, timestamp, and operator.
  Permission failures such as `Operation not permitted` remain available after
  the transient banner is closed or the app is restarted.

## 0.15.2 - 2026-07-21

- Kept strict macOS nested-code and sealed-resource verification while making
  the quarantined policy check portable to GitHub's macOS 15 runners.
- When `syspolicy_check` reports an internal XProtect error, the release gate
  now builds a separate minimal ad-hoc control app and accepts the runner state
  only if the same error occurs for that known-good control. Product-only
  XProtect or any signature/resource damage still blocks publication.
- Recorded policy-service availability and the control result in each macOS
  verification report and final release manifest. The `0.15.1` tag was blocked
  before publication, so users should install `0.15.2` or later.

## 0.15.1 - 2026-07-21

- Fixed the invalid macOS app resource seal in the `0.15.0` DMGs that could make
  Gatekeeper report that DOHC Viewer was damaged. The `0.15.0` macOS assets are
  superseded; its Windows installer is unaffected.
- Added an explicit ad-hoc seal for the macOS app, main executable, and bundled
  FFmpeg, including a post-signing FFmpeg hash in the bundled provenance
  manifest. This validates package integrity without claiming a trusted Apple
  Developer ID or notarization.
- Added strict nested-code and sealed-resource verification plus a quarantined
  Gatekeeper regression gate. macOS packages may now fail policy only for the
  expected ad-hoc identity and missing notarization, never for structural damage.

## 0.15.0 - 2026-07-21

- Added GitHub CD for explicitly unsigned Windows x64 NSIS and macOS arm64/x64
  DMG installers, with native install/startup smoke checks, complete-set
  publication, checksums, manifests, and build provenance.
- Added a reviewed `docs/wiki` user manual and automatic GitHub Wiki sync for
  installation, SD-card loading, validation, playback, annotation, export,
  privacy, troubleshooting, and release operations.
- Added pinned Windows FFmpeg/WebView2 inputs and reproducible minimal macOS
  FFmpeg source builds; all public assets and reports carry an `UNSIGNED`
  warning until Authenticode, Developer ID, and notarization are added.
- Fixed macOS packaging at macOS 12 or later, added headless DMG construction,
  and pinned the release Rust toolchain to 1.97.1.

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
