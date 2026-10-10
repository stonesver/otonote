"""Same-origin, memory-only gateway for the website's account growth import.

Run behind the supplied HTTPS reverse proxy. Never expose the development
login UI or its shared snapshot/status endpoints as a multi-user service.
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from tools.growth_export import ExportError
from tools.growth_login import GameClient, LoginError, Profile, SdkClient
from tools.gacha_history import GachaHistoryClient

ROOT = '/api/growth-export/'
DIAGNOSTIC_STAGES = frozenset({
    'request', 'discovering', 'sdk_login', 'checking_existing_account',
    'game_login', 'reading_growth', 'reading_gacha_history',
})
DIAGNOSTIC_ERRORS = frozenset({
    'origin_refused', 'not_found', 'invalid_request', 'request_too_large',
    'busy', 'rate_limited', 'upstream_unavailable', 'invalid_sdk_profile',
    'unsupported_sdk_profile', 'invalid_auth_response',
    'sdk_parameter_override_refused', 'sdk_operation_refused',
    'sdk_response_too_large', 'sdk_network_or_tls_error',
    'invalid_sdk_response', 'invalid_account_input', 'invalid_password_input',
    'invalid_rsa_key', 'sdk_rsa_encryption_failed', 'invalid_game_text',
    'game_target_refused', 'game_authentication_failed',
    'unexpected_game_server', 'tw_server_not_unique',
    'no_existing_role_in_selected_server', 'unexpected_new_role_response',
    'response_too_large', 'truncated_varint', 'varint_overflow',
    'too_many_fields', 'invalid_field_number', 'truncated_field',
    'unsupported_wire_type', 'ambiguous_or_invalid_growth_field',
    'growth_integer_out_of_range', 'missing_public_master_id',
    'expected_one_uncompressed_grpc_frame', 'invalid_player_data',
    'expected_exactly_one_player_data', 'invalid_growth_message',
    'too_many_growth_records', 'duplicate_tgw_message',
    'duplicate_public_master_id', 'invalid_history_field',
    'missing_history_prize_id', 'invalid_history_collection',
    'too_many_history_records', 'unsupported_history_response',
    'missing_history_pool_id', 'invalid_history_prize', 'empty_history_batch',
})
DIAGNOSTIC_REASONS = frozenset({
    'credentials_rejected', 'account_not_found', 'verification_required', 'rate_limited',
})
MAX_LOGIN_STARTS_PER_MINUTE = 24
GRPC_ERROR_CODES = frozenset({
    'cancelled', 'unknown', 'invalid_argument', 'deadline_exceeded', 'not_found',
    'already_exists', 'permission_denied', 'resource_exhausted',
    'failed_precondition', 'aborted', 'out_of_range', 'unimplemented',
    'internal', 'unavailable', 'data_loss', 'unauthenticated',
})


def diagnostic_error(value):
    """Only emit codes produced by this gateway, never exception text."""
    if not isinstance(value, str):
        return 'other'
    if value in DIAGNOSTIC_ERRORS:
        return value
    if re.fullmatch(r'sdk_service_-?[0-9]{1,10}|sdk_http_[0-9]{3}', value):
        return value
    if value.startswith('game_rpc_') and value[9:] in GRPC_ERROR_CODES:
        return value
    if value.startswith('invalid_game_response_field_'):
        return 'invalid_game_response_field'
    return 'other'


def diagnostic_request_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) else secrets.token_hex(16)


class GrowthGateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, profile, origins, port=0, sdk_factory=SdkClient, game_factory=GameClient,
                 history_factory=GachaHistoryClient, diagnostic_sink=None):
        self.origins = set(origins)
        if not self.origins:
            raise ValueError('at_least_one_origin_required')
        self.hosts = set()
        for origin in self.origins:
            p = urlsplit(origin)
            if (p.scheme not in ('http', 'https') or not p.hostname or p.path or p.query
                    or p.fragment or p.username or p.password
                    or (p.scheme == 'http' and p.hostname not in ('127.0.0.1', 'localhost'))):
                raise ValueError('invalid_origin')
            self.hosts.add(p.netloc)
        self.profile, self.sdk_factory, self.game_factory = profile, sdk_factory, game_factory
        self.history_factory = history_factory
        self.nonce = secrets.token_urlsafe(32)
        self.capacity = threading.BoundedSemaphore(2)
        self.connections = threading.BoundedSemaphore(16)
        self.rate_lock, self.starts = threading.Lock(), deque()
        self.diagnostic_lock = threading.Lock()
        self.diagnostic_sink = diagnostic_sink or (lambda record: print(json.dumps(record, separators=(',', ':')), flush=True))
        super().__init__(('127.0.0.1', port), Handler)

    def diagnostic(self, request_id, route, event, stage, elapsed_ms, *, status=None, error=None,
                   reason=None, message=None, message_state=None):
        record = {'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds'),
                  'requestId': request_id, 'route': route, 'event': event,
                  'stage': stage if isinstance(stage, str) and stage in DIAGNOSTIC_STAGES else 'other',
                  'elapsedMs': elapsed_ms}
        if status is not None:
            record['status'] = status
        if error is not None:
            record['error'] = diagnostic_error(error)
            if record['error'].startswith('sdk_service_'):
                record['reason'] = (reason if isinstance(reason, str) and reason in DIAGNOSTIC_REASONS
                                    else 'unclassified')
                if message_state in ('original', 'redacted', 'omitted', 'missing'):
                    record['messageState'] = message_state
                    if (message_state in ('original', 'redacted') and isinstance(message, str)
                            and 0 < len(message) <= 200 and not any(ord(c) < 32 for c in message)):
                        record['message'] = message
        try:
            with self.diagnostic_lock:
                self.diagnostic_sink(record)
        except Exception:
            pass  # Logging must never change a login result.

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()

    def handle_error(self, request, client_address):
        pass  # No tracebacks or request objects in production logs.

    def admit(self):
        with self.rate_lock:
            now = time.monotonic()
            while self.starts and self.starts[0] < now - 60:
                self.starts.popleft()
            if len(self.starts) >= MAX_LOGIN_STARTS_PER_MINUTE:
                return False
            self.starts.append(now)
            return True

    def read_growth(self, account, password, *, history=False, progress_callback=None,
                    failure_callback=None):
        stage = 'discovering'
        def progress(value):
            nonlocal stage
            stage = value
            if progress_callback:
                progress_callback(value)
        try:
            progress(stage)
            game = (self.history_factory if history else self.game_factory)()
            host = game.discover()
            progress('sdk_login')
            sdk = self.sdk_factory(self.profile)
            identity = sdk.login(account, password)
            account = password = ''
            snapshot = game.export(identity, sdk.device_id, host, progress)
            return 200, {'snapshot': snapshot}
        except (LoginError, ExportError) as exc:
            if failure_callback:
                failure_callback(exc)
            return 422, {'error': str(exc), 'stage': stage, 'reason': getattr(exc, 'reason', None)}
        except Exception:
            return 502, {'error': 'upstream_unavailable', 'stage': stage}
        finally:
            account = password = ''


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        if hasattr(self, '_diagnostic'):
            self._diagnostic['status'] = status
            self._diagnostic['error'] = payload.get('error')
            self._diagnostic['reason'] = payload.get('reason')
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        if status == 429:
            self.send_header('Retry-After', '60')
        self.end_headers()
        self.wfile.write(data)

    def valid_source(self):
        return (self.headers.get('Host') in self.server.hosts
                and self.headers.get('Sec-Fetch-Site') not in ('cross-site', 'same-site'))

    def do_GET(self):
        if not self.valid_source():
            return self.reply(403, {'error': 'origin_refused'})
        if self.path.rstrip('/') != ROOT + 'capabilities':
            return self.reply(404, {'error': 'not_found'})
        return self.reply(200, {'enabled': True, 'region': 'TW/HK/MO', 'nonce': self.server.nonce,
                               'gachaHistory': True})

    def do_POST(self):
        path = self.path.rstrip('/')
        route = {ROOT + 'read': 'growth', ROOT + 'gacha-history': 'gacha_history'}.get(path)
        if route is None:
            return self.reply(404, {'error': 'not_found'})
        request_id = diagnostic_request_id(self.headers.get('X-Request-ID'))
        started = time.monotonic()
        self._diagnostic = {'stage': 'request', 'status': None, 'error': None, 'reason': None,
                            'message': None, 'message_state': None}
        def elapsed():
            return max(0, round((time.monotonic() - started) * 1000))
        def progress(stage):
            self._diagnostic['stage'] = stage
            self.server.diagnostic(request_id, route, 'stage', stage, elapsed())
        def failure(exc):
            self._diagnostic['message'] = getattr(exc, 'diagnostic_message', None)
            self._diagnostic['message_state'] = getattr(exc, 'message_state', None)
        self.server.diagnostic(request_id, route, 'start', 'request', 0)
        try:
            return self._post_with_diagnostics(path, progress, failure)
        finally:
            self.server.diagnostic(request_id, route, 'finish', self._diagnostic['stage'], elapsed(),
                                   status=self._diagnostic['status'], error=self._diagnostic['error'],
                                   reason=self._diagnostic['reason'], message=self._diagnostic['message'],
                                   message_state=self._diagnostic['message_state'])

    def _post_with_diagnostics(self, path, progress, failure):
        if (not self.valid_source() or self.headers.get('Origin') not in self.server.origins
                or self.headers.get('X-Growth-Nonce') != self.server.nonce):
            return self.reply(403, {'error': 'origin_refused'})
        if (self.headers.get('Content-Type') != 'application/json'
                or self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1):
            return self.reply(400, {'error': 'invalid_request'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                return self.reply(413, {'error': 'request_too_large'})
            body = json.loads(self.rfile.read(size))
            if (not isinstance(body, dict) or set(body) != {'account', 'password'}
                    or not isinstance(body['account'], str) or not 1 <= len(body['account'].strip()) <= 320
                    or not isinstance(body['password'], str) or not 1 <= len(body['password'].encode()) <= 4096):
                return self.reply(400, {'error': 'invalid_request'})
        except (ValueError, OSError):
            return self.reply(400, {'error': 'invalid_request'})
        if not self.server.capacity.acquire(blocking=False):
            return self.reply(429, {'error': 'busy'})
        try:
            if not self.server.admit():
                return self.reply(429, {'error': 'rate_limited'})
            account, password = body.pop('account'), body.pop('password')
            body.clear()
            status, result = self.server.read_growth(
                account, password, history=path == ROOT + 'gacha-history',
                progress_callback=progress, failure_callback=failure)
            account = password = ''
            self.reply(status, result)
        finally:
            account = password = ''
            body.clear()
            self.server.capacity.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-resources', type=Path, required=True)
    parser.add_argument('--origin', action='append', required=True)
    parser.add_argument('--port', type=int, default=18765)
    args = parser.parse_args()
    server = GrowthGateway(Profile.from_resources(args.sdk_resources), args.origin, args.port)
    print('Growth gateway listening on loopback port ' + str(server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
