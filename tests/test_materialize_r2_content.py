import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from tools.materialize_r2_content import materialize


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Reader:
    def __init__(self):
        self.objects = {}
        self.control_reads = {}
        self.head_reads = []
        self.change_pointer_after = None
        self.downloaded = []

    def control(self, key):
        self.control_reads[key] = self.control_reads.get(key, 0) + 1
        if self.change_pointer_after == (key, self.control_reads[key]):
            return b'{"changed":true}'
        return self.objects.get(key)

    def list(self, prefix):
        return [(key, len(data)) for key, data in self.objects.items() if key.startswith(prefix)]

    def head(self, key):
        self.head_reads.append(key)
        data = self.objects.get(key)
        if data is None:
            return None
        return sha(data), len(data)

    def download(self, key, target):
        data = self.objects[key]
        self.downloaded.append(key)
        target.write_bytes(data)
        return sha(data), len(data)


def add_release(reader, region="global", release_id="a" * 24):
    prefix = f"content/releases/{release_id}/"
    files = {"en/catalog.json": b'{"cards":[]}', "zh-CN/catalog.json": b'{"cards":[]}'}
    files["public/gallery/manifest.json"] = b'{"schemaVersion":1}'
    files["public/gallery/stamps-1000000008.webp"] = b"loading art 1"
    files["public/gallery/stamps-1000000004.webp"] = b"loading art 2"
    files["public/gallery/title.webp"] = b"unrelated media"
    manifest = {"schemaVersion": 1, "region": region, "contentReleaseId": f"{region}-1",
                "root": "/" + prefix, "locales": {
                    locale: {"files": {"projection/catalog.json": {
                        "path": f"{locale}/catalog.json", "sha256": sha(files[f"{locale}/catalog.json"]),
                        "bytes": len(files[f"{locale}/catalog.json"]) }}, "groups": {}}
                    for locale in ("en", "zh-CN")}}
    files["manifest.json"] = json.dumps(manifest).encode()
    reader.objects.update({prefix + name: data for name, data in files.items()})
    pointer = {"schemaVersion": 1, "contentReleaseId": f"{region}-1",
               "manifest": "/" + prefix + "manifest.json", "sha256": sha(files["manifest.json"])}
    key = "content/current.json" if region == "global" else "content/jp/current.json"
    reader.objects[key] = json.dumps(pointer).encode()
    return files, key



def share_media(reader, release_id="a" * 24):
    prefix = f"content/releases/{release_id}/"
    shards = {}
    for key in list(reader.objects):
        if not key.startswith(prefix + "public/"):
            continue
        name = key[len(prefix):]
        data = reader.objects.pop(key)
        checksum = sha(data)
        reader.objects["content/blobs/" + checksum] = data
        h = sha(name.encode())[0]
        shards.setdefault(h, {})[name] = {"sha256": checksum, "bytes": len(data),
            "etag": '"verified"', "contentType": "image/webp"}
    descriptor = {"schemaVersion": 1, "layout": "shared-media-v1", "releaseId": release_id,
        "manifestSha256": sha(reader.objects[prefix + "manifest.json"]),
        "inventorySha256": "b" * 64, "shards": {}}
    for h, files in shards.items():
        raw = json.dumps({"schemaVersion": 1, "releaseId": release_id, "files": files}).encode()
        reader.objects[f"content/storage/{release_id}/{h}.json"] = raw
        descriptor["shards"][h] = {"sha256": sha(raw), "bytes": len(raw)}
    reader.objects[f"content/storage/{release_id}/descriptor.json"] = json.dumps(descriptor).encode()
    return descriptor

class MaterializeTests(unittest.TestCase):
    def test_shared_media_is_materialized_at_unchanged_logical_paths(self):
        reader = Reader()
        files, _ = add_release(reader)
        share_media(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = materialize(reader, root, ("global",))
            self.assertEqual(result["global"]["status"], "ready")
            for name in ("public/gallery/manifest.json", "public/gallery/stamps-1000000008.webp", "public/gallery/stamps-1000000004.webp"):
                self.assertEqual((root / "releases" / ("a" * 24) / name).read_bytes(), files[name])
                self.assertIn("content/blobs/" + sha(files[name]), reader.downloaded)
                self.assertNotIn("content/releases/" + "a" * 24 + "/" + name, reader.downloaded)
            downloads, heads = len(reader.downloaded), len(reader.head_reads)
            materialize(reader, root, ("global",))
            self.assertEqual(len(reader.downloaded), downloads)
            self.assertEqual(len(reader.head_reads), heads)

    def test_shared_storage_corruption_never_falls_back_to_direct_media(self):
        for damage in ("manifest", "shard", "blob"):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as temporary:
                reader = Reader()
                files, _ = add_release(reader)
                descriptor = share_media(reader)
                name = "public/gallery/stamps-1000000008.webp"
                reader.objects["content/releases/" + "a" * 24 + "/" + name] = files[name]
                if damage == "manifest":
                    descriptor["manifestSha256"] = "f" * 64
                    reader.objects["content/storage/" + "a" * 24 + "/descriptor.json"] = json.dumps(descriptor).encode()
                elif damage == "shard":
                    reader.objects["content/storage/" + "a" * 24 + "/" + sha(name.encode())[0] + ".json"] = b"{}"
                else:
                    reader.objects["content/blobs/" + sha(files[name])] = b"changed"
                with self.assertRaises(ValueError):
                    materialize(reader, Path(temporary), ("global",))
                self.assertFalse((Path(temporary) / "current.json").exists())

    def test_shared_optional_artwork_absent_is_skipped(self):
        reader = Reader()
        add_release(reader)
        reader.objects.pop("content/releases/" + "a" * 24 + "/public/gallery/stamps-1000000008.webp")
        share_media(reader)
        with tempfile.TemporaryDirectory() as temporary:
            result = materialize(reader, Path(temporary), ("global",))
            self.assertEqual(result["global"]["status"], "ready")
            self.assertFalse((Path(temporary) / "releases" / ("a" * 24) / "public/gallery/stamps-1000000008.webp").exists())

    def test_required_records_skip_head_and_downloads_are_bounded_parallel(self):
        class ConcurrentReader(Reader):
            def __init__(self):
                super().__init__()
                self.lock = threading.Lock()
                self.active = self.peak = 0
                self.concurrent = threading.Event()

            def download(self, key, target):
                with self.lock:
                    self.active += 1
                    self.peak = max(self.peak, self.active)
                    if self.active > 1:
                        self.concurrent.set()
                try:
                    if not self.concurrent.wait(2):
                        raise AssertionError("downloads never overlapped")
                    return super().download(key, target)
                finally:
                    with self.lock:
                        self.active -= 1

        reader = ConcurrentReader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            materialize(reader, Path(temporary), ("global",))
        self.assertGreater(reader.peak, 1)
        self.assertLessEqual(reader.peak, 8)
        self.assertEqual(len(reader.head_reads), 3)
        self.assertTrue(all("/public/gallery/" in key for key in reader.head_reads))
        self.assertNotIn("content/releases/" + "a" * 24 + "/manifest.json", reader.downloaded)

    def test_parallel_failure_joins_workers_and_preserves_pointer(self):
        class FailingReader(Reader):
            def __init__(self):
                super().__init__()
                self.lock = threading.Lock()
                self.active = 0
                self.concurrent = threading.Event()

            def download(self, key, target):
                with self.lock:
                    self.active += 1
                    if self.active > 1:
                        self.concurrent.set()
                try:
                    self.concurrent.wait(2)
                    if key.endswith("/en/catalog.json"):
                        raise ValueError("simulated download failure")
                    time.sleep(0.02)
                    return super().download(key, target)
                finally:
                    with self.lock:
                        self.active -= 1

        reader = FailingReader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "current.json").write_bytes(b"old pointer")
            with self.assertRaisesRegex(ValueError, "simulated download failure"):
                materialize(reader, root, ("global",))
            self.assertEqual(reader.active, 0)
            self.assertEqual((root / "current.json").read_bytes(), b"old pointer")
            self.assertEqual(list((root / "releases").iterdir()), [])

    def test_missing_required_record_does_not_replace_pointer(self):
        reader = Reader()
        add_release(reader)
        del reader.objects["content/releases/" + "a" * 24 + "/en/catalog.json"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "current.json").write_bytes(b"old pointer")
            with self.assertRaises(KeyError):
                materialize(reader, root, ("global",))
            self.assertEqual((root / "current.json").read_bytes(), b"old pointer")
            self.assertEqual(list((root / "releases").iterdir()), [])

    def test_limits_are_checked_before_any_download(self):
        for name in ("MAX_OBJECTS", "MAX_RELEASE_BYTES"):
            with self.subTest(limit=name), tempfile.TemporaryDirectory() as temporary:
                reader = Reader()
                add_release(reader)
                with patch("tools.materialize_r2_content." + name, 1):
                    with self.assertRaisesRegex(ValueError, "exceeds materialization limit"):
                        materialize(reader, Path(temporary), ("global",))
                self.assertEqual(reader.downloaded, [])
                self.assertFalse((Path(temporary) / "current.json").exists())

    def test_verified_receipt_reuses_both_regions_without_object_requests(self):
        reader = Reader()
        add_release(reader)
        add_release(reader, "jp", "b" * 24)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root)
            initial_heads = len(reader.head_reads)
            initial_downloads = len(reader.downloaded)
            self.assertGreater(initial_heads, 0)
            self.assertTrue((root / "releases" / ("a" * 24) / ".r2-materialization-receipt.json").is_file())
            self.assertTrue((root / "releases" / ("b" * 24) / ".r2-materialization-receipt.json").is_file())
            materialize(reader, root)
            self.assertEqual(len(reader.head_reads), initial_heads)
            self.assertEqual(len(reader.downloaded), initial_downloads)
            self.assertEqual(reader.control_reads["content/current.json"], 6)
            self.assertEqual(reader.control_reads["content/jp/current.json"], 6)
            self.assertEqual(reader.control_reads["content/releases/" + "a" * 24 + "/manifest.json"], 2)
            self.assertNotIn("content/releases/" + "a" * 24 + "/.r2-materialization-receipt.json", reader.objects)

    def test_pointer_change_invalidates_receipt_and_checks_objects_again(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            first_heads = len(reader.head_reads)
            pointer = json.loads(reader.objects["content/current.json"])
            pointer["newPublicationMarker"] = "same release, changed pointer"
            reader.objects["content/current.json"] = json.dumps(pointer).encode()
            materialize(reader, root, ("global",))
            self.assertGreater(len(reader.head_reads), first_heads)
            self.assertEqual((root / "current.json").read_bytes(), reader.objects["content/current.json"])
            second_heads = len(reader.head_reads)
            materialize(reader, root, ("global",))
            self.assertEqual(len(reader.head_reads), second_heads)

    def test_new_release_downloads_again_and_keeps_old_release(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            first_heads, first_downloads = len(reader.head_reads), len(reader.downloaded)
            add_release(reader, release_id="c" * 24)
            materialize(reader, root, ("global",))
            self.assertGreater(len(reader.head_reads), first_heads)
            self.assertGreater(len(reader.downloaded), first_downloads)
            self.assertTrue((root / "releases" / ("a" * 24)).is_dir())
            self.assertEqual((root / "current.json").read_bytes(), reader.objects["content/current.json"])

    def test_receipt_symlink_is_rejected_without_changing_pointer(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            receipt = root / "releases" / ("a" * 24) / ".r2-materialization-receipt.json"
            receipt.unlink()
            receipt.symlink_to(root / "current.json")
            heads = len(reader.head_reads)
            with self.assertRaisesRegex(ValueError, "invalid local materialization receipt"):
                materialize(reader, root, ("global",))
            self.assertEqual(len(reader.head_reads), heads)
            self.assertEqual((root / "current.json").read_bytes(), reader.objects["content/current.json"])

    def test_forged_required_file_and_receipt_still_fail_manifest_binding(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            release = root / "releases" / ("a" * 24)
            target = release / "en/catalog.json"
            tampered = b"x" * target.stat().st_size
            target.write_bytes(tampered)
            receipt_path = release / ".r2-materialization-receipt.json"
            receipt = json.loads(receipt_path.read_bytes())
            receipt["objects"]["en/catalog.json"] = {"sha256": sha(tampered), "bytes": len(tampered)}
            receipt_path.write_text(json.dumps(receipt))
            old_pointer = (root / "current.json").read_bytes()
            initial_heads = len(reader.head_reads)
            initial_downloads = len(reader.downloaded)
            with self.assertRaisesRegex(ValueError, "receipt differs from manifest"):
                materialize(reader, root, ("global",))
            self.assertEqual(len(reader.head_reads), initial_heads)
            self.assertEqual(len(reader.downloaded), initial_downloads)
            self.assertEqual((root / "current.json").read_bytes(), old_pointer)

    def test_final_remote_pointer_change_during_cached_run_keeps_both_local_pointers(self):
        reader = Reader()
        add_release(reader)
        add_release(reader, "jp", "b" * 24)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root)
            old_global = (root / "current.json").read_bytes()
            old_jp = (root / "jp/current.json").read_bytes()
            initial_heads = len(reader.head_reads)
            initial_downloads = len(reader.downloaded)
            # Initial run reads each pointer three times. The sixth JP read is
            # the final promotion check on the second, receipt-backed run.
            reader.change_pointer_after = ("content/jp/current.json", 6)
            with self.assertRaisesRegex(ValueError, "pointer changed before local promotion"):
                materialize(reader, root)
            self.assertEqual(reader.control_reads["content/jp/current.json"], 6)
            self.assertEqual(len(reader.head_reads), initial_heads)
            self.assertEqual(len(reader.downloaded), initial_downloads)
            self.assertEqual((root / "current.json").read_bytes(), old_global)
            self.assertEqual((root / "jp/current.json").read_bytes(), old_jp)

    def test_missing_receipt_requires_full_recheck_then_recreates_it(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            receipt = root / "releases" / ("a" * 24) / ".r2-materialization-receipt.json"
            receipt.unlink()
            first_heads = len(reader.head_reads)
            materialize(reader, root, ("global",))
            self.assertGreater(len(reader.head_reads), first_heads)
            self.assertTrue(receipt.is_file())

    def test_materializes_both_regions_and_reuses_existing_release(self):
        reader = Reader()
        global_files, global_key = add_release(reader)
        add_release(reader, "jp", "b" * 24)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outcome = materialize(reader, root)
            self.assertEqual(outcome["global"]["files"], len(global_files) - 1)
            self.assertEqual(outcome["jp"]["status"], "ready")
            self.assertEqual((root / "current.json").read_bytes(), reader.objects[global_key])
            self.assertTrue((root / "releases" / ("a" * 24) / "public/gallery/stamps-1000000008.webp").is_file())
            self.assertFalse((root / "releases" / ("a" * 24) / "public/gallery/title.webp").exists())
            self.assertNotIn("content/releases/" + "a" * 24 + "/public/gallery/title.webp", reader.downloaded)
            self.assertEqual((root / "jp/current.json").read_bytes(), reader.objects["content/jp/current.json"])
            self.assertEqual(materialize(reader, root)["global"]["status"], "ready")

    def test_tampered_record_does_not_replace_current(self):
        reader = Reader()
        _, key = add_release(reader)
        record_key = "content/releases/" + "a" * 24 + "/en/catalog.json"
        reader.objects[record_key] = b"x" * len(reader.objects[record_key])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "current.json").write_bytes(b"old pointer")
            with self.assertRaisesRegex(ValueError, "record differs"):
                materialize(reader, root, ("global",))
            self.assertEqual((root / "current.json").read_bytes(), b"old pointer")

    def test_unsafe_remote_path_is_rejected(self):
        reader = Reader()
        add_release(reader)
        manifest_key = "content/releases/" + "a" * 24 + "/manifest.json"
        manifest = json.loads(reader.objects[manifest_key])
        manifest["locales"]["en"]["files"]["projection/catalog.json"]["path"] = "en/../escape"
        reader.objects[manifest_key] = json.dumps(manifest).encode()
        pointer = json.loads(reader.objects["content/current.json"])
        pointer["sha256"] = sha(reader.objects[manifest_key])
        reader.objects["content/current.json"] = json.dumps(pointer).encode()
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "unsafe public content path"):
                materialize(reader, Path(temporary), ("global",))

    def test_pointer_change_preserves_old_pointer(self):
        reader = Reader()
        add_release(reader)
        reader.change_pointer_after = ("content/current.json", 2)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "current.json").write_bytes(b"old pointer")
            with self.assertRaisesRegex(ValueError, "pointer changed"):
                materialize(reader, root, ("global",))
            self.assertEqual((root / "current.json").read_bytes(), b"old pointer")

    def test_missing_jp_never_keeps_stale_local_jp(self):
        reader = Reader()
        add_release(reader)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "jp").mkdir()
            (root / "jp/current.json").write_bytes(b"old")
            with self.assertRaisesRegex(ValueError, "while a local JP pointer exists"):
                materialize(reader, root)

    def test_existing_corruption_cannot_be_reused(self):
        for name in ("en/catalog.json", "public/gallery/stamps-1000000008.webp"):
            with self.subTest(name=name):
                reader = Reader()
                add_release(reader)
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    materialize(reader, root, ("global",))
                    initial_heads = len(reader.head_reads)
                    initial_pointer = (root / "current.json").read_bytes()
                    target = root / "releases" / ("a" * 24) / name
                    target.write_bytes(b"x" * target.stat().st_size)
                    with self.assertRaisesRegex(ValueError, "differs from R2"):
                        materialize(reader, root, ("global",))
                    self.assertEqual(len(reader.head_reads), initial_heads)
                    self.assertEqual((root / "current.json").read_bytes(), initial_pointer)

    def test_missing_optional_loading_art_uses_renderer_fallback(self):
        reader = Reader()
        add_release(reader)
        art = "content/releases/" + "a" * 24 + "/public/gallery/stamps-1000000004.webp"
        del reader.objects[art]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            materialize(reader, root, ("global",))
            self.assertFalse((root / "releases" / ("a" * 24) / "public/gallery/stamps-1000000004.webp").exists())


if __name__ == "__main__":
    unittest.main()
