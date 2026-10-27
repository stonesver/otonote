import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.scoring_content import bind_scoring_rules, bind_reviewed_reference, TABLES
from tools.build_formal_scoring_rules import project_tables


class ScoringContentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        song = {'_id':1, '_musicType':1, '_bestMusicTagIDs':[2],
                '_gekisouMission1':1, '_gekisouMission2':1, '_gekisouMission3':1}
        self.base = {'sourceReleaseId':'baseline','verificationStatus':'code_audited',
                     'masterSha256':{},'tables':{'LiveMusic':[song], 'LiveMusicScore':[{'_id':100},{'_id':200}]},
                     'nativeSha256':'native','native':{'sourceReleaseId':'baseline','nativeSha256':'native'},
                     'capabilities':{'formationPower':'code_audited'}}
        for name in TABLES:
            raw = json.dumps({'_allData':self.base['tables'].get(name,[])}).encode()
            (self.root/f'Master{name}.json').write_bytes(raw)
            self.base['masterSha256'][f'Master{name}'] = hashlib.sha256(raw).hexdigest()

    def test_current_content_uses_reference_without_relabelling_native_audit(self):
        path = self.root/'MasterLiveMusic.json'; song = self.base['tables']['LiveMusic'][0]
        path.write_text(json.dumps({'_allData':[song,{**song,'_id':2}]}))
        rules = bind_scoring_rules(self.root,'current',self.base)
        self.assertEqual(rules['sourceReleaseId'],'current')
        self.assertEqual(rules['verificationStatus'],'reference_compatible')
        self.assertEqual(rules['native']['sourceReleaseId'],'baseline')
        self.assertFalse(rules['referenceProfile']['currentGameplayVerified'])
        self.assertEqual(len(rules['tables']['LiveMusic']),2)
        self.assertEqual(self.base['verificationStatus'],'code_audited')

    def test_reachable_band_item_levels_travel_with_current_scoring_inputs(self):
        rows = [{'_bandItemId':101, '_level':30, '_playerRank':1}]
        raw = json.dumps({'_allData':rows}).encode()
        (self.root/'MasterBandItemLevel.json').write_bytes(raw)
        rules = bind_scoring_rules(self.root, 'current', self.base)
        self.assertEqual(rules['tables']['BandItemLevel'], rows)
        self.assertEqual(rules['masterSha256']['MasterBandItemLevel'], hashlib.sha256(raw).hexdigest())

    def test_content_changes_use_current_parameters_without_another_audit(self):
        (self.root/'MasterMemberCard.json').write_text('{"_allData":[{"_id":999}]}')
        (self.root/'MasterParameter.json').write_text('{"_allData":[{"_id":"client_version_required","_value":"new"}]}')
        rules = bind_scoring_rules(self.root, 'global-new', self.base)
        self.assertEqual(rules['verificationStatus'], 'reference_compatible')
        self.assertEqual(rules['tables']['MemberCard'], [{'_id':999}])
        self.assertEqual(rules['referenceProfile']['dataCompatibility'], 'supported_model')
        self.assertEqual(rules['native'], self.base['native'])

    def test_new_song_parameters_are_data_and_missing_inputs_still_fail(self):
        song=self.base['tables']['LiveMusic'][0]
        (self.root/'MasterLiveMusic.json').write_text(json.dumps({'_allData':[song,{**song,'_id':3}]}))
        self.assertEqual(len(bind_scoring_rules(self.root,'global-new',self.base)['tables']['LiveMusic']),2)
        (self.root/'MasterMemberCard.json').unlink()
        self.assertEqual(bind_scoring_rules(self.root,'global-new',self.base)['verificationStatus'],'unavailable')

    def test_audited_release_requires_identical_hashes(self):
        self.assertEqual(bind_scoring_rules(self.root,'baseline',self.base),self.base)
        path=self.root/'MasterLiveMusic.json';path.write_text(path.read_text()+' ')
        self.assertEqual(bind_scoring_rules(self.root,'baseline',self.base)['verificationStatus'],'unavailable')

    def test_retired_unconsumed_arena_table_does_not_disable_current_tools(self):
        (self.root/'MasterArenaEventBonus.json').unlink()
        rules = bind_scoring_rules(self.root, 'current', self.base)
        self.assertEqual(rules['verificationStatus'], 'reference_compatible')
        self.assertNotIn('ArenaEventBonus', rules['tables'])
        self.assertNotIn('MasterArenaEventBonus', rules['masterSha256'])
        self.assertEqual(rules['tables']['LiveMusic'][0]['_id'], 1)
        self.assertFalse(rules['referenceProfile']['currentGameplayVerified'])
        self.assertEqual(bind_scoring_rules(self.root, 'baseline', self.base)['reason'], 'audit_input_mismatch')

    def test_present_arena_table_is_still_checked_and_bound(self):
        path = self.root/'MasterArenaEventBonus.json'
        rows = [{'_id':1}]
        raw = json.dumps({'_allData':rows}).encode()
        path.write_bytes(raw)
        rules = bind_scoring_rules(self.root, 'current', self.base)
        self.assertEqual(rules['tables']['ArenaEventBonus'], rows)
        self.assertEqual(rules['masterSha256']['MasterArenaEventBonus'], hashlib.sha256(raw).hexdigest())
        path.write_text('{"_allData":{}}')
        self.assertEqual(bind_scoring_rules(self.root, 'current', self.base)['reason'], 'invalid_scoring_inputs')

    def test_reviewed_profile_uses_current_rows_and_rejects_drift(self):
        # Supply the effect tables required by the projection's closed schema.
        tables, hashes = project_tables(self.root)
        base = {**self.base, 'tables':tables}
        profile = {'id':'test-reference','packageVersion':'test','referenceNativeSha256':'native',
                   'masterSha256':hashes,'unchangedCoreTables':['LiveSettings']}
        rules = bind_reviewed_reference(self.root,'jp-current',base,profile)
        self.assertEqual(rules['verificationStatus'],'reference_compatible')
        self.assertEqual(rules['referenceProfile']['dataCompatibility'],'reviewed_current_tables')
        self.assertEqual(rules['native']['sourceReleaseId'],'baseline')
        self.assertFalse(rules['referenceProfile']['currentGameplayVerified'])
        (self.root/'MasterLiveSettings.json').write_text('{"_allData":[{"_id":1}]}')
        self.assertEqual(bind_reviewed_reference(self.root,'jp-current',base,profile)['reason'],'unreviewed_reference_inputs')
        profile['masterSha256'] = project_tables(self.root)[1]
        self.assertEqual(bind_reviewed_reference(self.root,'jp-current',base,profile)['reason'],'changed_reference_core')
