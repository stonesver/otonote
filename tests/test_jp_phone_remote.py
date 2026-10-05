"""Synthetic safeguards around JP CDN bundle intake and APK trust."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256, PhoneResources, build
from tools.jp_remote_sync import acquire, remote_cache_name, resource_identity


class JpRemoteInputTests(unittest.TestCase):
    def test_long_real_catalog_name_writes_receipt_and_reuses_cache(self):
        name = ('spot_assets_spot_home_003_yumemita_ex01_akiba_fam_restaurant_0203_'
                'background_model_003_yumemita_ex01_akiba_fam_restaurant_0203_'
                'material_003_yumemita_ex01_akiba_fam_restaurant_0203_'
                'material_transparent_ffaaf5a0beaf6b6d632197d7a0a6f8aa.bundle')
        payload = b'JP official bundle'
        location = SimpleNamespace(primary_key=name,
            internal_id='{Fwk.Resource.RemoteAssetDir}/' + name,
            expected_size=len(payload), expected_hash='catalog-hash',
            provider_id='remote', resource_type='AssetBundle')

        class Client:
            calls = 0

            def download(self, _url, stream, _size):
                self.calls += 1
                stream.write(payload)
                return SimpleNamespace(byte_size=len(payload), headers={})

        with TemporaryDirectory() as directory:
            resources = PhoneResources.__new__(PhoneResources)
            resources.encrypted, resources.cached = {}, {}
            resources.packaged, resources.shared, resources.used = {}, {}, {}
            resources.downloaded, resources.max_download_bytes = 0, len(payload)
            resources.remote_client = Client()
            resources.cache = Path(directory)
            resources.report = {'observation': {'resourceVersion': '1.0.0.300/' + 'b' * 32}}
            path = resources.get(location)
            receipt = path.with_name(path.name + '.receipt.json')
            self.assertEqual(path.read_bytes(), payload)
            self.assertLessEqual(len((receipt.name + '.tmp').encode()), 255)
            self.assertEqual(json.loads(receipt.read_text())['identity'], resource_identity(location))
            # A later run starts with a fresh per-run download budget.
            resources.downloaded = 0
            self.assertEqual(resources.get(location), path)
            self.assertEqual(resources.remote_client.calls, 1)
            self.assertEqual(resources.downloaded, 0)

    def test_multibyte_catalog_identity_has_bounded_real_receipt_path(self):
        identity = {'key': '背景资源/' + '料理店' * 100 + '.bundle',
                    'internalId': '{Fwk.Resource.RemoteAssetDir}/' + '料理店' * 100,
                    'hash': 'catalog-hash', 'size': 4,
                    'provider': 'remote', 'resourceType': 'AssetBundle'}
        name = remote_cache_name(identity)
        self.assertLessEqual(len((name + '.receipt.json.tmp').encode('utf-8')), 255)

        class Client:
            def download(self, _url, stream, _size):
                stream.write(b'data')
                return SimpleNamespace(byte_size=4, headers={})

        with TemporaryDirectory() as directory:
            target = Path(directory) / name
            acquire(Client(), 'https://static.bang-dream-on.jp/asset/Android/sample.bundle',
                    target, 4, identity=identity)
            self.assertEqual(target.read_bytes(), b'data')
            self.assertEqual(json.loads(target.with_name(name + '.receipt.json').read_text())['identity'], identity)

    def test_same_basename_in_different_catalog_paths_cannot_collide(self):
        shared_name = 'shared_' + 'a' * 32 + '.bundle'
        locations = [SimpleNamespace(
            primary_key=area + '/' + shared_name,
            internal_id='{Fwk.Resource.RemoteAssetDir}/' + area + '/' + shared_name,
            expected_size=4, expected_hash='same-catalog-hash',
            provider_id='remote', resource_type='AssetBundle')
            for area in ('area-one', 'area-two')]

        class Client:
            calls = 0

            def download(self, url, stream, _size):
                self.calls += 1
                stream.write(b'one!' if 'area-one' in url else b'two!')
                return SimpleNamespace(byte_size=4, headers={})

        with TemporaryDirectory() as directory:
            resources = PhoneResources.__new__(PhoneResources)
            resources.encrypted, resources.cached = {}, {}
            resources.packaged, resources.shared, resources.used = {}, {}, {}
            resources.downloaded, resources.max_download_bytes = 0, 8
            resources.remote_client = Client()
            resources.cache = Path(directory)
            resources.report = {'observation': {'resourceVersion': '1.0.0.300/' + 'b' * 32}}
            paths = [resources.get(location) for location in locations]
            self.assertNotEqual(paths[0], paths[1])
            self.assertEqual([path.read_bytes() for path in paths], [b'one!', b'two!'])
            self.assertEqual(resources.remote_client.calls, 2)
            self.assertEqual(
                [json.loads(path.with_name(path.name + '.receipt.json').read_text())['identity'] for path in paths],
                [resource_identity(location) for location in locations])

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
