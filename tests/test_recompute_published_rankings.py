import json
from pathlib import Path
import tempfile
import unittest

from tools import r2_content as content
from tools import r2_shared_media as shared
from tools import recompute_published_rankings as refresh
from tests.test_r2_content import fixture
from tests.test_r2_shared_media import TrackedBucket, reseal


MODEL = 'ournotes-native-score-v9'


def computed(source, output, model):
    output.mkdir()
    for locale in ('en', 'zh-CN'):
        row = {'id': 'chart-1', 'expectedScore': 123456, 'chartFingerprint': 'chart-hash'}
        data = {'sourceReleaseId': 'sample', 'benchmark': {'modelVersion': model},
                'fingerprint': 'ranking-hash', 'rulesFingerprint': 'rules-hash',
                'ordinary': [row], 'gekisou': [row]}
        (output / (locale + '.json')).write_bytes(content.canonical(data))


class RecomputePublishedRankingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bucket = TrackedBucket()
        self.identifier = 'a' * 24

    def seed(self, region='global'):
        self.region = region
        store = self.root / 'store'
        pointer_path = fixture(store, region=region)
        release = store / 'releases' / self.identifier
        manifest = json.loads((release / 'manifest.json').read_bytes())
        for locale in ('en', 'zh-CN'):
            catalog = {'release': {'id': 'sample'}, 'musicCharts': [{'id': 'chart-1'}],
                       'cover': manifest['root'] + 'public/media/sample.webp'}
            for key, value in [('projection/catalog.json', catalog),
                               ('supplemental/song-rankings.json', {'old': True})]:
                name = locale + '/' + key
                raw = content.canonical(value)
                path = release / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                manifest['locales'][locale]['files'][key] = {
                    'path': name, 'sha256': content.digest(raw), 'bytes': len(raw)}
        # A direct object outside manifest records must also be preserved and verified.
        (release / 'recognition').mkdir()
        (release / 'recognition/extra.json').write_bytes(b'{"keep":true}')
        raw = content.canonical(manifest)
        (release / 'manifest.json').write_bytes(raw)
        pointer = json.loads(pointer_path.read_bytes())
        pointer['sha256'] = content.digest(raw)
        pointer_path.write_bytes(content.canonical(pointer))
        reseal(store, self.identifier)
        content.upload_release(self.bucket, store, region, shared_media=True)
        content.promote(self.bucket, store, region, 'none', source_run='seed')
        self.key = content.pointer_key(region)
        self.before = dict(self.bucket.objects)
        self.expected = content.digest(self.before[self.key])
        self.bucket.gets.clear(); self.bucket.puts.clear()

    def run_refresh(self, **kwargs):
        return refresh.recompute(self.bucket, self.region, self.expected, self.root/'work',
                                 model=MODEL, source_run='refresh', workers=2, **kwargs)

    def assert_no_publication(self):
        self.assertEqual(self.bucket.objects[self.key], self.before[self.key])
        self.assertFalse(any('/refresh-' in key for key in self.bucket.objects))

    def test_publish_both_regions_preserves_snapshot_media_and_rollback(self):
        for region in ('global', 'jp'):
            with self.subTest(region=region), tempfile.TemporaryDirectory() as directory:
                self.root = Path(directory); self.bucket = TrackedBucket()
                self.seed(region)
                result = self.run_refresh(publish=True, compute=computed)
                self.assertEqual(result['status'], 'published')
                pointer = json.loads(self.bucket.objects[self.key])
                root = pointer['manifest'].removesuffix('manifest.json').lstrip('/')
                manifest_raw = self.bucket.objects[root+'manifest.json']
                self.assertEqual(content.digest(manifest_raw), pointer['sha256'])
                manifest = json.loads(manifest_raw)
                for locale in ('en', 'zh-CN'):
                    records = manifest['locales'][locale]['files']
                    catalog = json.loads(self.bucket.objects[root+records['projection/catalog.json']['path']])
                    self.assertEqual(catalog['cover'], '/'+root+'public/media/sample.webp')
                    data = json.loads(self.bucket.objects[root+records['supplemental/song-rankings.json']['path']])
                    refresh.validate_rankings(data, catalog, MODEL)
                self.assertEqual(self.bucket.objects[root+'recognition/extra.json'], b'{"keep":true}')
                for key, value in self.before.items():
                    if key != self.key:
                        self.assertEqual(self.bucket.objects[key], value)
                self.assertFalse(any(key.startswith('content/blobs/') for key in self.bucket.gets+self.bucket.puts))
                previous = 'content/previous.json' if region == 'global' else 'content/jp/previous.json'
                self.assertEqual(self.bucket.objects[previous], self.before[self.key])
                restored = content.rollback(self.bucket, region, result['pointerSha256'], source_run='restore')
                self.assertEqual(restored['status'], 'rolled_back')
                self.assertEqual(self.bucket.objects[self.key], self.before[self.key])

    def test_verify_does_not_write_remote(self):
        self.seed()
        result = self.run_refresh(compute=computed)
        self.assertEqual(result['status'], 'verified_local')
        self.assertEqual(self.bucket.objects, self.before)
        self.assertEqual(self.bucket.puts, [])

    def test_incomplete_or_invalid_scores_never_upload(self):
        for fault in ('model', 'coverage', 'score', 'release'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                self.root = Path(directory); self.bucket = TrackedBucket(); self.seed()
                def invalid(source, output, model):
                    computed(source, output, model)
                    path = output/'en.json'; data = json.loads(path.read_bytes())
                    if fault == 'model': data['benchmark']['modelVersion'] = 'old-model'
                    if fault == 'coverage': data['gekisou'] = []
                    if fault == 'score': data['ordinary'][0]['expectedScore'] = 0
                    if fault == 'release': data['sourceReleaseId'] = 'other'
                    path.write_bytes(content.canonical(data))
                with self.assertRaises(ValueError):
                    self.run_refresh(publish=True, compute=invalid)
                self.assert_no_publication()
                self.assertEqual(self.bucket.puts, [])

    def test_missing_or_changed_direct_source_fails_inventory(self):
        for fault in ('missing', 'changed', 'extra'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                self.root = Path(directory); self.bucket = TrackedBucket(); self.seed()
                key = 'content/releases/'+self.identifier+'/recognition/extra.json'
                if fault == 'missing': del self.bucket.objects[key]
                elif fault == 'changed': self.bucket.replace(key, b'{}', self.bucket.etags[key])
                else: self.bucket.put_new(key.replace('extra', 'unrecorded'), b'{}')
                self.bucket.puts.clear()
                with self.assertRaisesRegex(ValueError, 'inventory'):
                    self.run_refresh(publish=True, compute=computed)
                self.assert_no_publication()
                self.assertEqual(self.bucket.puts, [])

    def test_changed_media_identity_blocks_publication(self):
        self.seed()
        key = shared.blob_key(content.digest(b'public image'))
        self.bucket.replace(key, b'changed', self.bucket.etags[key])
        with self.assertRaisesRegex(ValueError, 'media is missing or changed'):
            self.run_refresh(publish=True, compute=computed)
        self.assert_no_publication()

    def test_changed_pointer_during_compute_cancels_before_upload(self):
        self.seed()
        def concurrent(source, output, model):
            computed(source, output, model)
            self.bucket.replace(self.key, b'{"newer":true}', self.bucket.etags[self.key])
        with self.assertRaisesRegex(ValueError, 'pointer changed'):
            self.run_refresh(publish=True, compute=concurrent)
        self.assertEqual(self.bucket.objects[self.key], b'{"newer":true}')
        self.assertEqual(self.bucket.puts, [])

    def test_pointer_cas_failure_keeps_newer_current_and_previous(self):
        self.seed()
        replace = self.bucket.replace
        def competing(key, data, etag, **options):
            if key == self.key:
                replace(key, b'{"newer":true}', etag)
            return replace(key, data, etag, **options)
        self.bucket.replace = competing
        with self.assertRaisesRegex(ValueError, 'pointer changed'):
            self.run_refresh(publish=True, compute=computed)
        self.assertEqual(self.bucket.objects[self.key], b'{"newer":true}')
        self.assertNotIn('content/previous.json', self.bucket.objects)
        self.assertTrue(any('/refresh-' in key for key in self.bucket.objects))

    def test_damaged_upload_never_publishes(self):
        self.seed()
        original = self.bucket.get
        def damaged(key):
            item = original(key)
            if item and key.startswith('content/releases/') and self.identifier not in key:
                return b'damaged', item[1]
            return item
        self.bucket.get = damaged
        with self.assertRaisesRegex(ValueError, 'failed readback'):
            self.run_refresh(publish=True, compute=computed)
        self.assert_no_publication()


if __name__ == '__main__':
    unittest.main()
