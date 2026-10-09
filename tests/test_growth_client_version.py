"""Exercise the gateway against the official minimum-client-version failure."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import grpc

from tests.test_growth_export import account_response
from tools.growth_login import (
    BOOTSTRAP, LOGIN_SERVICE, GameClient, Profile, SdkClient, SdkIdentity,
    integer, message, string,
)
from tools.growth_web import GrowthGateway


class ClientUpdateRequired(grpc.RpcError):
    def code(self):
        return grpc.StatusCode.UNKNOWN

    def details(self):
        return 'client update required'


class GrowthClientVersionTests(unittest.TestCase):
    def test_gateway_passes_current_version_gate_through_growth_read(self):
        """1.0.2 fails before SDK login; 1.0.3 reaches the growth response."""
        calls = []
        sdk = SimpleNamespace(device_id='FAKE-DEVICE', login=Mock(
            return_value=SdkIdentity('FAKE-UID', 'FAKE-TOKEN')))
        gateway = object.__new__(GrowthGateway)
        gateway.profile = Profile('FAKE-APP-KEY')
        gateway.sdk_factory = Mock(return_value=sdk)
        gateway.game_factory = GameClient
        server = message(1, 'TW/HK/MO') + message(3, 'https://' + BOOTSTRAP) + message(8, '2')
        credential = message(1, 'FAKE-PLAYER') + message(2, 'FAKE-CREDENTIAL')
        responses = {
            '/' + LOGIN_SERVICE + 'GetServerList': message(1, server),
            '/' + LOGIN_SERVICE + 'PlayerPreLogin': integer(1, 1),
            '/' + LOGIN_SERVICE + 'PlayerLogin': message(1, credential),
            '/app.player.PlayerService/GetPlayerData': account_response(),
        }

        def unary(method, **kwargs):
            def call(payload, *, metadata, timeout, wait_for_ready):
                calls.append((method, payload, dict(metadata)))
                if dict(metadata)['x-client-version'] != '1.0.3':
                    raise ClientUpdateRequired()
                return responses[method]
            return call

        with patch('grpc.secure_channel') as channel:
            channel.return_value.__enter__.return_value.unary_unary.side_effect = unary
            with patch('tools.growth_login.CLIENT_VERSION', '1.0.2'):
                old_status, old_result = gateway.read_growth('FAKE-ACCOUNT', 'FAKE-PASSWORD')
            self.assertEqual((old_status, old_result['error'], old_result['stage']),
                             (422, 'game_rpc_unknown', 'discovering'))
            self.assertEqual([row[0] for row in calls], ['/' + LOGIN_SERVICE + 'GetServerList'])
            sdk.login.assert_not_called()
            calls.clear()
            status, result = gateway.read_growth('FAKE-ACCOUNT', 'FAKE-PASSWORD')

        self.assertEqual(status, 200, result)
        self.assertEqual([row[0] for row in calls], list(responses))
        self.assertTrue(all(row[2]['x-client-version'] == '1.0.3' for row in calls))
        self.assertEqual(string(calls[1][1], 6), '1.0.3')
        self.assertEqual(string(calls[2][1], 6), '1.0.3')
        self.assertEqual(SdkClient(gateway.profile).parameters({})['app_ver'], '1.0.3')
        self.assertEqual(result['snapshot']['source']['clientVersion'], '1.0.3')
        self.assertEqual(result['snapshot']['growth']['tgw']['point'], 4000)
        sdk.login.assert_called_once_with('FAKE-ACCOUNT', 'FAKE-PASSWORD')


if __name__ == '__main__':
    unittest.main()
