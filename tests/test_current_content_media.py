"""Offline cached Live2D reuse must preserve catalog identity and file digests."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tools.current_content_media import live2d
from tools.global_remote_sync import file_hash, read_json, write_json
from tools.resource_pipeline.catalog_adapter import CatalogAdapter


class CachedLive2DTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.prior = root / 'prior'
        self.stories = root / 'stories'
        self.public = root / 'public'
        self.data = root / 'data'
        self.addressable = 'Character/Live2D/1_adv/model'
        self.bundle = 'character-live2d_fixture.bundle'
        self.capture = root / 'catalog.json'
        write_json(self.capture, {'locations': [{
            'primaryKey': self.addressable, 'internalId': 'fixture-model',
            'providerId': 'UnityEngine.ResourceManagement.ResourceProviders.BundledAssetProvider',
            'resourceType': 'UnityEngine.GameObject', 'dependencies': [self.bundle],
        }]})
        snapshot = CatalogAdapter().parse(self.capture)
        self.resources = SimpleNamespace(
            catalog=snapshot, rows=Mock(return_value=[]),
            locate=Mock(side_effect=snapshot.location_for_key),
            prior_supplemental=self.prior, prior_catalog=self.capture,
            environment=Mock(side_effect=AssertionError('cached model must not be decoded')),
            report={'catalogSha256': file_hash(self.capture)}, used={},
        )
        self.origin = self.prior / 'public/live2d/old-release/fixture-model'
        self.origin.mkdir(parents=True)
        self.files = {
            'model.model3.json': json.dumps({'FileReferences': {
                'Moc': 'model.moc3', 'Textures': ['texture.png'],
            }}).encode(),
            'model.moc3': b'synthetic model fixture',
            'texture.png': b'synthetic texture fixture',
        }
        rows = []
        for name, data in self.files.items():
            (self.origin / name).write_bytes(data)
            rows.append({'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        write_json(self.origin / 'manifest.json', {
            'model': 'model.model3.json', 'resources': rows,
            'totalBytes': sum(map(len, self.files.values())), 'motions': [],
            'blockedMotionCount': 0, 'expressionCount': 0, 'physics': False,
        })
        self.model_id = 'asset-' + hashlib.sha256(b'1_adv/model').hexdigest()[:16]
        write_json(self.prior / 'data/live2d-catalog.json', {
            'catalogSha256': file_hash(self.capture), 'models': [{
                'id': self.model_id, 'state': 'available',
                'root': '/live2d/old-release/fixture-model/', 'sourceSha256': 'a' * 64,
            }],
        })
        write_json(self.stories / 'index.json', {'documents': []})
        # Reuse requires no Unity decoder; exercise the real catalog parser,
        # verified copy and output resource-closure validation below.
        exporter = ModuleType('tools.prepare_live2d')
        self.export_model = exporter.export_model = Mock(side_effect=AssertionError('unexpected export'))
        exporter_patch = patch.dict('sys.modules', {'tools.prepare_live2d': exporter})
        exporter_patch.start()
        self.addCleanup(exporter_patch.stop)

    def test_matching_old_catalog_reuses_same_addressable_model(self):
        self.assertEqual(live2d(self.resources, 'new-release', self.stories, self.public, self.data), 1)
        self.resources.locate.assert_called_once_with(self.addressable)
        self.resources.environment.assert_not_called()
        self.export_model.assert_not_called()
        payload = read_json(self.data / 'live2d-catalog.json')
        model = payload['models'][0]
        self.assertEqual(model['id'], self.model_id)
        self.assertEqual(model['sourceSha256'], 'a' * 64)
        self.assertEqual(model['root'], '/live2d/new-release/fixture-model/')
        for name, data in self.files.items():
            self.assertEqual((self.public / model['root'].lstrip('/') / name).read_bytes(), data)
            self.assertEqual((self.origin / name).read_bytes(), data)

    def test_matching_catalog_still_rejects_changed_cached_resource(self):
        (self.origin / 'texture.png').write_bytes(b'corrupt cached texture')
        with self.assertRaisesRegex(ValueError, 'cached input digest mismatch'):
            live2d(self.resources, 'new-release', self.stories, self.public, self.data)
        self.assertFalse((self.data / 'live2d-catalog.json').exists())
        self.resources.environment.assert_not_called()
        self.export_model.assert_not_called()

    def missing_old_location(self, *, retain_previous):
        # Current resources retain the independently parsed current catalog.
        write_json(self.capture, {'locations': []})
        path = self.prior / 'data/live2d-catalog.json'
        previous = read_json(path)
        previous['catalogSha256'] = file_hash(self.capture)
        if not retain_previous:
            previous['models'] = []
        write_json(path, previous)

    def assert_full_export(self):
        environment = object()
        self.resources.environment.side_effect = None
        self.resources.environment.return_value = environment
        self.resources.used[self.bundle] = {'sha256': 'b' * 64}

        def export(actual_environment, destination, name):
            self.assertIs(actual_environment, environment)
            self.assertEqual(name, 'model')
            destination.mkdir(parents=True)
            rows = []
            for relative, data in self.files.items():
                (destination / relative).write_bytes(data)
                rows.append({'file': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            manifest = {'model': 'model.model3.json', 'resources': rows,
                        'totalBytes': sum(map(len, self.files.values())), 'motions': [],
                        'blockedMotionCount': 0, 'expressionCount': 0, 'physics': False}
            write_json(destination / 'manifest.json', manifest)
            return manifest

        self.export_model.side_effect = export
        self.assertEqual(live2d(self.resources, 'new-release', self.stories, self.public, self.data), 1)
        self.resources.environment.assert_called_once_with(self.bundle)
        self.export_model.assert_called_once()
        model = read_json(self.data / 'live2d-catalog.json')['models'][0]
        self.assertEqual(model['sourceSha256'], 'b' * 64)
        self.assertEqual(model['root'], f'/live2d/new-release/{self.model_id}-bbbbbbbbbbbb-v1/')

    def test_new_model_absent_from_old_catalog_is_fully_extracted(self):
        self.missing_old_location(retain_previous=False)
        self.assert_full_export()

    def test_prior_model_without_matching_old_location_is_fully_extracted(self):
        self.missing_old_location(retain_previous=True)
        self.assert_full_export()

    def test_malformed_old_catalog_is_not_treated_as_a_missing_model(self):
        self.capture.write_text('{invalid catalog')
        path = self.prior / 'data/live2d-catalog.json'
        previous = read_json(path)
        previous['catalogSha256'] = file_hash(self.capture)
        write_json(path, previous)
        from tools.resource_pipeline.catalog_adapter import CatalogAdapterError
        with self.assertRaises(CatalogAdapterError):
            live2d(self.resources, 'new-release', self.stories, self.public, self.data)
        self.resources.environment.assert_not_called()
        self.export_model.assert_not_called()

    def test_missing_current_location_is_not_treated_as_an_old_cache_miss(self):
        self.resources.locate.side_effect = KeyError('current model missing')
        with self.assertRaisesRegex(KeyError, 'current model missing'):
            live2d(self.resources, 'new-release', self.stories, self.public, self.data)
        self.resources.environment.assert_not_called()
        self.export_model.assert_not_called()

    def test_different_catalog_digest_does_not_reuse_cache(self):
        path = self.prior / 'data/live2d-catalog.json'
        previous = read_json(path)
        previous['catalogSha256'] = '0' * 64
        write_json(path, previous)
        with self.assertRaisesRegex(AssertionError, 'cached model must not be decoded'):
            live2d(self.resources, 'new-release', self.stories, self.public, self.data)
        self.resources.environment.assert_called_once_with(self.bundle)
        self.assertFalse((self.data / 'live2d-catalog.json').exists())


class PackagedBandRankTests(unittest.TestCase):
    def extract(self, root, mapping_names, *, duplicate=False):
        import zipfile
        from tools.current_growth_inputs import growth

        texture = 'ui_assets_embui_texture_bandrank_fixture.bundle'
        apk = root / 'fixture.apk'
        with zipfile.ZipFile(apk, 'w') as archive:
            for name in [texture, *mapping_names]:
                archive.writestr('assets/aa/Android/' + name, b'UnityFS\0fixture')
        loaded = []
        class Environment:
            def __init__(self): self.objects = []
            def load_file(self, _raw, *, name):
                loaded.append(name)
                if name == texture: return
                entries = [{'bandRank': 1, 'sprite': {'m_FileID': 1, 'm_PathID': 11}},
                           {'bandRank': 2, 'sprite': {'m_FileID': 1, 'm_PathID': 12}}]
                if duplicate: entries.append(entries[0])
                self.objects.append(SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'),
                    read_typetree=lambda: {'_type': entries}, assets_file=object()))
        def pointer(*, m_FileID, m_PathID, assetsfile):
            label = {11: 'D1', 12: 'D2'}[m_PathID]
            image = SimpleNamespace(width=2, height=2,
                save=lambda target, *_args, **_kwargs: target.write_bytes(label.encode()))
            return SimpleNamespace(read=lambda: SimpleNamespace(m_Name='ImgScorerank_' + label, image=image))
        decoder = ModuleType('analysis.crypto.decrypt_global_formal_scores')
        decoder.UnityPy = SimpleNamespace(Environment=Environment)
        decoder.decrypt_header = Mock(side_effect=AssertionError('unexpected decrypt'))
        classes = ModuleType('UnityPy.classes'); classes.PPtr = pointer
        resources = SimpleNamespace(apk=apk, locations={}, report={'catalogSha256': 'fixture'})
        with patch.dict('sys.modules', {'analysis.crypto.decrypt_global_formal_scores': decoder,
                                       'UnityPy.classes': classes}):
            count = growth(resources, root / 'growth')
        return count, read_json(root / 'growth/manifest.json'), loaded

    def test_legacy_and_profile_prefab_extract_same_serialized_mapping(self):
        for name in ('ui_assets_embui_prefab_fixparts_band_uibandrankicon_fixture.bundle',
                     'ui_assets_embui_prefab_fixparts_playerprofile_uiplayerprofilebandrankentity_fixture.bundle'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                count, manifest, loaded = self.extract(Path(temporary), [name])
                self.assertIn(name, loaded)
                self.assertEqual(count, 2)
                self.assertEqual([(r['rank'], r['label']) for r in manifest['bandRanks']], [(1, 'D1'), (2, 'D2')])
                self.assertTrue(all((Path(temporary) / 'growth' / row['image']).is_file()
                                    for row in manifest['bandRanks']))

    def test_legacy_prefab_remains_the_unique_primary_source(self):
        old = 'ui_assets_embui_prefab_fixparts_band_uibandrankicon_fixture.bundle'
        new = 'ui_assets_embui_prefab_fixparts_playerprofile_uiplayerprofilebandrankentity_fixture.bundle'
        with tempfile.TemporaryDirectory() as temporary:
            _, _, loaded = self.extract(Path(temporary), [old, new])
            self.assertIn(old, loaded)
            self.assertNotIn(new, loaded)

    def test_missing_ambiguous_or_duplicate_mapping_still_blocks(self):
        prefix = 'ui_assets_embui_prefab_fixparts_playerprofile_uiplayerprofilebandrankentity_'
        for names, duplicate in (([], False), ([prefix + 'a.bundle', prefix + 'b.bundle'], False),
                                 ([prefix + 'a.bundle'], True)):
            with self.subTest(names=names, duplicate=duplicate), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError, 'missing or duplicate rank mapping|duplicate growth image'):
                    self.extract(Path(temporary), names, duplicate=duplicate)
                self.assertFalse((Path(temporary) / 'growth/manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
