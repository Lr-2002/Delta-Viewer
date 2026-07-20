# DOHC Viewer hdf5-pure patch

This directory vendors `hdf5-pure` 0.21.2 from crates.io. The published crate
checksum is `3ae0690844254fb750baa400ad696e909d7402b2e663440b9233a3775bc85dcc`
and its upstream Git revision is `fd294e947bbe4be219eb3ab8aac8047a7f4a220a`.

DOHC Viewer carries one narrow API patch:

- expose the existing `ChunkProvider` trait;
- add `DatasetBuilder::with_streamed_u8_data`, a checked wrapper around the
  crate's existing lazy raw-chunk writer.

No HDF5 serialization logic is forked or replaced. The wrapper fixes the
dataset to unfiltered one-dimensional `u8` chunks and requires the caller to
pad the final chunk. This lets DOHC Viewer stream concatenated JPEG payloads
without retaining an entire camera stream in memory.

The upstream MIT license is preserved in `LICENSE`.
