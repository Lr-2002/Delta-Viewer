# Unified Manager Source and Delivery Record

On 2026-11-10 the D1 Manager UI/device work and the cloud-QC work were brought into one repository worktree so that a delivered version has one source state. The unified candidate carries forward the changes from the device workspace, cloud QC, task indexing, and Windows queue compatibility work.

The source workspaces and preview artifacts are retained in private diagnostics. This document deliberately omits local paths, branches, source archive hashes, device addresses, and preview binary fingerprints.

The 1.7.4–1.7.7 numbers describe preview iterations, not public Releases. The next release candidate uses a new version and must include all code, documentation, version files, and Changelog in one release-ready commit. The main CI and Release workflow create the annotated tag and complete Windows x64, macOS arm64, and Ubuntu x64 asset set. No single-platform or manual-tag release is valid.
