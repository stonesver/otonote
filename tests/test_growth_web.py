import http.client
import json
import threading
import unittest
from unittest.mock import patch

from tools.growth_export import extract_growth
from tools.growth_login import LoginError, Profile, SdkIdentity
from tools.growth_web import GrowthGateway, ROOT
from tests.test_growth_export import account_response
from tests.test_gacha_history import execution
from tools.gacha_history import extract_history


class FakeSdk:
    device_id = 'FAKE-DEVICE'
    def __init__(self, profile):
        pass
    def login(self, account, password):
        if password == 'reject':
            raise LoginError('sdk_service_500002', reason='credentials_rejected')
        return SdkIdentity('FAKE-UID', 'FAKE-TOKEN')


class FakeGame:
    def discover(self):
        return 'fake-host'
    def export(self, identity, device, host, progress):
        progress('reading_growth')
        return extract_growth(account_response())


class FakeHistory(FakeGame):
    def export(self, identity, device, host, progress):
        progress('reading_gacha_history')
        return extract_history(execution(51, 51))


class GrowthWebTests(unittest.TestCase):
    def setUp(self):
        self.server = GrowthGateway(Profile('fake'), ['http://127.0.0.1:4342'], sdk_factory=FakeSdk,
                                    game_factory=FakeGame, history_factory=FakeHistory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def request(self, path='read', method='POST', delta=None, body=None):
        headers={'Host':'127.0.0.1:4342','Origin':'http://127.0.0.1:4342','Content-Type':'application/json',
                 'X-Growth-Nonce':self.server.nonce}
        headers.update(delta or {})
        if method=='POST' and body is None:
            body=json.dumps({'account':'PRIVATE-EMAIL','password':'PRIVATE-PASSWORD'})
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        connection.request(method,ROOT+path,body,headers)
        response=connection.getresponse();result=response.status,dict(response.getheaders()),response.read()
        connection.close();return result
    def test_same_origin_reads_return_only_own_snapshot_and_no_stored_session(self):
        status,headers,data=self.request()
        self.assertEqual(status,200);self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertNotIn(b'PRIVATE',data);self.assertNotIn(b'FAKE',data)
        self.assertEqual(json.loads(data)['snapshot']['growth']['tgw']['point'],4000)
        self.assertFalse(hasattr(self.server,'snapshot'))
        self.assertEqual(self.request(path='download',method='GET')[0],404)
    def test_rejects_cross_origin_bad_nonce_and_oversize_without_auth(self):
        with patch.object(FakeSdk,'login') as login:
            for delta in [{'Origin':'https://evil.invalid'},{'Host':'evil.invalid'},
                          {'X-Growth-Nonce':'bad'},{'Sec-Fetch-Site':'cross-site'}]:
                self.assertEqual(self.request(delta=delta)[0],403)
            self.assertEqual(self.request(body='x'*8193)[0],413)
            login.assert_not_called()
    def test_failure_classifies_without_echoing_credentials(self):
        status,_,data=self.request(body=json.dumps({'account':'PRIVATE','password':'reject'}))
        self.assertEqual(status,422);self.assertNotIn(b'PRIVATE',data)
        self.assertEqual(json.loads(data),{'error':'sdk_service_500002','stage':'sdk_login','reason':'credentials_rejected'})
    def test_capacity_rejects_without_logging_in_and_recovers(self):
        self.server.capacity.acquire();self.server.capacity.acquire()
        try:
            with patch.object(FakeSdk,'login') as login:
                self.assertEqual(self.request()[0],429);login.assert_not_called()
        finally:
            self.server.capacity.release();self.server.capacity.release()
        self.assertEqual(self.request()[0],200)
    def test_capabilities_are_uncached_and_request_shape_is_strict(self):
        status,headers,data=self.request(path='capabilities',method='GET')
        self.assertEqual(status,200);self.assertEqual(json.loads(data)['nonce'],self.server.nonce)
        self.assertNotIn('Access-Control-Allow-Origin',headers)
        self.assertEqual(self.request(body=json.dumps({'account':'a','password':'b','url':'https://evil.invalid'}))[0],400)

    def test_history_is_uncached_requires_fresh_login_and_has_no_download_endpoint(self):
        with patch.object(FakeSdk, 'login', wraps=FakeSdk(Profile('fake')).login) as login:
            for _ in range(2):
                status, headers, data = self.request(path='gacha-history')
                self.assertEqual(status, 200)
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertEqual(json.loads(data)['snapshot']['format'], 'otonote-gacha-history')
                self.assertNotIn(b'PRIVATE', data)
                self.assertNotIn(b'FAKE', data)
            self.assertEqual(login.call_count, 2)
        self.assertEqual(self.request(path='gacha-history', method='GET')[0], 404)
        with patch.object(FakeSdk, 'login') as login:
            self.assertEqual(self.request(path='gacha-history', delta={'Origin':'https://evil.invalid'})[0], 403)
            self.assertEqual(self.request(path='gacha-history', body=json.dumps({'account':'a','password':'b','session':'reuse'}))[0], 400)
            login.assert_not_called()


if __name__=='__main__':
    unittest.main()
