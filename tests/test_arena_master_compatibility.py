"""Version-only updates must not strand rankings or admit changed rank rules."""
import copy
import io
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tools.collect_arena_rankings import ArenaRankingClient, run_capture
from tools.global_game_config import GLOBAL_SERVERS
from tools.growth_login import GameClient, LoginError, Profile, message
from tools.ranking_regions import CDN

TABLES = ('MasterArenaSeason.bin', 'MasterArenaLeague.bin', 'MasterArenaRank.bin')


class ArenaMasterCompatibilityTests(unittest.TestCase):
    def fixtures(self, server):
        old, new = 'a' * 32, 'b' * 32
        plan = dict(serverId=server, masterVersion=old, contentReleaseId='approved-release')
        game = ArenaRankingClient(plan)
        game.arena_master = new
        prefix, hosts = CDN[server]
        cdn = 'https://' + hosts[0] + '/prod/' + prefix + '_' + 'c' * 32
        definition = GLOBAL_SERVERS[server]
        game._public_rpc = Mock(return_value=message(1,
            message(1, definition['name']) + message(2, cdn) + message(8, definition['wireId'])))
        rows = [dict(name=name, hash='d' * 64, size=100) for name in TABLES]
        manifests = {old: dict(version=old, files=rows), new: dict(version=new, files=copy.deepcopy(rows))}
        # Unpublished card/text changes do not alter the reviewed rank thresholds.
        manifests[new]['files'].append(dict(name='MasterText.bin', hash='e' * 64, size=200))
        requests = []
        def fetch(request, timeout):
            requests.append(request.full_url)
            version = request.full_url.split('/')[-2]
            return io.BytesIO(json.dumps(manifests[version]).encode())
        return plan, game, manifests, requests, Mock(open=fetch)

    def test_unchanged_rank_tables_accept_new_versions_in_each_server_without_changing_public_scope(self):
        for server in GLOBAL_SERVERS:
            with self.subTest(server=server):
                plan, game, manifests, requests, opener = self.fixtures(server)
                before = copy.deepcopy(plan)
                with patch.object(GameClient, 'discover', return_value='host'), \
                        patch('tools.ranking_regions.build_opener', return_value=opener):
                    self.assertEqual(game.discover(), 'host')
                self.assertEqual(plan, before)
                self.assertEqual([u.split('/')[-2] for u in requests], list(manifests))

    def test_changed_rank_rules_stop_before_credentials_and_keep_last_snapshot(self):
        for name in TABLES:
            with self.subTest(table=name):
                plan, game, manifests, _, opener = self.fixtures('global-hmt')
                next(r for r in manifests['b' * 32]['files'] if r['name'] == name)['hash'] = 'f' * 64
                sdk, publisher = Mock(), Mock()
                with patch.object(GameClient, 'discover', return_value='host'), \
                        patch('tools.ranking_regions.build_opener', return_value=opener):
                    with self.assertRaisesRegex(LoginError, 'arena_rank_tables_changed'):
                        run_capture(plan, Profile('FAKE'), 'synthetic', 'synthetic', Path('/unused'),
                                    game_factory=lambda p: game, sdk_factory=sdk, publisher=publisher)
                sdk.assert_not_called()
                publisher.assert_not_called()

    def test_incomplete_or_wrong_version_manifest_is_not_compatible(self):
        for fault in ('missing', 'version', 'duplicate'):
            with self.subTest(fault=fault):
                _, game, manifests, _, opener = self.fixtures('global-en')
                target = manifests['b' * 32]
                if fault == 'missing': target['files'].pop(0)
                if fault == 'version': target['version'] = 'f' * 32
                if fault == 'duplicate': target['files'].append(target['files'][0])
                with patch.object(GameClient, 'discover', return_value='host'), \
                        patch('tools.ranking_regions.build_opener', return_value=opener):
                    with self.assertRaisesRegex(LoginError, 'arena_master_verification_failed'):
                        game.discover()
