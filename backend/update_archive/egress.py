"""Loopback CONNECT relay for a single configured archive S3 hostname.

The workbench keeps its existing egress deny rule. Only this credential-free
relay may contact the configured host; TLS and S3 authentication remain end to end.
Compatible with the host's system Python (3.6+).
"""
import argparse
import re
import select
import socket
import socketserver
import threading
import time


def destination(request, allowed_host):
    try:
        line = request.decode('ascii').split('\r\n', 1)[0]
        method, authority, protocol = line.split(' ')
    except (ValueError, UnicodeDecodeError):
        raise ValueError('invalid_connect')
    if (method != 'CONNECT' or protocol not in ('HTTP/1.0', 'HTTP/1.1')
            or authority != allowed_host + ':443'):
        raise ValueError('destination_not_allowed')
    return allowed_host, 443


class Relay(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def __init__(self, host, port):
        self.allowed_host = host
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(('127.0.0.1', port), Handler)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.slots.acquire(False):
            self.request.sendall(b'HTTP/1.1 503 Busy\r\nConnection: close\r\n\r\n')
            return
        upstream = None
        try:
            self.request.settimeout(10)
            header = bytearray()
            while b'\r\n\r\n' not in header:
                chunk = self.request.recv(1)
                if not chunk or len(header) >= 8192:
                    raise ValueError('invalid_header')
                header.extend(chunk)
            target = destination(header, self.server.allowed_host)
            upstream = socket.create_connection(target, timeout=10)
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            deadline = time.monotonic() + 295
            peers = (self.request, upstream)
            while time.monotonic() < deadline:
                ready, _, _ = select.select(peers, (), (), min(30, max(0, deadline-time.monotonic())))
                for source in ready:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.request else self.request).sendall(chunk)
        except ValueError:
            self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        except OSError:
            pass  # Do not log credentials, headers, payloads or remote errors.
        finally:
            if upstream:
                upstream.close()
            self.server.slots.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=18085)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{32}\.r2\.cloudflarestorage\.com', args.host) or not 1024 <= args.port <= 65535:
        parser.error('expected one R2 account endpoint and an unprivileged loopback port')
    with Relay(args.host, args.port) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
