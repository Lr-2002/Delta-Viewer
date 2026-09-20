#!/usr/bin/env python3
"""NAS-local QC index. Python 3.8+, standard library only; media stays read-only."""
import argparse
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import struct
import time
import uuid

ZONE = dt.timezone(dt.timedelta(hours=8))
MAX_JSON = 8 * 1024 * 1024
COUNTS = ("total", "reviewed", "approved", "rejected", "errors")


def now_ms():
    return int(time.time() * 1000)


def scheduled_cutoff(timestamp):
    local = dt.datetime.fromtimestamp(timestamp, ZONE)
    cutoff = local.replace(hour=23, minute=0, second=0, microsecond=0)
    if local < cutoff:
        cutoff -= dt.timedelta(days=1)
    return int(cutoff.timestamp() * 1000)


def read_json(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Not a regular JSON file")
        data = source.read(MAX_JSON + 1)
        if len(data) > MAX_JSON:
            raise ValueError("JSON exceeds 8 MiB")
        return json.loads(data)


def atomic_json(path, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_JSON:
        raise ValueError("Index shard exceeds 8 MiB")
    temporary = path.with_name(".partial-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(str(temporary), 0o644)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def qc_status(path):
    try:
        value = read_json(path / "session.json")
    except FileNotFoundError:
        return "pending", ""
    except (ValueError, OSError) as error:
        return "error", "QC 读取失败: " + str(error)
    if not isinstance(value, dict):
        return "error", "session.json 不是对象"
    qc = value.get("qc")
    if qc is None:
        return "pending", ""
    if not isinstance(qc, str):
        return "error", "QC 结果无法识别"
    qc = qc.strip()
    if qc == "通过":
        return "approved", ""
    if qc == "不通过" or qc.startswith(("不通过：", "不通过:")):
        return "rejected", ""
    if qc in ("", "待审核", "未审核"):
        return "pending", ""
    return "error", "QC 结果无法识别"


class Watcher:
    # Directory watches see the atomic rename used by Viewer and SMB writers.
    MASK = 0x8 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x40 | 0x04000000 | 0x02000000

    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        self.paths = {}
        self.watched = set()

    def add(self, path):
        if path in self.watched:
            return
        wd = self.libc.inotify_add_watch(self.fd, os.fsencode(str(path)), self.MASK)
        if wd < 0:
            raise OSError(ctypes.get_errno(), "Cannot watch QC directories; check inotify limit")
        self.paths[wd] = path
        self.watched.add(path)

    def drain(self):
        dirty, overflow = set(), False
        while True:
            try:
                data = os.read(self.fd, 256 * 1024)
            except BlockingIOError:
                break
            offset = 0
            while offset < len(data):
                wd, mask, _, length = struct.unpack_from("iIII", data, offset)
                name = os.fsdecode(data[offset + 16:offset + 16 + length].split(b"\0", 1)[0])
                offset += 16 + length
                if mask & 0x4000:
                    overflow = True
                parent = self.paths.get(wd)
                if parent is not None:
                    if name == "session.json" or mask & 0x40000000 or mask & (0x400 | 0x800):
                        dirty.add(parent)
                    if mask & 0x8000:
                        self.watched.discard(parent)
                        self.paths.pop(wd, None)
        return dirty, overflow

    def close(self):
        os.close(self.fd)

    def retain(self, paths):
        for wd, path in list(self.paths.items()):
            if path not in paths:
                self.libc.inotify_rm_watch(self.fd, wd)
                self.paths.pop(wd, None)
                self.watched.discard(path)


class TaskIndex:
    def __init__(self, source, output, watcher=None):
        self.source = Path(source).resolve(strict=True)
        self.output = Path(output).resolve()
        if self.source == self.output or self.source in self.output.parents or self.output in self.source.parents:
            raise ValueError("Index must be outside the source dataset")
        self.output.mkdir(parents=True, exist_ok=True)
        self.objects = self.output / "nodes"
        self.objects.mkdir(exist_ok=True)
        self.watcher = watcher
        self.nodes = {}
        self.manifest = {"schemaVersion": 1, "dataset": self.source.name, "completedAtMs": 0,
                         "updatedAtMs": 0, "generation": "", "nodes": {}}
        self.status = {"running": False, "startedAtMs": 0, "heartbeatAtMs": 0,
                       "sessions": 0, "error": "", "schedule": "23:00 Asia/Shanghai"}
        self.last_progress = 0
        self.sessions = 0
        self.visited = 0
        self.last_attempt = 0
        self.request_stamp = None
        self.last_gc = 0

    def publish_status(self, **changes):
        self.status.update(changes)
        self.status["heartbeatAtMs"] = now_ms()
        atomic_json(self.output / "status.json", self.status)

    def load(self):
        try:
            manifest = read_json(self.output / "index.json")
        except FileNotFoundError:
            return
        if manifest.get("schemaVersion") != 1 or manifest.get("dataset") != self.source.name:
            raise ValueError("Index identity mismatch")
        nodes = {}
        for relative, digest in manifest["nodes"].items():
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("Invalid index hash")
            document = read_json(self.objects / (digest + ".json"))
            nodes[relative] = document
            for child in document["children"]:
                if child["session"]:
                    nodes[child["relativePath"]] = child
        self.manifest, self.nodes = manifest, nodes

    def node(self, path):
        relative = path.relative_to(self.source).as_posix()
        if relative == ".":
            relative = ""
        batch = relative.split("/")[0]
        return dict(name=path.name, relativePath=relative,
                    batchKey=hashlib.sha256((self.source.name.lower() + "\n" + batch).encode()).hexdigest(),
                    session=False, status="pending", error="", total=0, reviewed=0, approved=0,
                    rejected=0, errors=0, incomplete=False, scanning=False, childrenLoaded=True, children=[])

    def visit(self, path, nodes, depth=0):
        self.visited += 1
        if self.visited > 250000 or depth > 32:
            raise ValueError("Task directory limit exceeded")
        node = self.node(path)
        if path.is_symlink():
            node.update(error="跳过链接目录，统计不完整", errors=1, incomplete=True)
            nodes[node["relativePath"]] = node
            return node
        if self.watcher:
            self.watcher.add(path)
        qc = path / "session.json"
        if os.path.lexists(str(qc)):
            entries = []
            session = True
        else:
            entries = sorted(os.scandir(str(path)), key=lambda entry: entry.name)
            names = {entry.name for entry in entries}
            meta = path / ".session_meta"
            session = bool(names & {"states.jsonl", "manifest.json", "cam0"}) or (
                not meta.is_symlink() and os.path.lexists(str(meta / "manifest.json")))
        if session:
            status, error = qc_status(path)
            node.update(session=True, total=1, status=status, error=error,
                        approved=int(status == "approved"), rejected=int(status == "rejected"),
                        reviewed=int(status in ("approved", "rejected")), errors=int(status == "error"))
            self.sessions += 1
        else:
            for entry in entries:
                if entry.name.startswith(".") or entry.name in ("@eaDir", "#recycle", "Delta-Viewer-Previews", "Delta-Viewer-TaskIndex"):
                    continue
                if entry.is_dir(follow_symlinks=False) or entry.is_symlink():
                    child = self.visit(Path(entry.path), nodes, depth + 1)
                    node["children"].append(child)
            self.aggregate(node)
        nodes[node["relativePath"]] = node
        if time.monotonic() - self.last_progress > 2:
            self.last_progress = time.monotonic()
            self.publish_status(sessions=self.sessions)
        return node

    @staticmethod
    def aggregate(node):
        for key in COUNTS:
            node[key] = sum(child[key] for child in node["children"])
        node["errors"] += int(bool(node["error"]))
        node["incomplete"] = bool(node["error"]) or any(child["incomplete"] for child in node["children"])

    def publish(self, completed=False):
        mapping = {}
        for relative, node in self.nodes.items():
            if node["session"] and relative:
                continue
            shallow = dict(node, children=[dict(child, children=[], childrenLoaded=child["session"])
                                          for child in node["children"]])
            data = json.dumps(shallow, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            digest = hashlib.sha256(data).hexdigest()
            target = self.objects / (digest + ".json")
            if not target.exists():
                atomic_json(target, shallow)
            mapping[relative] = digest
        stamp = now_ms()
        manifest = dict(self.manifest, generation=uuid.uuid4().hex, updatedAtMs=stamp, nodes=mapping)
        if completed:
            manifest["completedAtMs"] = stamp
        atomic_json(self.output / "index.json", manifest)
        self.manifest = manifest
        if time.monotonic() - self.last_gc > 3600:
            # Only expired, hash-named objects created by this service are eligible.
            keep = set(mapping.values())
            try:
                for entry in self.objects.iterdir():
                    if entry.suffix == ".json" and len(entry.stem) == 64 and all(c in "0123456789abcdef" for c in entry.stem):
                        if entry.stem not in keep and not entry.is_symlink() and time.time() - entry.stat().st_mtime > 3600:
                            entry.unlink()
            except OSError:
                # Housekeeping failure must not roll back an already published generation.
                pass
            self.last_gc = time.monotonic()

    def rebuild(self):
        self.last_attempt = now_ms()
        self.sessions = self.visited = 0
        self.publish_status(running=True, startedAtMs=self.last_attempt, sessions=0, error="")
        previous = self.nodes
        try:
            nodes = {}
            self.visit(self.source, nodes)
            self.nodes = nodes
            self.publish(completed=True)
            if self.watcher:
                self.watcher.retain({self.source / relative for relative in nodes})
            self.publish_status(running=False, sessions=self.sessions, error="")
            return True
        except Exception as error:
            self.nodes = previous
            self.publish_status(running=False, error="统计失败: " + str(error))
            return False

    def update(self, paths):
        # Re-read changed QC from disk, never trust a client-supplied conclusion.
        changed = False
        for path in paths:
            relative = path.relative_to(self.source).as_posix()
            if relative == ".":
                relative = ""
            node = self.nodes.get(relative)
            if not node or not node["session"] or not path.is_dir() or path.is_symlink():
                continue  # New/removed directories are reconciled by a rebuild below.
            status, error = qc_status(path)
            if (node["status"], node["error"]) != (status, error):
                node.update(status=status, error=error, approved=int(status == "approved"),
                            rejected=int(status == "rejected"), reviewed=int(status in ("approved", "rejected")),
                            errors=int(status == "error"))
                changed = True
        if changed:
            # Loaded shards are shallow; re-link their immediate children before aggregation.
            for relative in sorted(self.nodes, key=lambda name: name.count("/") + bool(name), reverse=True):
                node = self.nodes[relative]
                if not node["session"]:
                    node["children"] = [self.nodes[child["relativePath"]] for child in node["children"]]
                    self.aggregate(node)
            self.publish()

    def run(self):
        try:
            self.load()
        except (ValueError, OSError, KeyError):
            # A corrupt cache must not prevent rebuilding it from authoritative QC.
            self.nodes = {}
        # Install watches from the last index, including session directories, without reading media.
        for relative in self.nodes:
            path = self.source / relative
            if path.is_dir() and not path.is_symlink():
                self.watcher.add(path)
        # Startup reconciliation covers edits while the service was stopped.
        request = self.output / "rebuild.request.json"
        try:
            self.request_stamp = request.stat().st_mtime_ns
        except FileNotFoundError:
            pass
        retry_needed = not self.rebuild()
        pending, last_flush, last_heartbeat = set(), time.monotonic(), time.monotonic()
        while True:
            select.select([self.watcher.fd], [], [], 1)
            dirty, overflow = self.watcher.drain()
            pending.update(dirty)
            try:
                stamp = request.stat().st_mtime_ns
            except FileNotFoundError:
                stamp = None
            requested = stamp is not None and stamp != self.request_stamp
            self.request_stamp = stamp
            nightly = (retry_needed or self.manifest["completedAtMs"] < scheduled_cutoff(time.time())) and now_ms() - self.last_attempt > 300000
            topology = any(not self.nodes.get("" if path == self.source else path.relative_to(self.source).as_posix(), {}).get("session") or not path.is_dir() or path.is_symlink() for path in pending)
            if overflow or requested or nightly or (topology and time.monotonic() - last_flush >= 10):
                pending.clear()
                retry_needed = not self.rebuild()
                last_flush = time.monotonic()
            elif pending and time.monotonic() - last_flush >= 2:
                try:
                    self.update(pending)
                except Exception as error:
                    self.publish_status(error="增量统计失败: " + str(error))
                pending.clear()
                last_flush = time.monotonic()
            if time.monotonic() - last_heartbeat > 10:
                self.publish_status()
                last_heartbeat = time.monotonic()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--index-root", required=True)
    parser.add_argument("--once", action="store_true")
    options = parser.parse_args()
    watcher = None if options.once else Watcher()
    index = TaskIndex(options.source_root, options.index_root, watcher)
    with (index.output / ".worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if options.once:
            index.load()
            if not index.rebuild():
                raise SystemExit(index.status["error"])
        else:
            index.run()


if __name__ == "__main__":
    main()
