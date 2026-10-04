"""Bounded, stateless gacha history read. See docs/GACHA_HISTORY.md for wire evidence."""
from __future__ import annotations

from datetime import datetime, timezone

from tools.growth_export import ExportError, MAX_SAFE_INTEGER, fields
from tools.growth_login import CLIENT_VERSION, GameClient

HISTORY_METHOD = 'app.gacha.GachaService/History'
MAX_BATCHES = 2000
MAX_PRIZES = 10000
MAX_TIMESTAMP = 253402271999  # Last whole second in ISO year 9999 when shown in UTC+8.


def scalars(data, spec):
    result = {name: 0 for name, _ in spec.values()}
    seen = set()
    for number, wire, value in fields(data):
        if number not in spec:
            continue
        name, maximum = spec[number]
        if number in seen or wire != 0 or value > maximum:
            raise ExportError('invalid_history_field')
        seen.add(number)
        result[name] = value
    return result


def prize(data, *, legacy=False):
    spec = {1: ('prizeId', MAX_SAFE_INTEGER), 3 if legacy else 2: ('converted', 1)}
    if legacy:
        spec[2] = ('executedAt', MAX_TIMESTAMP)
    row = scalars(data, spec)
    if not row['prizeId']:
        raise ExportError('missing_history_prize_id')
    row['converted'] = bool(row['converted'])
    return row


def extract_history(data):
    executions, legacy = [], []
    for number, wire, value in fields(data):
        if number not in (1, 2):
            continue
        if wire != 2:
            raise ExportError('invalid_history_collection')
        target = legacy if number == 1 else executions
        target.append(value)
        if len(target) > (MAX_PRIZES if number == 1 else MAX_BATCHES):
            raise ExportError('too_many_history_records')
    if data and not executions and not legacy:
        raise ExportError('unsupported_history_response')
    batches, count = [], 0
    for raw in executions:
        row = scalars(raw, {1: ('poolId', MAX_SAFE_INTEGER),
                            2: ('productId', MAX_SAFE_INTEGER),
                            6: ('executedAt', MAX_TIMESTAMP)})
        if not row['poolId']:
            raise ExportError('missing_history_pool_id')
        row['productId'] = row['productId'] or None
        row['executedAt'] = row['executedAt'] or None
        row['prizes'] = []
        for number, wire, value in fields(raw):
            if number != 7:
                continue
            if wire != 2:
                raise ExportError('invalid_history_prize')
            count += 1
            if count > MAX_PRIZES:
                raise ExportError('too_many_history_records')
            row['prizes'].append(prize(value))
        if not row['prizes']:
            raise ExportError('empty_history_batch')
        batches.append(row)
    # These are two representations, never concatenate or content-deduplicate.
    if not executions:
        for raw in legacy:
            item = prize(raw, legacy=True)
            batches.append({'poolId': None, 'productId': None,
                            'executedAt': item.pop('executedAt') or None, 'prizes': [item]})
    return {
        'format': 'otonote-gacha-history', 'schemaVersion': 1,
        'queriedAt': datetime.now(timezone.utc).isoformat(),
        'source': {'kind': 'direct_game_read', 'region': 'global',
                   'serverId': 'global-hmt', 'clientVersion': CLIENT_VERSION},
        'coverage': {'scope': 'server_returned', 'retentionDays': None,
                     'historyKind': 'execution' if executions else 'legacy' if legacy else 'empty',
                     'legacyOmittedCount': len(legacy) if executions else 0},
        'batches': batches,
    }


class GachaHistoryClient(GameClient):
    # The growth client itself keeps its original, smaller read allowlist.
    read_methods = GameClient.read_methods | {HISTORY_METHOD}

    def export(self, identity, device_id, host, progress=lambda s: None):
        auth = self.authenticate(identity, device_id, host, progress)
        progress('reading_gacha_history')
        return extract_history(self.rpc(host, HISTORY_METHOD, b'', auth))
