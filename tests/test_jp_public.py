import base64
import json
import os
from pathlib import Path
import unittest
import subprocess
from unittest.mock import Mock, patch

from tools.resource_pipeline.adapters.jp_public import JpPublicClient, API_ROOT, CDN_ROOT, resource_version, version_proxy, VERSION_PROXY_ENV
from tools.resource_pipeline.adapters.global_public import ProtocolError
from tools.resource_pipeline.transport import HttpResponse, TransportError


class JpTransportTests(unittest.TestCase):
    def setUp(self):
        self.authorization = 'Basic ' + base64.b64encode(b'test-client:test-only').decode()
        self.client = JpPublicClient('1.0.4', self.authorization)

    def test_requires_explicit_valid_authorization(self):
        for value in (None, '', 'Bearer sample', 'Basic broken', self.authorization+'\r\nX-Test: bad'):
            with self.assertRaises(ProtocolError):JpPublicClient('1.0.4', value)

    def test_rpc_is_fixed_read_only_and_credentials_are_not_arguments(self):
        payload = b'\x0a\x03abc'
        def run(command, **options):
            self.assertNotIn(self.authorization, ' '.join(command))
            self.assertIn(self.authorization.encode(), options['input'])
            self.assertEqual(command[-1], API_ROOT+'/app.masterdata.MasterdataService/Version')
            self.assertEqual(Path(command[command.index('--data-binary')+1][1:]).read_bytes(), bytes(5))
            Path(command[command.index('--dump-header')+1]).write_text('HTTP/2 200\r\ncontent-type: application/grpc\r\ngrpc-status: 0\r\nset-cookie: must-not-leak\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'\x00'+len(payload).to_bytes(4,'big')+payload)
            return Mock(returncode=0)
        with patch('tools.resource_pipeline.adapters.jp_public.subprocess.run',side_effect=run) as call:
            headers, actual = self.client.rpc('app.masterdata.MasterdataService/Version')
            self.assertEqual(actual,payload);self.assertNotIn('set-cookie',headers)
            with self.assertRaises(ProtocolError):self.client.rpc('app.playerlogin.PlayerLoginService/PlayerLogin')
            self.assertEqual(call.call_count,1)

    def test_refusal_stops_without_retry_and_does_not_include_credentials(self):
        def run(command, **options):
            Path(command[command.index('--dump-header')+1]).write_text('HTTP/2 403\r\ncontent-type: application/grpc\r\ngrpc-status: 7\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'')
            return Mock(returncode=0)
        with patch('tools.resource_pipeline.adapters.jp_public.subprocess.run',side_effect=run) as call:
            with self.assertRaisesRegex(ProtocolError,'HTTP status 403') as error:self.client.rpc('app.masterdata.MasterdataService/Version')
            self.assertNotIn(self.authorization,str(error.exception));self.assertEqual(call.call_count,1)

    def test_static_resources_cannot_forward_credentials_to_another_host(self):
        with patch('tools.resource_pipeline.adapters.jp_public.HttpTransport') as transport:
            transport.return_value.request.return_value=HttpResponse(200,{},b'content')
            self.assertEqual(self.client.get('https://static.bang-dream-on.jp/catalog.hash',256).body,b'content')
            request=transport.return_value.request.call_args.args[0]
            self.assertEqual(request.headers['Authorization'],self.authorization)
            for url in ('https://example.com/catalog.hash','http://static.bang-dream-on.jp/catalog.hash','https://static.bang-dream-on.jp@evil.invalid/catalog.hash'):
                with self.assertRaises(ProtocolError):self.client.get(url,256)
            with self.assertRaises(ProtocolError):self.client.get('https://static.bang-dream-on.jp/',256,method='POST')
            self.assertEqual(transport.return_value.request.call_count,1)


class JpVersionProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = JpPublicClient('1.0.4', 'Basic '+base64.b64encode(b'test:client').decode())
        self.proxy = 'https://' + 'proxy-user:proxy-secret@proxy.example:8443/'

    def test_valid_schemes_and_ports(self):
        for value in ('http://127.0.0.1:7890', 'https://proxy.example',
                      'socks5://' + 'user:p%40ss@proxy.example:1080', 'socks5h://[::1]:65535/',
                      self.proxy):
            with self.subTest(value=value), patch.dict(os.environ, {VERSION_PROXY_ENV: value}):
                self.assertEqual(version_proxy(), value)

    def test_unset_or_empty_proxy_preserves_default_curl_configuration(self):
        for environment in ({}, {VERSION_PROXY_ENV: ''}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                self.assertIsNone(version_proxy())
                with patch('tools.resource_pipeline.adapters.jp_public.subprocess.run', return_value=Mock(returncode=6)) as run:
                    with self.assertRaises(TransportError):
                        self.client.rpc('app.masterdata.MasterdataService/Version')
                self.assertNotIn(b'proxy', run.call_args.kwargs['input'])
                self.assertNotIn('env', run.call_args.kwargs)

    def test_invalid_urls_are_rejected_before_starting_curl_without_echoing_input(self):
        invalid = ['ftp://proxy.example:21', 'proxy.example:8080', 'http://',
                   'http://proxy.example:0', 'http://proxy.example:65536', 'http://proxy.example:not-a-port',
                   'http://proxy.example:', 'http://proxy.example/path', 'http://proxy.example/?',
                   'http://proxy.example/#', 'http://proxy.example?key=value', 'http://proxy.example#part',
                   'http://' + 'user:secret@proxy.example\nheader = "injected"',
                   'http://' + 'user:secret\r@proxy.example', 'http://' + 'user:secret\t@proxy.example',
                   'http://' + 'user:%0d%0a@proxy.example', 'http://' + 'user:%00@proxy.example',
                   'http://' + 'user:%7f@proxy.example', 'http://' + 'user:bad%zz@proxy.example',
                   'http://' + 'user:%C2%80@proxy.example', 'http://' + 'user:\u200bsecret@proxy.example',
                   ' http://proxy.example', 'http://proxy.example ', 'http://proxy\\.example',
                   'http://' + 'user:secret@other@proxy.example', 'http://@proxy.example',
                   'http://[::1', 'http://[::1]extra', 'http://bad..example', 'http://[::1%25lo0]:8080']
        for value in invalid:
            with self.subTest(value=value), patch.dict(os.environ, {VERSION_PROXY_ENV: value}), \
                    patch('tools.resource_pipeline.adapters.jp_public.subprocess.run') as run:
                with self.assertRaisesRegex(ProtocolError, '^invalid JP version proxy configuration$') as error:
                    self.client.rpc('app.masterdata.MasterdataService/Version')
                self.assertNotIn('secret', str(error.exception))
                run.assert_not_called()

    def test_proxy_credentials_use_stdin_only_and_refusal_still_stops(self):
        def refused(command, **options):
            self.assertNotIn(self.proxy, ' '.join(command))
            self.assertNotIn('proxy-secret', ' '.join(command))
            self.assertNotIn(VERSION_PROXY_ENV, options['env'])
            self.assertIn(('proxy = '+json.dumps(self.proxy)+'\n').encode(), options['input'])
            self.assertIn(b'noproxy = ""', options['input'])
            self.assertNotIn('--insecure', command)
            self.assertNotIn('--proxy-insecure', command)
            self.assertEqual(command[-1], API_ROOT+'/app.masterdata.MasterdataService/Version')
            Path(command[command.index('--dump-header')+1]).write_text('HTTP/2 403\r\ncontent-type: application/grpc\r\ngrpc-status: 7\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'')
            return Mock(returncode=0, stderr=b'proxy-secret')
        with patch.dict(os.environ, {VERSION_PROXY_ENV: self.proxy}), \
                patch('tools.resource_pipeline.adapters.jp_public.subprocess.run', side_effect=refused) as run:
            with self.assertRaisesRegex(ProtocolError, 'HTTP status 403') as error:
                self.client.discover()
            self.assertNotIn('proxy-secret', str(error.exception))
            self.assertEqual(run.call_count, 1)
            with self.assertRaisesRegex(ProtocolError, 'unsupported JP read-only RPC'):
                self.client.rpc('app.player.PlayerService/GetPlayerData')
            self.assertEqual(run.call_count, 1)

    def test_transport_errors_do_not_expose_proxy_stderr(self):
        for error in (subprocess.TimeoutExpired(['curl'], 35, stderr=b'proxy-secret'), OSError('proxy-secret')):
            with self.subTest(kind=type(error).__name__), patch.dict(os.environ, {VERSION_PROXY_ENV: self.proxy}), \
                    patch('tools.resource_pipeline.adapters.jp_public.subprocess.run', side_effect=error):
                with self.assertRaisesRegex(TransportError, '^JP read-only RPC transport failed$') as caught:
                    self.client.rpc('app.masterdata.MasterdataService/Version')
                self.assertNotIn('proxy-secret', str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)

    def test_successful_observation_contains_no_proxy_configuration(self):
        master = '1.0.0.300/'+'a'*32
        payload = b'\x0a'+bytes([len(master)])+master.encode()
        asset = json.dumps({'version': '1.0.0.300', 'Android': 'b'*32})
        def success(command, **options):
            Path(command[command.index('--dump-header')+1]).write_text(
                'HTTP/2 200\r\ncontent-type: application/grpc\r\ngrpc-status: 0\r\n'
                + 'x-asset-version: '+asset+'\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'\x00'+len(payload).to_bytes(4,'big')+payload)
            return Mock(returncode=0)
        with patch.dict(os.environ, {VERSION_PROXY_ENV: self.proxy}), \
                patch('tools.resource_pipeline.adapters.jp_public.subprocess.run', side_effect=success):
            observation = self.client.discover()
        self.assertEqual(observation['resourceVersion'], '1.0.0.300/'+'b'*32)
        self.assertNotIn('proxy', json.dumps(observation).lower())

    def test_cdn_requests_do_not_read_version_proxy_configuration(self):
        with patch.dict(os.environ, {VERSION_PROXY_ENV: 'invalid proxy-secret value'}), \
                patch('tools.resource_pipeline.adapters.jp_public.HttpTransport') as transport, \
                patch('tools.resource_pipeline.adapters.jp_public.subprocess.run') as run:
            transport.return_value.request.return_value = HttpResponse(200, {}, b'catalog')
            self.assertEqual(self.client.get(CDN_ROOT+'/catalog.bin', 128).body, b'catalog')
            request = transport.return_value.request.call_args.args[0]
            self.assertNotIn('proxy-secret', str(request.headers))
            self.assertEqual(transport.call_args.kwargs['allowed_hosts'], ('static.bang-dream-on.jp',))
            run.assert_not_called()




class JpSourceTests(unittest.TestCase):
    def test_jp_versions_and_paths_are_not_global_paths(self):
        from tools.resource_pipeline.adapters.jp_public import asset_directory, asset_url
        version = '1.0.0.300/'+'a'*32
        self.assertEqual(asset_directory(version), 'https://static.bang-dream-on.jp/asset/1.0.0.300/Android/'+'a'*32)
        self.assertTrue(asset_url(version, '{Fwk.Resource.RemoteAssetDir}/cri_assets_cri/sound/test').endswith('/cri_assets_cri/sound/test'))
        for path in ('https://dummy.net/asset/test', '{Fwk.Resource.RemoteAssetDir}/../other', '{Fwk.Resource.RemoteAssetDir}/%2e%2e/other'):
            with self.assertRaises(ProtocolError):asset_url(version, path)
        with self.assertRaises(ProtocolError):asset_directory('1.0.0.300')

    def test_catalog_gzip_is_bounded(self):
        import gzip
        from tools.resource_pipeline.adapters.jp_public import decode_catalog
        self.assertEqual(decode_catalog(gzip.compress(b'catalog')),b'catalog')
        self.assertEqual(decode_catalog(b'catalog'),b'catalog')
        with self.assertRaisesRegex(ProtocolError,'size limit'):decode_catalog(gzip.compress(b'x'*100),limit=10)
        with self.assertRaises(ProtocolError):decode_catalog(b'\x1f\x8bbroken')

    def test_jp_response_uses_header_and_missing_header_fails_closed(self):
        c=JpPublicClient('1.0.4','Basic '+base64.b64encode(b'client:test').decode())
        master='1.0.0.300/'+'a'*32;resource='1.0.0.300/'+'b'*32
        payload=b'\x0a'+bytes([len(master)])+master.encode()
        asset_header = json.dumps({'version': '1.0.0.300', 'Android': 'b'*32})
        with patch.object(c,'rpc',return_value=({'x-asset-version':asset_header},payload)):
            observation=c.discover()
            self.assertEqual(observation['region'],'jp')
            self.assertEqual(observation['resourceVersion'],resource)
            self.assertIn('/1.0.0.300/Android/'+('b'*32),observation['catalogUrl'])
        with patch.object(c,'rpc',return_value=({},payload)):
            with self.assertRaises(ProtocolError):c.discover()
        with patch.object(c,'rpc',return_value=({'x-asset-version':asset_header,'x-client-recommended-version':'1.0.5'},payload)):
            with self.assertRaisesRegex(ProtocolError,'verified client intake'):c.discover()

    def test_authenticated_requests_never_follow_redirects(self):
        from tools.resource_pipeline.adapters.jp_public import _NoRedirect
        self.assertIsNone(_NoRedirect().redirect_request(None,None,302,'',{},'http://static.bang-dream-on.jp/file'))

    def test_live_json_uses_highest_applicable_minimum_client_version(self):
        payload = {'live': [
            {'minClientVersion': '1.0.0', 'version': '1.0.0.900', 'Android': 'a'*32},
            {'minClientVersion': '1.0.4.0', 'version': '1.0.0.300', 'Android': 'b'*32},
            {'minClientVersion': '1.0.5', 'version': '1.0.0.500', 'Android': 'c'*32},
        ], 'futureOptionalField': 'ignored'}
        self.assertEqual(resource_version(json.dumps(payload), '1.0.4'), '1.0.0.300/'+'b'*32)
        self.assertEqual(resource_version(json.dumps(payload), '1.0.3'), '1.0.0.900/'+'a'*32)
        self.assertEqual(resource_version(json.dumps(payload), '1.0.5'), '1.0.0.500/'+'c'*32)

    def test_live_json_never_falls_back_to_history_or_root_when_client_is_too_old(self):
        payload = {'version': '1.0.0.100', 'Android': 'a'*32,
                   'live': [{'minClientVersion': '1.0.5', 'version': '1.0.0.500', 'Android': 'b'*32}],
                   'history': [{'version': '1.0.0.100', 'Android': 'a'*32}]}
        with self.assertRaisesRegex(ProtocolError, 'new intake'):
            resource_version(json.dumps(payload), '1.0.4')

    def test_legacy_json_and_unknown_optional_fields_follow_client_payload_contract(self):
        for live in (None, []):
            payload = {'version': '1.0.0.300', 'Android': 'a'*32, 'iOS': 'b'*32,
                       'live': live, 'unknown': {'nextSchema': True}}
            self.assertEqual(resource_version(json.dumps(payload), '1.0.4'), '1.0.0.300/'+'a'*32)

    def test_invalid_or_ambiguous_live_identity_is_rejected(self):
        entry = {'minClientVersion': '1.0.4', 'version': '1.0.0.300', 'Android': 'a'*32}
        bad = [None, 'unknown', '1.0.0.300/'+'a'*32, '[]',
               json.dumps({'live': 'invalid'}),
               json.dumps({'live': [dict(entry, minClientVersion='')] }),
               json.dumps({'live': [dict(entry, minClientVersion='1.0.2147483648')] }),
               json.dumps({'live': [dict(entry, Android=None)]}),
               json.dumps({'live': [dict(entry, version='../300')]}),
               json.dumps({'live': [entry, dict(entry, Android='b'*32)]})]
        for header in bad:
            with self.subTest(header=header), self.assertRaises(ProtocolError):
                resource_version(header, '1.0.4')

    def test_service_cdn_password_refresh_is_private_and_host_bound(self):
        client = JpPublicClient('1.0.4', 'Basic '+base64.b64encode(b'client:old-test').decode())
        master = '1.0.0.300/'+'a'*32
        payload = b'\x0a'+bytes([len(master)])+master.encode()
        asset = json.dumps({'live': [{'minClientVersion': '1.0.4', 'version': '1.0.0.300', 'Android': 'b'*32}]})
        def run(command, **options):
            Path(command[command.index('--dump-header')+1]).write_text(
                'HTTP/2 200\r\ncontent-type: application/grpc\r\ngrpc-status: 0\r\n'
                + 'x-asset-version: '+asset+'\r\nx-sirius-env: '+CDN_ROOT
                + '\r\nx-sirius-cred: new-test-password\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'\x00'+len(payload).to_bytes(4,'big')+payload)
            return Mock(returncode=0)
        with patch('tools.resource_pipeline.adapters.jp_public.subprocess.run', side_effect=run):
            observation = client.discover()
        self.assertNotIn('new-test-password', json.dumps(observation))
        self.assertNotIn('x-sirius-cred', observation['responseHeaders'])
        self.assertEqual(base64.b64decode(client._headers()['Authorization'][6:]), b'client:new-test-password')
        previous = client._headers()['Authorization']
        for root in ('https://evil.invalid', CDN_ROOT+'/other', CDN_ROOT+'@evil.invalid', None):
            with self.subTest(root=root), self.assertRaises(ProtocolError) as error:
                client._refresh_cdn_authorization({'x-sirius-env': root, 'x-sirius-cred': 'must-not-leak'})
            self.assertNotIn('must-not-leak', str(error.exception))
            self.assertEqual(client._headers()['Authorization'], previous)


class JpIncrementalTests(unittest.TestCase):
    def test_verified_cache_is_reused_across_version_directories_and_corruption_stops(self):
        import hashlib,tempfile
        from tools.jp_remote_sync import acquire
        from tools.resource_pipeline.transport import DownloadReceipt
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'cache';body=b'verified resource';identity={'key':'asset','hash':'same','size':len(body)}
            client=Mock()
            def download(url,stream,limit):
                stream.write(body)
                return DownloadReceipt(200,{'etag':hashlib.md5(body).hexdigest()},len(body))
            client.download.side_effect=download
            a=acquire(client,'https://static.bang-dream-on.jp/v1/asset',path,len(body),identity=identity)
            b=acquire(client,'https://static.bang-dream-on.jp/v2/asset',path,len(body),identity=identity)
            self.assertFalse(a['reused']);self.assertTrue(b['reused']);self.assertEqual(client.download.call_count,1)
            with self.assertRaises(ProtocolError):acquire(client,'https://static.bang-dream-on.jp/v3/asset',path,len(body),identity={**identity,'hash':'changed'})
            path.write_bytes(b'x'*len(body))
            with self.assertRaises(ProtocolError):acquire(client,'https://static.bang-dream-on.jp/v2/asset',path,len(body),identity=identity)
            self.assertEqual(client.download.call_count,1)

    def test_failed_download_does_not_commit_bytes_or_receipt(self):
        import tempfile
        from tools.jp_remote_sync import acquire
        from tools.resource_pipeline.transport import DownloadReceipt
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'cache';client=Mock()
            def download(url,stream,limit):
                stream.write(b'wrong')
                return DownloadReceipt(200,{},5)
            client.download.side_effect=download
            with self.assertRaises(ProtocolError):acquire(client,'https://static.bang-dream-on.jp/file',path,5,expected_sha='0'*64)
            self.assertFalse(path.exists());self.assertFalse(path.with_name('cache.receipt.json').exists())
            client.download.side_effect=ProtocolError('JP resource HTTP 403')
            with self.assertRaises(ProtocolError):acquire(client,'https://static.bang-dream-on.jp/file',path,5,expected_sha='0'*64)
            self.assertFalse(path.exists());self.assertEqual(client.download.call_count,2)

    def test_unverified_metadata_is_rejected_before_extracting_credentials(self):
        import tempfile
        from tools.jp_remote_sync import client_from_metadata
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'metadata';path.write_bytes(b'untrusted')
            with self.assertRaisesRegex(ProtocolError,'explicit authorization'):client_from_metadata(path)
            with self.assertRaisesRegex(ProtocolError,'unverified JP client'):client_from_metadata(path,authorize_builtin_credentials=True)


if __name__=='__main__':unittest.main()
