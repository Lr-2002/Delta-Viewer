# Device Page and Runtime Status Validation

The 1.7.6 preview hardened the embedded device page with a host handshake, bounded waits, isolated navigation, a fixed API allowlist, and shared task cancellation. Device configuration writes remain method/path/field constrained and require explicit confirmation; protected camera calibration fields are re-read and compared before a save.

The Chinese runtime panel derives status from the device's existing status/health response. It preserves unknown, stale, unsupported, and not-run states and does not invent thresholds or claim that an old device-side test ran during the current session. A Type-C port occupied by the host connection is shown as a connection limitation for the affected camera.

Browser regression covered initial page loading, repeated configuration navigation, stale status, missing fields, and narrow viewports using isolated fixtures. A prior fixed read from a real device confirmed the response was reachable at that observation time; it did not validate a full configuration write or AP provisioning workflow. Raw device responses and target-machine details remain outside this repository.
