import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest

from tools import r2_content


class MemoryBucket:
    def __init__(self):
        self.objects = {}
        self.etags = {}
        self.counter = 0

    def get(self, key):
        if key not in self.objects:
            return None
        return self.objects[key], self.etags[key]

    def put_new(self, key, data, **_):
        if key in self.objects:
            return False
        self.counter += 1
        self.objects[key] = data
        self.etags[key] = f'"{self.counter}"'
        return True

    def replace(self, key, data, etag, **_):
        current = self.etags.get(key)
        if current != etag:
            raise ValueError("content pointer changed during publication")
        self.counter += 1
        self.objects[key] = data
        self.etags[key] = f'"{self.counter}"'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixture(root: Path, region="global", release_id="a" * 24, channel="production"):
    release = root / "releases" / release_id
    (release / "en").mkdir(parents=True)
    (release / "zh-CN").mkdir(parents=True)
    (release / "public" / "media").mkdir(parents=True)
    (release / "en" / "catalog.json").write_text("{}")
    (release / "zh-CN" / "catalog.json").write_text("{}")
    record = lambda locale: {"projection/catalog.json": {"path": locale + "/catalog.json",
                                            "sha256": sha(b"{}"), "bytes": 2}}
    manifest = {"schemaVersion": 1, "region": region, "channel": channel,
                "contentReleaseId": "sample",
                "root": f"/content/releases/{release_id}/",
                "locales": {locale: {"files": record(locale), "groups": {}}
                            for locale in ("en", "zh-CN")}}
    (release / "manifest.json").write_text(json.dumps(manifest))
    (release / "public" / "media" / "sample.webp").write_bytes(b"public image")
    files = {str(path.relative_to(release)): sha(path.read_bytes()) for path in release.rglob("*") if path.is_file()}
    (release / ".receipt.json").write_text(json.dumps({"schemaVersion": 1, "files": files}))
    pointer = {"schemaVersion": 1, "contentReleaseId": "sample", "manifest": f"/content/releases/{release_id}/manifest.json",
               "sha256": files["manifest.json"]}
    pointer_path = root / ("current.json" if region == "global" else "jp/current.json")
    pointer_path.parent.mkdir(parents=True, exist_ok=True)
    pointer_path.write_text(json.dumps(pointer))
    return pointer_path


class R2PublicationTests(unittest.TestCase):
    def test_new_object_readback_damage_prevents_manifest(self):
        class DamagedReadback(MemoryBucket):
            def get(self, key):
                result = super().get(key)
                if key.endswith("/en/catalog.json") and result is not None:
                    return b"damaged after upload", result[1]
                return result

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            bucket = DamagedReadback()
            with self.assertRaisesRegex(ValueError, "different bytes"):
                r2_content.upload_release(bucket, root, "global")
            self.assertIn("content/releases/" + "a" * 24 + "/en/catalog.json", bucket.objects)
            self.assertNotIn("content/releases/" + "a" * 24 + "/manifest.json", bucket.objects)
            self.assertNotIn("content/current.json", bucket.objects)

    def test_concurrent_upload_failure_never_writes_manifest(self):
        class ConcurrentDamage(MemoryBucket):
            def __init__(self):
                super().__init__()
                self.barrier = threading.Barrier(2, timeout=5)

            def get(self, key):
                if key.endswith(("/en/catalog.json", "/zh-CN/catalog.json")):
                    self.barrier.wait()
                result = super().get(key)
                if key.endswith("/en/catalog.json") and result is not None:
                    return b"damaged", result[1]
                return result

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            bucket = ConcurrentDamage()
            with self.assertRaisesRegex(ValueError, "different bytes"):
                r2_content.upload_release(bucket, root, "global", workers=2)
            self.assertNotIn("content/releases/" + "a" * 24 + "/manifest.json", bucket.objects)
            self.assertNotIn("content/current.json", bucket.objects)

    def test_concurrent_promote_failure_never_writes_journal_or_pointer(self):
        class ConcurrentMissing(MemoryBucket):
            def __init__(self, objects, etags):
                super().__init__()
                self.objects, self.etags = objects, etags
                self.barrier = threading.Barrier(2, timeout=5)

            def matches(self, key, expected_sha, expected_size):
                if key.endswith(("/en/catalog.json", "/zh-CN/catalog.json")):
                    self.barrier.wait()
                item = self.get(key)
                return (not key.endswith("/en/catalog.json") and item is not None
                        and len(item[0]) == expected_size and sha(item[0]) == expected_sha)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            original = MemoryBucket()
            r2_content.upload_release(original, root, "global")
            bucket = ConcurrentMissing(original.objects, original.etags)
            with self.assertRaisesRegex(ValueError, "incomplete"):
                r2_content.promote(bucket, root, "global", "none", source_run="test", workers=2)
            self.assertFalse(any(key.startswith("content/promotions/") for key in bucket.objects))
            self.assertNotIn("content/current.json", bucket.objects)

    def test_parallel_worker_count_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            for workers in (0, 17, True):
                with self.subTest(workers=workers):
                    with self.assertRaisesRegex(ValueError, "workers must be between"):
                        r2_content.upload_release(None, root, "global", dry_run=True, workers=workers)

    def test_preview_channel_cannot_enter_public_bucket(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, channel="preview")
            bucket = MemoryBucket()
            with self.assertRaisesRegex(ValueError, "content manifest"):
                r2_content.upload_release(bucket, root, "global")
            self.assertEqual(bucket.objects, {})

    def test_upload_then_promote_and_skip_private_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pointer = fixture(root)
            bucket = MemoryBucket()
            upload = r2_content.upload_release(bucket, root, "global", workers=2)
            self.assertEqual(upload["files"], 4)
            self.assertEqual(upload["uploaded"], 4)
            self.assertNotIn("content/releases/" + "a" * 24 + "/.receipt.json", bucket.objects)
            result = r2_content.promote(bucket, root, "global", "none", source_run="test-1", workers=2)
            self.assertEqual(result["status"], "published")
            self.assertEqual(bucket.objects["content/current.json"], pointer.read_bytes())
            self.assertEqual(r2_content.promote(bucket, root, "global", sha(pointer.read_bytes()), source_run="test-2")["status"], "unchanged")

    def test_dry_run_verifies_without_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            bucket = MemoryBucket()
            local = r2_content.upload_release(None, root, "global", dry_run=True)
            self.assertEqual(local["status"], "verified_local")
            self.assertEqual(bucket.objects, {})
            r2_content.upload_release(bucket, root, "global")
            before = dict(bucket.objects)
            ready = r2_content.promote(bucket, root, "global", "none",
                                       source_run="preview", dry_run=True)
            self.assertEqual(ready["status"], "ready")
            self.assertEqual(bucket.objects, before)

    def test_missing_remote_file_cannot_be_promoted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, "jp")
            bucket = MemoryBucket()
            r2_content.upload_release(bucket, root, "jp")
            del bucket.objects["content/releases/" + "a" * 24 + "/en/catalog.json"]
            with self.assertRaisesRegex(ValueError, "incomplete"):
                r2_content.promote(bucket, root, "jp", "none", source_run="test-1")
            self.assertNotIn("content/jp/current.json", bucket.objects)

    def test_stale_baseline_cannot_replace_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            bucket = MemoryBucket()
            r2_content.upload_release(bucket, root, "global")
            bucket.put_new("content/current.json", b"different", content_type="application/json", cache_control="no-store", sha256=sha(b"different"))
            with self.assertRaisesRegex(ValueError, "expected baseline"):
                r2_content.promote(bucket, root, "global", "none", source_run="test-1")
            self.assertEqual(bucket.objects["content/current.json"], b"different")

    def test_existing_immutable_key_with_different_bytes_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root)
            bucket = MemoryBucket()
            bucket.put_new("content/releases/" + "a" * 24 + "/en/catalog.json", b"wrong",
                           content_type="application/json", cache_control="immutable", sha256=sha(b"wrong"))
            with self.assertRaisesRegex(ValueError, "different bytes"):
                r2_content.upload_release(bucket, root, "global")

    def test_rollback_restores_previous_pointer_with_journal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = fixture(root).read_bytes()
            bucket = MemoryBucket()
            r2_content.upload_release(bucket, root, "global")
            r2_content.promote(bucket, root, "global", "none", source_run="first")
            second = fixture(root, release_id="b" * 24).read_bytes()
            r2_content.upload_release(bucket, root, "global")
            r2_content.promote(bucket, root, "global", sha(first), source_run="second")
            before = r2_content.baseline(bucket, "global")
            self.assertEqual(before["currentSha256"], sha(second))
            self.assertEqual(before["previousSha256"], sha(first))
            result = r2_content.rollback(bucket, "global", sha(second), source_run="revert")
            self.assertEqual(result["status"], "rolled_back")
            self.assertEqual(bucket.objects["content/current.json"], first)
            self.assertEqual(bucket.objects["content/previous.json"], second)
            self.assertIn(result["promotionJournal"], bucket.objects)

    def test_rollback_rejects_damaged_previous_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = fixture(root).read_bytes()
            bucket = MemoryBucket()
            r2_content.upload_release(bucket, root, "global")
            r2_content.promote(bucket, root, "global", "none", source_run="first")
            second = fixture(root, release_id="b" * 24).read_bytes()
            r2_content.upload_release(bucket, root, "global")
            r2_content.promote(bucket, root, "global", sha(first), source_run="second")
            del bucket.objects["content/releases/" + "a" * 24 + "/manifest.json"]
            with self.assertRaisesRegex(ValueError, "missing or damaged"):
                r2_content.rollback(bucket, "global", sha(second), source_run="revert")
            self.assertEqual(bucket.objects["content/current.json"], second)


if __name__ == "__main__":
    unittest.main()
