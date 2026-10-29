"""Read-only Arena observations, isolated by server, season, band and snapshot."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from backend.player_rankings import SERVERS, public_high_score_deck

RPC = 'app.arena.ArenaService/ArenaRanking'
MAX_ENTRIES = 1000
ID = re.compile(r'[1-9][0-9]{0,15}')


class RankingCursorChanged(ValueError):
    """The caller must restart pagination for the selected observation."""


def scope(server, season, band):
    if server not in SERVERS or any(not isinstance(i, str) or not ID.fullmatch(i) for i in (season, band)):
        raise ValueError('invalid_arena_ranking_scope')


def absolute(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError('invalid_arena_ranking_time')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('invalid_arena_ranking_time')
    return dt


def number(value, minimum=0, maximum=(1 << 31) - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('invalid_arena_ranking_number')
    return value


def validate_observation(value, server, season, band):
    """Project only public ranking fields; never forward a raw profile or deck."""
    scope(server, season, band)
    if (not isinstance(value, dict) or value.get('schemaVersion') != 1
            or (value.get('serverId'), value.get('seasonId'), value.get('bandId')) != (server, season, band)):
        raise ValueError('arena_ranking_identity_mismatch')
    observed, expires = absolute(value.get('observedAt')), absolute(value.get('expiresAt'))
    if not 0 < (expires - observed).total_seconds() <= 3600:
        raise ValueError('invalid_arena_ranking_expiry')
    source = value.get('source')
    if (not isinstance(source, dict) or source.get('method') != RPC
            or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,4}', str(source.get('clientVersion', '')))
            or not isinstance(source.get('contentReleaseId'), str) or not source['contentReleaseId']
            or not re.fullmatch(r'[a-f0-9]{64}', str(source.get('projectionSha256', '')))):
        raise ValueError('invalid_arena_ranking_source')
    coverage = value.get('coverage')
    if not isinstance(coverage, dict):
        raise ValueError('invalid_arena_ranking_coverage')
    start, end = number(coverage.get('startRank'), 1), number(coverage.get('endRank'), 1)
    if not 0 <= end - start < MAX_ENTRIES:
        raise ValueError('invalid_arena_ranking_coverage')
    maximum = number(value.get('maxRank'))
    rows = value.get('entries')
    if not isinstance(rows, list) or len(rows) > MAX_ENTRIES:
        raise ValueError('invalid_arena_ranking_entries')
    entries, seen, previous = [], set(), 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid_arena_ranking_entry')
        player, name = row.get('playerId'), row.get('name')
        if (not isinstance(player, str) or not 1 <= len(player) <= 128 or player in seen
                or not isinstance(name, str) or len(name) > 100
                or any(ord(c) < 32 or ord(c) == 127 for c in player + name)):
            raise ValueError('invalid_arena_ranking_player')
        rank, point = number(row.get('rank'), 1), number(row.get('point'))
        if not start <= rank <= min(end, maximum) or rank < previous:
            raise ValueError('invalid_arena_ranking_order')
        # Preserve official ties and ranking gaps; never regenerate ranks.
        entries.append(dict(playerId=player, name=name, rank=rank, point=point,
                            deck=public_high_score_deck(row.get('deck'))))
        seen.add(player)
        previous = rank
    return dict(schemaVersion=1, serverId=server, seasonId=season, bandId=band,
                observedAt=value['observedAt'], expiresAt=value['expiresAt'],
                source={k: source[k] for k in ('method', 'clientVersion', 'contentReleaseId', 'projectionSha256')},
                coverage=dict(startRank=start, endRank=end), maxRank=maximum, entries=entries)


def observation_path(root, server, season, band):
    scope(server, season, band)
    return Path(root) / server / 'arena' / ('season-' + season) / ('band-' + band + '.json')


def query_arena_rankings(root, *, server, season, band, cursor=None, limit=10, now=None, rank=1):
    scope(server, season, band)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('invalid_arena_ranking_limit')
    number(rank,1)
    result = dict(schemaVersion=1, serverId=server, seasonId=season, bandId=band,
                  status='unavailable', entries=[], observedAt=None, expiresAt=None,
                  snapshotId=None, sourceReleaseId=None, coverage=None, maxRank=None, totalEntries=0, nextCursor=None)
    path = observation_path(root, server, season, band)
    if not path.exists():
        if cursor:
            raise RankingCursorChanged('arena_ranking_snapshot_changed')
        return result
    if path.stat().st_size > 8_000_000:
        raise OSError('arena_ranking_snapshot_invalid')
    raw = path.read_bytes()
    try:
        data = validate_observation(json.loads(raw), server, season, band)
    except (ValueError, TypeError, KeyError) as exc:
        raise OSError('arena_ranking_snapshot_invalid') from exc
    digest = hashlib.sha256(raw).hexdigest()
    if not data['coverage']['startRank']<=rank<=data['coverage']['endRank']:return result
    identity, offset = [server, season, band, digest, rank], 0
    if not cursor:offset=next((i for i,row in enumerate(data['entries']) if row['rank']>=rank),len(data['entries']))
    if cursor:
        try:
            if not isinstance(cursor, str) or len(cursor) > 1024:
                raise ValueError()
            decoded = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            offset = decoded['offset']
            if decoded['identity'] != identity or type(offset) is not int or not 0 < offset < len(data['entries']):
                raise ValueError()
        except (ValueError, KeyError, TypeError) as exc:
            raise RankingCursorChanged('arena_ranking_snapshot_changed') from exc
    rows = data['entries']
    result.update(observedAt=data['observedAt'], expiresAt=data['expiresAt'], snapshotId=digest,
                  sourceReleaseId=data['source']['contentReleaseId'],
                  coverage=data['coverage'], maxRank=data['maxRank'], totalEntries=sum(r['rank']>=rank for r in rows),
                  entries=rows[offset:offset + limit])
    current = now or datetime.now(timezone.utc)
    result['status'] = 'stale' if absolute(data['expiresAt']) <= current else 'available' if result['totalEntries'] else 'empty'
    if offset + limit < len(rows):
        result['nextCursor'] = base64.urlsafe_b64encode(json.dumps(dict(identity=identity, offset=offset + limit)).encode()).decode().rstrip('=')
    return result
