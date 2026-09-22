import datetime as dt
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("task_index", Path(__file__).with_name("task-index-server.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "Delta-D1"
        self.root.mkdir()
        self.out = Path(self.temp.name) / "Delta-Viewer-TaskIndex" / "Delta-D1"
        self.index = module.TaskIndex(self.root, self.out)

    def tearDown(self):
        self.temp.cleanup()

    def session(self, name, qc):
        path = self.root / name
        path.mkdir(parents=True, exist_ok=True)
        module.atomic_json(path / "session.json", {"qc": qc})
        return path

    def test_qc_index_lazy_shards_restart_incremental_and_pending(self):
        one = self.session("batch/one", "通过")
        self.session("batch/two", "不通过：任务不符")
        self.session("batch/three", "待审核")
        self.session("other/invalid", ["通过"])
        (one / "cam0").mkdir()
        (one / "cam0" / "session.json").write_text("not media")
        self.assertTrue(self.index.rebuild())
        self.assertEqual(self.index.nodes[""]["total"], 4)
        self.assertEqual(self.index.nodes[""]["reviewed"], 2)
        self.assertEqual(self.index.nodes[""]["errors"], 1)
        manifest = module.read_json(self.out / "index.json")
        self.assertEqual(set(manifest["nodes"]), {"", "batch", "other"})
        root = module.read_json(self.out / "nodes" / (manifest["nodes"][""] + ".json"))
        self.assertFalse(root["children"][0]["childrenLoaded"])
        self.assertEqual(root["children"][0]["children"], [])
        restarted = module.TaskIndex(self.root, self.out)
        restarted.load()
        completed = restarted.manifest["completedAtMs"]
        self.session("batch/one", "待审核")
        restarted.update({one})
        self.assertEqual(restarted.nodes[""]["reviewed"], 1)
        self.assertEqual(restarted.nodes["batch"]["reviewed"], 1)
        self.assertEqual(restarted.manifest["completedAtMs"], completed)
        generation = restarted.manifest["generation"]
        restarted.update({one})
        self.assertEqual(restarted.manifest["generation"], generation)

    def test_failed_full_scan_keeps_previous_completion_and_snapshot(self):
        self.session("batch/one", "通过")
        self.assertTrue(self.index.rebuild())
        before = (self.out / "index.json").read_bytes()
        with patch.object(self.index, "visit", side_effect=PermissionError("denied")):
            self.assertFalse(self.index.rebuild())
        self.assertEqual((self.out / "index.json").read_bytes(), before)
        self.assertIn("denied", module.read_json(self.out / "status.json")["error"])
        self.assertFalse(self.index.status["running"])

    def test_malformed_qc_and_symlink_are_not_counted_reviewed(self):
        one = self.session("batch/one", "通过")
        (one / "session.json").write_text("bad JSON")
        (self.root / "linked").symlink_to(one, target_is_directory=True)
        self.assertTrue(self.index.rebuild())
        self.assertEqual(self.index.nodes[""]["reviewed"], 0)
        self.assertTrue(self.index.nodes[""]["incomplete"])
        self.assertEqual(self.index.nodes[""]["errors"], 2)
        self.session("batch/one", "通过")
        self.index.update({one})
        self.assertTrue(self.index.nodes[""]["incomplete"], "incremental aggregation must preserve skipped links")
        self.assertEqual(self.index.nodes[""]["errors"], 1)

    def test_removed_session_during_visit_does_not_abort_rebuild(self):
        removed = self.session("batch/one", "待审核")
        self.session("batch/two", "通过")
        self.assertTrue(self.index.rebuild())
        visit = self.index.visit

        def delete_before_visit(path, nodes, depth=0):
            if path == removed:
                shutil.rmtree(path)
            return visit(path, nodes, depth)

        with patch.object(self.index, "visit", side_effect=delete_before_visit):
            self.assertTrue(self.index.rebuild())
        self.assertNotIn("batch/one", self.index.nodes)
        self.assertEqual(self.index.nodes[""]["total"], 1)
        self.assertEqual(self.index.nodes[""]["reviewed"], 1)
        self.assertEqual(self.index.status["error"], "")
        restarted = module.TaskIndex(self.root, self.out)
        restarted.load()
        self.assertNotIn("batch/one", restarted.nodes)

    def test_removed_subtree_discards_partially_scanned_nodes(self):
        one = self.session("batch/one", "通过")
        two = self.session("batch/two", "待审核")
        self.session("other/one", "不通过")
        visit = self.index.visit

        def delete_during_visit(path, nodes, depth=0):
            if path == two:
                self.assertIn("batch/one", nodes)
                shutil.rmtree(one.parent)
            return visit(path, nodes, depth)

        with patch.object(self.index, "visit", side_effect=delete_during_visit):
            self.assertTrue(self.index.rebuild())
        self.assertFalse(any(key.startswith("batch") for key in self.index.nodes))
        self.assertEqual(self.index.status["sessions"], 1)
        self.assertEqual(self.index.nodes[""]["total"], 1)

    def test_missing_root_keeps_previous_snapshot(self):
        self.session("batch/one", "通过")
        self.assertTrue(self.index.rebuild())
        before = (self.out / "index.json").read_bytes()
        shutil.rmtree(self.root)
        self.assertFalse(self.index.rebuild())
        self.assertEqual((self.out / "index.json").read_bytes(), before)

    def test_missing_file_error_with_existing_directory_is_not_ignored(self):
        one = self.session("batch/one", "通过")
        self.assertTrue(self.index.rebuild())
        before = (self.out / "index.json").read_bytes()
        visit = self.index.visit

        def fail_visit(path, nodes, depth=0):
            if path == one:
                raise FileNotFoundError("unexpected missing resource")
            return visit(path, nodes, depth)

        with patch.object(self.index, "visit", side_effect=fail_visit):
            self.assertFalse(self.index.rebuild())
        self.assertEqual((self.out / "index.json").read_bytes(), before)

    def test_watcher_detects_atomic_qc_replacement_and_ignores_media(self):
        one = self.session("batch/one", "通过")
        watcher = module.Watcher()
        try:
            watcher.add(one)
            self.session("batch/one", "不通过")
            (one / "video.mp4").write_bytes(b"fixture")
            dirty, overflow = watcher.drain()
            self.assertEqual(dirty, {one})
            self.assertFalse(overflow)
            (one / "video.mp4").write_bytes(b"next")
            self.assertEqual(watcher.drain()[0], set())
        finally:
            watcher.close()

    def test_schedule_uses_china_time_and_does_not_run_before_2300(self):
        for hour, expected in [(22, "2026-09-19T23:00:00+08:00"), (23, "2026-09-20T23:00:00+08:00")]:
            now = dt.datetime(2026, 9, 20, hour, 0, tzinfo=module.ZONE).timestamp()
            self.assertEqual(module.scheduled_cutoff(now), int(dt.datetime.fromisoformat(expected).timestamp() * 1000))

    def test_output_cannot_modify_dataset(self):
        with self.assertRaises(ValueError):
            module.TaskIndex(self.root, self.root / "index")


if __name__ == "__main__":
    unittest.main()
