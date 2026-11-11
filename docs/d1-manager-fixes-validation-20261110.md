# D1 Manager Task Loading and Session Fixes

This note records the design and validation scope of the task-index and session-continuity fixes. Host details, account data, process identifiers, deployment paths, and raw service manifests are intentionally kept outside the public repository.

The task index is a derived local/server-side index. It must preserve the source audit log and existing task semantics while bounding queries to the relevant account and recent activity. Index recovery and append processing are tested without using production review records as fixtures.

Session continuity persists revocation and expiry state without storing bearer tokens or passwords in plaintext. Authentication still checks the current account state; an online-presence event is not treated as an audit action or review result.

The user-center task-index fix was applied through the previously authorized service procedure. This release work does not repeat that deployment or restart the service. The current release candidate must pass its own repository CI; historical service validation does not substitute for it.
