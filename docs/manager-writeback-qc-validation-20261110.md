# Cloud QC Download and Writeback Notification Validation

The 1.7.5 preview addressed a Windows TLS provider initialization failure in the signed BOS download path. Certificate validation, allowed-host checks, redirect rejection, download size limits, and SHA-256 verification remain enabled. A failed or cancelled transfer never opens an unverified directory.

Managed writeback notifications are deduplicated by stable command identity. This changes notification repetition only; it does not change durable queue state, acknowledgements, retry behavior, or the distinction between an accepted request and a confirmed writeback.

Regression tests used isolated fixtures. Historical read-only download evidence and production transaction details are kept outside the public repository. No service restart or production writeback is part of this current release work.
