import base64
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from tools.growth_login import (BOOTSTRAP, LOGIN_SERVICE, GameClient, LoginError,
                                Profile, SdkClient, SdkIdentity, diagnostic_sdk_message,
                                integer, message, single)
from tools.growth_login_local import LoginServer
from tests.test_growth_export import account_response


class LoginTests(unittest.TestCase):
    def test_rsa_encrypts_password_and_prefix_before_transport(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        calls = []
        def request(operation, extra=None, **kwargs):
            calls.append((operation, extra))
            if operation == 'rsa':
                return {'hash': 'salt-', 'rsa_key': public}
            self.assertEqual(extra['user_id'], 'example@example.invalid')
            plain = key.decrypt(base64.b64decode(extra['pwd']), padding.PKCS1v15())
            self.assertEqual(plain, b'salt-FAKE-PASSWORD')
            self.assertNotIn('FAKE-PASSWORD', json.dumps(extra))
            self.assertIn('FAKE-PASSWORD', kwargs['private_values'])
            return {'uid': 42, 'access_key': 'FAKE-TOKEN'}
        client = SdkClient(Profile('test-key'))
        client.request = request
        identity = client.login('example@example.invalid', 'FAKE-PASSWORD')
        self.assertEqual(identity.uid, '42')
        self.assertEqual([x[0] for x in calls], ['rsa', 'login'])
        self.assertNotIn('FAKE-TOKEN', repr(identity))

    def test_remote_error_text_stays_out_of_public_error(self):
        client = SdkClient(Profile('test-key'))
        with patch.object(client.opener, 'open') as opening:
            opening.return_value.__enter__.return_value.read.return_value = json.dumps({
                'code': -400, 'message': '帳號 FAKE-PRIVATE-ACCOUNT 無效', 'data': None}).encode()
            with self.assertRaisesRegex(LoginError, '^sdk_service_-400$') as captured:
                client.request('login', {'pwd': 'CIPHERTEXT'}, private_values=('FAKE-PRIVATE-ACCOUNT',))
            self.assertEqual(captured.exception.diagnostic_message, '帳號 [已遮蔽] 無效')
            self.assertEqual(captured.exception.message_state, 'redacted')

    def test_diagnostic_sdk_message_keeps_wording_and_masks_submitted_values(self):
        text='帳號或密碼錯誤'
        self.assertEqual(diagnostic_sdk_message(text, ('user@example.invalid', 'fixture-passphrase')),
                         (text, 'original'))
        value='帳號 user@example.invalid 密碼 fixture-passphrase 無效'
        safe, state=diagnostic_sdk_message(value, ('user@example.invalid', 'fixture-passphrase'))
        self.assertEqual(state, 'redacted')
        self.assertIn('帳號', safe)
        self.assertNotIn('user@example.invalid', safe)
        self.assertNotIn('fixture-passphrase', safe)
        self.assertEqual(diagnostic_sdk_message('token=fixture-sensitive-canary')[1], 'redacted')
        self.assertEqual(diagnostic_sdk_message('line\nsecond'), (None, 'omitted'))

    def test_500002_does_not_imply_password_failure_without_message_evidence(self):
        client = SdkClient(Profile('test-key'))
        for remote, expected in [('PRIVATE unknown response', None),
                                 ('密碼錯誤 PRIVATE', 'credentials_rejected')]:
            with patch.object(client.opener, 'open') as opening:
                opening.return_value.__enter__.return_value.read.return_value = json.dumps({
                    'code': 500002, 'message': remote, 'data': None}).encode()
                with self.assertRaises(LoginError) as captured:
                    client.request('login', {'pwd': 'CIPHERTEXT'})
                self.assertEqual(str(captured.exception), 'sdk_service_500002')
                self.assertEqual(captured.exception.reason, expected)
                self.assertEqual(captured.exception.diagnostic_message, remote)

    def test_wire_error_reports_schema_only(self):
        with self.assertRaises(LoginError) as captured:
            single(message(1, 'PRIVATE-ONE') + message(1, 'PRIVATE-TWO'), 1)
        self.assertEqual(str(captured.exception), 'invalid_game_response_field_1_expected_wire_2_observed_2_2')

    def test_targets_and_methods_are_pinned(self):
        for host, method in [('attacker.invalid', LOGIN_SERVICE + 'PlayerLogin'),
                             (BOOTSTRAP, 'app.player.PlayerService/DeletePlayer')]:
            with self.assertRaisesRegex(LoginError, 'game_target_refused'):
                GameClient().rpc(host, method)

    def test_nonexistent_role_does_not_call_login(self):
        game = GameClient()
        with patch.object(game, 'rpc', return_value=b'') as rpc:
            with self.assertRaisesRegex(LoginError, 'no_existing_role'):
                game.export(SdkIdentity('42', 'FAKE-TOKEN'), 'device', BOOTSTRAP)
            self.assertEqual(rpc.call_count, 1)
            self.assertEqual(rpc.call_args.args[1], LOGIN_SERVICE + 'PlayerPreLogin')

    def test_success_exports_only_growth(self):
        credential = message(1, 'FAKE-PLAYER') + message(2, 'FAKE-CREDENTIAL') + message(3, 'FAKE-DEVICE')
        game = GameClient()
        with patch.object(game, 'rpc', side_effect=[integer(1, 1), message(1, credential), account_response()]) as rpc:
            snapshot = game.export(SdkIdentity('42', 'FAKE-SDK-TOKEN'), 'device', BOOTSTRAP)
            self.assertEqual(rpc.call_count, 3)
            self.assertEqual(snapshot['growth']['tgw']['point'], 4000)
            self.assertNotIn('FAKE-', json.dumps(snapshot))
            self.assertIn(('x-player-credential', 'FAKE-CREDENTIAL'), rpc.call_args.args[3])

    def test_login_credential_can_omit_device_id(self):
        # Live failure: login returned id + credential, but no field 3.
        for optional_device in (b'', message(3, '')):
            credential = message(1, 'FAKE-PLAYER') + message(2, 'FAKE-CREDENTIAL') + optional_device
            game = GameClient()
            with patch.object(game, 'rpc', side_effect=[integer(1, 1), message(1, credential), account_response()]) as rpc:
                snapshot = game.export(SdkIdentity('42', 'FAKE-SDK-TOKEN'), 'FAKE-LOCAL-DEVICE', BOOTSTRAP)
                self.assertEqual(snapshot['growth']['tgw']['point'], 4000)
                self.assertEqual(rpc.call_count, 3)
                self.assertNotIn('x-device-id', dict(rpc.call_args.args[3]))

    def test_missing_required_credential_and_invalid_optional_device_stop_before_read(self):
        for credential in (message(1, 'FAKE-PLAYER'),
                           message(1, 'FAKE-PLAYER') + message(2, 'FAKE-TOKEN') + integer(3, 1)):
            with patch.object(GameClient, 'rpc', side_effect=[integer(1, 1), message(1, credential)]) as rpc:
                with self.assertRaises(LoginError):
                    GameClient().export(SdkIdentity('42', 'FAKE-SDK-TOKEN'), 'device', BOOTSTRAP)
                self.assertEqual(rpc.call_count, 2)


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = LoginServer(Profile('test-key'), Path(self.temp.name) / 'growth.json')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(self.server.authority, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_loopback_binding_and_page_privacy_headers(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        status, headers, body = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertIn(b"'\\n", body)  # JS contains escaped newlines, not broken string literals.
        self.assertNotIn(b'NONCE', body)

    def test_wrong_host_origin_or_nonce_cannot_submit_credentials(self):
        good = {'Origin': self.server.origin, 'Content-Type': 'application/json',
                'X-Local-Nonce': self.server.nonce}
        body = json.dumps({'account': 'FAKE-ACCOUNT', 'password': 'FAKE-PASSWORD'})
        for delta in [{'Host': 'attacker.invalid'}, {'Origin': 'https://attacker.invalid'},
                      {'X-Local-Nonce': 'invalid'}]:
            headers = dict(good, **delta)
            self.assertEqual(self.request('POST', '/export', body, headers)[0], 403)
        self.assertEqual(self.server.state['stage'], 'waiting')

    def test_unexpected_exceptions_are_redacted(self):
        self.server.game_factory = lambda: (_ for _ in ()).throw(RuntimeError('FAKE-PRIVATE'))
        self.server.lock.acquire()
        self.server.export('FAKE-ACCOUNT', 'FAKE-PASSWORD')
        status, _, body = self.request('GET', '/status')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['error'], 'local_export_failed')
        self.assertEqual(json.loads(body)['failedStage'], 'discovering')
        self.assertEqual(json.loads(body)['attempt'], 1)
        self.assertNotIn(b'FAKE-', body)
        self.assertFalse(self.server.output.exists())

    def test_configuration_is_memory_only_and_never_returned_in_status(self):
        self.server.profile = None
        self.server.update('waiting', busy=False)
        headers = {'Origin': self.server.origin, 'Content-Type': 'application/json',
                   'X-Local-Nonce': self.server.nonce}
        fields = {'appid': '17703', 'merchantid': '1045', 'serverid': '16841',
                  'channelid': '2001', 'one_global_brand_id': '5',
                  'one_global_area_id': '6', 'one_appkey': 'FAKE-APP-SECRET'}
        xml = '<resources>' + ''.join('<string name="' + key + '">' + value + '</string>'
                                     for key, value in fields.items()) + '</resources>'
        status, _, body = self.request('POST', '/configure', json.dumps({'xml': xml}), headers)
        self.assertEqual(status, 200)
        self.assertNotIn(b'FAKE-APP-SECRET', body)
        _, _, body = self.request('GET', '/status')
        self.assertTrue(json.loads(body)['sdkConfigured'])
        self.assertNotIn(b'FAKE-APP-SECRET', body)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        self.server.lock.acquire()
        try:
            self.assertEqual(self.request('POST', '/configure', json.dumps({'xml': xml}), headers)[0], 409)
        finally:
            self.server.lock.release()

    def test_missing_configuration_and_empty_credentials_never_start_login(self):
        self.server.profile = None
        headers = {'Origin': self.server.origin, 'Content-Type': 'application/json',
                   'X-Local-Nonce': self.server.nonce}
        with patch.object(self.server, 'export') as export:
            self.assertEqual(self.request('POST', '/export',
                             json.dumps({'account': 'fake@example.invalid', 'password': 'fake'}), headers)[0], 409)
            self.assertEqual(self.request('POST', '/export',
                             json.dumps({'account': 'fake@example.invalid', 'password': ''}), headers)[0], 400)
            export.assert_not_called()


if __name__ == '__main__':
    unittest.main()
