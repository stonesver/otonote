import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.arena_content import read_arena_review,build_arena_content
from tools.arena_review_inputs import prepare,LIMIT
from tools.r2_content import canonical,digest
from tools import r2_production_gate as gate
from tools import global_update


class ArenaReviewInputTests(unittest.TestCase):
    def test_pinned_private_input_reaches_normal_build_and_other_release_fails_closed(self):
        image=b'RIFF'+bytes(4)+b'WEBP'+b'test'
        review=dict(schemaVersion=1,region='global',sourceReleaseId='test',masterVersion='a'*32,
                    tables={},serverScopes=['global-hmt'],rankIcons=[dict(tier=1,path='rank-icons/rank-1.webp',sha256=digest(image))])
        raw=canonical(dict(review=review,files={'rank-icons/rank-1.webp':base64.b64encode(image).decode()}))
        class Client:
            def get_object(self,**kwargs):
                self.request=kwargs
                return dict(ContentLength=len(raw),Body=io.BytesIO(raw))
        client=Client();bucket=SimpleNamespace(client=client,bucket='private-example')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);env=root/'github-env'
            prepare(root,digest(raw),bucket,env)
            binding=dict(line.split('=',1) for line in env.read_text().splitlines())
            with patch.dict(os.environ,binding):
                selected=read_arena_review(dict(region='global',contentReleaseId='test'),root)
                value=build_arena_content(root,'test','global',review=selected)
                self.assertTrue(value['rankIcons'][0]['image'].startswith('data:image/webp;base64,'))
                self.assertNotIn(str(root),json.dumps(value))
                with self.assertRaisesRegex(ValueError,'arena review renewal required'):
                    read_arena_review(dict(region='global',contentReleaseId='next-master'),root)
            self.assertEqual(client.request['Key'],'state/objects/'+digest(raw))
            with self.assertRaises(ValueError):prepare(root,'0'*64,bucket,env)

    def test_review_digest_changes_the_production_gate_and_oversized_input_is_not_read(self):
        with patch('tools.jp_update.fingerprint',return_value='a'*64):
            with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'b'*64}):first=gate.code_fingerprints(gate.ROOT)
            with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'c'*64}):second=gate.code_fingerprints(gate.ROOT)
            self.assertEqual(first[0],second[0]);self.assertNotEqual(first[1],second[1])
        with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'b'*64}):first=global_update.chart_projection_fingerprint()
        with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'c'*64}):second=global_update.chart_projection_fingerprint()
        self.assertNotEqual(first,second,'review changes must not reuse an older sealed candidate')
        class Body:
            def read(self,*args):raise AssertionError('oversized input must not be read')
            def close(self):pass
        client=SimpleNamespace(get_object=lambda **kwargs:dict(ContentLength=LIMIT+1,Body=Body()))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):prepare(Path(folder),'a'*64,SimpleNamespace(client=client,bucket='private-example'),Path(folder)/'env')

    def test_same_master_resource_update_rebinds_only_verified_tables_and_same_client(self):
        from tests.test_arena_content import ArenaContentTests
        fixture=ArenaContentTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        root=fixture.root
        old='global-prod-remote-1-1-0-100-abcdef01-12345678-'+('a'*32)+'-c'+('b'*12)
        new='global-prod-remote-1-1-0-200-abcdef02-87654321-'+('a'*32)+'-c'+('b'*12)
        review=fixture.review;review.update(sourceReleaseId=old,masterVersion='a'*32)
        raw=canonical(review);(root/'review.json').write_bytes(raw)
        binding={'OURNOTES_ARENA_REVIEW_PATH':'review.json','OURNOTES_ARENA_REVIEW_SHA256':digest(raw)}
        source=dict(region='global',contentReleaseId=new,masterRoot='.')
        with patch.dict(os.environ,binding):
            selected=read_arena_review(source,root)
            self.assertEqual(selected['sourceReleaseId'],new)
            self.assertEqual(json.loads((root/'review.json').read_bytes())['sourceReleaseId'],old)
            value=build_arena_content(root,new,'global',review=selected)
            self.assertTrue(value['capabilities']['conditions'])
            for changed in (new.replace('a'*32,'c'*32),new.replace('b'*12,'d'*12)):
                with self.assertRaisesRegex(ValueError,'arena review renewal required'):
                    read_arena_review(dict(source,contentReleaseId=changed),root)
            (root/'MasterArenaSeason.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'table changed'):
                read_arena_review(source,root)
        # Explicit per-source reviews remain exact, even on the same Master.
        with self.assertRaisesRegex(ValueError,'identity mismatch'):
            read_arena_review(dict(source,arenaReview={'path':'review.json','sha256':digest(raw)}),root)


class ArenaReviewRenewalTests(unittest.TestCase):
    def setUp(self):
        import copy
        from tests.test_arena_content import ArenaContentTests
        from tools.global_game_config import GLOBAL_SERVERS
        from tools.growth_login import message
        from tools.ranking_regions import CDN
        fixture = ArenaContentTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        self.root = fixture.root
        # An unapproved future row must stay excluded after renewal.
        fixture.tables['MasterArenaSeason'].append(dict(fixture.tables['MasterArenaSeason'][0], _id=2))
        fixture.seal()
        self.review = fixture.review
        self.review['tables']['MasterArenaSeason']['publishedIds'] = [1]
        self.old = dict(zip(GLOBAL_SERVERS, ('a'*32, 'b'*32, 'c'*32)))
        self.new = dict(zip(GLOBAL_SERVERS, ('d'*32, 'e'*32, 'f'*32)))
        self.release = 'global-prod-remote-1-1-0-100-abcdef01-12345678-' + self.old['global-hmt'] + '-c' + '1'*12
        self.review.update(sourceReleaseId=self.release, masterVersion=self.old['global-hmt'],
                           serverScopes=list(GLOBAL_SERVERS))
        hashes = {name: row['sha256'] for name, row in self.review['tables'].items()}
        self.review['serverMasters'] = {s: dict(version=v, tables=dict(hashes)) for s,v in self.old.items()}
        files = {name+'.json': base64.b64encode((self.root/(name+'.json')).read_bytes()).decode()
                 for name in self.review['tables']}
        self.bundle = dict(review=self.review, files=files)
        self.manifests = {}
        self.servers = b''
        self.rpc_calls = []
        for server, definition in GLOBAL_SERVERS.items():
            prefix, hosts = CDN[server]
            cdn = 'https://' + hosts[0] + '/prod/' + prefix + '_' + '9'*32
            self.servers += message(1, message(1, definition['name']) + message(2, cdn)
                                    + message(3, 'https://' + definition['hosts'][0]) + message(8, definition['wireId']))
            rows = [dict(name=name+'.bin', hash=digest(name.encode()), size=100) for name in self.review['tables']]
            for version in (self.old[server], self.new[server]):
                self.manifests[cdn+'/master/'+version+'/MasterManifest.json'] = dict(version=version, files=copy.deepcopy(rows))
        def rpc(game, host, method, payload=b'', auth=()):
            self.rpc_calls.append((method, payload, auth))
            if method.endswith('/GetServerList'): return self.servers
            if method.endswith('/Version'): return message(1, self.new[game.server_id])
            raise AssertionError('unexpected RPC')
        def open_manifest(request, timeout):
            return io.BytesIO(canonical(self.manifests[request.full_url]))
        from unittest.mock import Mock
        self.rpc_patch = patch('tools.growth_login.GameClient.rpc', rpc)
        self.http_patch = patch('tools.ranking_regions.build_opener', return_value=Mock(open=open_manifest))
        self.rpc_patch.start(); self.addCleanup(self.rpc_patch.stop)
        self.http_patch.start(); self.addCleanup(self.http_patch.stop)

    def prepare(self):
        raw = canonical(self.bundle)
        client = SimpleNamespace(get_object=lambda **kw: dict(ContentLength=len(raw), Body=io.BytesIO(raw)))
        env = self.root/'github-env'
        result = prepare(self.root, digest(raw), SimpleNamespace(client=client, bucket='private'), env,
                         renew_unchanged=True)
        binding = dict(line.split('=', 1) for line in env.read_text().splitlines())
        return result, binding

    def test_new_masters_reach_both_locales_without_expanding_scope_or_changing_pin(self):
        before = canonical(self.bundle)
        result, binding = self.prepare()
        target = self.release.replace(self.old['global-hmt'], self.new['global-hmt']).replace('1-1-0-100', '1-1-0-200')
        source = dict(region='global', contentReleaseId=target, masterRoot='.')
        with patch.dict(os.environ, binding):
            selected = read_arena_review(source, self.root)
            for locale in ('zh-CN', 'en'):
                value = build_arena_content(self.root, target, 'global', locale, selected)
                self.assertEqual(value['sourceMasterVersions'], self.new)
                self.assertEqual(value['sourceReleaseId'], target)
                self.assertEqual([r['id'] for r in value['seasons']], ['1'])
                self.assertTrue(value['capabilities']['conditions'])
            with self.assertRaisesRegex(ValueError, 'renewal required'):
                read_arena_review(dict(source, contentReleaseId=target.replace('1'*12, '2'*12)), self.root)
        self.assertEqual(canonical(self.bundle), before)
        self.assertEqual(result['renewal'], 'renewed')
        self.assertTrue(all(not payload and not auth for _,payload,auth in self.rpc_calls))

    def test_unchanged_versions_keep_original_review_bytes(self):
        self.new = dict(self.old)
        result, binding = self.prepare()
        self.assertEqual(result['renewal'], 'unchanged')
        self.assertEqual((self.root/binding['OURNOTES_ARENA_REVIEW_PATH']).read_bytes(), canonical(self.review))

    def test_any_reviewed_table_change_in_any_region_blocks_environment_binding(self):
        import copy
        original = copy.deepcopy(self.manifests)
        for server, version in self.new.items():
            for name in self.review['tables']:
                with self.subTest(server=server, table=name):
                    self.manifests = copy.deepcopy(original)
                    target = next(v for v in self.manifests.values() if v['version']==version)
                    next(row for row in target['files'] if row['name']==name+'.bin')['hash'] = '0'*64
                    with self.assertRaisesRegex(ValueError, 'renewal required'):
                        self.prepare()
                    self.assertFalse((self.root/'github-env').exists())

    def test_manifest_failure_or_incomplete_region_review_blocks_renewal(self):
        import copy
        original = copy.deepcopy(self.manifests)
        for fault in ('missing', 'version', 'duplicate', 'size', 'offline', 'region'):
            with self.subTest(fault=fault):
                self.manifests = copy.deepcopy(original)
                target = next(v for v in self.manifests.values() if v['version']==self.new['global-en'])
                if fault=='missing': target['files'].pop()
                elif fault=='version': target['version']='0'*32
                elif fault=='duplicate': target['files'].append(target['files'][0])
                elif fault=='size': target['files'][0]['size'] += 1
                elif fault=='offline': self.manifests.clear()
                elif fault=='region': self.review['serverMasters'].pop('global-en')
                with self.assertRaisesRegex(ValueError, 'renewal required'):
                    self.prepare()
                self.assertFalse((self.root/'github-env').exists())

    def test_modified_local_input_still_fails_after_remote_verification(self):
        _, binding = self.prepare()
        (self.root/'MasterArenaSeason.json').write_text('{}')
        target = self.release.replace(self.old['global-hmt'], self.new['global-hmt'])
        with patch.dict(os.environ, binding):
            with self.assertRaisesRegex(ValueError, 'table changed'):
                selected = read_arena_review(dict(region='global',contentReleaseId=target,masterRoot='.'),self.root)
                build_arena_content(self.root, target, 'global', review=selected)
