# D1 Manager current feature manual

This manual is bundled for offline use. Illustrated lessons and interactive guides support Chinese and English, search, resume and restart. Screenshots labelled v1.11.6 illustrate the earlier layout; follow the controls and status in your running version.

## Getting started, accounts and shortcuts

Use Offline mode for local work or sign in with your configured user center. Save before signing out. Recover temporary connection failures as prompted rather than creating duplicate accounts. Switching language preserves inputs and current work.

From the data workspace toolbar, open Task Center, choose a data folder, view the review overview or check for updates. Open the avatar, name and username menu for shortcuts, documentation, version history and account actions. Accounts allowed to change their display name have an Edit button beside it. Offline mode has a workspace menu. Find operation errors under the diagnostics icon near the source path or in an error notice.

Open the account menu → Keyboard shortcuts to search, change, clear or restore bindings. Settings are stored on this computer per workspace mode, user center and account, not synchronized across computers. PageUp/PageDown navigate recordings without submitting decisions. Space plays or pauses; arrows step frames or parts, Home/End seek to boundaries and Minus/Equal change speed. Resolve conflicts before saving. Workspace actions are suppressed while typing, using dialogs or during blocked operations.

## Device connection and setup

Choose Type-C, the device AP hotspot or a LAN IP. After connection succeeds, use Device management, Device information or Diagnostics below the connection controls. Yellow notices explain the required user actions.

Device Management opens the current D1 web page in the Device Page tab. Use the language button on the device page. The page refreshes its own status. Select Refresh page to reopen the device home page. Application Upgrade opens the Manager update workflow. For guided steps within the device page, use the device controls and then select Continue.

AP runtime information depends on whether the installed firmware exposes a valid report. Configuration-only firmware shows its limitations. Submitting Wi-Fi settings can disconnect the hotspot. Follow device prerequisites before configuration or updates.

## Diagnostics, logs and updates

Run device diagnostics to obtain actual observations, timestamps and alerts. Unknown or stale does not mean healthy. The existing local diagnostic package contains observations and summaries, not automatically collected raw device logs.

The existing support-report upload is a separate, explicitly confirmed action. New D1 support-bundle reception to this computer and Agent questions are still being prepared and are unavailable in this version. The existing backend upload does not replace local bundle reception.

Device application updates and Manager updates have separate entry points. Device updates use SSH to the actual device IP for all three connection modes. Stop recording, self-test and stress tests; keep power and connectivity stable. Follow the reported voltage, temperature and runtime conditions and charge a low battery first. An up-to-date result requires no reinstall. Distinguish an OTA-origin timeout from a device connection failure. Transfer completion does not prove installation success: check the final running version and result.

The computer reads the update channel over its current network route. If connecting times out, check access to the update service. If the response times out, retry. Technical Details shows the request address and elapsed time.

## Loading and playback

Select a data folder on an SD card, external drive or NAS for direct reading. Check the loaded path, row states and operation history. Click to select, then double-click or use the keyboard to open a recording; a full copy is unnecessary. Full validation and export checks remain separate actions.

Views reflect actual source cameras with placeholders for missing streams. Use main-camera fill or fit, fullscreen, seeking, paused frame stepping, FPS and quality controls where available. Local speeds are 0.25×, 0.5×, 1×, 2×, 3×, 4×, 6× and 8×; outbound offers 0.25×, 0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×, 3×, 4×, 6× and 8×.

Fast browsing is optional and off by default. At 4× or higher it samples displayed frames without audio, preserving source resolution and all seven cameras. Pause for exact frame inspection or disable it for normal playback. Sustained reading and decoding limit the actual rate. Wait for buffering recovery or follow a specific retry message; selecting 8× does not guarantee 8× throughput.

Smooth local playback creates a local cache only after you request it. Follow actual progress and cancellation results. Source recordings are retained.

## Proofreading, annotation and special tags

Select the machine-annotation source and inspect actual timelines to split or adjust action boundaries, labels and reasons. Create special tags and retain custom common entries for later use. Language changes do not alter source names or submitted values.

Approve and Reject write real decisions. Handle unsaved drafts and verify acknowledgements before continuing. Navigation shortcuts do not submit reviews. Unknown frame timing is reported rather than guessed.

## Validation and export

Checks distinguish errors, warnings and passes and can locate issues or export a report. Interactive sampling is not evidence of full decoding. MCAP, HDF5 and LeRobot exports follow format availability and backend checks. Resolve blocking errors and choose an output directory.

## Local tasks and writeback

Task Center reads task summaries and directories, with claim, open and resume actions according to permission. Background synchronization retains the visible list. When opening a NAS batch, the progress display shows how many folders have been scanned. Locally pending NAS writeback differs from server-confirmed progress. Reconnect and verify the result before treating it as saved to the shared source.

## Cloud QC

Use configured batches that your account can access. Follow batch state for sampling, claims, playback and decisions while preserving original media and platform permissions. Follow the specific failure message instead of creating duplicate tasks for the same review.

## Outbound review

The task center syncs overall review progress with the batch list. The progress bar shows valid, invalid, anomalous and unreviewed recordings. The rate divides valid by reviewed recordings and counts each original once. Select Unreviewed to find batches with recordings awaiting a decision. Opening a filtered batch shows those recordings. Select Unreviewed again to restore the full list. Batches claimed by another reviewer retain their claim status.

The queue follows the configured Xingju company identity on the delivery platform. Claim and open enters the main workspace; each batch has independent busy state. Seven fixed camera positions keep the main view larger. MP4 parts share a continuous timeline with automatic transitions and cross-part seeking. Switching recordings releases old media reads and decoder resources.

If playback stops advancing, it tries once to reconnect at the current position. Use Reconnect videos if it still stalls at the same position. Missing files and read failures are shown separately; select a notice to open the affected part. Valid requires every source video present and ready. Anomalous and invalid decisions can be submitted with an accurate reason before video is ready; a buffering timeout alone does not prove damage. Anomalous and invalid have separate common-reason libraries with add, reorder and remove actions. Removing a common reason preserves historical decisions. Follow the notice if a service does not support anomalous decisions.

A successful first decision advances to the next pending item. Once the final decision is confirmed, the workspace and task list show a green Review complete badge, regardless of the pass rate. The batch stays claimed and its reviewer can reopen it. Revising a saved decision or reason updates counts and stays on the current item. Uncertain acknowledgements are checked read-only: do not repeatedly submit. Temporary outages retain the queue and recover; expired permission, missing sources and connection failures have distinct messages.

## Supervision and account management

Management opens on Review accounts for users with management permission. NAS writeback has a separate view for requests and receipts. The account menu opens the external review workbench and documentation, or returns to Test mode when permitted. Confirm the target and scope before changing account state, sending reminders or requesting writeback.

## Text corrections

Search and preview the original term, target and scope before applying changes. Inspect history or undo when appropriate. Confirm matches manually. Interface language changes do not rewrite user names, source paths or business content.

## Versions and updates

Open Versions and updates inside the app, choose automatic, company LAN or GitHub and check for updates. Inspect stable or candidate source, notes and current status. After download and verification, save work and explicitly choose whether to restart and install.

Manual installer download is separate from the updater. Choose an available platform and destination, then locate and run the completed installer yourself. Previews can offer only platforms already built. Version history provides past installers and rollback instructions. Download availability does not imply a stable release or a guarantee that all performance issues are resolved.


### Skeleton annotation sources

In Skeleton segments, use Skeleton annotation source to select the human result or a skeleton model export. Eligible JSON filenames contain `skeleton`; files are discovered in the recording root and `.session_meta`, with paths distinguishing duplicate names. Tencent skeleton-only output is `skeleton.description.tencent-custom.v1.json`. The selected source supplies segments for adding, deleting, editing and adjusting boundaries.

Human edits always save to the recording-root `skeleton.description.json`. Source files remain unchanged. Skeleton saves do not submit action review decisions or change QC. The human result opens by default; selecting another model loads its own segments rather than applying edits from a different source. Pending saves, failed saves and shared-file changes retain the existing conflict protection.
