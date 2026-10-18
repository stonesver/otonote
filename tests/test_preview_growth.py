"""Preview-to-gateway integration, using synthetic accounts only."""
import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tools.preview_independent_site import handler
from tools.growth_login import Profile
from tools.growth_web import GrowthGateway
from tests.test_growth_web import FakeSdk, FakeGame, FakeHistory
from tools.game_service_status import GameServiceStatus


class PreviewGrowthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'code-release.json').write_text('{"codeId":"test"}')
        self.gateway = GrowthGateway(Profile('fake'), ['http://127.0.0.1:4338'],
                                     sdk_factory=FakeSdk, game_factory=FakeGame, history_factory=FakeHistory)
        upstream = f'http://127.0.0.1:{self.gateway.server_port}'
        self.preview = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.root, self.root, growth_upstream=upstream))
        for server in (self.gateway, self.preview):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join)
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

    def request(self, path='read', method='POST', body=None, delta=None):
        headers = {'Host': '127.0.0.1:4338', 'Origin': 'http://127.0.0.1:4338',
                   'X-Growth-Nonce': self.gateway.nonce, 'Content-Type': 'application/json'}
        headers.update(delta or {})
        if method == 'POST' and body is None:
            body = json.dumps({'account': 'PRIVATE-EMAIL', 'password': 'PRIVATE-PASSWORD'})
        connection = http.client.HTTPConnection('127.0.0.1', self.preview.server_port, timeout=3)
        try:
            route,separator,query=path.partition('?')
            connection.request(method, '/api/growth-export/' + route + '/' + ('?' + query if separator else ''), body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_capabilities_and_snapshot_pass_through_without_credentials(self):
        status, headers, body = self.request('capabilities', 'GET')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(body)['nonce'], self.gateway.nonce)
        status, _, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['snapshot']['growth']['tgw']['point'], 4000)
        self.assertNotIn(b'PRIVATE', body)

    def test_browser_provenance_and_route_restrictions_survive_proxy(self):
        with patch.object(FakeSdk, 'login') as login:
            for delta in ({'Host': 'evil.invalid'}, {'Origin': 'https://evil.invalid'},
                          {'X-Growth-Nonce': 'bad'}, {'Sec-Fetch-Site': 'cross-site'}):
                self.assertEqual(self.request(delta=delta)[0], 403)
            self.assertEqual(self.request(body='x' * 8193)[0], 413)
            self.assertEqual(self.request('download', 'GET')[0], 404)
            login.assert_not_called()

    def test_refuses_remote_or_ambiguous_upstreams(self):
        for upstream in ('https://127.0.0.1:1', 'http://example.com:1',
                         'http://127.0.0.1:1/path', 'http://user@127.0.0.1:1'):
            with self.assertRaises(ValueError):
                handler(self.root, self.root, growth_upstream=upstream)

    def test_stateless_history_passes_through_same_restricted_proxy(self):
        status, headers, body = self.request('gacha-history')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(body)['snapshot']['format'], 'otonote-gacha-history')
        self.assertNotIn(b'PRIVATE', body)
        self.assertEqual(self.request('gacha-history', 'GET')[0], 404)

    def test_public_maintenance_snapshot_passes_without_auth_or_nonce(self):
        self.gateway.game_status = GameServiceStatus(lambda server, version: {
            'status':'maintenance','source':'official_game_response'}, version='1.0.6')
        status, headers, body = self.request('status', 'GET', delta={'X-Growth-Nonce':''})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(body)['servers']['global-en']['status'], 'maintenance')
        self.assertNotIn(b'nonce', body)

    def test_region_query_and_body_survive_proxy(self):
        status,_,body=self.request('capabilities?serverId=global-kr','GET')
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['serverId'],'global-kr')
        status,_,body=self.request('read',body=json.dumps({'serverId':'global-en','account':'FAKE-ACCOUNT','password':'FAKE-PASSWORD'}))
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['snapshot']['source']['serverId'],'global-en')
