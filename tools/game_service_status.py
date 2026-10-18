"""Shared, credential-free observations of Global game maintenance.

Only the public Masterdata Version RPC is permitted. Successful discovery is
not evidence that account login works; snapshots never contain player data.
"""
from __future__ import annotations

import copy
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from tools.global_game_config import DISCOVERY_VERSION, GLOBAL_SERVERS, recommended_version

SERVERS = {sid: server['hosts'][-1] for sid, server in GLOBAL_SERVERS.items()}
METHOD = '/app.masterdata.MasterdataService/Version'
TTL_SECONDS = 60



def iso_time(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError):
        return None


def maintenance_metadata(metadata, message):
    """Accept the exact total-maintenance signal verified on all three servers."""
    values = {}
    for key, value in metadata or ():
        key = key.lower()
        if key in values:
            return None
        values[key] = value
    if message != 'under maintenance' or values.get('x-maintenance-total') != '1':
        return None
    return {'total': True,
            'startAt': iso_time(values.get('x-maintenance-start-at')),
            'expectedEndAt': iso_time(values.get('x-maintenance-end-at')),
            'emergency': values.get('x-maintenance-is-emergency') == '1'}


def probe(server_id, version):
    """At most two bounded public calls, including a recommended-version retry."""
    import grpc
    host = SERVERS[server_id]
    for attempt in range(2):
        try:
            with grpc.secure_channel(host + ':443', grpc.ssl_channel_credentials(), options=(
                    ('grpc.enable_retries', 0), ('grpc.max_receive_message_length', 65536))) as channel:
                call = channel.unary_unary(METHOD, request_serializer=lambda b: b,
                                          response_deserializer=lambda b: b)
                call(b'', metadata=(('x-client-version', version), ('x-platform', 'android')),
                     timeout=2.5, wait_for_ready=False)
            return {'status': 'no_maintenance_signal', 'source': 'official_game_response'}
        except grpc.RpcError as exc:
            metadata = tuple(exc.trailing_metadata() or ())
            maintenance = maintenance_metadata(metadata, exc.details())
            if maintenance is not None:
                return {'status': 'maintenance', 'source': 'official_game_response',
                        'maintenance': maintenance}
            if attempt == 0 and exc.details() == 'client update required':
                candidate = recommended_version(metadata)
                if candidate and candidate != version:
                    version = candidate
                    continue
            return {'status': 'unknown', 'source': 'public_probe_unavailable'}
    return {'status': 'unknown', 'source': 'public_probe_unavailable'}


class GameServiceStatus:
    """One bounded refresh per minute per process, shared by every visitor."""
    def __init__(self, probe_fn=probe, *, version=None, monotonic=time.monotonic,
                 wall_time=time.time):
        if version is None:
            version = DISCOVERY_VERSION
        self.probe = probe_fn
        self.version = version
        self.monotonic, self.wall_time = monotonic, wall_time
        self.lock = threading.Lock()
        self.cached = None
        self.deadline = 0

    def snapshot(self):
        with self.lock:
            if self.cached is not None and self.monotonic() < self.deadline:
                return copy.deepcopy(self.cached)
            def observe(server_id):
                try:
                    return self.probe(server_id, self.version)
                except Exception:
                    return {'status': 'unknown', 'source': 'public_probe_unavailable'}
            with ThreadPoolExecutor(max_workers=3) as executor:
                rows = dict(zip(SERVERS, executor.map(observe, SERVERS)))
            now = self.wall_time()
            self.cached = {'schemaVersion': 1,
                           'checkedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(),
                           'validUntil': datetime.fromtimestamp(now + TTL_SECONDS, timezone.utc).isoformat(),
                           'servers': rows}
            self.deadline = self.monotonic() + TTL_SECONDS
            return copy.deepcopy(self.cached)

    def server(self, server_id):
        return self.snapshot()['servers'].get(server_id, {'status': 'unknown'})
