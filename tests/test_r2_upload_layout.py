from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.test_r2_content import MemoryBucket, fixture
from tools import r2_upload_layout as layout
from tools.r2_shared_media import descriptor_key


RELEASE = "a" * 24


class UploadLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = Path(self.temporary.name)
        self.pointer = fixture(self.store)
        self.bucket = MemoryBucket()
        self.manifest = (self.store / "releases" / RELEASE / "manifest.json").read_bytes()
        self.manifest_key = f"content/releases/{RELEASE}/manifest.json"

    def put(self, key, value):
        self.bucket.put_new(key, value, content_type="application/json",
                            cache_control="immutable", sha256=layout.digest(value))

    def test_direct_request_does_not_query_remote_or_change_existing_contract(self):
        self.assertEqual(layout.select_layout(None, self.store, "global", False), "direct")
        with self.assertRaisesRegex(ValueError, "boolean"):
            layout.select_layout(self.bucket, self.store, "global", "false")

    def test_new_release_uses_shared_layout(self):
        self.assertEqual(layout.select_layout(self.bucket, self.store, "global", True), "shared")

    def test_existing_identical_direct_release_keeps_direct_layout(self):
        self.put(self.manifest_key, self.manifest)
        self.assertEqual(layout.select_layout(self.bucket, self.store, "global", True), "direct")

    def test_existing_shared_descriptor_keeps_shared_layout(self):
        self.put(self.manifest_key, self.manifest)
        self.put(descriptor_key(RELEASE), b"shared descriptor; uploader verifies it")
        self.assertEqual(layout.select_layout(self.bucket, self.store, "global", True), "shared")

    def test_mismatched_manifest_fails_even_if_descriptor_exists(self):
        self.put(self.manifest_key, b"different immutable manifest")
        self.put(descriptor_key(RELEASE), b"shared descriptor")
        with self.assertRaisesRegex(ValueError, "manifest differs"):
            layout.select_layout(self.bucket, self.store, "global", True)

    def test_jp_uses_its_sealed_pointer_and_cli_prints_only_layout(self):
        fixture(self.store, region="jp", release_id="b" * 24)
        self.assertEqual(layout.select_layout(self.bucket, self.store, "jp", True), "shared")
        output = StringIO()
        with patch.object(layout.S3Bucket, "from_environment", return_value=self.bucket), redirect_stdout(output):
            status = layout.main(["--store", str(self.store), "--region", "jp", "--shared", "true"])
        self.assertEqual(status, 0)
        self.assertEqual(output.getvalue(), "shared\n")


if __name__ == "__main__":
    unittest.main()
