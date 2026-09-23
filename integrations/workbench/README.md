# Viewer Overview Integration

Viewer opens `/qc.html?viewer=overview` on the existing workbench service.
Apply `viewer-overview.patch` to the workbench's `qc-management.js` before
deploying Viewer 1.0.55. This is a static asset update; no worker restart or
database migration is needed.

The overview keeps the existing date/reviewer filters, efficiency timelines,
refresh, and CSV export. It skips account lookup and only issues GET requests
to `/api/qc/management`, using the existing LAN preview bootstrap without
forwarding account cookies. Other views and login controls are removed in this
mode. The normal `/qc.html` management page remains available to administrators.

The query parameter controls presentation, not server authorization. The
existing statistics API already permits reads without a user-center login;
administrative APIs retain their server-side account checks.

Opt-in browser verification (statistics are mocked, no account mutations):

```sh
WORKBENCH_TEST_ORIGIN=http://10.1.41.17:44587 node --test scripts/workbench-overview.test.mjs
```
