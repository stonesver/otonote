"""Run one producer with an operator-provisioned, Version-only Trojan egress.

The caller must provision and verify the pinned mihomo binary before invoking
this module. This module never downloads software, subscriptions or providers.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata

NODE_ENV = 'OURNOTES_JP_PROXY_NODE'
PROXY_ENV = 'OURNOTES_JP_VERSION_PROXY'
PROXY_URL = 'http://127.0.0.1:17897'
NODE_NAME = 'jp-version-node'


class EgressError(Exception):
    """Public errors contain no untrusted configuration or process output."""


class _Interrupted(BaseException):
    def __init__(self, signum):
        self.signum = signum


def _text(value, limit=4096):
    if (not isinstance(value, str) or not value or len(value) > limit
            or any(unicodedata.category(c).startswith('C') for c in value)):
        raise EgressError('invalid JP proxy node configuration')
    return value


def _host(value):
    value = _text(value, 253)
    try:
        ipaddress.ip_address(value)
    except ValueError:
        if not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', p)
                   for p in value.split('.')):
            raise EgressError('invalid JP proxy node configuration') from None
    return value


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise EgressError('invalid JP proxy node configuration')
        obj[key] = value
    return obj


def node_config(raw):
    """Accept a single strict Trojan node, never a complete client config."""
    try:
        if not isinstance(raw, str) or len(raw) > 16384:
            raise ValueError()
        node = json.loads(raw, object_pairs_hook=_unique_object)
        allowed = {'name', 'type', 'server', 'port', 'password', 'sni', 'udp',
                   'network', 'grpc-opts', 'skip-cert-verify'}
        if not isinstance(node, dict) or set(node) - allowed:
            raise ValueError()
        if node.get('type') != 'trojan':
            raise ValueError()
        if type(node.get('port')) is not int or not 1 <= node['port'] <= 65535:
            raise ValueError()
        if 'skip-cert-verify' in node and node['skip-cert-verify'] is not False:
            raise ValueError()
        if 'udp' in node and type(node['udp']) is not bool:
            raise ValueError()
        if 'name' in node:
            _text(node['name'], 256)
        result = {'name': NODE_NAME, 'type': 'trojan', 'server': _host(node['server']),
                  'port': node['port'], 'password': _text(node['password']),
                  'skip-cert-verify': False, 'udp': False}
        if 'sni' in node:
            result['sni'] = _host(node['sni'])
        network = node.get('network', 'tcp')
        if network not in ('tcp', 'grpc'):
            raise ValueError()
        result['network'] = network
        if network == 'grpc':
            opts = node.get('grpc-opts')
            if not isinstance(opts, dict) or set(opts) != {'grpc-service-name'}:
                raise ValueError()
            service = _text(opts['grpc-service-name'], 512)
            if not re.fullmatch(r'[A-Za-z0-9_.~-]+', service):
                raise ValueError()
            result['grpc-opts'] = {'grpc-service-name': service}
        elif 'grpc-opts' in node:
            raise ValueError()
        return result
    except (ValueError, KeyError, TypeError, RecursionError, EgressError):
        raise EgressError('invalid JP proxy node configuration') from None


def configuration(node):
    return {'mixed-port': 17897, 'bind-address': '127.0.0.1', 'allow-lan': False,
            'mode': 'rule', 'log-level': 'silent', 'ipv6': False,
            'geo-auto-update': False, 'find-process-mode': 'off',
            'profile': {'store-selected': False, 'store-fake-ip': False},
            'dns': {'enable': False}, 'tun': {'enable': False},
            'proxies': [node],
            'rules': ['DOMAIN,api.bang-dream-on.jp,' + NODE_NAME, 'MATCH,REJECT']}


def _private_file(path, content=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    stream = os.fdopen(fd, 'w')
    if content is not None:
        with stream:
            stream.write(content)
        return None
    return stream


def _require_free_port():
    try:
        with socket.socket() as check:
            check.bind(('127.0.0.1', 17897))
    except OSError:
        raise EgressError('JP proxy listener is unavailable') from None


def _wait_ready(process, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise EgressError('JP proxy process exited before readiness')
        try:
            with socket.create_connection(('127.0.0.1', 17897), timeout=.2):
                # Local listener readiness only; this does not validate upstream.
                if process.poll() is None:
                    return
        except OSError:
            pass
        time.sleep(.05)
    raise EgressError('JP proxy readiness timed out')


def _stop(process):
    if process is None:
        return
    # Dedicated sessions allow cleanup of child processes as well as the leader.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def _exit_code(value):
    return value if value >= 0 else 128 - value


def run(command, binary=None):
    if not command:
        raise EgressError('a producer command is required')
    environment = dict(os.environ)
    raw = environment.pop(NODE_ENV, '')
    node = None
    if raw:
        if environment.get(PROXY_ENV):
            raise EgressError('choose either a JP proxy node or a JP proxy URL')
        node = node_config(raw)
        binary = Path(binary or '')
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            raise EgressError('a verified executable mihomo binary is required')
    daemon = producer = None
    previous = {}

    def interrupted(signum, _frame):
        raise _Interrupted(signum)

    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupted)
        with tempfile.TemporaryDirectory(prefix='otonote-jp-egress-') as temporary:
            directory = Path(temporary)
            os.chmod(directory, 0o700)
            try:
                if node is not None:
                    _require_free_port()
                    path = directory / 'config.json'
                    _private_file(path, json.dumps(configuration(node)))
                    with _private_file(directory / 'client.log') as log:
                        daemon = subprocess.Popen(
                            [str(binary), '-d', str(directory), '-f', str(path)],
                            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                            env={'PATH': os.defpath, 'HOME': str(directory), 'TMPDIR': str(directory)},
                            start_new_session=True)
                    _wait_ready(daemon)
                    environment[PROXY_ENV] = PROXY_URL
                producer = subprocess.Popen(command, env=environment, start_new_session=True)
                while producer.poll() is None:
                    if daemon is not None and daemon.poll() is not None:
                        raise EgressError('JP proxy exited while the producer was running')
                    time.sleep(.1)
                return _exit_code(producer.returncode)
            finally:
                # A second interrupt cannot skip private-file/process cleanup.
                for signum in previous:
                    signal.signal(signum, signal.SIG_IGN)
                try:
                    _stop(producer)
                finally:
                    _stop(daemon)
    except _Interrupted as exc:
        return 128 + exc.signum
    except (OSError, subprocess.SubprocessError):
        raise EgressError('JP egress process operation failed') from None
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', help='absolute path to a verified, pinned mihomo executable')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    try:
        return run(command, args.binary)
    except EgressError as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
