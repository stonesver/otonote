import json
import tempfile
import unittest
from pathlib import Path
from tools.collect_arena_trends import RPC, ArenaTrendClient, decode_trend, save_observations, trend_plan
from tools.growth_login import GameClient, LoginError, integer, message, single
from tests.test_arena_rankings import projection, NOW


class ArenaTrendCollectionTests(unittest.TestCase):
    def catalog(self):
        return dict(release=dict(id='test-release'), bands=[dict(id='band-1', masterId=1)],
                    musicTracks=[dict(masterId=1001, bandIds=['band-1']), dict(masterId=1002, bandIds=['band-1'])])

    def test_plan_uses_same_release_exact_server_and_catalog_songs(self):
        plan = trend_plan(projection(), 'a' * 64, self.catalog(), 'b' * 64, 'global-hmt', now=NOW)
        self.assertEqual(plan['queries'], [dict(bandId='1',musicId=1001), dict(bandId='1',musicId=1002)])
        self.assertIsNone(trend_plan(projection(), 'a' * 64, self.catalog(), 'b' * 64, 'global-en', now=NOW))
        c = self.catalog(); c['release']['id'] = 'other'
        with self.assertRaises(ValueError): trend_plan(projection(), 'a' * 64, c, 'b' * 64, 'global-hmt', now=NOW)
        c = self.catalog(); c['musicTracks'] *= 101
        with self.assertRaises(ValueError): trend_plan(projection(), 'a' * 64, c, 'b' * 64, 'global-hmt', now=NOW)

    def test_three_wire_groups_preserve_official_order_and_drop_unknown_fields(self):
        raw = message(1,integer(1,12)+message(9,'synthetic-private'))+message(2,integer(1,22))+message(2,integer(1,11))+message(3,integer(1,32))
        self.assertEqual(decode_trend(raw),dict(leaders=[dict(memberCardId=12)],members=[dict(memberCardId=22),dict(memberCardId=11)],supports=[dict(supportCardId=32)]))
        self.assertEqual(decode_trend(b''),dict(leaders=[],members=[],supports=[]))
        with self.assertRaises(LoginError): decode_trend(message(1,integer(1,0)))
        with self.assertRaises(LoginError): decode_trend(integer(1,12))

    def test_public_review_file_is_atomic_whitelisted_and_mode_600(self):
        records=[dict(source='ArenaService.DeckTrend',serverId='global-hmt',seasonId='1',bandId='1',musicId=1001,
                      observedAt='2026-10-29T01:00:00Z',response=decode_trend(message(1,integer(1,12))),account='synthetic-private')]
        with tempfile.TemporaryDirectory() as root:
            path=save_observations(records,root,'global-hmt')[0];before=path.read_bytes()
            self.assertNotIn(b'synthetic-private',before);self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(before)[0]['response']['leaders'],[dict(memberCardId=12)])
            records[0]['source']='unknown'
            with self.assertRaises(ValueError): save_observations(records,root,'global-hmt')
            self.assertEqual(path.read_bytes(),before)

    def test_capture_only_calls_trend_with_explicit_song_season_band_and_clears_auth(self):
        plan=trend_plan(projection(),'a'*64,self.catalog(),'b'*64,'global-hmt',now=NOW)
        auth=[('synthetic','synthetic-token')];calls=[]
        class Client(ArenaTrendClient):
            def authenticate(self,*args):return auth
            def rpc(self,host,method,payload=b'',credential=()):
                calls.append((method,single(payload,1,wire=0),single(payload,2,wire=0),single(payload,3,wire=0)))
                return message(1,integer(1,12))
        rows=Client(plan).export(None,None,'host')
        self.assertEqual(calls,[(RPC,1001,1,1),(RPC,1002,1,1)]);self.assertEqual(auth,[]);self.assertEqual(len(rows),2)
        self.assertEqual(ArenaTrendClient.read_methods-GameClient.read_methods,{RPC})


if __name__=='__main__':unittest.main()
