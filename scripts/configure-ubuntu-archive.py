#!/usr/bin/env python3
"""Use Ubuntu's primary archive on ephemeral GitHub build runners only."""

import argparse
import os
from pathlib import Path
import re
import stat
import tempfile


def configure(apt_root: Path) -> int:
    candidates = [apt_root / "sources.list"]
    source_dir = apt_root / "sources.list.d"
    if source_dir.is_dir():
        candidates.extend(sorted(source_dir.glob("*.list")))
        candidates.extend(sorted(source_dir.glob("*.sources")))
    changed = 0
    for path in candidates:
        if not path.exists() and not path.is_symlink():
            continue
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"Expected a regular apt source file: {path}")
        original = path.read_text()
        updated = re.sub(
            r"https?://azure\.archive\.ubuntu\.com/ubuntu(?=[/\s]|$)",
            "https://archive.ubuntu.com/ubuntu",
            original,
        )
        if updated == original:
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            os.replace(temporary, path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
        changed += 1
        print(f"Configured Ubuntu primary archive: {path.name}")
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apt-root", type=Path, default=Path("/etc/apt"))
    args = parser.parse_args()
    configure(args.apt_root.resolve(strict=True))
