import json
import hashlib
import shutil
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from tools.growth_login import Profile, LoginError
from tools.growth_login_local import LoginServer
from tools.build_growth_distribution import TEMPLATE, source_tree, write_zip
from tests.test_growth_web import FakeSdk, FakeGame

XML = b'''<resources><string name="appid">17703</string><string name="merchantid">1045</string><string name="serverid">16841</string><string name="channelid">2001</string><string name="one_global_brand_id">5</string><string name="one_global_area_id">6</string><string name="one_appkey">FAKE-APP-KEY</string></resources>'''

class DistributionTests(unittest.TestCase):
    def test_zip_preserves_macos_launcher_mode_and_runtime_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'portable'
            root.mkdir()
            launcher = root / 'Start.command'
            launcher.write_text('#!/bin/sh\n')
            launcher.chmod(0o755)
            (root / 'runtime-link').symlink_to('Start.command')
            archive = Path(folder) / 'tool.zip'
            write_zip(root, archive)
            with zipfile.ZipFile(archive) as z:
                self.assertEqual(z.getinfo('portable/Start.command').external_attr >> 16 & 0o777, 0o755)
                self.assertTrue(stat.S_ISLNK(z.getinfo('portable/runtime-link').external_attr >> 16))
                self.assertEqual(z.read('portable/runtime-link'), b'Start.command')
                manifest = json.loads(z.read('portable/FILES.sha256.json'))
                for name, checksum in manifest.items():
                    self.assertEqual(hashlib.sha256(z.read('portable/' + name)).hexdigest(), checksum)

    def test_profile_rejects_entities_and_malformed_xml_without_echoing_input(self):
        self.assertEqual(Profile.from_xml(XML).game_id, '17703')
        for data in [b'<PRIVATE', b'<!DOCTYPE resources><resources/>', b'<other/>']:
            with self.assertRaises(LoginError) as caught:
                Profile.from_xml(data)
            self.assertEqual(str(caught.exception), 'invalid_sdk_profile')

    def test_memory_export_can_repeat_and_failure_discards_previous_snapshot(self):
        server = LoginServer(Profile('fake'), sdk_factory=FakeSdk, game_factory=FakeGame)
        try:
            for attempt in [1, 2]:
                server.lock.acquire(); server.export('FAKE-ACCOUNT', 'FAKE-PASSWORD')
                self.assertEqual(server.state['stage'], 'complete')
                self.assertEqual(server.state['attempt'], attempt)
                self.assertIsNone(server.output)
                self.assertNotIn('FAKE', json.dumps(server.snapshot))
            server.lock.acquire(); server.export('FAKE-ACCOUNT', 'reject')
            self.assertIsNone(server.snapshot)
            self.assertEqual(server.state['stage'], 'failed')
        finally:
            server.server_close()

    def test_source_includes_three_region_modules_but_no_sdk_identity_snapshots_or_adb(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'source'
            template = Path(folder) / 'template'
            shutil.copytree(TEMPLATE, template)
            (template / 'sdk.bhk.xml').write_bytes(XML)
            with patch('tools.build_growth_distribution.TEMPLATE', template):
                source_tree(target)
            paths = {str(p.relative_to(target)) for p in target.rglob('*') if p.is_file()}
            self.assertNotIn('sdk.xml', paths)
            self.assertNotIn('sdk.bhk.xml', paths)
            self.assertNotIn('packaging/growth-tool/sdk.bhk.xml', paths)
            self.assertIn('sdk.example.xml', paths)
            self.assertIn('tools/global_game_config.py', paths)
            self.assertIn('tools/game_service_status.py', paths)
            self.assertNotIn('tools/growth_cache_export.py', paths)
            self.assertFalse(any('snapshot' in path or 'verification' in path for path in paths))
            self.assertIn('launcher.py', paths)
            self.assertNotIn('growth_cache_export', (target / 'tools/growth_login_local.py').read_text())

if __name__ == '__main__':
    unittest.main()
