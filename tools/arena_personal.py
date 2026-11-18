"""One authenticated, read-only ArenaMyRank call for the requesting account.

Global 1.1.0: request field 1 season; response 1 master points/rank,
2 repeated league points (1 band, 2 points, 3 rank). No player-id selector,
ArenaTop, inventory, leaderboard traversal or account writes are used.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from tools.growth_export import fields, MAX_SAFE_INTEGER
from tools.growth_login import GameClient, LoginError, integer, single, string
from tools.global_game_config import export_source

MY_RANK_METHOD = 'app.arena.ArenaService/ArenaMyRank'
VERSION_METHOD = 'app.masterdata.MasterdataService/Version'


def arena_scope(season, band):
    if any(not isinstance(v, str) or not re.fullmatch(r'[1-9][0-9]{0,15}', v)
           or int(v) > MAX_SAFE_INTEGER for v in (season, band)):
        raise LoginError('invalid_arena_personal_scope')


def extract_my_rank(raw, season, band, *, server_id, client_version, master_version=None, observed_master_version=None):
    arena_scope(season, band)
    rows, seen = [], set()
    for n, wire, value in fields(raw):
        if n not in (1, 2):
            continue
        if wire != 2:
            raise LoginError('invalid_arena_personal_response')
        if n == 1:
            if 'mp' in seen:
                raise LoginError('invalid_arena_personal_response')
            seen.add('mp')
            continue  # Master points are unrelated to the selected league rank.
        if len(rows) >= 10:
            raise LoginError('invalid_arena_personal_response')
        band_id = single(value, 1, wire=0)
        point = single(value, 2, wire=0, required=False) or 0
        rank = single(value, 3, wire=0, required=False) or 0
        if (band_id in seen or not 1 <= band_id <= MAX_SAFE_INTEGER
                or not 0 <= point <= MAX_SAFE_INTEGER or not 0 <= rank <= 2147483647):
            raise LoginError('invalid_arena_personal_response')
        seen.add(band_id)
        rows.append(dict(bandId=str(band_id), point=point, rank=rank or None))
    selected = next((row for row in rows if row['bandId'] == band), None)
    return dict(format='otonote-arena-personal', schemaVersion=1,
                source={**export_source(server_id, client_version), 'masterVersion': master_version,
                        'observedMasterVersion': observed_master_version},
                seasonId=season, bandId=band, queriedAt=datetime.now(timezone.utc).isoformat(),
                status='ranked' if selected and selected['rank'] else 'unranked' if selected else 'unavailable',
                rank=selected['rank'] if selected else None, point=selected['point'] if selected else None)


class ArenaPersonalClient(GameClient):
    read_methods = GameClient.read_methods | {MY_RANK_METHOD}

    def __init__(self, server_id='global-hmt'):
        super().__init__(server_id)
        self.master_version = None
        self.rank_master_version = None

    def discover(self):
        host = super().discover()
        # Resolve only already-public rules, before touching account credentials.
        # A failed rules check must not hide the game's own rank/point response.
        from tools.arena_public import read_public_projection, arena_master_version
        from tools.ranking_regions import verify_arena_rank_tables
        self.rank_master_version = None
        if self.master_version:
            try:
                projection = read_public_projection('https://ournotes.stonebg.cn')
                approved = arena_master_version(projection[0], self.server_id) if projection else None
                if approved:
                    if approved != self.master_version:
                        verify_arena_rank_tables(self, approved, self.master_version)
                    self.rank_master_version = approved
            except (LoginError, ValueError, OSError):
                pass  # No compatibility binding; UI keeps its exact-version gate.
        return host

    def _public_rpc(self, host, method):
        raw = super()._public_rpc(host, method)
        if method == VERSION_METHOD:
            version = string(raw, 1, optional=True)
            self.master_version = version if re.fullmatch(r'[a-f0-9]{32}', version) else None
        return raw

    def export_rank(self, identity, device_id, host, season, band, progress=lambda s: None):
        arena_scope(season, band)
        auth = self.authenticate(identity, device_id, host, progress)
        try:
            progress('reading_arena_rank')
            return extract_my_rank(self.rpc(host, MY_RANK_METHOD, integer(1, int(season)), auth),
                                   season, band, server_id=self.server_id,
                                   client_version=self.client_version,
                                   master_version=self.rank_master_version or self.master_version,
                                   observed_master_version=self.master_version)
        finally:
            auth.clear()
