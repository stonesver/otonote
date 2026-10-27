import hashlib
import json
import os
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.jp_phone_inputs import PhoneResources, extract_taxonomy
from tools.jp_remote_sync import remote_cache_name, resource_identity


class JpTaxonomyTests(unittest.TestCase):
    def resources(self, localized):
        from tools.build_site_catalog import CARD_TAXONOMY_NAMES
        atlas = 'ui_assets_embui_atlas_fixuispriteatlas_' + 'a' * 32 + '.bundle'
        resources = SimpleNamespace(packaged={name: 'assets/aa/Android/' + name
                                             for name in [atlas, *localized]})
        calls = []

        def environment(name):
            self.assertIn(name, resources.packaged)
            calls.append(name)
            names = CARD_TAXONOMY_NAMES if name == atlas else ['icon_awakened']
            image = SimpleNamespace(width=2, height=2,
                                    save=lambda target, _format: target.write_bytes(b'fixture-png'))
            objects = []
            for index, key in enumerate(sorted(names), 1):
                data = SimpleNamespace(m_Name=key, image=image)
                objects.append(SimpleNamespace(type=SimpleNamespace(name='Sprite'), path_id=index,
                                               read=lambda data=data: data))
            return SimpleNamespace(objects=objects)

        resources.environment = environment
        return resources, calls

    def test_taxonomy_uses_unique_legacy_or_current_japanese_package(self):
        for localized in ('localization-assets-japanese(ja)_assets_all.bundle',
                          'localization-assets-japanese_assets_all.bundle'):
            with self.subTest(localized=localized), TemporaryDirectory() as directory:
                resources, calls = self.resources([localized, 'localization-assets-english_assets_all.bundle'])
                count = extract_taxonomy(resources, Path(directory))
                rows = json.loads((Path(directory) / 'manifest.json').read_text())['assets']
                awake = next(row for row in rows if row['name'] == 'icon_awakened')
                self.assertEqual(awake['bundle'], localized)
                self.assertEqual(calls[1:], [localized])
                self.assertEqual(count, len(rows))
                self.assertTrue((Path(directory) / awake['exported_file']).is_file())

    def test_missing_or_ambiguous_japanese_package_blocks_taxonomy(self):
        for localized in ([], ['localization-assets-english_assets_all.bundle'],
                          ['localization-assets-japanese(ja)_assets_all.bundle',
                           'localization-assets-japanese_assets_all.bundle']):
            with self.subTest(localized=localized), TemporaryDirectory() as directory:
                resources, calls = self.resources(localized)
                with self.assertRaisesRegex(ValueError, 'missing unique JP Japanese localization bundle'):
                    extract_taxonomy(resources, Path(directory))
                self.assertEqual(calls, [])
                self.assertFalse((Path(directory) / 'manifest.json').exists())


class JpCacheTests(unittest.TestCase):
    def test_remote_reuse_survives_prior_run_pruning_and_checks_identity(self):
        with TemporaryDirectory() as directory:
            root=Path(directory); payload=b'JP verified resource'; name='sample.bundle'
            loc=SimpleNamespace(primary_key=name,expected_hash='catalog-hash',expected_size=len(payload),
                provider_id='provider',resource_type='bundle',internal_id='{Fwk.Resource.RemoteAssetDir}/sample.bundle')
            identity=resource_identity(loc); sha=hashlib.sha256(payload).hexdigest()
            old=root/'old';old.mkdir();path=old/remote_cache_name(identity);path.write_bytes(payload)
            receipt=path.with_name(path.name+'.receipt.json')
            receipt.write_text(json.dumps({'identity':identity,'sha256':sha,
                'url':'https://static.bang-dream-on.jp/asset/1.0.0/Android/'+('a'*32)+'/sample.bundle'}))
            prior=SimpleNamespace(locations=[loc],catalog_hash='prior')
            def resource(cache):
                value=PhoneResources.__new__(PhoneResources)
                value.locations={name:loc};value.shared={};value.encrypted={};value.cached={}
                value.packaged={};value.used={};value.cache=cache;value.remote_client=object()
                value.report={'observation':{'resourceVersion':'1.0.0.300/'+'b'*32}}
                return value
            new=resource(root/'new')
            with patch('tools.jp_phone_inputs.CatalogAdapter.parse',return_value=prior):
                new.reuse_local(root/'catalog',[old])
            copied=new.get(loc)
            self.assertEqual(copied.read_bytes(),payload)
            self.assertTrue(copied.is_relative_to(root/'new'))
            shutil.rmtree(old)
            third=resource(root/'third')
            with patch('tools.jp_phone_inputs.CatalogAdapter.parse',return_value=prior):
                third.reuse_local(root/'new-catalog',[root/'new'])
            self.assertEqual(third.get(loc).read_bytes(),payload)
            row=json.loads(copied.with_name(copied.name+'.receipt.json').read_text())
            row['identity']['provider']='wrong-provider'
            copied.with_name(copied.name+'.receipt.json').write_text(json.dumps(row))
            with patch('tools.jp_phone_inputs.CatalogAdapter.parse',return_value=prior):
                with self.assertRaisesRegex(ValueError,'identity mismatch'):
                    resource(root/'fourth').reuse_local(root/'catalog',[root/'new'])

    def test_shared_bytes_require_matching_catalog_binding_and_receipt(self):
        with TemporaryDirectory() as directory:
            root=Path(directory);name='asset_'+'a'*32+'.bundle';payload=b'UnityFS\0test'
            loc=SimpleNamespace(primary_key=name,expected_hash='catalog-hash',expected_size=len(payload),provider_id='provider',resource_type='bundle')
            path=root/name;path.write_bytes(payload)
            sha=hashlib.sha256(payload).hexdigest()
            (root/(name+'.receipt.json')).write_text(json.dumps({'url':'https://cdn.invalid/asset/Android/'+name,'sha256':sha}))
            resource=PhoneResources.__new__(PhoneResources)
            resource.locations={name:loc};resource.shared={};resource.encrypted={};resource.cached={};resource.packaged={};resource.used={}
            prior=SimpleNamespace(locations=[SimpleNamespace(**{**vars(loc),'expected_hash':'another-hash'})],catalog_hash='prior')
            with patch('tools.jp_phone_inputs.CatalogAdapter.parse',return_value=prior):resource.reuse_local(root/'catalog', [root])
            with self.assertRaisesRegex(ValueError,'missing unique'):resource.get(loc)
            prior.locations=[loc]
            with patch('tools.jp_phone_inputs.CatalogAdapter.parse',return_value=prior):resource.reuse_local(root/'catalog',[Path(os.path.relpath(root))])
            self.assertTrue(resource.get(loc).is_absolute())
            self.assertEqual(resource.get(loc).read_bytes(),payload)
            self.assertEqual(resource.used[name]['origin'],'identical-catalog-local-cache')
            path.write_bytes(b'x'*len(payload))
            with self.assertRaisesRegex(ValueError,'digest mismatch'):resource.get(loc)
