"""Read-only NAS throughput and source-video diagnostics. Requires PyAV."""
import argparse
import json
import io
import statistics
import time
from pathlib import Path

import av


def measure_read(path, chunk_size, limit):
    started = time.perf_counter()
    total = 0
    latencies = []
    with path.open("rb", buffering=0) as source:
        while total < limit:
            tick = time.perf_counter()
            block = source.read(min(chunk_size, limit - total))
            latencies.append((time.perf_counter() - tick) * 1000)
            if not block:
                break
            total += len(block)
    elapsed = time.perf_counter() - started
    return {"chunkBytes": chunk_size, "bytes": total, "seconds": round(elapsed, 3),
            "MiBPerSecond": round(total / 1048576 / elapsed, 2),
            "readP95Ms": round(sorted(latencies)[int((len(latencies) - 1) * .95)], 2),
            "readMaxMs": round(max(latencies), 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--memory-decode", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((args.root / "manifest.json").read_text(encoding="utf-8"))
    report = {"root": str(args.root), "readOnly": True, "streams": []}
    for name, declared in manifest["streams"].items():
        if not declared.get("segments"):
            continue
        path = args.root / declared["segments"][0]["path"]
        row = {"stream": name, "declaredFps": declared["fps"],
               "declaredFrames": declared["frame_count"], "sizeBytes": path.stat().st_size}
        if name == "cam0" and not args.memory_decode:
            row["reads"] = [measure_read(path, size, 16 * 1048576)
                            for size in [8192, 1048576, 8192, 1048576]]
        started = time.perf_counter()
        timestamps = []
        try:
            media = str(path)
            if args.memory_decode:
                if path.stat().st_size > 256 * 1048576:
                    raise ValueError("Memory diagnostic is limited to 256 MiB per stream")
                with path.open("rb") as source:
                    media = io.BytesIO(source.read())
                row["readSeconds"] = round(time.perf_counter() - started, 3)
                started = time.perf_counter()
            with av.open(media) as container:
                stream = container.streams.video[0]
                stream.thread_type = "AUTO"
                row.update(codec=stream.codec_context.name, width=stream.width, height=stream.height,
                           mediaFps=float(stream.average_rate), mediaFrames=stream.frames,
                           durationSeconds=float(stream.duration * stream.time_base))
                for frame in container.decode(stream):
                    timestamps.append(float(frame.pts * frame.time_base))
                deltas = [b - a for a, b in zip(timestamps, timestamps[1:])]
                row.update(decodedFrames=len(timestamps), decodeSeconds=round(time.perf_counter() - started, 3),
                           nonIncreasingPts=sum(d <= 0 for d in deltas),
                           ptsMedianMs=round(statistics.median(deltas) * 1000, 3),
                           ptsMaxMs=round(max(deltas) * 1000, 3))
        except Exception as exc:
            row["error"] = str(exc)
        report["streams"].append(row)
        print(json.dumps(row), flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
