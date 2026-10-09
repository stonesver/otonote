import copy
import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from backend.player_rankings import public_high_score_deck, query_player_rankings, validate_observation
from tools.collect_player_rankings import MUSIC_RPC, RankingClient, high_score_deck, ranking_entries, read_plan, read_current_content_plan, pause_required, run_capture, main
from tools.growth_login import CLIENT_VERSION, LoginError, SdkIdentity, integer, message, single
from tools.import_player_rankings import publish, publish_observation


def player(identity, score, name='Player'):
    return message(1, message(1, identity) + message(2, name) + message(6, 'IGNORED-PROFILE')) + integer(3, score)


def content_fixture(events=None):
    release = 'global-test-release'
    events = events if events is not None else [
        {'id': 1, 'name': 'Old event', 'schedule': {'startAt': '2026/10/01 12:00:00', 'endAt': '2026/10/08 20:59:59'}},
        {'id': 2, 'name': 'New event', 'schedule': {'startAt': '2026/10/09 12:00:00', 'endAt': '2026/10/17 20:59:59'}},
        {'id': 99, 'name': 'Future event', 'schedule': {'startAt': '2026/10/18 12:00:00', 'endAt': '2026/10/26 20:59:59'}},
    ]
    rows = [{**event, 'edition': 'global', 'sourceReleaseId': release,
             'ranking': {'configured': {'eventPoints': False, 'music': True, 'totalMusic': True}},
             'challengeSongs': [{'id': 2001, 'musicId': 100109, 'name': 'Song'}]} for event in events]
    projection = {'schemaVersion': 1, 'sourceReleaseId': release,
                  'events': {'edition': 'global', 'sourceReleaseId': release, 'records': rows}}
    raw_projection = json.dumps(projection).encode()
    root = '/content/releases/0123456789abcdef01234567/'
    manifest = {'schemaVersion': 1, 'region': 'global', 'root': root, 'contentReleaseId': release,
                'locales': {'zh-CN': {'files': {'projection/game-modes.json': {
                    'path': 'zh-CN/game-modes.json', 'sha256': hashlib.sha256(raw_projection).hexdigest()}}}}}
    raw_manifest = json.dumps(manifest).encode()
    pointer = {'manifest': root + 'manifest.json', 'sha256': hashlib.sha256(raw_manifest).hexdigest(),
               'contentReleaseId': release}
    return {'/content/current.json': json.dumps(pointer).encode(),
            root + 'manifest.json': raw_manifest, root + 'zh-CN/game-modes.json': raw_projection}


class RankingCollectionTests(unittest.TestCase):
    def test_observation_version_matches_the_actual_transport_version(self):
        client = RankingClient(self.plan())
        with patch.object(client, 'authenticate', return_value=[]), patch.object(client, 'rpc', return_value=b''):
            value = client.export(SdkIdentity('FAKE', 'FAKE-TOKEN'), 'device', 'host')
        self.assertEqual(value['source']['clientVersion'], CLIENT_VERSION)

    def test_capture_deployment_keeps_sdk_resources_outside_the_image(self):
        root = Path(__file__).resolve().parents[1]
        dockerfile = (root/'deploy/player-rankings-capture.Dockerfile').read_text()
        unit = (root/'deploy/ournotes-player-rankings-capture.service').read_text()
        self.assertNotIn('COPY packaging/growth-tool/sdk.bhk.xml', dockerfile)
        self.assertIn('source=${RANKING_SDK_RESOURCES},target=/run/ranking-sdk/resources.xml,readonly', unit)
        self.assertIn('--sdk-resources /run/ranking-sdk/resources.xml', unit)
        self.assertNotIn('/app/packaging/growth-tool/sdk.bhk.xml', unit)
        self.assertIn('--event auto', unit)
        self.assertNotIn('RANKING_EVENT_ID', unit)

    def test_auto_event_selection_uses_verified_current_content_and_taipei_schedule(self):
        files = content_fixture()
        select = lambda now: read_current_content_plan('https://ournotes.stonebg.cn', now=now,
                                                         fetch_bytes=files.__getitem__)
        self.assertIsNone(select(datetime(2026, 10, 9, 3, 59, tzinfo=timezone.utc)))
        plan = select(datetime(2026, 10, 9, 4, tzinfo=timezone.utc))
        self.assertEqual(plan['eventId'], '2')
        self.assertEqual(plan['boards'], [{'type': 'music', 'musicId': '100109', 'musicName': 'Song',
                                           'challengeMusicId': 2001}])
        self.assertEqual(plan['contentReleaseId'], 'global-test-release')
        self.assertEqual(plan['eventProjectionSha256'], hashlib.sha256(next(reversed(files.values()))).hexdigest())
        self.assertEqual(select(datetime(2026, 10, 17, 12, 59, 59, tzinfo=timezone.utc))['eventId'], '2')
        self.assertIsNone(select(datetime(2026, 10, 17, 13, tzinfo=timezone.utc)))
        self.assertEqual(select(datetime(2026, 10, 18, 4, tzinfo=timezone.utc))['eventId'], '99')

    def test_auto_event_selection_rejects_tampering_and_ambiguous_schedule(self):
        files = content_fixture()
        path = next(reversed(files))
        files[path] += b' '
        with self.assertRaisesRegex(ValueError, 'event_projection_hash_mismatch'):
            read_current_content_plan('https://ournotes.stonebg.cn', fetch_bytes=files.__getitem__)
        current = {'id': 2, 'name': 'Current', 'schedule': {'startAt': '2026/10/09 12:00:00',
                                                          'endAt': '2026/10/17 20:59:59'}}
        files = content_fixture([current, {**current, 'id': 3}])
        with self.assertRaisesRegex(ValueError, 'ambiguous_active_events'):
            read_current_content_plan('https://ournotes.stonebg.cn', now=datetime(2026, 10, 10, tzinfo=timezone.utc),
                                      fetch_bytes=files.__getitem__)
        files = content_fixture([{**current, 'schedule': {**current['schedule'], 'startAt': 'bad'}}])
        with self.assertRaisesRegex(ValueError, 'invalid_event_schedule'):
            read_current_content_plan('https://ournotes.stonebg.cn', now=datetime(2026, 10, 10, tzinfo=timezone.utc),
                                      fetch_bytes=files.__getitem__)

    def test_auto_capture_publishes_the_active_event(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            observations = root / 'observations'
            def fake_capture(plan, profile, account, password, output, *, progress):
                self.assertEqual(plan['eventId'], '2')
                self.assertEqual(plan['eventName'], 'New event')
                self.assertEqual(output, observations)
                return publish_observation({'schemaVersion': 1, 'serverId': 'global-hmt',
                    'observedAt': '2026-10-10T00:00:00Z', 'expiresAt': '2026-10-10T00:15:00Z',
                    'boards': [{'eventId': plan['eventId'], 'eventName': plan['eventName'],
                                'type': 'event-points', 'entries': []}]}, output, 'global-hmt')
            with patch('tools.collect_player_rankings.read_current_content_plan',
                       side_effect=lambda base: read_current_content_plan(base, now=datetime(2026, 10, 10, tzinfo=timezone.utc),
                                                                            fetch_bytes=content_fixture().__getitem__)), \
                 patch('tools.collect_player_rankings.Profile.from_resources'), \
                 patch('tools.collect_player_rankings.run_capture', side_effect=fake_capture), \
                 patch('tools.collect_player_rankings.getpass.getpass', return_value='FAKE'), \
                 contextlib.redirect_stdout(io.StringIO()):
                result = main(['--root', str(observations),
                               '--state-dir', str(root / 'state'), '--sdk-resources', str(root / 'resources.xml'),
                               '--prompt'])
            self.assertEqual(result, 0)
            self.assertEqual(query_player_rankings(observations, server='global-hmt')['eventId'], '2')
            self.assertEqual(json.loads((root / 'state/status.json').read_text())['eventId'], 2)

    def test_no_active_event_waits_without_replacing_the_last_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            observations = root / 'observations'
            previous = publish_observation({'schemaVersion': 1, 'serverId': 'global-hmt',
                'observedAt': '2026-10-08T00:00:00Z', 'expiresAt': '2026-10-08T00:15:00Z',
                'boards': [{'eventId': '1', 'type': 'event-points', 'entries': []}]}, observations, 'global-hmt')
            original = previous.read_bytes()
            with patch('tools.collect_player_rankings.read_current_content_plan', return_value=None), \
                 patch('tools.collect_player_rankings.Profile.from_resources') as profile, \
                 patch('tools.collect_player_rankings.run_capture') as capture, \
                 contextlib.redirect_stdout(io.StringIO()):
                result = main(['--root', str(observations),
                               '--state-dir', str(root / 'state'), '--sdk-resources', str(root / 'resources.xml')])
            self.assertEqual(result, 0)
            self.assertEqual(previous.read_bytes(), original)
            self.assertEqual(json.loads((root / 'state/status.json').read_text())['status'], 'waiting')
            profile.assert_not_called(); capture.assert_not_called()

    def test_invalid_current_content_does_not_permanently_pause_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            arguments = ['--root', str(root / 'observations'),
                         '--state-dir', str(root / 'state'), '--sdk-resources', str(root / 'resources.xml')]
            with patch('tools.collect_player_rankings.read_current_content_plan', side_effect=ValueError('bad content')), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(arguments), 2)
            status = json.loads((root / 'state/status.json').read_text())
            self.assertEqual(status['stage'], 'selecting_event')
            self.assertEqual(status['error'], 'ranking_event_selection_failed')
            self.assertFalse(status['paused'])

    def test_discovery_failure_stops_before_sdk_login_or_publication(self):
        stages = []
        with patch('tools.collect_player_rankings.RankingClient') as factory, patch('tools.collect_player_rankings.SdkClient') as sdk, patch('tools.collect_player_rankings.publish_observation') as publish:
            factory.return_value.discover.side_effect = LoginError('game_rpc_unknown')
            with self.assertRaisesRegex(LoginError, '^game_rpc_unknown$'):
                run_capture(self.plan(), object(), 'PRIVATE-ACCOUNT', 'PRIVATE-PASSWORD', Path('unused'),
                            game_factory=factory, sdk_factory=sdk, progress=stages.append)
            sdk.assert_not_called()
            publish.assert_not_called()
        self.assertEqual(stages, ['discovering'])

    def test_failure_status_identifies_stage_and_version_without_private_input(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def fail(*args, progress, **kwargs):
                progress('discovering')
                raise LoginError('game_rpc_unknown')
            with patch('tools.collect_player_rankings.read_plan', return_value=self.plan()), patch('tools.collect_player_rankings.Profile.from_resources'), patch('tools.collect_player_rankings.run_capture', side_effect=fail), patch.dict('os.environ', {'OURNOTES_RANKING_ACCOUNT':'PRIVATE-ACCOUNT','OURNOTES_RANKING_PASSWORD':'PRIVATE-PASSWORD'}, clear=True), contextlib.redirect_stdout(io.StringIO()):
                result = main(['--master-dir', str(root), '--event', '1', '--root', str(root/'observations'),
                               '--state-dir', str(root/'state'), '--sdk-resources', str(root/'resources.xml')])
            status = json.loads((root/'state/status.json').read_text())
            self.assertEqual(result, 2)
            self.assertEqual(status['stage'], 'discovering')
            self.assertEqual(status['clientVersion'], CLIENT_VERSION)
            self.assertNotIn('PRIVATE', json.dumps(status))
            self.assertFalse((root/'observations/global-hmt/current.json').exists())

    def test_high_score_deck_decodes_pairs_and_drops_nonpublic_fields(self):
        member = integer(1, 59) + integer(2, 721000) + integer(3, 4) + integer(4, 5)
        support = integer(1, 61) + integer(3, 5)
        slot = message(3, member) + message(4, support)
        raw = integer(1, 9) + message(2, 'PRIVATE-DECK-NAME') + message(3, slot) + integer(4, 2756699)
        deck = high_score_deck(raw)
        self.assertEqual(deck['totalPower'], 2756699)
        self.assertEqual(deck['cards'][0]['member'], {'masterId':59, 'exp':721000, 'rank':5,
                         'awake':4, 'liveSkillLevel':None, 'performanceSkillLevel':None})
        self.assertEqual(deck['cards'][0]['support'], {'masterId':61, 'exp':0, 'rank':5})
        self.assertEqual(deck['cards'][0]['slot'], 0)
        self.assertIsNone(high_score_deck(None))
        self.assertNotIn('PRIVATE', json.dumps(deck))
        row = ranking_entries(message(1, player('p', 123) + message(4, raw)), music=True)[0]
        self.assertEqual(row['highScoreDeck'], deck)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); value={'schemaVersion':1,'serverId':'global-hmt','observedAt':'2026-09-30T00:00:00Z',
              'expiresAt':'2026-09-30T00:15:00Z','boards':[{'type':'music','eventId':'1','musicId':'100109','entries':[row]}]}
            row['highScoreDeck']['credential']='PRIVATE-TOKEN'
            row['highScoreDeck']['cards'][0]['member']['instanceId']='PRIVATE-INSTANCE'
            source=root/'input.json';source.write_text(json.dumps(value));publish(source,root,'global-hmt')
            result=query_player_rankings(root,server='global-hmt')['entries'][0]
            self.assertEqual(result['highScoreDeck']['totalPower'],2756699)
            self.assertNotIn('PRIVATE',json.dumps(result))

    def test_invalid_decks_are_rejected_and_missing_cards_remain_unknown(self):
        slot={'slot':0,'performanceOrder':0,'member':None,'support':None}
        self.assertEqual(public_high_score_deck({'totalPower':None,'cards':[slot]})['cards'][0],slot)
        for value in ({'cards':[slot,slot]}, {'cards':[dict(slot,slot=5)]}, {'cards':[dict(slot,performanceOrder=True)]},
                      {'cards':[dict(slot,member={'masterId':0})]}, {'cards':[],'totalPower':-1}, {'cards':'bad'}):
            with self.assertRaises(ValueError):public_high_score_deck(value)
        raw=message(3,message(3,integer(1,59)))
        with self.assertRaises(LoginError):high_score_deck(raw+raw)

    def test_empty_card_messages_do_not_block_ranking_publication(self):
        # A populated slot can contain a present-but-empty protobuf card message.
        for empty in (b'', integer(1, 0), integer(1, 0) + integer(2, 0) + integer(3, 0)):
            for card_field in (3, 4):
                with self.subTest(empty=empty, card_field=card_field):
                    slot = message(card_field, empty) + message(7 - card_field, integer(1, 59))
                    raw = message(3, slot) + integer(4, 91639)
                    response = message(1, player('empty-support', 123) + message(4, raw))
                    client = RankingClient(self.plan())
                    with patch.object(client, 'authenticate', return_value=[]), patch.object(client, 'rpc', return_value=response):
                        value = client.export(SdkIdentity('FAKE', 'FAKE'), 'device', 'host')
                    with tempfile.TemporaryDirectory() as folder:
                        root = Path(folder); source = root / 'input.json'
                        source.write_text(json.dumps(value)); publish(source, root, 'global-hmt')
                        result = query_player_rankings(root, server='global-hmt')
                        self.assertEqual(result['status'], 'available')
                        deck = result['entries'][0]['highScoreDeck']
                        self.assertEqual(deck['totalPower'], 91639)
                        kind = 'member' if card_field == 3 else 'support'
                        self.assertIsNone(deck['cards'][0][kind])
                        self.assertEqual(deck['cards'][0]['support' if kind == 'member' else 'member']['masterId'], 59)

    def test_zero_card_id_with_growth_data_is_not_an_empty_slot(self):
        for card_field, fields in ((3, range(2, 7)), (4, range(2, 4))):
            for field in fields:
                with self.subTest(card_field=card_field, field=field):
                    raw = message(3, message(card_field, integer(1, 0) + integer(field, 1)))
                    with self.assertRaisesRegex(LoginError, 'invalid_high_score_deck'):
                        high_score_deck(raw)

    def plan(self):
        return {'eventId': '1', 'eventName': 'Event', 'ttl': 900, 'masterHashes': {},
                'uncollectedBoards': ['total-music'], 'boards': [
                    {'type': 'music', 'musicId': '100109', 'musicName': 'Song', 'challengeMusicId': 1}]}

    def test_decode_public_fields_preserving_tied_server_order(self):
        raw = message(1, player('b', 123, '<script>')) + message(1, player('a', 123)) + integer(2, 8)
        rows = ranking_entries(raw, music=True)
        self.assertEqual([(r['playerId'], r['rank'], r['score']) for r in rows], [('b', 1, 123), ('a', 2, 123)])
        self.assertNotIn('IGNORED', json.dumps(rows))
        self.assertEqual(rows[0]['name'], '<script>')  # Rendered only through textContent.
        with self.assertRaises(LoginError):
            ranking_entries(message(1, player('a', 1)) + message(1, player('b', 2)), music=True)
        with self.assertRaises(LoginError):
            ranking_entries(message(1, player('a', 1 << 63)), music=True)

    def test_missing_role_stops_before_game_login_or_ranking_reads(self):
        client = RankingClient(self.plan())
        with patch.object(client, 'rpc', return_value=b'') as rpc:
            with self.assertRaisesRegex(LoginError, 'no_existing_role'):
                client.export(SdkIdentity('FAKE', 'FAKE-TOKEN'), 'device', 'host')
        self.assertEqual(rpc.call_count, 1)
        self.assertTrue(rpc.call_args.args[1].endswith('/PlayerPreLogin'))

    def test_challenge_identity_auth_redaction_and_scoped_import(self):
        plan = self.plan()
        client = RankingClient(plan)
        auth = [('x-player-credential', 'FAKE-CREDENTIAL')]
        with patch.object(client, 'authenticate', return_value=auth), patch.object(client, 'rpc', return_value=message(1, player('p', 123))) as rpc:
            value = client.export(SdkIdentity('FAKE', 'FAKE-TOKEN'), 'device', 'host')
        self.assertEqual(rpc.call_args.args[1], MUSIC_RPC)
        self.assertEqual(single(rpc.call_args.args[2], 1, wire=0), 1)
        self.assertEqual(value['boards'][0]['musicId'], '100109')
        self.assertEqual(auth, [])
        self.assertNotIn('FAKE', json.dumps(value))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'source.json'; source.write_text(json.dumps(value))
            publish(source, root, 'global-hmt')
            result = query_player_rankings(root, server='global-hmt')
            self.assertEqual(result['board'], 'music')
            self.assertEqual(result['boards'], ['music'])
            self.assertEqual(result['eventId'], '1')
            self.assertEqual(result['musicId'], '100109')
            self.assertEqual(result['entries'][0]['score'], 123)
            self.assertEqual(query_player_rankings(root, server='global-en')['status'], 'unavailable')
            missing = query_player_rankings(root, server='global-hmt', board='total-music')
            self.assertEqual(missing['status'], 'unavailable')
            self.assertIsNone(missing['observedAt'])

    def test_partial_failure_never_produces_publishable_snapshot(self):
        plan = self.plan(); plan['boards'].append({**plan['boards'][0], 'musicId': '100056', 'challengeMusicId': 2})
        client = RankingClient(plan); auth = [('x-player-credential', 'FAKE')]
        with patch.object(client, 'authenticate', return_value=auth), patch.object(client, 'rpc', side_effect=[b'', LoginError('game_rpc_resource_exhausted')]) as rpc:
            with self.assertRaisesRegex(LoginError, 'resource_exhausted'):
                client.export(SdkIdentity('FAKE', 'FAKE'), 'device', 'host')
        self.assertEqual(rpc.call_count, 2)
        self.assertEqual(auth, [])

    def test_scheduler_pauses_on_authentication_or_rate_limits(self):
        for error in ['sdk_service_500002', 'sdk_http_429', 'no_existing_role_in_selected_server',
                      'game_rpc_unauthenticated', 'game_rpc_resource_exhausted', 'game_authentication_failed']:
            self.assertTrue(pause_required(error))
        self.assertFalse(pause_required('game_rpc_unavailable'))

    def test_master_plan_respects_disabled_boards_and_song_identifiers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            tables = {
                'MasterEvent': [{'_id': 1, '_nameTextId': 'event', '_isRankingDisabled': True,
                                 '_isMusicRankingDisabled': False, '_isTotalMusicRankingDisabled': False}],
                'MasterChallengeMusic': [{'_id': 3, '_eventId': 1, '_liveMusicId': 100063}],
                'MasterLiveMusic': [{'_id': 100063, '_titleTextID': 'song'}],
                'MasterText': [{'_id':'song', '_simplifiedChinese':'Song'}, {'_id':'event', '_simplifiedChinese':'Event'}],
            }
            for name, rows in tables.items(): (root / (name + '.json')).write_text(json.dumps({'_allData':rows}))
            plan = read_plan(root, 1)
            self.assertEqual(plan['boards'], [{'type':'music', 'musicId':'100063', 'musicName':'Song', 'challengeMusicId':3}])
            self.assertEqual(plan['uncollectedBoards'], ['total-music'])
            with self.assertRaises(ValueError): read_plan(root, 99)

    def test_invalid_snapshots_rejected_without_unhandled_exceptions(self):
        base = {'schemaVersion':1, 'serverId':'global-hmt', 'observedAt':'2026-09-30T00:00:00Z',
                'expiresAt':'2026-09-30T01:00:00Z', 'boards':[{'eventId':'1', 'type':'music', 'musicId':'2', 'entries':[]}]}
        for bad in (None, [], 'bad'):
            with self.assertRaises(ValueError): validate_observation(bad, 'global-hmt')
        for entries in ([None], [{'playerId':'p', 'name':'p', 'rank':1, 'score':1 << 54}]):
            value = copy.deepcopy(base); value['boards'][0]['entries'] = entries
            with self.assertRaises(ValueError): validate_observation(value, 'global-hmt')


if __name__ == '__main__': unittest.main()
