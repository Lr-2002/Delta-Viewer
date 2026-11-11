# AP and Native Device Page Validation

This note summarizes the AP/Wi-Fi and embedded device-page work from the 1.7.1–1.7.2 preview iterations. Host addresses, local paths, process IDs, binary hashes, and raw device snapshots are kept in private diagnostics outside this repository.

The Windows path lists nearby Wi-Fi networks, recommends matching D1 hotspot names as a hint, and only changes the host connection after an explicit user action. The connection uses a temporary profile. The embedded device page is isolated from host IPC and external navigation; supported requests go through fixed Rust methods and bounded timeouts.

The code and browser fixtures cover hotspot selection, native-page rendering, navigation, and safe failure states. A complete real AP provisioning round trip was not established in that preview cycle. A fixture or a successful LAN read must not be presented as proof that AP provisioning works on every device.

Device configuration writes, OTA, remote log upload, and unrelated network discovery were not enabled by this validation. Device-side protocol or hardware changes require separate evidence and testing.
