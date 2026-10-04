from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tools import prepare_jp_r2_seed
from tools.global_remote_sync import file_hash


class PrepareJpSeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.metadata = root / 'metadata.dat'
        self.metadata.write_bytes(b'metadata')
        self.apks = root / 'apks'
        self.apks.mkdir()
        for name in ('base.apk', 'split_config.arm64_v8a.apk', 'split_UnityDataAssetPack.apk'):
            (self.apks / name).write_bytes(name.encode())
        self.unity = root / 'unity.ver'
        self.unity.write_text('1cefdadb-159f-405e-af01-fdf8f888004b\n')
        self.output = root / 'output' / 'r2-jp'

    def package(self):
        return {'packageName': 'com.bushiroad.sirius', 'versionName': '1.0.4',
                'versionCode': 10053, 'certificateSha256': 'a' * 64,
                'packageSetSha256': 'b' * 64}

    def test_verified_seed_contains_only_required_client_material(self):
        with patch.object(prepare_jp_r2_seed, 'JP_METADATA_SHA256', file_hash(self.metadata)), \
             patch.object(prepare_jp_r2_seed, 'JP_CERTIFICATE_SHA256', 'a' * 64), \
             patch.object(prepare_jp_r2_seed, 'JP_REVIEWED_PACKAGE_SET_SHA256', 'b' * 64), \
             patch.object(prepare_jp_r2_seed, 'build_package_set_manifest', return_value=self.package()):
            report = prepare_jp_r2_seed.prepare(self.metadata, self.apks, self.unity, self.output)
        self.assertEqual(report['status'], 'verified_seed')
        self.assertEqual(sorted(report['apks']), sorted(path.name for path in self.apks.glob('*.apk')))
        self.assertTrue((self.output / 'seed-manifest.json').is_file())
        self.assertEqual((self.output / 'metadata.v39.dat').read_bytes(), b'metadata')
        self.assertFalse((self.output / 'workspace').exists())

    def test_unreviewed_metadata_never_creates_seed(self):
        with self.assertRaisesRegex(ValueError, 'metadata does not match'):
            prepare_jp_r2_seed.prepare(self.metadata, self.apks, self.unity, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
