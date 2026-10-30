"""Bounded official DeckTrend reads using the existing capture account and lock.

Global 1.1.0 wire: request 1 music ID, 2 season, 3 band. Response 1 leaders,
2 members, 3 supports; each entry's field 1 is its public card Master ID.
No account inventory, saved teams, counts or percentages are exported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import fcntl
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from tools.arena_trends import project_deck_trends
from tools.collect_arena_rankings import read_plan, run_capture, ArenaRankingClient
from tools.collect_player_rankings import pause_required
from tools.growth_export import fields
from tools.growth_login import GameClient, LoginError, Profile, integer, single

RPC = 'app.arena.ArenaService/DeckTrend'
MAX_QUERIES = 200


def trend_plan(projection, projection_digest, catalog, catalog_digest, server, *, season=None, bands=None, now=None):
    plan = read_plan(projection, projection_digest, server, season=season, bands=bands, now=now)
    if plan is None:
        return None
    release = catalog.get('release', {}).get('id')
    # Catalog identity follows the site's existing release/projection contract.
    if release != plan['contentReleaseId']:
        raise ValueError('arena_trend_catalog_release_mismatch')
    if not isinstance(catalog_digest, str) or len(catalog_digest) != 64 or any(c not in '0123456789abcdef' for c in catalog_digest):
        raise ValueError('arena_trend_catalog_digest_invalid')
    band_ids = {b['id']: str(b['masterId']) for b in catalog['bands']}
    queries = []
    for band in plan['bandIds']:
        for song in catalog['musicTracks']:
            if band not in [band_ids.get(b) for b in song.get('bandIds', [])]:
                continue
            music = song.get('masterId')
            if type(music) is not int or not 0 < music <= (1 << 53) - 1:
                raise ValueError('invalid_arena_trend_music')
            queries.append(dict(bandId=band, musicId=music))
    identities = {(q['bandId'], q['musicId']) for q in queries}
    if not 1 <= len(queries) <= MAX_QUERIES or len(identities) != len(queries):
        raise ValueError('invalid_arena_trend_query_count')
    return dict(plan, queries=queries, catalogSha256=catalog_digest)


def decode_trend(raw):
    result = {k: [] for k in ('leaders', 'members', 'supports')}
    for field, wire, value in fields(raw):
        if field not in (1, 2, 3):
            continue
        group = ('leaders', 'members', 'supports')[field - 1]
        if wire != 2 or len(result[group]) >= 100:
            raise LoginError('invalid_arena_trend_response')
        identity = single(value, 1, wire=0)
        if not 0 < identity <= (1 << 53) - 1:
            raise LoginError('invalid_arena_trend_card')
        result[group].append({('supportCardId' if field == 3 else 'memberCardId'): identity})
    return result


class ArenaTrendClient(ArenaRankingClient):
    read_methods = GameClient.read_methods | {RPC}

    def __init__(self, plan):
        super().__init__(plan)

    def export(self, identity, device_id, host, progress=lambda stage: None):
        auth = self.authenticate(identity, device_id, host, progress)
        records = []
        try:
            for query in self.plan['queries']:
                payload = b''.join(integer(n, v) for n, v in enumerate([
                    query['musicId'], int(self.plan['seasonId']), int(query['bandId'])], 1))
                response = self.rpc(host, RPC, payload, auth)
                records.append(dict(source='ArenaService.DeckTrend', serverId=self.server_id,
                    seasonId=self.plan['seasonId'], **query, observedAt=datetime.now(timezone.utc).isoformat(),
                    response=decode_trend(response)))
        finally:
            auth.clear()
        # Reuse the publication whitelist before saving any observation.
        project_deck_trends(records, 'global', [dict(id=self.plan['seasonId'])],
                            [dict(bandId=b) for b in self.plan['bandIds']])
        return records


def save_observations(records, root, server):
    if not records or any(r.get('serverId') != server for r in records):
        raise ValueError('arena_trend_observation_scope_invalid')
    seasons = [dict(id=s) for s in {r['seasonId'] for r in records}]
    leagues = [dict(bandId=b) for b in {r['bandId'] for r in records}]
    public = project_deck_trends(records, 'global', seasons, leagues)
    # Reconstruct only whitelisted review inputs; unknown fields never reach disk.
    cleaned = [dict(source=r['source'], serverId=r['serverId'], seasonId=r['seasonId'], bandId=r['bandId'],
                    musicId=int(r['musicId']), observedAt=r['observedAt'], response={
                        k: [{('supportCardId' if k == 'supports' else 'memberCardId'): int(i)} for i in r[k]]
                        for k in ('leaders', 'members', 'supports')}) for r in public]
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    target = root / ('arena-deck-trends-' + server + '.json')
    fd, temporary = tempfile.mkstemp(prefix='.arena-trends-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(cleaned, stream)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return [target]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projection', required=True, type=Path)
    parser.add_argument('--projection-sha256', required=True)
    parser.add_argument('--catalog', required=True, type=Path)
    parser.add_argument('--catalog-sha256', required=True)
    parser.add_argument('--server', choices=('global-hmt', 'global-en', 'global-kr'), default='global-hmt')
    parser.add_argument('--season')
    parser.add_argument('--band', action='append', dest='bands')
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--lock-dir', required=True, type=Path)
    parser.add_argument('--sdk-resources', required=True, type=Path)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.lock_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    status = args.state_dir / ('arena-trends-' + args.server + '-status.json')
    with (args.lock_dir / 'capture.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Trend capture already running.'); return 0
        paused = status.exists() and json.loads(status.read_text()).get('paused') and not args.resume
        for name in ('status.json', 'finalize-status.json', 'arena-' + args.server + '-status.json'):
            path = args.state_dir / name
            paused = paused or path.exists() and json.loads(path.read_text()).get('paused')
        if paused:
            print('Trend capture paused; operator action required.'); return 0
        account = password = ''
        try:
            projection, catalog = args.projection.read_bytes(), args.catalog.read_bytes()
            if hashlib.sha256(projection).hexdigest() != args.projection_sha256 or hashlib.sha256(catalog).hexdigest() != args.catalog_sha256:
                raise ValueError('arena_trend_input_digest_mismatch')
            plan = trend_plan(json.loads(projection), args.projection_sha256, json.loads(catalog), args.catalog_sha256,
                              args.server, season=args.season, bands=args.bands)
            if plan is None:
                result = dict(status='waiting', paused=False, reason='arena_scope_not_published')
            else:
                credentials = os.environ.get('CREDENTIALS_DIRECTORY')
                if credentials:
                    account = (Path(credentials) / 'account').read_text().strip()
                    password = (Path(credentials) / 'password').read_text().rstrip('\r\n')
                else:
                    account, password = os.environ.get('OURNOTES_RANKING_ACCOUNT', ''), os.environ.get('OURNOTES_RANKING_PASSWORD', '')
                if not account or not password:
                    raise LoginError('ranking_credentials_required')
                paths = run_capture(plan, Profile.from_resources(args.sdk_resources), account, password, args.root,
                                    game_factory=ArenaTrendClient, publisher=save_observations)
                result = dict(status='complete', paused=False, queries=len(plan['queries']), files=len(paths))
        except LoginError as exc:
            result = dict(status='failed', paused=pause_required(str(exc)) or str(exc) == 'ranking_credentials_required', error=str(exc))
        except Exception:
            result = dict(status='failed', paused=False, error='arena_trend_capture_failed')
        finally:
            account = password = ''
        result['serverId'] = args.server
        temporary = status.with_suffix('.tmp'); temporary.write_text(json.dumps(result)); os.chmod(temporary, 0o600); temporary.replace(status)
        print(json.dumps(result))
        return 2 if result['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
