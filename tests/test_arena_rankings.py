import copy
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from backend.arena_rankings import RPC, RankingCursorChanged, query_arena_rankings, validate_observation
from tools.collect_arena_rankings import ArenaRankingClient, decode_response, read_plan, read_public_projection, run_capture
from tools.growth_login import LoginError, integer, message, single
from tools.import_arena_rankings import publish_observations


def observation(server='global-hmt', season='1', band='1'):
    return dict(schemaVersion=1, serverId=server, seasonId=season, bandId=band,
        observedAt='2026-10-29T01:00:00Z', expiresAt='2026-10-29T01:15:00Z',
        source=dict(method=RPC, clientVersion='1.1.0', contentReleaseId='test-release', projectionSha256='a' * 64),
        coverage=dict(startRank=1, endRank=100), maxRank=4,
        entries=[dict(playerId='public-' + str(i), name='Player ' + str(i), rank=rank, point=10)
                 for i, rank in enumerate((1, 1, 3, 4))])


def projection():
    return dict(schemaVersion=1, region='global', sourceReleaseId='test-release', serverScopes=['global-hmt'],
        seasons=[dict(id='1', validFrom='2026-10-28T00:00:00Z', validUntil='2026-11-28T00:00:00Z')],
        leagues=[dict(id='8', bandId='1', opensAt='2026-10-28T00:00:00Z')],
        regulations=[], ranks=[], basePoints=[], rewards=[], capabilities=dict(conditions=True))


NOW = datetime(2026, 10, 29, 1, 5, tzinfo=timezone.utc)


class ArenaRankingTests(unittest.TestCase):
    def test_scope_isolation_ties_history_expiry_and_missing_are_distinct(self):
        with tempfile.TemporaryDirectory() as folder:
            publish_observations([observation()], folder, 'global-hmt')
            query = lambda **kw: query_arena_rankings(folder, now=NOW, **kw)
            args = dict(server='global-hmt', season='1', band='1')
            self.assertEqual([r['rank'] for r in query(**args)['entries']], [1, 1, 3, 4])
            self.assertEqual(query(**args)['sourceReleaseId'], 'test-release')
            for key, other in [('server', 'global-en'), ('season', '2'), ('band', '2')]:
                result = query(**{**args, key: other})
                self.assertEqual((result['status'], result['entries'], result['observedAt']), ('unavailable', [], None))
            self.assertEqual(query_arena_rankings(folder, **args, now=datetime(2026, 11, 1, tzinfo=timezone.utc))['status'], 'stale')
            empty = observation(); empty.update(entries=[], maxRank=0)
            publish_observations([empty], folder, 'global-hmt')
            self.assertEqual(query(**args)['status'], 'empty')

    def test_pagination_binds_all_identity_fields_and_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = publish_observations([observation()], folder, 'global-hmt')
            args = dict(server='global-hmt', season='1', band='1', limit=1, now=NOW)
            first = query_arena_rankings(folder, **args)
            second = query_arena_rankings(folder, **args, cursor=first['nextCursor'])
            self.assertEqual(second['entries'][0]['rank'], 1)  # Official tie, not row index 2.
            for key, other in [('server', 'global-kr'), ('season', '2'), ('band', '2')]:
                with self.assertRaises(RankingCursorChanged):
                    query_arena_rankings(folder, **{**args, key: other}, cursor=first['nextCursor'])
            value = observation(); value['entries'][0]['name'] = 'Updated'
            publish_observations([value], folder, 'global-hmt')
            with self.assertRaises(RankingCursorChanged):
                query_arena_rankings(folder, **args, cursor=first['nextCursor'])
            paths[0].write_text('{}')
            with self.assertRaises(OSError): query_arena_rankings(folder, **args)

    def test_public_projection_drops_private_fields_and_rejects_invalid_bundle_before_replace(self):
        with tempfile.TemporaryDirectory() as folder:
            value = observation(); value['entries'][0].update(unrelatedDeck={'private': True}, token='synthetic-private')
            value['source']['authorization'] = 'synthetic-private'
            path = publish_observations([value], folder, 'global-hmt')[0]
            before = path.read_bytes()
            self.assertNotIn(b'synthetic-private', before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
            value['entries'][0]['name'] = 'Changed'
            broken = observation(band='2'); broken['entries'][1]['playerId'] = broken['entries'][0]['playerId']
            with self.assertRaises(ValueError): publish_observations([value, broken], folder, 'global-hmt')
            self.assertEqual(path.read_bytes(), before)
            for modify in (lambda v: v.update(serverId='global-kr'),
                           lambda v: v.update(expiresAt=v['observedAt']),
                           lambda v: v['entries'][0].update(rank=True),
                           lambda v: v['entries'][0].update(point=-1)):
                bad = observation(); modify(bad)
                with self.assertRaises(ValueError): validate_observation(bad, 'global-hmt', '1', '1')

    def test_http_scope_no_store_invalid_storage_and_changed_cursor(self):
        from fastapi.testclient import TestClient
        from tests.test_query_http import _make_config, _build_app
        with tempfile.TemporaryDirectory() as folder:
            config = _make_config(Path(folder))
            paths = publish_observations([observation()], config.data_root / 'observations', 'global-hmt')
            with TestClient(_build_app(config)) as client:
                route = '/api/v1/arena-rankings?server=global-hmt&season=1&band=1'
                first = client.get(route + '&limit=1')
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.headers['cache-control'], 'no-store')
                self.assertEqual(client.get(route.replace('band=1', 'band=2')).json()['status'], 'unavailable')
                self.assertEqual(client.get(route.replace('season=1', 'season=../')).status_code, 400)
                self.assertEqual([r['rank'] for r in client.get(route+'&rank=2').json()['entries']],[3,4])
                self.assertEqual(client.get(route+'&rank=101').json()['status'],'unavailable')
                self.assertEqual(client.get(route+'&rank=0').status_code,400)
                self.assertEqual(client.get(route + '&cursor=broken').status_code, 409)
                paths[0].write_text('{}')
                failed = client.get(route)
                self.assertEqual(failed.status_code, 503)
                self.assertNotIn(folder, failed.text)

    def test_plan_uses_reviewed_exact_server_season_band_and_digest(self):
        data = projection()
        self.assertEqual(read_plan(data, 'a' * 64, 'global-hmt', now=NOW)['bandIds'], ['1'])
        self.assertIsNone(read_plan(data, 'a' * 64, 'global-en', now=NOW))
        self.assertIsNone(read_plan(data, 'a' * 64, 'global-hmt', season='2', now=NOW))
        with self.assertRaises(ValueError): read_plan(data, 'a' * 64, 'global-hmt', bands=['2'], now=NOW)
        with self.assertRaises(ValueError): read_plan(data, 'broken', 'global-hmt', now=NOW)
        data['leagues'][0].update(opensAt=None, openingSourceText='')
        self.assertEqual(read_plan(data, 'a' * 64, 'global-hmt', now=NOW)['bandIds'], ['1'])
        data['leagues'][0]['openingSourceText'] = None
        with self.assertRaises(ValueError): read_plan(data, 'a' * 64, 'global-hmt', now=NOW)
        data['leagues'][0]['openingSourceText'] = ''
        data['seasons'].append(copy.deepcopy(data['seasons'][0]))
        with self.assertRaises(ValueError): read_plan(data, 'a' * 64, 'global-hmt', now=NOW)

    def test_wire_fields_project_public_deck_and_preserve_explicit_ranks(self):
        plan = dict(seasonId='1', limit=100)
        profile = message(1, 'public') + message(2, 'Name') + message(9, 'synthetic-private')
        deck = message(3, message(3, integer(1, 100001))) + integer(4, 123456)
        entry = message(1, profile) + message(2, deck) + integer(3, 8) + integer(4, 1234)
        result = decode_response(message(1, entry) + integer(2, 100), plan, '2')
        self.assertEqual({k:result['entries'][0][k] for k in ('playerId','name','rank','point')}, dict(playerId='public', name='Name', rank=8, point=1234))
        self.assertEqual(result['entries'][0]['deck']['cards'][0]['member']['masterId'], 100001)
        self.assertEqual(result['entries'][0]['deck']['totalPower'], 123456)
        self.assertEqual(result['maxRank'], 100)
        self.assertEqual(decode_response(b'', plan, '2')['entries'], [])
        self.assertNotIn('ArenaTop', ArenaRankingClient.read_methods)
        self.assertEqual(ArenaRankingClient.read_methods - __import__('tools.growth_login', fromlist=['GameClient']).GameClient.read_methods, {RPC})

    def test_native_master_is_selected_per_server_and_mismatch_stops_before_sdk(self):
        from unittest.mock import patch,Mock
        from tools.growth_login import GameClient,Profile
        data=projection();data.update(sourceMasterVersion='a'*32,serverScopes=['global-hmt','global-en','global-kr'],
            sourceMasterVersions={'global-hmt':'a'*32,'global-en':'b'*32,'global-kr':'c'*32})
        sdk=Mock()
        with patch.object(GameClient,'discover',return_value='synthetic-host'):
            for server,version in data['sourceMasterVersions'].items():
                plan=read_plan(data,'d'*64,server,now=NOW)
                self.assertEqual(plan['masterVersion'],version)
                game=ArenaRankingClient(plan);game.arena_master=version
                self.assertEqual(game.discover(),'synthetic-host')
                game.arena_master='e'*32
                with self.assertRaisesRegex(LoginError,'master_version_mismatch'):
                    run_capture(plan,Profile('FAKE'),'synthetic','synthetic',Path('/unused'),game_factory=lambda p:game,sdk_factory=sdk)
        sdk.assert_not_called()

    def test_capture_auth_cleared_and_failed_read_never_published(self):
        plan = dict(serverId='global-hmt', seasonId='1', bandIds=['1','2'], limit=100,
                    contentReleaseId='test-release', projectionSha256='a' * 64)
        auth = [('private', 'synthetic-private')]
        calls = []
        class Client(ArenaRankingClient):
            def authenticate(self, *args): return auth
            def rpc(self, host, method, payload=b'', credential=()):
                calls.append(method)
                self_outer.assertEqual(single(payload, 1, wire=0), 1)
                self_outer.assertEqual(single(payload, 3, wire=0), 1)
                self_outer.assertEqual(single(payload, 4, wire=0), 100)
                if single(payload, 2, wire=0) == 2: raise LoginError('game_rpc_resource_exhausted')
                return b''
        self_outer = self
        with self.assertRaises(LoginError): Client(plan).export(None, None, 'host')
        self.assertEqual(auth, [])
        self.assertEqual(calls, [RPC, RPC])

    def test_bounded_capture_pages_past_top_100_and_clears_auth(self):
        auth, ranges = [('private', 'synthetic')], []
        plan = dict(serverId='global-hmt', seasonId='1', bandIds=['1'], limit=1000,
                    contentReleaseId='test-release', projectionSha256='a' * 64)
        class Client(ArenaRankingClient):
            def authenticate(self, *args): return auth
            def rpc(self, host, method, payload=b'', credential=()):
                start, end = single(payload, 3, wire=0), single(payload, 4, wire=0)
                ranges.append((start, end))
                return b''.join(message(1, message(1, message(1, 'p'+str(n)) + message(2, 'Name')) + integer(3,n))
                    for n in range(start, min(end,250)+1)) + integer(2,250)
        result = Client(plan).export(None,None,'host')[0]
        self.assertEqual(ranges, [(1,100),(101,200),(201,300)])
        self.assertEqual(len(result['entries']),250)
        self.assertEqual(result['coverage']['endRank'],1000)
        self.assertEqual(auth,[])
        with tempfile.TemporaryDirectory() as folder:
            publish_observations([result],folder,'global-hmt')
            args=dict(server='global-hmt',season='1',band='1',limit=100)
            first=query_arena_rankings(folder,**args)
            second=query_arena_rankings(folder,**args,cursor=first['nextCursor'])
            self.assertEqual(second['entries'][0]['rank'],101)

    def test_public_content_hash_chain_and_missing_projection(self):
        raw = json.dumps(projection()).encode(); root='/content/releases/' + '1' * 24 + '/'
        manifest = dict(region='global', root=root, contentReleaseId='test-release', locales={'zh-CN': {'files': {
            'projection/arena.json': dict(path='zh-CN/arena.json', sha256=hashlib.sha256(raw).hexdigest())}}})
        m = json.dumps(manifest).encode()
        blobs = {'/content/current.json': json.dumps(dict(manifest=root+'manifest.json', contentReleaseId='test-release', sha256=hashlib.sha256(m).hexdigest())).encode(),
                 root+'manifest.json':m, root+'zh-CN/arena.json':raw}
        self.assertEqual(read_public_projection('https://example.invalid',blobs.__getitem__)[0]['serverScopes'], ['global-hmt'])
        blobs[root+'zh-CN/arena.json'] = b'{}'
        with self.assertRaises(ValueError): read_public_projection('https://example.invalid',blobs.__getitem__)


if __name__ == '__main__': unittest.main()
