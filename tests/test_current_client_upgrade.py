"""The recommended APK must be downloaded and identified before decoding."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from tools import current_client
from tools.resource_pipeline.adapters.global_public import APK_HOSTS, APK_USER_AGENT
from tests.test_bundle_decoder import entry, metadata_fixture


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

    def test_website_apk_download_keeps_android_user_agent(self):
        package = {"url": "https://l14-pkg-download.biligames.com/sirius/apk/BanGDreamOurNotes_1.0.3_1.apk",
                   "byteSize": 3, "etag": '"etag"', "clientVersion": "1.0.3"}
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            jar = root / "apksig.jar"
            jar.write_bytes(b"fixture")
            with patch.object(current_client, "file_hash", return_value=current_client.APKSIG_SHA256), \
                 patch.object(current_client, "acquire", side_effect=ValueError('stop after download options')) as download:
                with self.assertRaisesRegex(ValueError, 'stop after download options'):
                    current_client.intake(package, root / "cache", jar)
            self.assertEqual(download.call_args.kwargs['request_headers'], {'User-Agent': APK_USER_AGENT})
            self.assertNotIn('allowed_hosts', download.call_args.kwargs)

    def test_prior_material_requires_matching_external_profile_and_apk_signature(self):
        import os
        import sys
        from types import SimpleNamespace
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache = root / 'clients'
            old = metadata_fixture()
            old_apk = cache / 'downloads' / 'receipt' / 'old.apk'
            old_apk.parent.mkdir(parents=True)
            old_apk.write_bytes(b'old verified apk')
            apk_sha = hashlib.sha256(old_apk.read_bytes()).hexdigest()
            metadata = cache / apk_sha / 'global-metadata.v39.dat'
            metadata.parent.mkdir(parents=True)
            metadata.write_bytes(old.data)
            (metadata.parent / 'decoder.json').write_text(json.dumps({
                'apkSha256': apk_sha, 'certificateSha256': current_client.CERTIFICATE,
                'signatureVerified': True, 'metadata': str(metadata),
                'metadataSha256': hashlib.sha256(old.data).hexdigest(),
                'clientVersion': '1.0.2', 'apk': str(old_apk),
            }))
            external = root / 'profiles.json'
            external.write_text(json.dumps({'schemaVersion': 1, 'profiles': [entry(old,'1.0.2')]}))
            module = SimpleNamespace(MetadataV39=lambda _: old)
            identity = {'versionName':'1.0.2','certificateSha256':current_client.CERTIFICATE,
                        'packageName':'com.bilibili.sirius'}
            with patch.dict(sys.modules, {'analysis.crypto.decrypt_global_formal_scores':module}), \
                 patch.dict(os.environ, {'OURNOTES_BUNDLE_DECODER_PROFILE':str(external)}), \
                 patch.object(current_client, 'inspect_apk', return_value=identity), \
                 patch.object(current_client, 'verify_apk_signature') as signature:
                self.assertEqual(current_client._verified_prior_material(cache, root / 'apksig.jar'),
                                 (bytes(range(16)), b'SEEDDEMO'))
                signature.assert_called_once()
                external.write_text(json.dumps({'schemaVersion': 1, 'profiles': [entry(old,'1.0.1')]}))
                with self.assertRaisesRegex(ValueError, 'no verified prior'):
                    current_client._verified_prior_material(cache, root / 'apksig.jar')

    def test_three_distinct_packaged_ciphertexts_are_required(self):
        with TemporaryDirectory() as tmp:
            apk = Path(tmp) / 'samples.apk'
            with zipfile.ZipFile(apk, 'w') as archive:
                for name in ('a.bundle', 'b.bundle', 'c.bundle'):
                    archive.writestr('assets/' + name, b'X' * 128)
            def decrypt(data, name, key, seed):
                self.assertIn(name, {'a.bundle','b.bundle','c.bundle','only.bundle'})
                self.assertEqual((key,seed),(b'K'*16,b'S'*8))
                return b'UnityFS\0' + data[8:]
            result = current_client._verify_packaged_bundles(apk, b'K'*16, b'S'*8, decrypt)
            self.assertEqual(len(result), 3)
            with self.assertRaisesRegex(ValueError, 'validation failed'):
                current_client._verify_packaged_bundles(
                    apk, b'K'*16, b'S'*8,
                    lambda data,name,key,seed: (_ for _ in ()).throw(ValueError('wrong key')))
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('assets/only.bundle', b'X' * 128)
            with self.assertRaisesRegex(ValueError, 'fewer than three'):
                current_client._verify_packaged_bundles(apk, b'K'*16, b'S'*8, decrypt)

    def test_unknown_exact_profile_uses_verified_relocation(self):
        import os
        import sys
        from types import SimpleNamespace
        with TemporaryDirectory() as tmp:
            old = metadata_fixture()
            current = metadata_fixture(swapped=True)
            external = Path(tmp) / 'profiles.json'
            external.write_text(json.dumps({'schemaVersion':1,'profiles':[entry(old,'1.0.2')]}))
            module = SimpleNamespace(decrypt_header=lambda *args: b'UnityFS\0')
            with patch.dict(os.environ, {'OURNOTES_BUNDLE_DECODER_PROFILE':str(external)}), \
                 patch.dict(sys.modules, {'analysis.crypto.decrypt_global_formal_scores':module}), \
                 patch.object(current_client, '_verified_prior_material',
                              return_value=(bytes(range(16)), b'SEEDDEMO')) as prior, \
                 patch.object(current_client, '_verify_packaged_bundles', return_value=['a','b','c']) as samples:
                binding, row = current_client._resolve_current_binding(
                    current, '1.0.3', Path(tmp) / 'new.apk', Path(tmp) / 'cache', Path(tmp) / 'apksig.jar')
            self.assertRegex(binding, r'^[a-f0-9]{64}$')
            self.assertEqual(row, entry(current,'1.0.3',swapped=True))
            prior.assert_called_once()
            samples.assert_called_once()


if __name__ == "__main__":
    unittest.main()
