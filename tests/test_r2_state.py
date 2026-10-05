import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

from tools import r2_state


class FakePrivateBucket:
    def __init__(self):
        self.objects = {}
        self.conflict_at_replace = False
        self.upload_calls = []
        self.verify_calls = []
        self.download_calls = []

    def read_small(self, key):
        data = self.objects.get(key)
        return None if data is None else (data, r2_state.digest(data))

    def put_small_new(self, key, data):
        if key in self.objects:
            return False
        self.objects[key] = data
        return True

    def put_manifest_new(self, key, data):
        return self.put_small_new(key, data)

    def read_manifest(self, key):
        return self.read_small(key)

    def replace_small(self, key, data, etag):
        existing = self.objects.get(key)
        if self.conflict_at_replace or (r2_state.digest(existing) if existing is not None else None) != etag:
            raise ValueError("private state pointer changed during checkpoint")
        self.objects[key] = data

    def put_file_new(self, key, path, sha, size):
        self.upload_calls.append((key, sha, size))
        if key in self.objects:
            return False
        data = path.read_bytes()
        if len(data) != size:
            raise ValueError("source changed")
        self.objects[key] = data
        return True

    def verify_file(self, key, sha, size):
        self.verify_calls.append((key, sha, size))
        data = self.objects.get(key)
        return data is not None and len(data) == size and r2_state.digest(data) == sha

    def download_file(self, key, target, sha, size):
        self.download_calls.append((key, sha, size))
        data = self.objects.get(key)
        if data is None or len(data) != size or r2_state.digest(data) != sha:
            raise ValueError("private state object missing or damaged")
        target.write_bytes(data)


class R2StateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.bucket = FakePrivateBucket()
        (self.root / "output/global").mkdir(parents=True)
        (self.root / "input/global").mkdir(parents=True)
        (self.root / "output/global/state.json").write_text(
            json.dumps({"inputPlan": str(self.root / "input/global/plan.json")}), encoding="utf-8")
        (self.root / "input/global/plan.json").write_bytes(b'{"files": []}\n')
        self.paths = ["output/global", "input/global"]

    def tearDown(self):
        self.temp.cleanup()

    def _checkpoint(self, region="global", expected="none"):
        return r2_state.checkpoint(self.bucket, self.root, region, self.paths, expected)

    def _stored_manifest(self, region="global"):
        pointer = json.loads(self.bucket.objects[r2_state.pointer_key(region)])
        return json.loads(self.bucket.objects[pointer["manifest"]])

    def _replace_manifest(self, manifest, region="global"):
        manifest_bytes = r2_state.canonical(manifest)
        sha = r2_state.digest(manifest_bytes)
        key = f"state/manifests/{region}/{sha}.json"
        self.bucket.objects[key] = manifest_bytes
        self.bucket.objects[r2_state.pointer_key(region)] = r2_state.canonical({
            "schemaVersion": 1, "region": region, "manifest": key, "sha256": sha})

    def test_roundtrip_preserves_absolute_state_paths_at_same_root(self):
        result = self._checkpoint()
        self.assertEqual(result["status"], "checkpointed")
        self.assertEqual(result["files"], 2)
        self.assertIn("state/objects/", " ".join(self.bucket.objects))
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        restored = r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertEqual(restored["status"], "restored")
        state = json.loads((self.root / "output/global/state.json").read_text())
        self.assertEqual(state["inputPlan"], str(self.root / "input/global/plan.json"))
        self.assertTrue(Path(state["inputPlan"]).is_file())

    def test_idempotent_checkpoint_and_optimistic_pointer_conflict(self):
        first = self._checkpoint()
        second = self._checkpoint(expected=first["pointerSha256"])
        self.assertEqual(second["status"], "unchanged")
        (self.root / "input/global/plan.json").write_bytes(b'{"files": [1]}\n')
        with self.assertRaisesRegex(ValueError, "expected baseline"):
            self._checkpoint(expected="none")
        before = self.bucket.objects[r2_state.pointer_key("global")]
        self.bucket.conflict_at_replace = True
        with self.assertRaisesRegex(ValueError, "pointer changed"):
            self._checkpoint(expected=first["pointerSha256"])
        self.assertEqual(self.bucket.objects[r2_state.pointer_key("global")], before)

    def test_damaged_existing_object_never_advances_pointer(self):
        sha = r2_state.digest((self.root / "input/global/plan.json").read_bytes())
        self.bucket.objects[r2_state.object_key(sha)] = b"wrong"
        with self.assertRaisesRegex(ValueError, "missing or damaged"):
            self._checkpoint()
        self.assertNotIn(r2_state.pointer_key("global"), self.bucket.objects)

    def test_oversize_manifest_fails_before_any_r2_write(self):
        with patch.object(r2_state, "MANIFEST_LIMIT", 1):
            with self.assertRaisesRegex(ValueError, "manifest is too large"):
                self._checkpoint()
        self.assertEqual(self.bucket.objects, {})

    def test_damaged_remote_object_prevents_any_restore_file(self):
        self._checkpoint()
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        sha = r2_state.digest(b'{"files": []}\n')
        self.bucket.objects[r2_state.object_key(sha)] = b"corrupt"
        with self.assertRaisesRegex(ValueError, "missing or damaged"):
            r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertFalse((self.root / "output/global/state.json").exists())
        self.assertFalse((self.root / "input/global/plan.json").exists())

    def test_symlink_and_traversal_paths_are_rejected(self):
        (self.root / "output/global/link").symlink_to(self.root / "input/global/plan.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self._checkpoint()
        (self.root / "output/global/link").unlink()
        with self.assertRaisesRegex(ValueError, "unsafe checkpoint path"):
            r2_state.checkpoint(self.bucket, self.root, "jp", ["../other"], "none")

    def test_restore_rejects_wrong_root_and_changed_allowlist(self):
        self._checkpoint()
        with tempfile.TemporaryDirectory() as other:
            with self.assertRaisesRegex(ValueError, "another ROOT"):
                r2_state.restore(self.bucket, Path(other).resolve(), "global", self.paths)
        with self.assertRaisesRegex(ValueError, "restore allowlist"):
            r2_state.restore(self.bucket, self.root, "global", ["output/global"])

    def test_local_checkpoint_records_future_actions_root(self):
        with tempfile.TemporaryDirectory() as destination:
            actions_root = Path(destination).resolve()
            r2_state.checkpoint(self.bucket, self.root, "global", self.paths, "none", actions_root)
            self.assertEqual(self._stored_manifest()["root"], str(actions_root))
            with self.assertRaisesRegex(ValueError, "another ROOT"):
                r2_state.restore(self.bucket, self.root, "global", self.paths)
            r2_state.restore(self.bucket, actions_root, "global", self.paths)
            self.assertTrue((actions_root / "input/global/plan.json").is_file())

    def test_recorded_root_rejects_relative_or_noncanonical_path(self):
        for recorded in (Path("relative"), Path("/srv/other/../app")):
            with self.subTest(recorded=recorded):
                with self.assertRaisesRegex(ValueError, "recorded ROOT"):
                    r2_state.checkpoint(self.bucket, self.root, "global", self.paths, "none", recorded)

    def test_forged_manifest_cannot_escape_allowlist(self):
        self._checkpoint()
        pointer_key = r2_state.pointer_key("global")
        pointer = json.loads(self.bucket.objects[pointer_key])
        manifest = json.loads(self.bucket.objects[pointer["manifest"]])
        manifest["files"][0]["path"] = "../escape"
        manifest_bytes = r2_state.canonical(manifest)
        sha = r2_state.digest(manifest_bytes)
        key = f"state/manifests/global/{sha}.json"
        self.bucket.objects[key] = manifest_bytes
        pointer["manifest"], pointer["sha256"] = key, sha
        self.bucket.objects[pointer_key] = r2_state.canonical(pointer)
        with self.assertRaisesRegex(ValueError, "unsafe checkpoint path"):
            r2_state.restore(self.bucket, self.root, "global", self.paths)

    def test_regions_have_separate_pointers(self):
        self._checkpoint("global")
        self._checkpoint("jp")
        self.assertIn(r2_state.pointer_key("global"), self.bucket.objects)
        self.assertIn(r2_state.pointer_key("jp"), self.bucket.objects)
        self.assertEqual(r2_state.current_sha(self.bucket, "global"),
                         r2_state.digest(self.bucket.objects[r2_state.pointer_key("global")]))

    def test_inspect_reports_restore_size_without_downloading(self):
        self._checkpoint()
        report = r2_state.inspect(self.bucket, self.root, "global", self.paths)
        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["files"], 2)
        self.assertEqual(report["totalBytes"], sum(path.stat().st_size for path in (
            self.root / "output/global/state.json", self.root / "input/global/plan.json")))
        self.assertEqual(report["requiredBytes"], report["totalBytes"])
        with self.assertRaisesRegex(ValueError, "restore allowlist"):
            r2_state.inspect(self.bucket, self.root, "global", ["input/global"])

    def test_schema2_restores_original_hardlinks_and_reports_saved_space(self):
        source = self.root / "input/global/plan.json"
        linked = self.root / "input/global/plan-hardlink.json"
        os.link(source, linked)
        r2_state.checkpoint(self.bucket, self.root, "global", self.paths, "none", workers=2)
        manifest = self._stored_manifest()
        self.assertEqual(manifest["schemaVersion"], 2)
        entries = {entry["path"]: entry for entry in manifest["files"]}
        pair = [entries[name] for name in ("input/global/plan.json", "input/global/plan-hardlink.json")]
        self.assertEqual(sum("hardlinkTo" in entry for entry in pair), 1)
        self.assertEqual(next(entry["hardlinkTo"] for entry in pair if "hardlinkTo" in entry),
                         next(entry["path"] for entry in pair if "hardlinkTo" not in entry))
        report = r2_state.inspect(self.bucket, self.root, "global", self.paths)
        self.assertEqual(report["totalBytes"] - report["requiredBytes"], source.stat().st_size)
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        r2_state.restore(self.bucket, self.root, "global", self.paths, workers=2)
        self.assertEqual(source.stat().st_ino, linked.stat().st_ino)
        self.assertEqual(source.read_bytes(), linked.read_bytes())

    def test_equal_content_separate_files_remain_separate_after_restore(self):
        source = self.root / "input/global/plan.json"
        copy = self.root / "input/global/plan-copy.json"
        copy.write_bytes(source.read_bytes())
        self.assertNotEqual(source.stat().st_ino, copy.stat().st_ino)
        self._checkpoint()
        manifest = self._stored_manifest()
        entries = {entry["path"]: entry for entry in manifest["files"]}
        self.assertNotIn("hardlinkTo", entries["input/global/plan-copy.json"])
        report = r2_state.inspect(self.bucket, self.root, "global", self.paths)
        self.assertEqual(report["requiredBytes"], report["totalBytes"])
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertEqual(source.read_bytes(), copy.read_bytes())
        self.assertNotEqual(source.stat().st_ino, copy.stat().st_ino)

    def test_object_transfer_occurs_once_per_unique_content(self):
        source = self.root / "input/global/plan.json"
        (self.root / "input/global/plan-copy.json").write_bytes(source.read_bytes())
        os.link(source, self.root / "input/global/plan-hardlink.json")
        self._checkpoint()
        unique_content = {
            (r2_state.digest(path.read_bytes()), path.stat().st_size)
            for path in (source, self.root / "output/global/state.json")
        }
        self.assertEqual(len(self.bucket.upload_calls), len(unique_content))
        self.assertEqual(len(self.bucket.verify_calls), len(unique_content))
        self.assertEqual({(sha, size) for _, sha, size in self.bucket.upload_calls}, unique_content)
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertEqual(len(self.bucket.download_calls), len(unique_content))
        self.assertEqual({(sha, size) for _, sha, size in self.bucket.download_calls}, unique_content)

    def test_malformed_hardlink_reference_rejects_before_destination_write(self):
        source = self.root / "input/global/plan.json"
        os.link(source, self.root / "input/global/plan-hardlink.json")
        self._checkpoint()
        manifest = self._stored_manifest()
        alias = next(entry for entry in manifest["files"] if "hardlinkTo" in entry)
        alias["hardlinkTo"] = "input/global/missing.json"
        self._replace_manifest(manifest)
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        with self.assertRaises(ValueError):
            r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertFalse((self.root / "output/global/state.json").exists())
        self.assertFalse((self.root / "input/global/plan.json").exists())

    def test_schema1_manifest_remains_restorable(self):
        original = (self.root / "input/global/plan.json").read_bytes()
        self._checkpoint()
        manifest = self._stored_manifest()
        manifest["schemaVersion"] = 1
        self._replace_manifest(manifest)
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")
        report = r2_state.inspect(self.bucket, self.root, "global", self.paths)
        self.assertEqual(report["requiredBytes"], report["totalBytes"])
        r2_state.restore(self.bucket, self.root, "global", self.paths)
        self.assertEqual((self.root / "input/global/plan.json").read_bytes(), original)

    def test_concurrent_checkpoint_failure_never_writes_manifest_or_pointer(self):
        class FailingBucket(FakePrivateBucket):
            def __init__(self):
                super().__init__()
                self.barrier = threading.Barrier(2, timeout=5)

            def verify_file(self, key, sha, size):
                self.barrier.wait()
                return False if sha == failed_sha else super().verify_file(key, sha, size)

        failed_sha = r2_state.digest((self.root / "input/global/plan.json").read_bytes())
        bucket = FailingBucket()
        with self.assertRaisesRegex(ValueError, "missing or damaged"):
            r2_state.checkpoint(bucket, self.root, "global", self.paths, "none", workers=2)
        self.assertEqual(len(bucket.upload_calls), 2)
        self.assertFalse(any(key.startswith("state/manifests/") for key in bucket.objects))
        self.assertNotIn(r2_state.pointer_key("global"), bucket.objects)

    def test_concurrent_restore_failure_never_writes_destination(self):
        self._checkpoint()
        shutil.rmtree(self.root / "output")
        shutil.rmtree(self.root / "input")

        class FailingBucket(FakePrivateBucket):
            def __init__(self, objects):
                super().__init__()
                self.objects = objects
                self.barrier = threading.Barrier(2, timeout=5)
                self.failure_signaled = threading.Event()
                self.other_transfer_finished = threading.Event()

            def download_file(self, key, target, sha, size):
                self.barrier.wait()
                if sha == failed_sha:
                    target.write_bytes(b"partial")
                    self.failure_signaled.set()
                    raise ValueError("injected concurrent download failure")
                if not self.failure_signaled.wait(5):
                    raise AssertionError("other transfer did not fail")
                super().download_file(key, target, sha, size)
                self.other_transfer_finished.set()

        failed_sha = r2_state.digest(b'{"files": []}\n')
        bucket = FailingBucket(self.bucket.objects)
        with self.assertRaisesRegex(ValueError, "injected concurrent download failure"):
            r2_state.restore(bucket, self.root, "global", self.paths, workers=2)
        self.assertTrue(bucket.other_transfer_finished.is_set())
        self.assertFalse((self.root / "output/global/state.json").exists())
        self.assertFalse((self.root / "input/global/plan.json").exists())
        self.assertFalse(list(self.root.glob(".r2-state-stage-*")))

    def test_parallel_worker_count_is_bounded(self):
        for workers in (0, 17, True):
            with self.subTest(workers=workers):
                with self.assertRaisesRegex(ValueError, "workers must be between"):
                    r2_state.checkpoint(self.bucket, self.root, "global", self.paths,
                                        "none", workers=workers)


if __name__ == "__main__":
    unittest.main()
