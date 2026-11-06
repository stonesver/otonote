"""Bounded read-only Arena rankings using the existing capture account and shared lock.

Wire fields verified against Global Android 1.1.0: ArenaRankingRequest fields
1 season, 2 optional band (always supplied), 3 start, 4 end; response 1 entries,
2 maxRank; ArenaRankingEntry 1 PlayerSimpleProfile, 2 public deck, 3 rank,
4 point. No ArenaTop, ArenaMyRank, rewards, matching or player writes are called.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from backend.arena_rankings import RPC, absolute, validate_observation
from tools.arena_content import validate_arena_publication, arena_master_version
from tools.collect_player_rankings import pause_required, high_score_deck
from tools.global_game_config import GLOBAL_SERVERS
from tools.growth_export import fields
from tools.growth_login import GameClient, LoginError, Profile, SdkClient, integer, single, string
from tools.import_arena_rankings import publish_observations


def read_public_projection(origin, fetch_bytes=None):
    """Use the same immutable content/hash chain as the existing ranking capture."""
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('invalid_content_origin')
    def fetch(path, limit):
        if fetch_bytes:
            raw = fetch_bytes(path)
        else:
            with urlopen(Request(origin.rstrip('/') + path, headers={'User-Agent': 'OurNotes-Arena-Ranking/1.0'}), timeout=15) as response:
                raw = response.read(limit + 1)
        if not isinstance(raw, bytes) or len(raw) > limit:
            raise ValueError('invalid_arena_content_response')
        return raw
    import re
    pointer = json.loads(fetch('/content/current.json', 16_384))
    manifest_path = pointer.get('manifest', '')
    if not re.fullmatch(r'/content/releases/[a-f0-9]{24}/manifest\.json', manifest_path):
        raise ValueError('invalid_arena_content_manifest')
    raw = fetch(manifest_path, 4_000_000)
    if hashlib.sha256(raw).hexdigest() != pointer.get('sha256'):
        raise ValueError('arena_content_manifest_hash_mismatch')
    manifest = json.loads(raw)
    root = manifest_path.removesuffix('manifest.json')
    if (manifest.get('region') != 'global' or manifest.get('root') != root
            or manifest.get('contentReleaseId') != pointer.get('contentReleaseId')):
        raise ValueError('arena_content_identity_mismatch')
    record = manifest.get('locales', {}).get('zh-CN', {}).get('files', {}).get('projection/arena.json')
    if record is None:
        return None
    path = record.get('path', '')
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', path) or path.startswith('/') or '..' in path.split('/'):
        raise ValueError('invalid_arena_projection_path')
    raw = fetch(root + path, 4_000_000)
    if hashlib.sha256(raw).hexdigest() != record.get('sha256'):
        raise ValueError('arena_projection_hash_mismatch')
    data = json.loads(raw)
    validate_arena_publication(data, pointer['contentReleaseId'], 'global')
    return data, hashlib.sha256(raw).hexdigest()


def read_plan(data, digest, server, season=None, bands=None, limit=1000, now=None):
    import re
    if server not in GLOBAL_SERVERS or type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('invalid_arena_capture_scope')
    if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('invalid_arena_projection_digest')
    validate_arena_publication(data, data.get('sourceReleaseId'), 'global')
    if not data['capabilities'].get('conditions') or server not in data['serverScopes']:
        return None
    now = now or datetime.now(timezone.utc)
    candidates = [s for s in data['seasons'] if s['id'] == season] if season else [
        s for s in data['seasons'] if absolute(s['validFrom']) <= now < absolute(s['validUntil'])]
    if not candidates:
        return None
    if len(candidates) != 1 or not re.fullmatch(r'[1-9][0-9]{0,15}', candidates[0]['id']):
        raise ValueError('ambiguous_arena_season')
    if absolute(candidates[0]['validFrom']) > now:
        return None
    league_bands = [l['bandId'] for l in data['leagues'] if (
        absolute(l['opensAt']) <= now if l.get('opensAt') else l.get('openingSourceText') == '')]
    selected = list(bands) if bands else league_bands
    if (not 1 <= len(selected) <= 10 or len(set(selected)) != len(selected)
            or any(b not in league_bands or not re.fullmatch(r'[1-9][0-9]{0,15}', b) for b in selected)):
        raise ValueError('invalid_arena_band_selection')
    return dict(serverId=server, seasonId=candidates[0]['id'], bandIds=selected, limit=limit,
                contentReleaseId=data['sourceReleaseId'], projectionSha256=digest,
                masterVersion=arena_master_version(data,server))


def public_player_name(profile):
    """Normalize public display whitespace without relaxing identity validation."""
    raw = single(profile, 2, required=False)
    if raw is None:
        return ''
    if len(raw) > 400:
        raise LoginError('invalid_arena_player_name')
    try:
        name = raw.decode('utf-8')
    except UnicodeError:
        raise LoginError('invalid_arena_player_name') from None
    if len(name) > 100:
        raise LoginError('invalid_arena_player_name')
    return ' '.join(''.join(' ' if ord(c) < 32 or ord(c) == 127 else c for c in name).split())


def decode_response(raw, plan, band):
    maximum = single(raw, 2, wire=0, required=False) or 0
    entries = []
    for n, wire, value in fields(raw):
        if n != 1:
            continue
        if wire != 2 or len(entries) >= 1000:
            raise LoginError('invalid_arena_ranking_response')
        profile = single(value, 1)
        entries.append(dict(playerId=string(profile, 1), name=public_player_name(profile),
                            rank=single(value, 3, wire=0), point=single(value, 4, wire=0, required=False) or 0,
                            deck=high_score_deck(single(value, 2, required=False))))
    return dict(seasonId=plan['seasonId'], bandId=band, maxRank=maximum, entries=entries,
                coverage=dict(startRank=plan.get('rangeStart', 1), endRank=plan.get('rangeEnd', plan['limit'])))


class ArenaRankingClient(GameClient):
    read_methods = GameClient.read_methods | {RPC}

    def __init__(self, plan):
        super().__init__(server_id=plan['serverId'])
        self.plan = plan

    def _public_rpc(self,host,method):
        raw=super()._public_rpc(host,method)
        if method=='app.masterdata.MasterdataService/Version':self.arena_master=string(raw,1,optional=True)
        return raw

    def discover(self):
        host=super().discover()
        if self.plan.get('masterVersion') and getattr(self,'arena_master',None)!=self.plan['masterVersion']:
            raise LoginError('arena_master_version_mismatch')
        return host

    def export(self, identity, device_id, host, progress=lambda stage: None):
        auth = self.authenticate(identity, device_id, host, progress)
        observations = []
        try:
            progress('reading_rankings')
            for band in self.plan['bandIds']:
                rows, maximum = [], 0
                for start in range(1, self.plan['limit'] + 1, 100):
                    end = min(start + 99, self.plan['limit'])
                    payload = b''.join(integer(n, v) for n, v in enumerate([
                        int(self.plan['seasonId']), int(band), start, end], 1))
                    response = self.rpc(host, RPC, payload, auth)
                    page = decode_response(response, dict(self.plan, rangeStart=start, rangeEnd=end), band)
                    if any(not start <= r['rank'] <= end for r in page['entries']):
                        raise LoginError('arena_ranking_page_scope_mismatch')
                    rows.extend(page['entries']); maximum = max(maximum, page['maxRank'])
                    if page['maxRank'] <= end:
                        break
                observed = datetime.now(timezone.utc)
                record = dict(schemaVersion=1, serverId=self.server_id,
                    observedAt=observed.isoformat(), expiresAt=(observed + timedelta(seconds=900)).isoformat(),
                    source=dict(method=RPC, clientVersion=self.client_version,
                                contentReleaseId=self.plan['contentReleaseId'], projectionSha256=self.plan['projectionSha256']),
                    seasonId=self.plan['seasonId'], bandId=band, maxRank=maximum, entries=rows,
                    coverage=dict(startRank=1, endRank=self.plan['limit']))
                observations.append(validate_observation(record, self.server_id, self.plan['seasonId'], band))
        finally:
            auth.clear()
        return observations


def run_capture(plan, profile, account, password, root, *, game_factory=ArenaRankingClient,
                sdk_factory=SdkClient, publisher=publish_observations):
    game = game_factory(plan)
    host = game.discover()  # Public version negotiation precedes credential use.
    sdk = sdk_factory(replace(profile, version=game.client_version, language=game.server['language']))
    identity = sdk.login(account, password)
    try:
        observations = game.export(identity, sdk.device_id, host)
    finally:
        identity = None
    return publisher(observations, root, game.server_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', choices=tuple(GLOBAL_SERVERS), default='global-hmt')
    parser.add_argument('--content-base', default='https://ournotes.stonebg.cn')
    parser.add_argument('--projection', type=Path, help='explicit reviewed local Arena projection')
    parser.add_argument('--projection-sha256', help='required digest for a local projection')
    parser.add_argument('--season')
    parser.add_argument('--band', action='append', dest='bands')
    parser.add_argument('--population', action='store_true', help='bounded major-tier estimates only; no ranking snapshot capture')
    parser.add_argument('--limit', type=int, default=1000)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--lock-dir', required=True, type=Path, help='same directory as existing event capture')
    parser.add_argument('--sdk-resources', required=True, type=Path)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    if args.population and args.resume:parser.error('Population capture cannot bypass pause or cooldown')
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    status = args.state_dir / ('arena-' + args.server + '-status.json')
    with (args.lock_dir / 'capture.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Arena capture already running.'); return 0
        paused = status.exists() and json.loads(status.read_text()).get('paused') and not args.resume
        for previous in ('status.json', 'finalize-status.json', 'arena-live-status.json'):
            previous = args.state_dir / previous
            paused = paused or previous.exists() and json.loads(previous.read_text()).get('paused')
        if paused:
            print('Arena capture paused; operator action required.'); return 0
        population_attempt=args.state_dir/('arena-population-'+args.server+'-attempt.json')
        if args.population and population_attempt.exists():
            attempted=absolute(json.loads(population_attempt.read_text())['attemptedAt'])
            if (datetime.now(timezone.utc)-attempted).total_seconds()<21600:
                print('Arena population capture is cooling down.');return 0
        account = password = ''
        try:
            if args.projection:
                raw = args.projection.read_bytes()
                digest = hashlib.sha256(raw).hexdigest()
                if digest != args.projection_sha256:
                    raise ValueError('arena_projection_hash_mismatch')
                projection = (json.loads(raw), digest)
            else:
                projection = read_public_projection(args.content_base)
            plan = read_plan(*projection, args.server, args.season, args.bands, args.limit) if projection else None
            if plan is None:
                result = dict(status='waiting', paused=False, reason='arena_scope_not_published')
            else:
                if args.population:
                    from tools.arena_population import population_plan
                    plan=population_plan(projection[0],plan)
                    temporary=population_attempt.with_suffix('.tmp')
                    temporary.write_text(json.dumps(dict(attemptedAt=datetime.now(timezone.utc).isoformat())))
                    os.chmod(temporary,0o600);temporary.replace(population_attempt)
                credentials = os.environ.get('CREDENTIALS_DIRECTORY')
                if credentials:
                    account = (Path(credentials) / 'account').read_text().strip()
                    password = (Path(credentials) / 'password').read_text().rstrip('\r\n')
                else:
                    account, password = os.environ.get('OURNOTES_RANKING_ACCOUNT', ''), os.environ.get('OURNOTES_RANKING_PASSWORD', '')
                if not account or not password:
                    raise LoginError('ranking_credentials_required')
                if args.population:
                    from tools.arena_population import ArenaPopulationClient,publish_populations
                    paths=run_capture(plan,Profile.from_resources(args.sdk_resources),account,password,args.root,
                                      game_factory=ArenaPopulationClient,publisher=publish_populations)
                else:
                    paths = run_capture(plan, Profile.from_resources(args.sdk_resources), account, password, args.root)
                result = dict(status='complete', paused=False, boards=len(paths), seasonId=plan['seasonId'])
        except LoginError as exc:
            result = dict(status='failed', paused=pause_required(str(exc)) or str(exc) == 'ranking_credentials_required', error=str(exc))
        except Exception:
            result = dict(status='failed', paused=False, error='arena_capture_failed')
        finally:
            account = password = ''
        result.update(serverId=args.server)
        temp = status.with_suffix('.tmp')
        temp.write_text(json.dumps(result))
        os.chmod(temp, 0o600)
        temp.replace(status)
        print(json.dumps(result))
        return 2 if result['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
