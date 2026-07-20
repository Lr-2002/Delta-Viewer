Do not place binaries here manually.

Use scripts/stage-ffmpeg.ps1 on Windows or scripts/stage-ffmpeg.sh on macOS.
The scripts verify the expected SHA-256, architecture, mpeg4 encoder, license
input, and build metadata before publishing the ignored staged resources.

Formal bundles require a reviewed portable FFmpeg build. A macOS manifest
created with --allow-nonportable is only suitable for a local debug bundle.
