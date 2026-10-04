"""A JP snapshot must seal only verified, durable source receipts."""
from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch
import sys

from tools import jp_remote_sync


class FakeClient:
    client_version = '1.0.4'

    def __init__(self, *, changed=False):
        self.changed = changed
        self.calls = 0

    def discover(self):
        self.calls += 1
        version = '1.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        if self.changed and self.calls > 1:
            version = '1.1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        return {'schemaVersion': 1, 'environmentId': 'jp-production', 'region': 'jp',
                'observedAt': '2026-10-05T00:00:00Z', 'clientVersion': '1.0.4',
                'masterVersion': version, 'resourceVersion': version,
                'catalogHash': version.split('/')[1], 'apiRoot': 'https://api.bang-dream-on.jp',
                'cdnRoot': 'https://static.bang-dream-on.jp',
                'catalogUrl': 'https://static.bang-dream-on.jp/catalog_main.bin',
                'masterManifestUrl': 'https://static.bang-dream-on.jp/MasterManifest.json',
                'responseHeaders': {'authorization': 'must-not-persist'}}

    def get(self, url, limit):
        body = b'catalog' if url.endswith('catalog_main.bin') else b'{"version":"1.0"}'
        return type('Response', (), {'body': body})()


def fake_acquire(client, url, target, size, *, expected_sha=None):
    target.write_bytes(b'x' * size)
    return {'path': str(target), 'sha256': expected_sha, 'byteSize': size}


def fake_decrypt(source, destination, **kwargs):
    destination.write_text('{}')
    return {'source': str(source), 'output': str(destination),
            'encrypted_sha256': 'a' * 64, 'json_sha256': 'b' * 64}


class SnapshotTests(unittest.TestCase):
    def run_snapshot(self, *, changed=False, retry=False):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        output = Path(temporary.name) / 'snapshot'
        crypto = ModuleType('analysis.crypto.decrypt_master')
        crypto.decrypt_master_file = fake_decrypt
        crypto.DEFAULT_SALT = crypto.DEFAULT_KEY = crypto.DEFAULT_IV = b'x' * 32
        with patch.object(jp_remote_sync, 'decode_catalog', side_effect=lambda data: data), \
             patch.object(jp_remote_sync.CatalogAdapter, 'parse_bytes', return_value=type('Catalog', (), {'locations': []})()), \
             patch.object(jp_remote_sync, 'validate_manifest', return_value=[{'name': 'MasterTest.bin', 'size': 3, 'hash': 'a' * 64}]), \
             patch.object(jp_remote_sync, 'acquire', side_effect=fake_acquire), \
             patch.dict(sys.modules, {'analysis.crypto.decrypt_master': crypto}):
            if changed:
                with self.assertRaises(jp_remote_sync.ProtocolError):
                    jp_remote_sync.snapshot(FakeClient(changed=True), output)
                if retry:
                    jp_remote_sync.snapshot(FakeClient(), output)
            else:
                jp_remote_sync.snapshot(FakeClient(), output)
        return output

    def test_snapshot_seals_relative_receipts_and_sanitized_observation(self):
        output = self.run_snapshot()
        self.assertTrue(output.is_dir())
        report = json.loads((output / 'master-json/master-decrypt-report.json').read_text())
        self.assertEqual(report['results'][0]['source'], 'Master/MasterTest.bin')
        self.assertEqual(report['results'][0]['output'], 'master-json/MasterTest.json')
        observation = json.loads((output / 'observation.json').read_text())
        self.assertNotIn('responseHeaders', observation)

    def test_version_change_does_not_seal_snapshot(self):
        output = self.run_snapshot(changed=True)
        self.assertFalse(output.exists())

    def test_failed_snapshot_does_not_poison_next_attempt(self):
        output = self.run_snapshot(changed=True, retry=True)
        self.assertTrue((output / 'report.json').is_file())


if __name__ == '__main__':
    unittest.main()
