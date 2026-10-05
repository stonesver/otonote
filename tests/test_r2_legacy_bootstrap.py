from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import r2_content, r2_legacy_bootstrap as legacy, r2_state


class MemoryPrivateBucket:
    def __init__(self):
        self.objects = {}

    def read_small(self, key):
        data = self.objects.get(key)
        return None if data is None else (data, r2_state.digest(data))

    def read_manifest(self, key):
        return self.read_small(key)

    def put_small_new(self, key, data):
        if key in self.objects:
            return False
        self.objects[key] = data
        return True

    def put_manifest_new(self, key, data):
        return self.put_small_new(key, data)

    def replace_small(self, key, data, etag):
        existing = self.objects.get(key)
        if (r2_state.digest(existing) if existing is not None else None) != etag:
            raise ValueError("private state pointer changed during checkpoint")
        self.objects[key] = data

    def put_file_new(self, key, path, sha, size):
        if key in self.objects:
            return False
        self.objects[key] = path.read_bytes()
        return True

    def verify_file(self, key, sha, size):
        data = self.objects.get(key)
        return data is not None and len(data) == size and r2_state.digest(data) == sha

    def download_file(self, key, target, sha, size):
        if not self.verify_file(key, sha, size):
            raise ValueError("private state object missing or damaged")
        target.write_bytes(self.objects[key])


def make_store(root: Path, *, global_id=None):
    store = root / "content"
    ids = dict(legacy.RELEASE_IDS)
    if global_id is not None:
        ids["global"] = global_id
    for region, release_id in ids.items():
        release = store / "releases" / release_id
        (release / "en").mkdir(parents=True)
        (release / "zh-CN").mkdir(parents=True)
        (release / "en" / "catalog.json").write_bytes(b"{}")
        (release / "zh-CN" / "catalog.json").write_bytes(b"{}")
        manifest = {"schemaVersion": 1, "region": region, "channel": "production",
                    "contentReleaseId": f"legacy-{region}",
                    "root": f"/content/releases/{release_id}/",
                    "locales": {"en": {}, "zh-CN": {}}}
        manifest_bytes = r2_state.canonical(manifest)
        (release / "manifest.json").write_bytes(manifest_bytes)
        files = {path.relative_to(release).as_posix(): r2_state.digest(path.read_bytes())
                 for path in release.rglob("*") if path.is_file()}
        (release / ".receipt.json").write_bytes(r2_state.canonical({"files": files}))
        pointer = {"schemaVersion": 1, "contentReleaseId": f"legacy-{region}",
                   "manifest": f"/content/releases/{release_id}/manifest.json",
                   "sha256": files["manifest.json"]}
        pointer_path = store / ("current.json" if region == "global" else "jp/current.json")
        pointer_path.parent.mkdir(parents=True, exist_ok=True)
        pointer_path.write_bytes(r2_state.canonical(pointer))
    return store


class LegacyBootstrapTests(unittest.TestCase):
    def test_seed_is_namespaced_and_restore_keeps_both_pins(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir).resolve()
            target = Path(target_dir).resolve()
            make_store(source)
            bucket = MemoryPrivateBucket()
            with patch.object(legacy, "RECORDED_ROOT", target):
                seeded = legacy.seed(bucket, source, workers=2)
                self.assertEqual(seeded["status"], "checkpointed")
                self.assertTrue(bucket.objects)
                self.assertTrue(all(key.startswith(legacy.NAMESPACE) for key in bucket.objects))
                self.assertNotIn("state/global/current.json", bucket.objects)
                with self.assertRaisesRegex(ValueError, "expected baseline"):
                    legacy.seed(bucket, source, workers=2)
                restored = legacy.restore(bucket, target, workers=2, free_bytes=10 * 1024**3)
                self.assertEqual(restored["status"], "restored")
                for region, expected_id in legacy.RELEASE_IDS.items():
                    release, _, _, _ = r2_content.sealed_release(target / "content", region)
                    self.assertEqual(release.name, expected_id)

    def test_wrong_release_is_rejected_before_private_upload(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir).resolve()
            make_store(source, global_id="b" * 24)
            bucket = MemoryPrivateBucket()
            with patch.object(legacy, "RECORDED_ROOT", Path(target_dir).resolve()):
                with self.assertRaisesRegex(ValueError, "exactly the two pinned releases"):
                    legacy.seed(bucket, source)
            self.assertEqual(bucket.objects, {})

    def test_modified_sealed_release_is_rejected_before_private_upload(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir).resolve()
            store = make_store(source)
            (store / "releases" / legacy.RELEASE_IDS["jp"] / "en/catalog.json").write_bytes(b"changed")
            bucket = MemoryPrivateBucket()
            with patch.object(legacy, "RECORDED_ROOT", Path(target_dir).resolve()):
                with self.assertRaisesRegex(ValueError, "inventory or digest mismatch"):
                    legacy.seed(bucket, source)
            self.assertEqual(bucket.objects, {})

    def test_missing_private_object_stops_restore_before_public_upload(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir).resolve()
            target = Path(target_dir).resolve()
            make_store(source)
            bucket = MemoryPrivateBucket()
            with patch.object(legacy, "RECORDED_ROOT", target):
                legacy.seed(bucket, source)
                object_key = next(key for key in bucket.objects if key.startswith(legacy.NAMESPACE + "state/objects/"))
                del bucket.objects[object_key]
                with self.assertRaisesRegex(ValueError, "missing or damaged"):
                    legacy.restore(bucket, target, free_bytes=10 * 1024**3)
                self.assertFalse((target / "content/current.json").exists())
                self.assertFalse((target / "content/jp/current.json").exists())
                self.assertFalse(list(target.glob(".r2-state-stage-*")))

    def test_capacity_check_precedes_any_download(self):
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            source = Path(source_dir).resolve()
            target = Path(target_dir).resolve()
            make_store(source)
            bucket = MemoryPrivateBucket()
            with patch.object(legacy, "RECORDED_ROOT", target):
                legacy.seed(bucket, source)
                with self.assertRaisesRegex(ValueError, "disk is too small"):
                    legacy.restore(bucket, target, free_bytes=1)
                self.assertFalse((target / "content").exists())


if __name__ == "__main__":
    unittest.main()
