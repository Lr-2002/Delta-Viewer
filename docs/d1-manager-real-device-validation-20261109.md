# Real D1 Read-Only Validation

An earlier Windows preview was connected to a real D1 over its USB network link. The application read the device's fixed health/status interfaces and displayed the observed identity and health evidence. This was a read-only check; it did not change device configuration, run a device-side write command, or perform OTA.

The device self-reported identity is not cryptographic pairing. A reachable status page is not proof that every component is healthy, and a timeout or disconnect is not proof of hardware failure. Results apply only to the observation time and firmware returned by that device.

The diagnostic export was locally reviewed. No device log upload was performed. The historical raw report and device snapshot are retained outside the public repository because they may reveal operational details.

This record is not a cross-platform hardware certification. macOS and Ubuntu hardware discovery, multiple simultaneous devices, and a complete AP provisioning flow require separate validation.
