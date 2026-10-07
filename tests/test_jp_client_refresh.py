import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tools import jp_client_refresh
from tools.global_remote_sync import file_hash


class JpClientRefreshTests(unittest.TestCase):
    def test_current_seed_is_recognized_without_package_download(self):
        with TemporaryDirectory() as directory:
            seed = Path(directory) / "r2-jp"
            (seed / "apks").mkdir(parents=True)
            (seed / "apks/base.apk").write_bytes(b"fixture")
            metadata = seed / "metadata.v39.dat"
            metadata.write_bytes(b"reviewed metadata")
            (seed / "unity-version.txt").write_text("6000.3.12f1\n")
            (seed / "seed-manifest.json").write_text(json.dumps({
                "status": "verified_seed", "clientVersion": "1.0.5", "versionCode": 10059,
                "certificateSha256": "a" * 64, "metadataSha256": file_hash(metadata),
                "packageSetSha256": "b" * 64,
            }))
            package = {
                "packageSetSha256": "b" * 64,
                "certificateSha256": "a" * 64,
                "versionName": "1.0.5",
                "versionCode": 10059,
            }
            with (patch.object(jp_client_refresh, "JP_CERTIFICATE_SHA256", "a" * 64),
                  patch.object(jp_client_refresh, "JP_METADATA_SHA256", file_hash(metadata)),
                  patch.object(jp_client_refresh, "JP_REVIEWED_PACKAGE_SET_SHA256", "b" * 64),
                  patch.object(jp_client_refresh, "build_package_set_manifest", return_value=package)):
                self.assertTrue(jp_client_refresh.seed_is_current(seed))

    def test_unreviewed_archive_leaves_restored_seed_unchanged(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            seed = root / "output/r2-jp"
            (seed / "apks").mkdir(parents=True)
            (seed / "apks/base.apk").write_bytes(b"old package")
            (seed / "metadata.v39.dat").write_bytes(b"old metadata")
            (seed / "unity-version.txt").write_text("old unity")
            (seed / "seed-manifest.json").write_text("{}")
            (seed / "workspace").mkdir()
            (seed / "workspace/state.json").write_text("preserve")
            archive = root / "unreviewed.xapk"
            archive.write_bytes(b"not the reviewed package")
            apksig = root / "apksig.jar"
            apksig.write_bytes(b"unused because archive digest fails first")
            with patch.object(jp_client_refresh, "ROOT", root):
                with self.assertRaisesRegex(ValueError, "archive differs"):
                    jp_client_refresh.refresh(archive, apksig, seed)
            self.assertEqual((seed / "apks/base.apk").read_bytes(), b"old package")
            self.assertEqual((seed / "metadata.v39.dat").read_bytes(), b"old metadata")
            self.assertEqual((seed / "workspace/state.json").read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
