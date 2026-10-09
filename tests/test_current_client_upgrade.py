"""The recommended APK must be downloaded and identified before decoding."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tools import current_client
from tools.resource_pipeline.adapters.global_public import APK_HOSTS, APK_USER_AGENT


class CurrentClientUpgradeTest(unittest.TestCase):
    def test_official_upgrade_uses_android_download_and_rejects_wrong_version(self):
        package = {
            "url": "https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02.apk",
            "byteSize": 3,
            "etag": '"etag"',
            "clientVersion": "1.0.3",
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            jar = root / "apksig.jar"
            jar.write_bytes(b"fixture")

            def fake_hash(path):
                return current_client.APKSIG_SHA256 if path == jar else "a" * 64

            def fake_download(url, path, size, **kwargs):
                path.parent.mkdir(parents=True)
                path.write_bytes(b"apk")
                return {}

            with patch.object(current_client, "file_hash", side_effect=fake_hash), \
                 patch.object(current_client, "acquire", side_effect=fake_download) as download, \
                 patch.object(current_client, "inspect_apk", return_value={
                     "packageName": "com.bilibili.sirius", "certificateSha256": current_client.CERTIFICATE,
                     "versionName": "1.0.2", "versionCode": 26,
                 }), \
                 patch.object(current_client, "verify_apk_signature") as signature:
                with self.assertRaisesRegex(ValueError, "recommended client version"):
                    current_client.intake(package, root / "cache", jar)
            self.assertEqual(download.call_args.kwargs["allowed_hosts"], APK_HOSTS)
            self.assertEqual(download.call_args.kwargs["request_headers"], {"User-Agent": APK_USER_AGENT})
            signature.assert_not_called()


if __name__ == "__main__":
    unittest.main()
