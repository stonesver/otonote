import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from backend.update_archive.sources.global_source import GlobalSource


class SourceTests(unittest.TestCase):
    def test_snapshot_fetches_manifests_without_downloading_all_resources(self):
        class Client:
            client_version = '1.0.1'
            calls = []
            def discover(self):
                return {'clientVersion': '1.0.1', 'cdnRoot': 'https://example.com',
                        'catalogUrl': 'catalog', 'masterManifestUrl': 'master',
                        'resourceVersion': 'r1', 'catalogHash': 'h1', 'masterVersion': 'm1'}
            def get(self, url, limit):
                self.calls.append(url)
                if url == 'catalog':
                    return SimpleNamespace(body=json.dumps({'locations': [{'primaryKey': 'card.bundle',
                        'internalId': 'https://dummy.net/asset/Android/card.bundle',
                        'providerId': 'bundle', 'resourceType': 'bundle', 'expectedSize': 4,
                        'expectedHash': 'c'}]}).encode())
                return SimpleNamespace(body=json.dumps({'version': 'm1', 'files': [
                    {'name': 'MasterCards.bin', 'size': 3, 'hash': hashlib.sha256(b'abc').hexdigest()}]}).encode())
        source = GlobalSource(Client())
        snapshot = source.snapshot()
        self.assertEqual(len(snapshot['files']), 2)
        self.assertEqual(source.client.calls, ['catalog', 'master'])
        self.assertEqual(snapshot['files'][0]['source'], 'remote_asset')

    def test_jp_manifest_observation_and_unchanged_reuse_are_independent(self):
        from backend.update_archive.sources.jp_source import JpSource
        class Client:
            calls = []
            def discover(self):
                return {'clientVersion':'1.0.4','resourceVersion':'1.0.4.1/'+'a'*32,
                    'masterVersion':'1.0.4.1/'+'b'*32,'catalogHash':'a'*32,
                    'cdnRoot':'https://static.bang-dream-on.jp','catalogUrl':'catalog','masterManifestUrl':'master'}
            def get(self,url,limit):
                self.calls.append(url)
                if url=='catalog':
                    data={'locations':[{'primaryKey':'card.bundle','internalId':'{Fwk.Resource.RemoteAssetDir}/card.bundle',
                        'providerId':'bundle','resourceType':'bundle','expectedSize':4,'expectedHash':'a'*32}]}
                else:
                    data={'version':'1.0.4.1/'+'b'*32,'files':[{'name':'MasterCards.bin','size':3,'hash':hashlib.sha256(b'abc').hexdigest()}]}
                return SimpleNamespace(body=json.dumps(data).encode())
        source=JpSource(Client());snap=source.snapshot()
        old={f'jp:{s}':{'files':[r for r in snap['files'] if r['source']==s],'observation':snap['observation']}
             for s in snap['sources']}
        again=source.snapshot(previous=old)
        self.assertEqual(len(again['files']),2)
        self.assertEqual(source.client.calls,['catalog','master'])
        self.assertEqual(again['fileLimit'],256_000_000)

    def test_historical_logical_hash_cannot_be_replaced_by_new_same_named_content(self):
        from backend.update_archive.models import ArchiveError
        source=GlobalSource(None)
        original={'source':'remote_asset','key':'card.bundle','url':'https://old.example/card', 'size':4,'hash':'a'}
        source.current_inventory={('remote_asset','card.bundle'):{**original,'hash':'b'}}
        with self.assertRaisesRegex(ArchiveError,'historical_identity_unverifiable'):
            source.validate_historical(original)
