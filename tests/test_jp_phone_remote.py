"""Synthetic safeguards around JP CDN bundle intake and APK trust."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256, PhoneResources, build


class JpRemoteInputTests(unittest.TestCase):
    def test_missing_bundle_uses_official_cdn_with_catalog_identity_and_budget(self):
        payload = b'official resource bytes'
        name = 'sample_' + 'a' * 32 + '.bundle'
        loc = SimpleNamespace(
            primary_key=name, internal_id='{Fwk.Resource.RemoteAssetDir}/' + name,
            expected_size=len(payload), expected_hash='catalog-hash',
            provider_id='remote', resource_type='AssetBundle',
        )
        with TemporaryDirectory() as directory:
            resources = PhoneResources.__new__(PhoneResources)
            resources.encrypted = {}
            resources.cached = {}
            resources.packaged = {}
            resources.shared = {}
            resources.used = {}
            resources.downloaded = 0
            resources.max_download_bytes = len(payload)
            resources.remote_client = object()
            resources.cache = Path(directory)
            resources.report = {'observation': {
                'resourceVersion': '1.0.0.300/' + 'b' * 32,
            }}

            def acquired(_client, url, target, size, *, identity):
                self.assertTrue(url.startswith('https://static.bang-dream-on.jp/'))
                self.assertEqual(identity['key'], name)
                self.assertEqual(identity['hash'], loc.expected_hash)
                self.assertEqual(size, len(payload))
                target.parent.mkdir(parents=True)
                target.write_bytes(payload)
                return {'sha256': 'd' * 64, 'byteSize': len(payload), 'reused': False}

            with patch('tools.jp_remote_sync.acquire', side_effect=acquired) as acquire:
                self.assertEqual(resources.get(loc).read_bytes(), payload)
                self.assertEqual(resources.used[name]['origin'], 'jp-official-cdn')
                self.assertEqual(resources.downloaded, len(payload))
                acquire.assert_called_once()
            with patch('tools.jp_remote_sync.acquire') as acquire:
                with self.assertRaisesRegex(ValueError, 'budget'):
                    resources.get(loc)
                acquire.assert_not_called()

    def test_untrusted_apk_signer_stops_before_resource_decoding(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            capture = root / 'capture'
            master = root / 'master'
            apk_root = root / 'apks'
            output = root / 'output' / 'jp-inputs'
            capture.mkdir()
            master.mkdir()
            apk_root.mkdir()
            (master / 'master-decrypt-report.json').write_text(json.dumps({
                'failures': [], 'results': [],
            }))
            package = {
                'packageName': 'com.bushiroad.sirius',
                'certificateSha256': '0' * 64,
                'versionName': '1.0.4', 'versionCode': 10053,
            }
            with (patch('tools.jp_phone_inputs.ROOT', root),
                  patch('tools.jp_phone_inputs.build_package_set_manifest', return_value=package),
                  patch('tools.jp_phone_inputs.PhoneResources') as resources):
                with self.assertRaisesRegex(ValueError, 'signer identity changed'):
                    build(capture, master, root / 'metadata', apk_root, output)
                resources.assert_not_called()
            self.assertFalse(output.exists())

    def test_new_jp_apk_version_requires_decoder_review(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            capture = root / 'capture'
            master = root / 'master'
            apk_root = root / 'apks'
            output = root / 'output' / 'jp-inputs'
            capture.mkdir()
            master.mkdir()
            apk_root.mkdir()
            (master / 'master-decrypt-report.json').write_text(json.dumps({
                'failures': [], 'results': [],
            }))
            (capture / 'observation.json').write_text(json.dumps({
                'region': 'jp', 'clientVersion': '1.0.5',
            }))
            package = {
                'packageName': 'com.bushiroad.sirius',
                'certificateSha256': JP_CERTIFICATE_SHA256,
                'versionName': '1.0.5', 'versionCode': 10054,
            }
            with (patch('tools.jp_phone_inputs.ROOT', root),
                  patch('tools.jp_phone_inputs.build_package_set_manifest', return_value=package),
                  patch('tools.jp_remote_sync.client_from_metadata') as client,
                  patch('tools.jp_phone_inputs.PhoneResources') as resources):
                with self.assertRaisesRegex(ValueError, 'reviewed decoder profile'):
                    build(capture, master, root / 'metadata', apk_root, output,
                          remote=True, unity_version_file=root / 'unity.ver')
                client.assert_not_called()
                resources.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
