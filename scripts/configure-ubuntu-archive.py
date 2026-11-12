#!/usr/bin/env python3
"""Use Ubuntu's primary archive on ephemeral GitHub build runners only."""

import argparse
import os
from pathlib import Path
import re
import stat
import tempfile
from urllib.error import URLError
from urllib.request import Request, urlopen

UBUNTU_ARCHIVE_CANDIDATES = (
    "https://us.archive.ubuntu.com/ubuntu",
    "https://mirrors.edge.kernel.org/ubuntu",
    "https://mirror.math.princeton.edu/pub/ubuntu",
    "https://ubuntu.osuosl.org/ubuntu",
    "https://mirror.csclub.uwaterloo.ca/ubuntu",
    "https://mirror.umd.edu/ubuntu",
    "https://archive.ubuntu.com/ubuntu",
)
UBUNTU_ARCHIVE_URL = re.compile(
    r"https?://(?:azure\.archive|archive|security)\.ubuntu\.com/ubuntu(?=[/\s]|$)"
)


def probe_archive(url: str) -> bool:
    request = Request(f"{url}/dists/noble/InRelease", method="HEAD")
    try:
        with urlopen(request, timeout=6) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def select_archive(probe=None, candidates=UBUNTU_ARCHIVE_CANDIDATES) -> str:
    probe = probe or probe_archive
    for url in candidates:
        if probe(url):
            return url
    raise RuntimeError("No configured Ubuntu archive mirror is reachable over HTTPS")


def configure(apt_root: Path, archive_url: str | None = None) -> int:
    # GitHub's mirror+file sources resolve through this list before apt downloads.
    candidates = [apt_root / "sources.list", apt_root / "apt-mirrors.txt"]
    source_dir = apt_root / "sources.list.d"
    if source_dir.is_dir():
        candidates.extend(sorted(source_dir.glob("*.list")))
        candidates.extend(sorted(source_dir.glob("*.sources")))
    source_files = []
    for path in candidates:
        if not path.exists() and not path.is_symlink():
            continue
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"Expected a regular apt source file: {path}")
        original = path.read_text()
        source_files.append((path, metadata, original))
    if archive_url is not None and archive_url not in UBUNTU_ARCHIVE_CANDIDATES:
        raise ValueError("Unsupported Ubuntu archive mirror")
    if archive_url is None and any(UBUNTU_ARCHIVE_URL.search(text) for _, _, text in source_files):
        archive_url = select_archive()
    if archive_url is None:
        return 0

    changed = 0
    for path, metadata, original in source_files:
        updated = UBUNTU_ARCHIVE_URL.sub(archive_url, original)
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
    parser.add_argument("--archive-url", choices=UBUNTU_ARCHIVE_CANDIDATES)
    args = parser.parse_args()
    configure(args.apt_root.resolve(strict=True), args.archive_url)
