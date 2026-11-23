# D1 Manager current feature manual

This manual is bundled for offline use. Illustrated lessons and interactive guides support Chinese and English, search, resume and restart. Screenshots labelled v1.11.6 illustrate the earlier layout; follow the controls and status in your running version.

## Getting started, accounts and shortcuts

Use Offline mode for local work or sign in with your configured user center. Save before signing out. Recover temporary connection failures as prompted rather than creating duplicate accounts. Switching language preserves inputs and current work.

From the data workspace toolbar, open Task Center, choose a data folder, view the review overview or check for updates. Open the avatar, name and username menu for shortcuts, documentation, version history and account actions. Accounts allowed to change their display name have an Edit button beside it. Offline mode has a workspace menu. Find operation errors under the diagnostics icon near the source path or in an error notice.

Open the account menu → Keyboard shortcuts to search, change, clear or restore bindings. Settings are stored on this computer per workspace mode, user center and account, not synchronized across computers. PageUp/PageDown navigate recordings without submitting decisions. Space plays or pauses; arrows step frames or parts, Home/End seek to boundaries and Minus/Equal change speed. Resolve conflicts before saving. Workspace actions are suppressed while typing, using dialogs or during blocked operations.

## Device connection and setup

Choose Type-C, the device AP hotspot or a LAN IP. After connection succeeds, use Device management, Device information or Diagnostics below the connection controls. Yellow notices explain the required user actions.

AP runtime information depends on whether the installed firmware exposes a valid report. Configuration-only firmware shows its limitations. Submitting Wi-Fi settings can disconnect the hotspot. Follow device prerequisites before configuration or updates.

## Diagnostics, logs and updates

Run device diagnostics to obtain actual observations, timestamps and alerts. Unknown or stale does not mean healthy. The existing local diagnostic package contains observations and summaries, not automatically collected raw device logs.

The existing support-report upload is a separate, explicitly confirmed action. New D1 support-bundle reception to this computer and Agent questions are still being prepared and are unavailable in this version. The existing backend upload does not replace local bundle reception.

Device application updates and Manager updates have separate entry points. Device updates use SSH to the actual device IP for all three connection modes. Stop recording, self-test and stress tests; keep power and connectivity stable. Follow the reported voltage, temperature and runtime conditions and charge a low battery first. An up-to-date result requires no reinstall. Distinguish an OTA-origin timeout from a device connection failure. Transfer completion does not prove installation success: check the final running version and result.

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

Task Center reads task summaries and directories, with claim, open and resume actions according to permission. Background synchronization retains the visible list. Locally pending NAS writeback differs from server-confirmed progress. Reconnect and verify the result before treating it as saved to the shared source.

## Cloud QC

Use configured batches that your account can access. Follow batch state for sampling, claims, playback and decisions while preserving original media and platform permissions. Follow the specific failure message instead of creating duplicate tasks for the same review.

## Outbound review

The queue follows the configured Xingju company identity on the delivery platform. Claim and open enters the main workspace; each batch has independent busy state. Seven fixed camera positions keep the main view larger. MP4 parts share a continuous timeline with automatic transitions and cross-part seeking. Switching recordings releases old media reads and decoder resources.

Valid requires every video ready. Confirmed missing, damaged or failed sources can be marked anomalous or invalid with an accurate reason; loading alone does not prove damage. Anomalous and invalid have separate common-reason libraries with add, reorder and remove actions. Removing a common reason preserves historical decisions. Follow the notice if a service does not support anomalous decisions.

A successful first decision advances to the next pending item. Once the final decision is confirmed, the workspace and task list show a green Review complete badge, regardless of the pass rate. The batch stays claimed and its reviewer can reopen it. Revising a saved decision or reason updates counts and stays on the current item. Uncertain acknowledgements are checked read-only: do not repeatedly submit. Temporary outages retain the queue and recover; expired permission, missing sources and connection failures have distinct messages.

## Supervision and account management

Management opens on Review accounts for users with management permission. NAS writeback has a separate view for requests and receipts. The account menu opens the external review workbench and documentation, or returns to Test mode when permitted. Confirm the target and scope before changing account state, sending reminders or requesting writeback.

## Text corrections

Search and preview the original term, target and scope before applying changes. Inspect history or undo when appropriate. Confirm matches manually. Interface language changes do not rewrite user names, source paths or business content.

## Versions and updates

Open Versions and updates inside the app, choose automatic, company LAN or GitHub and check for updates. Inspect stable or candidate source, notes and current status. After download and verification, save work and explicitly choose whether to restart and install.

Manual installer download is separate from the updater. Choose an available platform and destination, then locate and run the completed installer yourself. Previews can offer only platforms already built. Version history provides past installers and rollback instructions. Download availability does not imply a stable release or a guarantee that all performance issues are resolved.
