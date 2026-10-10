"""Bounded HMT event ranking reads using an existing, in-memory game login.

Wire schema: Global Android 1.0.1 (25), EventService and PlayerSimpleProfile.
Transport version follows growth_login.CLIENT_VERSION, independently of this schema.
Only public profile id/name, ranking score and its high-score deck are retained.
Account growth, personal rank and all credentials are discarded. No automatic retry.
"""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from backend.player_rankings import public_high_score_deck, validate_observation
from tools.growth_export import fields
from tools.growth_login import CLIENT_VERSION, GameClient, LoginError, integer, message, single, string, varint
from tools.growth_login import Profile, SdkClient
from tools.import_player_rankings import (ensure_final_archive_metadata, publish_final_observation,
                                          publish_observation)
from tools.resource_pipeline.localization import resolve_text

MUSIC_RPC = 'app.event.EventService/GetChallengeMusicRanking'
POINTS_RPC = 'app.event.EventService/GetRankingList'
MAX_PLAYERS = 1000
EVENT_TIME_ZONE = timezone(timedelta(hours=8), 'Asia/Taipei')
EVENT_TIME_PATTERN = re.compile(r'^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$')
CONTENT_MANIFEST_PATTERN = re.compile(r'^/content/releases/[a-f0-9]{24}/manifest\.json$')
CONTENT_FILE_PATTERN = re.compile(r'^[A-Za-z0-9_./-]+$')
SHA256_PATTERN = re.compile(r'^[a-f0-9]{64}$')


def _event_local_time(value) -> datetime:
    match = EVENT_TIME_PATTERN.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError('invalid_event_schedule')
    try:
        return datetime(*(int(part or 0) for part in match.groups())).replace(tzinfo=EVENT_TIME_ZONE)
    except ValueError as exc:
        raise ValueError('invalid_event_schedule') from exc


def _read_content_plan(base: str, *, now: datetime | None = None, fetch_bytes=None,
                       ended_root: Path | None = None) -> dict | None:
    """Bind a ranking plan to the site's hash-checked Global event projection."""
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('invalid_content_origin')
    origin = base.rstrip('/')

    def fetch(path, limit):
        if fetch_bytes is not None:
            raw = fetch_bytes(path)
        else:
            request = Request(origin + path, headers={'User-Agent': 'OurNotes-Ranking-Capture/1.0',
                                                      'Accept': 'application/json'})
            with urlopen(request, timeout=15) as response:
                raw = response.read(limit + 1)
        if not isinstance(raw, bytes) or len(raw) > limit:
            raise ValueError('invalid_content_response')
        return raw

    pointer = json.loads(fetch('/content/current.json', 16_384))
    manifest_path = pointer.get('manifest') if isinstance(pointer, dict) else None
    if (not isinstance(manifest_path, str) or not CONTENT_MANIFEST_PATTERN.fullmatch(manifest_path)
            or not SHA256_PATTERN.fullmatch(str(pointer.get('sha256', '')))):
        raise ValueError('invalid_content_pointer')
    raw = fetch(manifest_path, 4_000_000)
    if hashlib.sha256(raw).hexdigest() != pointer['sha256']:
        raise ValueError('content_manifest_hash_mismatch')
    manifest = json.loads(raw)
    root = manifest_path.removesuffix('manifest.json')
    if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1
            or manifest.get('region') != 'global' or manifest.get('root') != root
            or manifest.get('contentReleaseId') != pointer.get('contentReleaseId')):
        raise ValueError('invalid_content_manifest')
    locales = manifest.get('locales')
    locale = locales.get('zh-CN') if isinstance(locales, dict) else None
    files = locale.get('files') if isinstance(locale, dict) else None
    record = files.get('projection/game-modes.json') if isinstance(files, dict) else None
    path = record.get('path') if isinstance(record, dict) else None
    sha = record.get('sha256') if isinstance(record, dict) else None
    if (not isinstance(path, str) or not CONTENT_FILE_PATTERN.fullmatch(path)
            or path.startswith('/') or '..' in path.split('/') or not SHA256_PATTERN.fullmatch(str(sha))):
        raise ValueError('invalid_event_projection_record')
    raw = fetch(root + path, 8_000_000)
    if hashlib.sha256(raw).hexdigest() != sha:
        raise ValueError('event_projection_hash_mismatch')
    projection = json.loads(raw)
    archive = projection.get('events') if isinstance(projection, dict) else None
    if (not isinstance(archive, dict) or projection.get('schemaVersion') != 1
            or projection.get('sourceReleaseId') != pointer['contentReleaseId']
            or archive.get('edition') != 'global' or archive.get('sourceReleaseId') != pointer['contentReleaseId']
            or not isinstance(archive.get('records'), list)):
        raise ValueError('invalid_event_projection')
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError('invalid_current_time')
    current = current.astimezone(EVENT_TIME_ZONE)
    active = []
    ended = []
    for event in archive['records']:
        schedule = event.get('schedule') if isinstance(event, dict) else None
        if (not isinstance(schedule, dict) or event.get('edition') != 'global'
                or event.get('sourceReleaseId') != pointer['contentReleaseId']
                or type(event.get('id')) is not int or event['id'] <= 0):
            raise ValueError('invalid_event_projection')
        start = _event_local_time(schedule.get('startAt'))
        end = _event_local_time(schedule.get('endAt'))
        if end < start:
            raise ValueError('invalid_event_schedule')
        ranking = event.get('ranking')
        flags = ranking.get('configured') if isinstance(ranking, dict) else None
        if (not isinstance(flags, dict)
                or any(type(flags.get(key)) is not bool for key in ('eventPoints', 'music', 'totalMusic'))):
            raise ValueError('invalid_event_projection')
        if ended_root is None and start <= current <= end:
            active.append(event)
        if (ended_root is not None and end + timedelta(minutes=10) <= current
                and (flags['eventPoints'] or flags['music'])
                and not ensure_final_archive_metadata(ended_root, 'global-hmt', str(event['id']))):
            ended.append((end, event))
    if ended_root is None:
        if len(active) > 1:
            raise ValueError('ambiguous_active_events')
        if not active:
            return None
        event = active[0]
    else:
        if not ended:
            return None
        event = max(ended, key=lambda item: item[0])[1]
    ranking = event.get('ranking')
    flags = ranking.get('configured') if isinstance(ranking, dict) else None
    if (type(event.get('id')) is not int or event['id'] <= 0 or not isinstance(event.get('name'), str)
            or not event['name'] or not isinstance(flags, dict)
            or any(type(flags.get(key)) is not bool for key in ('eventPoints', 'music', 'totalMusic'))):
        raise ValueError('invalid_event_projection')
    boards = []
    if flags['music']:
        songs = event.get('challengeSongs')
        if not isinstance(songs, list):
            raise ValueError('invalid_event_projection')
        for song in songs:
            if (not isinstance(song, dict) or type(song.get('id')) is not int or song['id'] <= 0
                    or type(song.get('musicId')) is not int or song['musicId'] <= 0
                    or not isinstance(song.get('name'), str) or not song['name']):
                raise ValueError('invalid_event_projection')
            boards.append({'type': 'music', 'musicId': str(song['musicId']),
                           'musicName': song['name'], 'challengeMusicId': song['id']})
    if flags['eventPoints']:
        boards.append({'type': 'event-points'})
    if not boards or len(boards) > 20:
        raise ValueError('no_supported_boards_or_too_many_boards')
    return {'eventId': str(event['id']), 'eventName': event['name'], 'boards': boards, 'ttl': 900,
            'contentReleaseId': pointer['contentReleaseId'], 'eventProjectionSha256': sha,
            'uncollectedBoards': ['total-music'] if flags['totalMusic'] else []}


def read_current_content_plan(base: str, *, now: datetime | None = None, fetch_bytes=None) -> dict | None:
    return _read_content_plan(base, now=now, fetch_bytes=fetch_bytes)


def read_ended_content_plan(base: str, root: Path, *, now: datetime | None = None,
                            fetch_bytes=None) -> dict | None:
    return _read_content_plan(base, now=now, fetch_bytes=fetch_bytes, ended_root=root)


def read_plan(master: Path, event_id: int, *, ttl: int = 900) -> dict:
    if type(event_id) is not int or event_id <= 0 or not 60 <= ttl <= 3600:
        raise ValueError('invalid_ranking_plan')
    tables, hashes = {}, {}
    for name in ('MasterEvent', 'MasterChallengeMusic', 'MasterLiveMusic', 'MasterText'):
        raw = (master / (name + '.json')).read_bytes()
        tables[name] = json.loads(raw)['_allData']
        hashes[name] = hashlib.sha256(raw).hexdigest()
    event = next((r for r in tables['MasterEvent'] if r['_id'] == event_id), None)
    if event is None:
        raise ValueError('event_not_in_selected_master')
    text = {r['_id']: r for r in tables['MasterText']}
    songs = {r['_id']: r for r in tables['MasterLiveMusic']}
    name = lambda row, fallback: resolve_text(text.get(row.get('_nameTextId') or row.get('_titleTextID')), fallback)
    boards = []
    if event.get('_isMusicRankingDisabled') is False:
        for row in tables['MasterChallengeMusic']:
            if row.get('_eventId') != event_id:
                continue
            music_id = row['_liveMusicId']
            if music_id not in songs or type(row['_id']) is not int or row['_id'] <= 0:
                raise ValueError('invalid_challenge_music_reference')
            boards.append({'type': 'music', 'musicId': str(music_id),
                           'musicName': name(songs[music_id], str(music_id)),
                           'challengeMusicId': row['_id']})
    if event.get('_isRankingDisabled') is False:
        boards.append({'type': 'event-points'})
    if not boards or len(boards) > 20:
        raise ValueError('no_supported_boards_or_too_many_boards')
    return {'eventId': str(event_id), 'eventName': name(event, str(event_id)),
            'boards': boards, 'ttl': ttl, 'masterHashes': hashes,
            'uncollectedBoards': ['total-music'] if event.get('_isTotalMusicRankingDisabled') is False else []}


def high_score_deck(raw):
    """Global 1.0.1 entity.DeckDetail, from ChallengeLiveRankingPlayer field 4."""
    if raw is None:
        return None
    scalar = lambda data, field: single(data, field, wire=0, required=False) or 0

    def card(data, member):
        if data is None:
            return None
        value = {'masterId': scalar(data, 1), 'exp': scalar(data, 2),
                 'rank': scalar(data, 4 if member else 3) or None}
        if member:
            value.update(awake=scalar(data, 3) or None, liveSkillLevel=scalar(data, 5) or None,
                         performanceSkillLevel=scalar(data, 6) or None)
        # Empty slots can carry a present protobuf message with all default values.
        # A zero ID with nonzero growth data remains invalid and is rejected below.
        if not any(value.values()):
            return None
        return value

    cards = []
    for n, wire, data in fields(raw):
        if n != 3:
            continue
        if wire != 2 or len(cards) >= 5:
            raise LoginError('invalid_high_score_deck')
        cards.append({'slot': scalar(data, 1), 'performanceOrder': scalar(data, 2),
                      'member': card(single(data, 3, required=False), True),
                      'support': card(single(data, 4, required=False), False)})
    try:
        return public_high_score_deck({'totalPower': scalar(raw, 4) or None, 'cards': cards})
    except ValueError:
        raise LoginError('invalid_high_score_deck') from None


def ranking_entries(raw: bytes, *, music: bool) -> list[dict]:
    result = []
    for number, wire, value in fields(raw):
        if number != 1:
            continue
        if wire != 2 or len(result) >= MAX_PLAYERS:
            raise LoginError('invalid_or_oversized_ranking_response')
        profile = single(value, 1)
        score = single(value, 3, wire=0, required=False) or 0
        rank = len(result) + 1 if music else single(value, 2, wire=0)
        if score > (1 << 31) - 1 or rank < 1 or rank > (1 << 31) - 1:
            raise LoginError('invalid_ranking_number')
        if music and result and score > result[-1]['score']:
            raise LoginError('ranking_order_changed')
        result.append({'playerId': string(profile, 1), 'name': string(profile, 2, optional=True),
                       'rank': rank, 'score': score,
                       'highScoreDeck': high_score_deck(single(value, 4, required=False)) if music else None})
    return result


class RankingClient(GameClient):
    read_methods = GameClient.read_methods | {MUSIC_RPC, POINTS_RPC}

    def __init__(self, plan: dict):
        self.plan = plan

    def export(self, identity, device_id, host, progress=lambda s: None):
        auth = self.authenticate(identity, device_id, host, progress)
        observed = datetime.now(timezone.utc)
        boards = []
        progress('reading_rankings')
        try:
            for definition in self.plan['boards']:
                music = definition['type'] == 'music'
                # ChallengeMusic ID is NOT the public LiveMusic ID.
                payload = integer(1, definition['challengeMusicId']) if music else (
                    integer(1, int(self.plan['eventId'])) + message(2, b''.join(varint(i) for i in range(1, 101))))
                response = self.rpc(host, MUSIC_RPC if music else POINTS_RPC, payload, auth)
                boards.append({**definition, 'eventId': self.plan['eventId'], 'eventName': self.plan['eventName'],
                               'coverage': 'server_returned_list' if music else 'top_100',
                               'entries': ranking_entries(response, music=music)})
        finally:
            auth.clear()
        source = {'kind': 'direct_game_read', 'clientVersion': CLIENT_VERSION}
        for key in ('masterHashes', 'contentReleaseId', 'eventProjectionSha256'):
            if key in self.plan:
                source[key] = self.plan[key]
        return validate_observation({
            'schemaVersion': 1, 'serverId': 'global-hmt', 'observedAt': observed.isoformat(),
            'expiresAt': (observed + timedelta(seconds=self.plan['ttl'])).isoformat(), 'boards': boards,
            'source': source,
            'uncollectedBoards': self.plan['uncollectedBoards'],
        }, 'global-hmt')


def pause_required(error: str) -> bool:
    return error.startswith(('sdk_service_', 'sdk_http_429', 'no_existing_role', 'game_authentication_failed',
                             'game_rpc_unauthenticated', 'game_rpc_permission_denied',
                             'game_rpc_resource_exhausted', 'unexpected_new_role'))


def run_capture(plan, profile, account, password, root, *, sdk_factory=SdkClient, game_factory=RankingClient,
                progress=lambda stage: None, publisher=None):
    game = game_factory(plan)
    progress('discovering')
    host = game.discover()
    progress('sdk_login')
    sdk = sdk_factory(profile)
    identity = sdk.login(account, password)
    try:
        snapshot = game.export(identity, sdk.device_id, host, progress)
    finally:
        identity = None
    progress('publishing')
    return (publisher or publish_observation)(snapshot, root, 'global-hmt')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--master-dir', type=Path, help='Master tables for an explicit maintenance event')
    parser.add_argument('--content-base', default='https://ournotes.stonebg.cn',
                        help='public current content origin used by auto selection')
    parser.add_argument('--event', default='auto', help='auto or an explicit event ID for maintenance')
    parser.add_argument('--mode', choices=('capture', 'finalize'), default='capture')
    parser.add_argument('--root', type=Path, required=True, help='published observations root')
    parser.add_argument('--state-dir', type=Path, required=True, help='private lock/status directory')
    parser.add_argument('--sdk-resources', type=Path, required=True)
    parser.add_argument('--prompt', action='store_true', help='maintenance-only terminal input, with echo disabled')
    parser.add_argument('--resume', action='store_true', help='operator resume after resolving authentication or rate limits')
    args = parser.parse_args(argv)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    status_path = args.state_dir / ('finalize-status.json' if args.mode == 'finalize' else 'status.json')
    with (args.state_dir / 'capture.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Ranking capture already running.'); return 0
        if status_path.exists() and not args.resume and json.loads(status_path.read_text()).get('paused'):
            print('Ranking capture paused; operator action required.'); return 0
        account = password = ''
        stage = 'configuration'
        event_id = None
        def progress(value):
            nonlocal stage
            if value in ('discovering', 'sdk_login', 'checking_existing_account', 'game_login',
                         'reading_rankings', 'publishing'):
                stage = value
        try:
            stage = 'selecting_event'
            if args.mode == 'finalize':
                if args.event != 'auto':
                    raise ValueError('manual_finalization_not_supported')
                plan = read_ended_content_plan(args.content_base, args.root)
                event_id = int(plan['eventId']) if plan else None
            elif args.event == 'auto':
                plan = read_current_content_plan(args.content_base)
                event_id = int(plan['eventId']) if plan else None
            else:
                try:
                    event_id = int(args.event)
                except ValueError as exc:
                    raise ValueError('invalid_event_selection') from exc
                if args.master_dir is None:
                    raise ValueError('master_dir_required_for_manual_event')
                plan = read_plan(args.master_dir, event_id)
            if event_id is None:
                result = {'status':'waiting', 'paused':False,
                          'reason':'no_ended_event_to_archive' if args.mode == 'finalize' else 'no_active_event'}
                code = 0
            else:
                stage = 'configuration'
                profile = Profile.from_resources(args.sdk_resources)
                if args.prompt:
                    account = getpass.getpass('Account (hidden): ')
                    password = getpass.getpass('Password (hidden): ')
                elif os.environ.get('CREDENTIALS_DIRECTORY'):
                    credentials = Path(os.environ['CREDENTIALS_DIRECTORY'])
                    account = (credentials / 'account').read_text().strip()
                    password = (credentials / 'password').read_text().rstrip('\r\n')
                else:
                    account = os.environ.get('OURNOTES_RANKING_ACCOUNT', '')
                    password = os.environ.get('OURNOTES_RANKING_PASSWORD', '')
                if not account or not password:
                    raise LoginError('ranking_credentials_required')
                publication = {'publisher': publish_final_observation} if args.mode == 'finalize' else {}
                path = run_capture(plan, profile, account, password, args.root, progress=progress,
                                   **publication)
                value = json.loads(path.read_text())
                result = {'status':'complete', 'paused':False, 'observedAt':value['observedAt'],
                          'boards':len(value['boards']), 'entries':sum(len(b['entries']) for b in value['boards'])}
                code = 0
        except LoginError as exc:
            result = {'status':'failed', 'paused':pause_required(str(exc)) or str(exc) == 'ranking_credentials_required', 'error':str(exc)}
            code = 2
        except Exception:
            selecting = stage == 'selecting_event'
            result = {'status':'failed', 'paused':not selecting,
                      'error':'ranking_event_selection_failed' if selecting else 'ranking_capture_failed'}
            code = 2
        finally:
            account = password = ''
        result.update(stage=stage, clientVersion=CLIENT_VERSION, eventId=event_id, mode=args.mode)
        temporary = status_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result) + '\n')
        os.chmod(temporary, 0o600)
        temporary.replace(status_path)
        print(json.dumps(result))
        return code


if __name__ == '__main__':
    raise SystemExit(main())
