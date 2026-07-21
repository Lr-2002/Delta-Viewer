# Local development sample

The private recording was copied from:

```text
host: dohc-dev (SSH alias hzhy)
source: /sdcard/2026-07-13 07:34:12
filesystem: ext4
local: data/raw/2026-07-13_07-34-12
```

All recording, import, and export directories under `data/` are excluded from
Git. Only this inventory document is tracked.

## Inventory

- 981 files, 80,531,730 bytes
- 196 valid `states.jsonl` records
- 196 JPEG frames in each of five streams
- `cam0`: 1920x1080 RGB
- `cam1`, `cam2`: 1280x720 RGB
- `t265_left`, `t265_right`: 848x800 grayscale
- zero missing frame IDs and zero JPEG decode failures

The sorted per-file aggregate SHA-256 calculated on the remote source and local
copy matched: `bfa75acf231acf180b417fe3b41813365642f8691258efb1f6c64bb0754b4b40`.
The importer dataset BLAKE3 is
`f5bc2dda9be850c0d89c88c1021ae8964f59592b7bad1db02159fdef24384727`.

The health checker reports one warning: frames 180-195 have state timestamp
intervals of roughly 170-369 ms, compared with a median interval of 33.9 ms.
This is retained as a recording-quality warning rather than hidden or repaired.
