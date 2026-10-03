import json
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from tools.costume_catalog import project_costumes
from tools.costume_assets import extract_costume_icons
from tools.costume_posters import poster_inputs, matches_costume_model


class CostumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = {'release': {'id': 'fixture', 'locale': 'zh-CN', 'region': 'global'},
                        'characters': [{'id': 'character-1', 'masterId': 1, 'bandId': 'band-1'}],
                        'memberCards': [{'id': 'member-card-9', 'masterId': 9, 'characterId': 'character-1'}]}
        self.groups = [{'_id': 1, '_characterID': 1, '_isChangeable': True, '_isInitial': False,
                        '_costumeNameTextId': 'outfit', '_iconPath': 'Character/costume/icon with space',
                        '_specialConditionMemberCardId': 9, '_startAt': '2030/10/04 0:00:00'},
                       {'_id': 2, '_characterID': 1, '_isChangeable': False, '_isInitial': True,
                        '_costumeNameTextId': '', '_iconPath': '', '_specialConditionMemberCardId': 0}]
        self.models = [{'_id': n, '_characterID': 1, '_groupID': 1, '_costumeType': n, '_live2dPath': f'model-{n}'} for n in (1, 2)]
        self.live = {'releaseId': 'fixture', 'models': [{'id': f'published-{n}', 'modelPath': f'model-{n}',
                      'characterId': 1, 'state': 'available'} for n in (1, 2)]}
        self.write('MasterCharacterCostumeGroup', self.groups)
        self.write('MasterCharacterCostume', self.models)
        self.write('MasterText', [{'_id': 'outfit', '_simplifiedChinese': '样例服装', '_english': 'Fixture costume'}])

    def write(self, name, rows):
        (self.root / (name + '.json')).write_text(json.dumps({'_allData': rows}))

    def project(self, **kwargs):
        return project_costumes(self.root, self.catalog, live2d=self.live, **kwargs)

    def test_groups_are_outfits_and_paths_select_published_ids(self):
        rows = self.project()['costumes']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['name'], '样例服装')
        self.assertEqual(rows[0]['unlockMemberCardId'], 'member-card-9')
        self.assertEqual(rows[0]['startAt'], '2030/10/04 0:00:00')
        self.assertEqual([r['modelId'] for r in rows[0]['models']], ['published-1', 'published-2'])
        self.catalog['release']['locale'] = 'en'
        self.assertEqual(self.project()['costumes'][0]['name'], 'Fixture costume')

    def test_missing_table_empty_table_missing_text_and_model(self):
        self.write('MasterText', [])
        self.live['models'] = []
        row = self.project()['costumes'][0]
        self.assertEqual(row['name'], '服装 #1')
        self.assertTrue(all(m['modelId'] is None for m in row['models']))
        (self.root / 'MasterCharacterCostumeGroup.json').unlink()
        self.assertEqual(self.project()['status'], 'unavailable')
        self.write('MasterCharacterCostumeGroup', [])
        self.write('MasterCharacterCostume', [])
        self.assertEqual(self.project()['status'], 'available')

    def test_initial_costume_and_unknown_acquisition(self):
        self.groups[0].update(_isInitial=True, _specialConditionMemberCardId=0)
        self.write('MasterCharacterCostumeGroup', self.groups)
        row = self.project()['costumes'][0]
        self.assertTrue(row['isInitial'])
        self.assertIsNone(row['unlockMemberCardId'])
        self.groups[0]['_isInitial'] = False
        self.write('MasterCharacterCostumeGroup', self.groups)
        self.assertIsNone(self.project()['costumes'][0]['unlockMemberCardId'])

    def test_duplicate_and_cross_character_relations_rejected(self):
        self.write('MasterCharacterCostumeGroup', self.groups + self.groups[:1])
        with self.assertRaisesRegex(ValueError, 'duplicate'): self.project()
        self.write('MasterCharacterCostumeGroup', self.groups)
        self.models[0]['_characterID'] = 2
        self.write('MasterCharacterCostume', self.models)
        with self.assertRaisesRegex(ValueError, 'model group'): self.project()
        self.write('MasterCharacterCostume', [])
        self.catalog['memberCards'][0]['characterId'] = 'character-2'
        with self.assertRaisesRegex(ValueError, 'unlock card'): self.project()
        self.catalog['memberCards'] = []
        with self.assertRaisesRegex(ValueError, 'unlock card'): self.project()

    def test_other_release_or_character_model_is_rejected(self):
        self.live['releaseId'] = 'other'
        with self.assertRaisesRegex(ValueError, 'release'): self.project()
        self.live['releaseId'] = 'fixture'
        self.live['models'][0]['characterId'] = 2
        with self.assertRaisesRegex(ValueError, 'character mismatch'): self.project()

    def test_full_body_image_is_bound_to_exact_model_and_validated_input(self):
        directory = self.root / 'icons/posters'
        directory.mkdir(parents=True)
        data = b'fixture-webp'; sha = hashlib.sha256(data).hexdigest()
        name = f'1-{sha}.webp'; (directory / name).write_bytes(data)
        self.live['models'][0]['sourceSha256'] = 'a' * 64
        poster = {'groupId':1,'characterId':1,'modelPath':'model-1','sourceSha256':'a'*64,
                  'file':name,'sha256':sha,'width':600,'height':800}
        manifest = directory / 'manifest.json'
        manifest.write_text(json.dumps({'schemaVersion':1,'posters':[poster]}))
        binding = {'costumePosterInputs':{'root':'icons/posters','sha256':hashlib.sha256(manifest.read_bytes()).hexdigest()}}
        self.assertEqual(poster_inputs(binding, self.root), directory.resolve())
        image = self.project(icons_root=self.root/'icons')['costumes'][0]['poster']
        self.assertEqual(image['url'], '/costumes/posters/' + name)
        self.live['models'][0]['sourceSha256'] = 'b' * 64
        self.assertIsNone(self.project(icons_root=self.root/'icons')['costumes'][0]['poster'])
        (directory / name).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'integrity'): poster_inputs(binding, self.root)

    def test_dialogue_counterparts_must_match_the_exact_costume_name(self):
        paths = ['022_live/live2d_miku_022_birthday2627_01_low/model/live2d_miku_022_birthday2627_01_low']
        model = {'usage':'story','modelPath':'022_adv/adv_live2d_miku_022_birthday2627_01/model/adv_live2d_miku_022_birthday2627_01'}
        self.assertTrue(matches_costume_model(model, paths))
        self.assertFalse(matches_costume_model({**model,'usage':'live'},paths))
        self.assertFalse(matches_costume_model({**model,'modelPath':model['modelPath'].replace('birthday2627','live')},paths))

    def resources(self):
        reference = self.groups[0]['_iconPath']
        cropped = SimpleNamespace(width=12, height=20)
        cropped.convert = Mock(return_value=cropped)
        cropped.save = Mock(side_effect=lambda stream, *args, **kwargs: stream.write(b'cropped sprite pixels'))
        sprite = SimpleNamespace(type=SimpleNamespace(name='Sprite'), read=Mock(return_value=SimpleNamespace(image=cropped)))
        texture = SimpleNamespace(type=SimpleNamespace(name='Texture2D'), read=Mock(side_effect=AssertionError('must crop Sprite, not atlas Texture2D')))
        loc = SimpleNamespace(resource_type='UnityEngine.Sprite', dependencies=['icon.bundle'], internal_id='exact-container')
        self.sprite = sprite
        return SimpleNamespace(master=self.root, report={'catalogSha256': 'a' * 64},
            by_key={reference: [SimpleNamespace(resource_type='UnityEngine.Texture2D'), loc]},
            environment=Mock(return_value=SimpleNamespace(container={'exact-container': sprite, 'atlas': texture})))

    def test_sprite_image_not_atlas_exported_and_verified(self):
        output = self.root / 'icons'
        self.assertEqual(extract_costume_icons(self.resources(), output), 1)
        icon = self.project(icons_root=output)['costumes'][0]['icon']
        self.assertEqual((icon['width'], icon['height']), (12, 20))
        path = output / icon['url'].split('/')[-1]
        self.assertEqual(path.read_bytes(), b'cropped sprite pixels')
        path.write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError, 'integrity'): self.project(icons_root=output)

    def test_missing_sprite_is_explicit_and_stale_group_manifest_rejected(self):
        resources = self.resources(); resources.by_key = {}
        output = self.root / 'icons'
        self.assertEqual(extract_costume_icons(resources, output), 0)
        self.assertIsNone(self.project(icons_root=output)['costumes'][0]['icon'])
        self.groups[0]['_iconPath'] = 'another'
        self.write('MasterCharacterCostumeGroup', self.groups)
        with self.assertRaisesRegex(ValueError, 'Master groups'): self.project(icons_root=output)

    def test_unsupported_sprite_can_fall_back_but_decode_errors_cannot(self):
        resources = self.resources()
        self.sprite.read.side_effect = NotImplementedError('format')
        self.assertEqual(extract_costume_icons(resources, self.root / 'icons'), 0)
        self.sprite.read.side_effect = ValueError('corrupt')
        with self.assertRaisesRegex(ValueError, 'corrupt'):
            extract_costume_icons(resources, self.root / 'icons')
