import json
import unittest
from unittest.mock import patch
from tools.arena_personal import ArenaPersonalClient, MY_RANK_METHOD, extract_my_rank
from tools.growth_login import GameClient, LoginError, integer, message
from tests.test_global_account_reads import gateway, Transport
from tests import test_growth_web as growth_web
from tests.test_growth_web import FakeGame
from tools.growth_export import fields


def response():
    return (message(1, integer(1,900)+integer(2,3))
            +message(2,integer(1,1)+integer(2,100)+integer(3,12345))
            +message(2,integer(1,2)))


class ArenaPersonalTests(unittest.TestCase):
    def read(self,raw,band='1'):
        return extract_my_rank(raw,'1',band,server_id='global-hmt',client_version='1.1.0',master_version='a'*32)

    def test_ranked_unranked_and_absent_are_distinct_and_master_rank_is_not_league_rank(self):
        result=self.read(response());self.assertEqual((result['rank'],result['point']),(12345,100))
        self.assertEqual(result['source']['masterVersion'],'a'*32)
        self.assertEqual(self.read(response(),'2')['status'],'unranked')
        missing=self.read(response(),'3');self.assertEqual(missing['status'],'unavailable')
        self.assertIsNone(missing['point']);self.assertNotIn('mp',result)
        self.assertNotIn('playerId',result)

    def test_rejects_duplicate_wrong_wire_negative_or_oversize_without_guessing(self):
        for raw in (response()+message(2,integer(1,1)), integer(2,1), message(2,integer(1,1)+integer(3,2**32)),
                    message(2,integer(1,1)+integer(2,2**54)),message(2,integer(1,1)+integer(2,1)+integer(2,2))):
            with self.subTest(raw=raw),self.assertRaises(LoginError):self.read(raw)
        for season in ('0','-1','1&playerId=2',1,True,None):
            with self.subTest(season=season),self.assertRaises(LoginError):
                extract_my_rank(b'',season,'1',server_id='global-hmt',client_version='1.1.0')

    def test_public_master_version_is_bound_before_auth_and_unknown_stays_unknown(self):
        from tools.arena_personal import VERSION_METHOD
        game=ArenaPersonalClient()
        for raw,expected in ((message(1,'a'*32),'a'*32),(b'',None),(message(1,'unverified'),None)):
            with patch.object(GameClient,'_public_rpc',return_value=raw):
                game._public_rpc('synthetic-host',VERSION_METHOD)
            self.assertEqual(game.master_version,expected)

    def test_one_read_per_user_authenticates_independently_in_selected_server_and_clears_auth(self):
        value,profiles,logins=gateway();value.arena_factory=ArenaPersonalClient
        class PersonalTransport(Transport):
            def channel(self,target,*args,**kwargs):
                channel=super().channel(target,*args,**kwargs);original=channel.unary_unary
                def unary(method,**options):
                    if method=='/'+MY_RANK_METHOD:
                        def call(payload,**params):
                            self.calls.append((target[:-4],method,payload,dict(params['metadata'])))
                            return response()
                        return call
                    return original(method,**options)
                channel.unary_unary=unary;return channel
        transport=PersonalTransport()
        with patch('grpc.secure_channel',side_effect=transport.channel):
            for sid in ('global-hmt','global-en','global-kr'):
                status,result=value.read_growth('SYNTHETIC','SYNTHETIC',server_id=sid,arena=('1','1'))
                self.assertEqual(status,200,result);self.assertEqual(result['snapshot']['source']['serverId'],sid)
                self.assertEqual(result['snapshot']['rank'],12345)
        reads=[r for r in transport.calls if r[1]=='/'+MY_RANK_METHOD]
        self.assertEqual(len(reads),3);self.assertEqual(len(logins),3)
        self.assertTrue(all(list(fields(r[2]))==[(1,0,1)] for r in reads))
        self.assertFalse(any(r[1].endswith(('/ArenaRanking','/ArenaTop','/GetPlayerData')) for r in transport.calls))
        self.assertFalse(hasattr(value,'snapshot'));self.assertFalse(hasattr(value,'identity'))
        self.assertEqual(ArenaPersonalClient.read_methods-GameClient.read_methods,{MY_RANK_METHOD})
        game=ArenaPersonalClient();auth=[('x-player-id','SYNTHETIC')]
        with patch.object(game,'authenticate',return_value=auth),patch.object(game,'rpc',side_effect=LoginError('game_rpc_unavailable')):
            with self.assertRaises(LoginError):game.export_rank(None,None,'host','1','1')
        self.assertEqual(auth,[])


class ArenaPersonalWebTests(unittest.TestCase):
    request = growth_web.GrowthWebTests.request
    tearDown = growth_web.GrowthWebTests.tearDown

    def setUp(self):
        growth_web.GrowthWebTests.setUp(self)
        class Personal(FakeGame):
            def export_rank(self,identity,device,host,season,band,progress):
                progress('reading_arena_rank')
                return extract_my_rank(response(),season,band,server_id=self.server_id,client_version=self.client_version)
        self.server.arena_factory=Personal

    def test_personal_route_uses_common_nonce_origin_capacity_and_no_store_without_id_selector(self):
        caps=json.loads(self.request('capabilities',method='GET')[2]);self.assertTrue(caps['arenaPersonal'])
        body={'account':'SYNTHETIC','password':'synthetic-password','serverId':'global-en','seasonId':'1','bandId':'1'}
        status,headers,raw=self.request('arena-rank',body=json.dumps(body));self.assertEqual(status,200)
        self.assertEqual(headers['Cache-Control'],'no-store');value=json.loads(raw)['snapshot']
        self.assertEqual(value['source']['serverId'],'global-en');self.assertEqual(value['rank'],12345)
        self.assertNotIn('SYNTHETIC',raw.decode());self.assertNotIn('SYNTHETIC',json.dumps(self.diagnostics))
        self.assertFalse(hasattr(self.server,'snapshot'))
        from tests.test_growth_web import FakeSdk
        with patch.object(FakeSdk,'login') as login:
            for bad in ({**body,'playerId':'other'},{**body,'rank':10001},{k:v for k,v in body.items() if k!='serverId'},
                        {**body,'seasonId':'0'},{**body,'bandId':[]},{**body,'serverId':'jp'}):
                self.assertEqual(self.request('arena-rank',body=json.dumps(bad))[0],400)
            for delta in ({'X-Growth-Nonce':'bad'},{'Origin':'https://evil.invalid'}):
                self.assertEqual(self.request('arena-rank',body=json.dumps(body),delta=delta)[0],403)
            login.assert_not_called()
