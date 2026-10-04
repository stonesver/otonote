import json
from pathlib import Path
import shutil
import tempfile
import unittest

from tools import r2_state


class FakePrivateBucket:
    def __init__(self):
        self.objects = {}
        self.conflict_at_replace = False

    def read_small(self, key):
        data = self.objects.get(key)
        return None if data is None else (data, r2_state.digest(data))

    def put_small_new(self, key, data):
        if key in self.objects:
            return False
        self.objects[key] = data
        return True

    def replace_small(self, key, data, etag):
        existing = self.objects.get(key)
        if self.conflict_at_replace or (r2_state.digest(existing) if existing is not None else None) != etag:
            raise ValueError("private state pointer changed during checkpoint")
        self.objects[key] = data

    def put_file_new(self, key, path, sha, size):
        if key in self.objects:
            return False
        data = path.read_bytes()
        if len(data) != size:
            raise ValueError("source changed")
        self.objects[key] = data
        return True

    def verify_file(self, key, sha, size):
        data = self.objects.get(key)
        return data is not None and len(data) == size and r2_state.digest(data) == sha

    def download_file(self, key, target, sha, size):
        if not self.verify_file(key, sha, size):
            raise ValueError("private state object missing or damaged")
        target.write_bytes(self.objects[key])


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
        with self.assertRaisesRegex(ValueError, "restore allowlist"):
            r2_state.inspect(self.bucket, self.root, "global", ["input/global"])


if __name__ == "__main__":
    unittest.main()
