"""Region/version integration with synthetic RPCs only; never authenticates players."""
import json
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock, patch

import grpc

from tests.test_growth_export import account_response
from tests.test_gacha_history import execution
from tools.global_game_config import GLOBAL_SERVERS
from tools.growth_login import (BOOTSTRAP, LOGIN_SERVICE, GameClient, LoginError,
                                Profile, SdkClient, SdkIdentity, integer, message, string)
from tools.gacha_history import GachaHistoryClient, HISTORY_METHOD
from tools.growth_web import GrowthGateway
from tools.growth_login_local import LoginServer


class Update(grpc.RpcError):
    def __init__(self, metadata=(('x-client-recommended-version','1.0.6'),)):
        self.metadata = metadata
    def details(self): return 'client update required'
    def code(self): return grpc.StatusCode.UNKNOWN
    def trailing_metadata(self): return self.metadata


def server_list(override=None):
    return b''.join(message(1, message(1, server['name']) + message(8, server['wireId'])
        + message(3, 'https://' + (override or server['hosts'][-1])))
        for server in GLOBAL_SERVERS.values())


class Transport:
    def __init__(self, *, existing=True, late_update=False):
        self.calls=[];self.existing=existing;self.late_update=late_update
    def channel(self, target, *args, **kwargs):
        transport=self
        class Channel:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def unary_unary(self, method, **kwargs):
                def call(payload, *, metadata, **kwargs):
                    headers=dict(metadata);transport.calls.append((target[:-4],method,payload,headers))
                    if headers['x-client-version']!='1.0.6':raise Update()
                    if method.endswith('/GetServerList'):return server_list()
                    if method.endswith('/Version'):return b''
                    if transport.late_update:raise Update((('x-client-recommended-version','1.0.7'),))
                    if method.endswith('/PlayerPreLogin'):return integer(1,1) if transport.existing else b''
                    if method.endswith('/PlayerLogin'):return message(1,message(1,'FAKE-PLAYER')+message(2,'FAKE-CREDENTIAL'))
                    if method.endswith('/GetPlayerData'):return account_response()
                    if method=='/'+HISTORY_METHOD:return execution(51,51)
                    raise AssertionError('unexpected RPC')
                return call
        return Channel()


def gateway():
    profiles=[];logins=[]
    def sdk(profile):
        profiles.append(profile)
        # Exercise the actual SDK parameter builder without HTTP.
        assert SdkClient(profile).parameters({})['app_ver']==profile.version
        def login(account,password):
            logins.append((account,password))
            return SdkIdentity('FAKE-'+str(len(logins)),'FAKE-TOKEN')
        return SimpleNamespace(login=login,device_id='FAKE-DEVICE')
    value=object.__new__(GrowthGateway)
    value.profile=Profile('FAKE-APP-KEY');value.sdk_factory=sdk
    value.game_factory=GameClient;value.history_factory=GachaHistoryClient
    return value,profiles,logins


class GlobalAccountReadsTests(unittest.TestCase):
    def test_each_region_and_feature_freezes_one_negotiated_version_and_authenticates_independently(self):
        value,profiles,logins=gateway();transport=Transport()
        with patch('grpc.secure_channel',side_effect=transport.channel):
            for server_id, server in GLOBAL_SERVERS.items():
                for history in (False,True):
                    with self.subTest(server=server_id,history=history):
                        start=len(transport.calls)
                        status,result=value.read_growth('FAKE-ACCOUNT','FAKE-PASSWORD',history=history,server_id=server_id)
                        self.assertEqual(status,200,result)
                        snapshot=result['snapshot'];self.assertEqual(snapshot['source']['serverId'],server_id)
                        self.assertEqual(snapshot['source']['region'],
                                         'TW/HK/MO' if server_id == 'global-hmt' else 'global')
                        self.assertEqual(snapshot['source']['clientVersion'],'1.0.6')
                        calls=transport.calls[start:]
                        self.assertEqual([c[3]['x-client-version'] for c in calls[:2]],['1.0.3','1.0.6'])
                        self.assertTrue(all(c[0] in server['hosts'] for c in calls[2:]))
                        self.assertTrue(all(c[3]['x-client-version']=='1.0.6' for c in calls[2:]))
                        for call in calls:
                            if call[1].endswith(('/PlayerPreLogin','/PlayerLogin')):self.assertEqual(string(call[2],6),'1.0.6')
                        self.assertNotIn('FAKE',json.dumps(snapshot))
        self.assertEqual(len(logins),6);self.assertEqual(len(profiles),6)
        self.assertEqual([p.language for p in profiles],['zh','zh','en','en','ko','ko'])
        self.assertTrue(all(p.version=='1.0.6' for p in profiles))
        self.assertEqual(value.profile.version,'1.0.3')
        self.assertFalse(hasattr(value,'identity'))

    def test_missing_role_never_creates_or_logs_into_role(self):
        transport=Transport(existing=False);value,_,logins=gateway()
        with patch('grpc.secure_channel',side_effect=transport.channel):
            status,result=value.read_growth('FAKE','FAKE',server_id='global-en')
        self.assertEqual((status,result['error']),(422,'no_existing_role_in_selected_server'))
        self.assertEqual(len(logins),1)
        self.assertFalse(any(c[1].endswith('/PlayerLogin') for c in transport.calls))

    def test_late_upgrade_stops_without_replaying_credentials_or_changing_frozen_version(self):
        transport=Transport(late_update=True);value,profiles,logins=gateway()
        with patch('grpc.secure_channel',side_effect=transport.channel):
            status,result=value.read_growth('FAKE','FAKE',server_id='global-kr')
        self.assertEqual((status,result['error']),(422,'game_client_update_required'))
        self.assertEqual(len(logins),1);self.assertEqual(len(transport.calls),4)
        self.assertEqual(profiles[0].version,'1.0.6')

    def test_discovery_and_player_requests_reject_other_regions_even_on_global_allowlist(self):
        game=GameClient('global-en')
        for host in GLOBAL_SERVERS['global-hmt']['hosts']+GLOBAL_SERVERS['global-kr']['hosts']:
            with self.assertRaisesRegex(LoginError,'game_target_refused'):
                game.rpc(host,LOGIN_SERVICE+'PlayerPreLogin')
        for target in ['evil.invalid',GLOBAL_SERVERS['global-kr']['hosts'][0]]:
            with patch.object(game,'rpc',return_value=server_list(target)):
                with self.assertRaisesRegex(LoginError,'unexpected_game_server'):game.discover()
        for malformed in ([],{},None,'jp','global-other'):
            with self.assertRaisesRegex(LoginError,'unsupported_game_server'):GameClient(malformed)

    def test_public_upgrade_hint_is_strict_and_at_most_one_retry(self):
        invalid=[(),(('x-client-recommended-version','bad\nvalue'),),
                 (('x-client-recommended-version','9'*200),),
                 (('x-client-recommended-version','1.0.6'),)*2]
        for metadata in invalid:
            game=GameClient('global-en')
            with patch('grpc.secure_channel') as channel:
                call=channel.return_value.__enter__.return_value.unary_unary.return_value
                call.side_effect=Update(metadata)
                with self.assertRaisesRegex(LoginError,'game_client_update_required'):game.discover()
                self.assertEqual(call.call_count,1)
        game=GameClient('global-kr')
        with patch('grpc.secure_channel') as channel:
            call=channel.return_value.__enter__.return_value.unary_unary.return_value
            call.side_effect=[Update(),Update((('x-client-recommended-version','1.0.7'),))]
            with self.assertRaisesRegex(LoginError,'game_client_update_required'):game.discover()
            self.assertEqual(call.call_count,2)

    def test_local_exporter_uses_selected_region_and_negotiated_sdk_version(self):
        _,profiles,_=gateway()
        def sdk(profile):
            profiles.append(profile)
            return SimpleNamespace(device_id='FAKE',login=lambda account,password:SdkIdentity('FAKE','FAKE'))
        for sid in ('global-en','global-kr'):
            server=LoginServer(Profile('fake'),sdk_factory=sdk)
            transport=Transport()
            try:
                server.lock.acquire()
                with patch('grpc.secure_channel',side_effect=transport.channel):server.export('FAKE','FAKE',sid)
                self.assertEqual(server.state['stage'],'complete')
                self.assertEqual(server.snapshot['source']['serverId'],sid)
                self.assertEqual(server.snapshot['source']['clientVersion'],'1.0.6')
                self.assertEqual(profiles[-1].version,'1.0.6')
            finally:server.server_close()

    def test_selected_region_negotiates_its_own_floor_before_sdk_credentials(self):
        game=GameClient('global-en')
        with patch.object(game,'rpc',side_effect=[server_list(),LoginError('game_client_update_required',recommended_version='1.0.6'),b'']) as rpc:
            self.assertEqual(game.discover(),GLOBAL_SERVERS['global-en']['hosts'][-1])
        self.assertEqual(game.client_version,'1.0.6')
        self.assertEqual([c.args[1] for c in rpc.call_args_list],
                         [LOGIN_SERVICE+'GetServerList','app.masterdata.MasterdataService/Version','app.masterdata.MasterdataService/Version'])
        self.assertTrue(all(len(c.args)==2 for c in rpc.call_args_list))
        game.authentication_started=True
        with self.assertRaisesRegex(LoginError,'game_target_refused'):
            game._public_rpc(BOOTSTRAP,LOGIN_SERVICE+'GetServerList')
