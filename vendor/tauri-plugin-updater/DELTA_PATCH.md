# Delta Viewer patch

Upstream: tauri-plugin-updater 2.10.1, crates.io archive SHA-256
`806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af`.
Repository: https://github.com/tauri-apps/plugins-workspace
License: Apache-2.0 OR MIT (included).

Only production modification: `src/updater.rs` replaces the updater metadata
response's unbounded `res.json()` with a 1 MiB streaming bound that checks both
Content-Length and accumulated chunked bytes before parsing the same JSON.
The plugin still owns its original Windows/macOS/Linux installation and
signature verification. Public APIs and platform behavior are unchanged.

Delta Viewer first fetches/validates the exact official Release manifest with
its own bound, then pins this plugin's read to that immutable tag and compares
the entire parsed manifest. The second read must not bypass the memory limit.
This patch adds no dependency or native library. Cargo uses this source through
`[patch.crates-io]`; keep this bound or replace it with an upstream equivalent
when upgrading. Platform size/launch checks remain in the release workflow.

Only Rust source, build/ACL inputs, API script, manifest, README and licenses are
vendored; package-manager outputs, upstream test assets and generated artifacts
are excluded.
