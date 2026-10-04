"""Same-origin, memory-only gateway for the website's account growth import.

Run behind the supplied HTTPS reverse proxy. Never expose the development
login UI or its shared snapshot/status endpoints as a multi-user service.
"""
from __future__ import annotations

import argparse
import json
import secrets
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from tools.growth_export import ExportError
from tools.growth_login import GameClient, LoginError, Profile, SdkClient
from tools.gacha_history import GachaHistoryClient

ROOT = '/api/growth-export/'


class GrowthGateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, profile, origins, port=0, sdk_factory=SdkClient, game_factory=GameClient,
                 history_factory=GachaHistoryClient):
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
        super().__init__(('127.0.0.1', port), Handler)

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
            if len(self.starts) >= 12:
                return False
            self.starts.append(now)
            return True

    def read_growth(self, account, password, *, history=False):
        stage = 'discovering'
        def progress(value):
            nonlocal stage
            stage = value
        try:
            game = (self.history_factory if history else self.game_factory)()
            host = game.discover()
            stage = 'sdk_login'
            sdk = self.sdk_factory(self.profile)
            identity = sdk.login(account, password)
            account = password = ''
            snapshot = game.export(identity, sdk.device_id, host, progress)
            return 200, {'snapshot': snapshot}
        except (LoginError, ExportError) as exc:
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
        if (not self.valid_source() or self.headers.get('Origin') not in self.server.origins
                or self.headers.get('X-Growth-Nonce') != self.server.nonce):
            return self.reply(403, {'error': 'origin_refused'})
        if self.path.rstrip('/') not in (ROOT + 'read', ROOT + 'gacha-history'):
            return self.reply(404, {'error': 'not_found'})
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
                account, password, history=self.path.rstrip('/') == ROOT + 'gacha-history')
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
