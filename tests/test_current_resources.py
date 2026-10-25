import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from tools.current_resources import CurrentResources
from tools.global_remote_sync import file_hash, write_json


class ResourceCacheTests(unittest.TestCase):
    def test_absent_unchanged_asset_is_downloaded_and_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            resource = CurrentResources.__new__(CurrentResources)
            resource.cache = Path(tmp)
            resource.report = {'observation': {'cdnRoot': 'https://example.invalid'}, 'catalogSha256': 'catalog-a'}
            resource.downloaded, resource.budget, resource.imports, resource.used = 0, 100, {}, {}
            name = 'long_' * 45 + '0' * 32 + '.bundle'
            location = SimpleNamespace(primary_key=name, expected_size=4, internal_id='https://dummy.net/asset/Android/' + name)
            def download(url, path, size):
                path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'data')
                receipt = {'url': url, 'byteSize': size, 'sha256': file_hash(path)}
                write_json(path.with_name(path.name + '.receipt.json'), receipt)
                return receipt
            with patch('tools.current_resources.acquire', side_effect=download) as acquire:
                path = resource.get(location)
                self.assertLess(len(path.name), 100)
                self.assertEqual(resource.get(location), path)
                acquire.assert_called_once()
                path.write_bytes(b'evil')
                with self.assertRaisesRegex(ValueError, 'integrity mismatch'): resource.get(location)

    def import_recovery(self, root):
        resource = CurrentResources.__new__(CurrentResources)
        resource.cache = root
        resource.report = {'observation': {'cdnRoot': 'https://example.invalid'}, 'catalogSha256': 'catalog-a'}
        resource.downloaded, resource.budget, resource.used = 0, 100, {}
        name = 'fixture.bundle'
        path = root / 'bundles' / name
        path.parent.mkdir()
        path.write_bytes(b'old!')
        shared = root / 'sealed-reference.bundle'
        os.link(path, shared)
        imported = root / 'import.bundle'
        imported.write_bytes(b'new!')
        resource.imports = {name: (imported, file_hash(imported))}
        location = SimpleNamespace(primary_key=name, expected_size=4,
                                   internal_id='https://dummy.net/asset/Android/' + name)
        return resource, location, path, shared

    def test_local_import_recovery_does_not_overwrite_shared_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            resource, location, path, shared = self.import_recovery(Path(tmp))
            prior_inode = shared.stat().st_ino
            with patch('tools.current_resources.acquire', side_effect=AssertionError('unexpected network')):
                self.assertEqual(resource.get(location), path)
                self.assertEqual(resource.get(location), path)
            self.assertEqual(path.read_bytes(), b'new!')
            self.assertEqual(shared.read_bytes(), b'old!')
            self.assertEqual(shared.stat().st_ino, prior_inode)
            self.assertNotEqual(path.stat().st_ino, prior_inode)
            self.assertEqual(resource.used[location.primary_key]['sha256'], file_hash(path))
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ['fixture.bundle', 'fixture.bundle.receipt.json'])

    def test_failed_or_invalid_import_copy_preserves_old_links_and_cleans_stage(self):
        for failure in ('copy-error', 'wrong-size', 'wrong-digest'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                resource, location, path, shared = self.import_recovery(Path(tmp))
                prior_inode = path.stat().st_ino
                def copy(source, destination):
                    Path(destination).write_bytes(b'corrupt' if failure == 'wrong-size' else b'bad!')
                    if failure == 'copy-error':
                        raise OSError('synthetic copy failure')
                with patch('tools.current_resources.shutil.copyfile', side_effect=copy):
                    with self.assertRaises(OSError if failure == 'copy-error' else ValueError):
                        resource.get(location)
                self.assertEqual(path.read_bytes(), b'old!')
                self.assertEqual(shared.read_bytes(), b'old!')
                self.assertEqual(path.stat().st_ino, prior_inode)
                self.assertEqual(shared.stat().st_ino, prior_inode)
                self.assertEqual(list(path.parent.iterdir()), [path])
                self.assertEqual(resource.used, {})

    def test_raw_cri_key_is_scoped_to_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            resource = CurrentResources.__new__(CurrentResources)
            resource.cache = Path(tmp)
            resource.report = {'observation': {'cdnRoot': 'https://example.invalid'}, 'catalogSha256': 'catalog-a'}
            resource.downloaded, resource.budget, resource.imports, resource.used = 0, 100, {}, {}
            loc = SimpleNamespace(primary_key='cri_assets_cri/sound/bgm', expected_size=4, internal_id='https://dummy.net/asset/Android/cri_assets_cri/sound/bgm')
            paths = []
            def download(url, path, size):
                paths.append(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'data')
                return {'url':url,'sha256':file_hash(path),'byteSize':size}
            with patch('tools.current_resources.acquire',side_effect=download):
                resource.get(loc);resource.report['catalogSha256']='catalog-b';resource.get(loc)
            self.assertNotEqual(paths[0],paths[1])

    def test_typed_texture_resolves_shared_sprite_address(self):
        resource = CurrentResources.__new__(CurrentResources)
        def loc(kind): return SimpleNamespace(resource_type=kind, internal_id='same', dependencies=('bundle',), provider_id=kind)
        resource.by_key = {'icon': [loc('UnityEngine.Sprite'), loc('UnityEngine.Texture2D')]}
        self.assertEqual(resource.locate('icon', 'UnityEngine.Texture2D').resource_type,'UnityEngine.Texture2D')
        with self.assertRaisesRegex(ValueError,'ambiguous'): resource.locate('icon')

class CurrentImageCoverageTests(unittest.TestCase):
    def item_resources(self, resource_class=CurrentResources):
        resource = resource_class.__new__(resource_class)
        ordinary, campaign = 'Item/coin', 'Image/Campaign/anniversary'
        common_bundle = 'item_assets_all_' + 'a' * 32 + '.bundle'
        campaign_bundle = 'image_assets_campaign_' + 'b' * 32 + '.bundle'
        def location(key, kind, container, dependencies=()):
            return SimpleNamespace(primary_key=key, resource_type=kind, internal_id=container,
                                   dependencies=dependencies, provider_id='fixture')
        bundles = [location(name, 'bundle', name) for name in (common_bundle, campaign_bundle)]
        textures = [location(ref, 'UnityEngine.Texture2D', 'Assets/AddressableResources/' + ref + '.png', (bundle,))
                    for ref, bundle in ((ordinary, common_bundle), (campaign, campaign_bundle))]
        # Addressables can expose a Sprite and Texture2D at the same address.
        sprite = location(campaign, 'UnityEngine.Sprite', textures[1].internal_id, (campaign_bundle,))
        locations = [*bundles, sprite, *textures]
        resource.catalog = SimpleNamespace(locations=locations)
        resource.locations = {loc.primary_key: loc for loc in locations}
        resource.by_key = {}
        for loc in locations:
            resource.by_key.setdefault(loc.primary_key, []).append(loc)
        resource.rows = lambda table: [{'_imagePath': ref} for ref in (ordinary, campaign)] if table == 'MasterItem' else []
        return resource, textures, bundles

    def test_item_images_follow_typed_catalog_dependencies_in_both_editions(self):
        from tools.current_content_inputs import extract_images
        from tools.jp_phone_inputs import PhoneResources
        for resource_class in (CurrentResources, PhoneResources):
            with self.subTest(edition=resource_class.__name__), tempfile.TemporaryDirectory() as tmp:
                resource, textures, bundles = self.item_resources(resource_class)
                root = Path(tmp)
                write_json(root / 'previous.json', {'assets': []})
                output = root / 'images'; output.mkdir()
                environments = {}
                for index, (texture, bundle) in enumerate(zip(textures, bundles)):
                    image = SimpleNamespace(width=2, height=2, save=lambda target, fmt: target.write_bytes(b'fixture-image'))
                    data = SimpleNamespace(m_Name='fixture', image=image)
                    obj = SimpleNamespace(type=SimpleNamespace(name='Texture2D'), path_id=index,
                                          read=lambda data=data: data)
                    environments[bundle.primary_key] = SimpleNamespace(container={texture.internal_id: obj})
                resource.environment = lambda name: environments[name]
                with patch('tools.current_content_inputs.ROOT', root):
                    extract_images(resource, {'assetManifest': 'previous.json', 'extractedRoot': 'old'}, output)
                assets = json.loads((output / 'manifest.json').read_text())['assets']
                self.assertEqual({a['container_path']: a['bundle'] for a in assets},
                                 {texture.internal_id: bundle.primary_key for texture, bundle in zip(textures, bundles)})
                self.assertTrue(all((output / a['exported_file']).is_file() for a in assets))

    def test_item_image_requires_one_catalog_texture_and_one_bundle(self):
        from tools.current_content_inputs import core_image_targets
        for invalid in ('missing', 'ambiguous', 'no-bundle', 'two-bundles'):
            with self.subTest(invalid=invalid):
                resource, textures, bundles = self.item_resources()
                texture = textures[1]
                if invalid == 'missing':
                    resource.by_key[texture.primary_key] = []
                elif invalid == 'ambiguous':
                    other = SimpleNamespace(**vars(texture)); other.internal_id += '.other'
                    resource.by_key[texture.primary_key].append(other)
                else:
                    texture.dependencies = () if invalid == 'no-bundle' else tuple(b.primary_key for b in bundles)
                with self.assertRaisesRegex(ValueError, 'catalog entry|texture dependency'):
                    core_image_targets(resource)

    def test_new_asset_ids_and_removals_follow_current_master(self):
        from tools.current_content_inputs import core_image_targets
        class Resources:
            catalog = SimpleNamespace(locations=[])
            members = [{'_id': 999, '_assetID': 2001}]
            def rows(self,name): return self.members if name=='MasterMemberCard' else []
            def prefix(self,name): return name
        resource=Resources()
        first=core_image_targets(resource)
        self.assertEqual(list(first),['Assets/AddressableResources/MemberCard/2001/member_full.png'])
        resource.members=[{'_id':1000,'_assetID':2002}]
        second=core_image_targets(resource)
        self.assertEqual(list(second),['Assets/AddressableResources/MemberCard/2002/member_full.png'])


class NonPlayableCharacterImageTests(unittest.TestCase):
    def resources(self, resource_class, characters):
        resource = resource_class.__new__(resource_class)
        name = 'character-image_assets_character-image-1everythinginitialdownload_' + 'a' * 32 + '.bundle'
        location = SimpleNamespace(primary_key=name)
        resource.locations = {name: location}
        resource.catalog = SimpleNamespace(locations=[])
        resource.rows = lambda table: characters if table == 'MasterCharacter' else []
        return resource

    def test_explicit_nonplayable_has_no_required_portrait_bundle_in_both_editions(self):
        from tools.current_content_inputs import core_image_targets
        from tools.jp_phone_inputs import PhoneResources
        characters = [{'_id': 1, '_isNonPlayable': False}, {'_id': 1001, '_isNonPlayable': True}]
        for resource_class in (CurrentResources, PhoneResources):
            with self.subTest(edition=resource_class.__name__):
                targets = core_image_targets(self.resources(resource_class, characters))
                self.assertEqual(set(targets), {
                    'Assets/AddressableResources/Character/Image/1/' + role + '.png'
                    for role in ('character_thumbnail', 'character_sprite', 'character_face_icon')})
                self.assertEqual(len(characters), 2)

    def test_missing_playable_portrait_still_blocks_without_id_heuristic(self):
        from tools.current_content_inputs import core_image_targets
        for flag in ({}, {'_isNonPlayable': False}, {'_isNonPlayable': 'true'}):
            with self.subTest(flag=flag):
                resource = self.resources(CurrentResources, [{'_id': 1001, **flag}])
                with self.assertRaisesRegex(ValueError, 'no unique resource'):
                    core_image_targets(resource)
        self.assertEqual(core_image_targets(self.resources(CurrentResources, [{'_id': 1, '_isNonPlayable': True}])), {})
