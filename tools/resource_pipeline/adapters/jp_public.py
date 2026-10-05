"""Bounded JP client transport; callers must supply explicitly authorized credentials.

Only resource-version RPCs and the official static host are allowed. CDN password
refreshes stay in memory; credentials are never logged. Player data and refusal
retries are outside this transport.
"""
from __future__ import annotations

import base64
import gzip
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
import urllib.request
from urllib.parse import unquote, urlsplit
import uuid

from .global_public import ProtocolError, VERSION, allowed_url, decode_grpc, protobuf_fields, string_field, utc_now
from ..transport import HttpRequest, HttpTransport, TransportError

API_ROOT = 'https://api.bang-dream-on.jp'
CDN_ROOT = 'https://static.bang-dream-on.jp'
READ_METHODS = frozenset({
    'app.masterdata.MasterdataService/Version',
})
RESOURCE_VERSION = re.compile(r'([0-9]+(?:\.[0-9]+){1,4})/([0-9a-f]{32})')
VERSION_PROXY_ENV = 'OURNOTES_JP_VERSION_PROXY'


def version_proxy():
    """Read an operator-configured RPC egress without exposing its credentials."""
    value = os.environ.get(VERSION_PROXY_ENV, '')
    if not value:
        return None
    try:
        if (len(value) > 8192 or any(char.isspace() or unicodedata.category(char).startswith('C') for char in value)
                or '\\' in value or '?' in value or '#' in value
                or re.search(r'%(?![0-9a-fA-F]{2})', value)):
            raise ValueError
        decoded = unquote(value, errors='strict')
        if any(unicodedata.category(char).startswith('C') for char in decoded):
            raise ValueError
        parsed = urlsplit(value)
        if (parsed.scheme not in ('http', 'https', 'socks5', 'socks5h')
                or not parsed.hostname or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or parsed.netloc.count('@') > 1
                or ('@' in parsed.netloc and not parsed.username)):
            raise ValueError
        authority = parsed.netloc.rsplit('@', 1)[-1]
        if authority.endswith(':') or (parsed.port is not None and not 1 <= parsed.port <= 65535):
            raise ValueError
        host = parsed.hostname
        if ':' in host:
            ipaddress.IPv6Address(host)
            if not re.fullmatch(r'\[[0-9A-Fa-f:.]+\](?::[0-9]+)?', authority):
                raise ValueError
        elif (len(host) > 253 or not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                                       for label in host.rstrip('.').split('.'))):
            raise ValueError
    except (ValueError, UnicodeError):
        raise ProtocolError('invalid JP version proxy configuration') from None
    return value


def resource_version(header, client_version):
    """Apply the signed 1.0.4 AssetVersion.Parse/SelectLive contract.

    Native Parse is at 0x6491dec and SelectLive at 0x649203c in the verified APK.
    A live entry is selected by its minimum client version, not by the largest
    resource version. The legacy JSON shape has version/Android at the root.
    ``history`` is never a fallback for a client with no applicable live entry.
    """
    def client_key(value):
        if not isinstance(value, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', value):
            raise ProtocolError('invalid JP minimum client version')
        parts = tuple(int(part) for part in value.split('.'))
        if any(part > 2147483647 for part in parts):
            raise ProtocolError('invalid JP minimum client version')
        return parts + (0,) * (4 - len(parts))

    if not isinstance(header, str) or len(header) > 65536:
        raise ProtocolError('invalid JP asset-version header')
    try:
        payload = json.loads(header)
    except (ValueError, TypeError):
        raise ProtocolError('JP asset-version header must be JSON') from None
    if not isinstance(payload, dict):
        raise ProtocolError('invalid JP asset-version payload')
    live = payload.get('live')
    if live is not None and not isinstance(live, list):
        raise ProtocolError('invalid JP live version entries')
    selected = payload
    if live:
        current = client_key(client_version)
        selected, selected_key = None, None
        for entry in live:
            if not isinstance(entry, dict):
                raise ProtocolError('invalid JP live version entry')
            minimum = client_key(entry.get('minClientVersion'))
            if minimum > current:
                continue
            if selected_key is None or minimum > selected_key:
                selected, selected_key = entry, minimum
            elif minimum == selected_key and any(entry.get(key) != selected.get(key) for key in ('version', 'Android')):
                raise ProtocolError('ambiguous JP live version entries')
        if selected is None:
            raise ProtocolError('no JP live version supports the verified client; a new intake is required')
    release, digest = selected.get('version'), selected.get('Android')
    if not isinstance(release, str) or not isinstance(digest, str):
        raise ProtocolError('JP asset version is missing its Android identity')
    result = release + '/' + digest
    version_parts(result)
    return result


def version_parts(value):
    match = RESOURCE_VERSION.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ProtocolError('invalid JP resource version')
    return match.groups()


def asset_directory(version):
    release, digest = version_parts(version)
    return f'{CDN_ROOT}/asset/{release}/Android/{digest}'


def asset_url(version, internal_id):
    prefix = '{Fwk.Resource.RemoteAssetDir}/'
    if not isinstance(internal_id, str) or not internal_id.startswith(prefix):
        raise ProtocolError('unexpected JP catalog resource path')
    path = internal_id[len(prefix):]
    if (not re.fullmatch(r'[A-Za-z0-9_./()\-]+', path)
            or any(part in ('', '.', '..') for part in path.split('/'))):
        raise ProtocolError('unexpected JP catalog resource path')
    return asset_directory(version) + '/' + path


def decode_catalog(body, limit=64_000_000):
    # The CDN serves gzip bytes; the installed client caches the decoded catalog.
    if body.startswith(b'\x1f\x8b'):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
                body = stream.read(limit + 1)
        except (OSError, EOFError):
            raise ProtocolError('invalid JP compressed catalog') from None
    if len(body) > limit:
        raise ProtocolError('JP decoded catalog exceeds size limit')
    return body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JpPublicClient:
    def __init__(self, client_version, authorization):
        if not VERSION.fullmatch(client_version):
            raise ProtocolError('invalid JP client version')
        if not isinstance(authorization, str) or not re.fullmatch(r'Basic [A-Za-z0-9+/]+={0,2}', authorization):
            raise ProtocolError('explicit JP client authorization is required')
        try:
            decoded = base64.b64decode(authorization[6:], validate=True)
        except ValueError:
            raise ProtocolError('invalid JP client authorization') from None
        if b':' not in decoded or any(x in decoded for x in (b'\r', b'\n', b'\x00')):
            raise ProtocolError('invalid JP client authorization')
        self.client_version = client_version
        self._authorization = authorization

    def rpc(self, method):
        if method not in READ_METHODS:
            raise ProtocolError('unsupported JP read-only RPC')
        proxy = version_proxy()
        with tempfile.TemporaryDirectory(prefix='ournotes-jp-rpc-') as temporary:
            directory = Path(temporary)
            headers, body, request = (directory/name for name in ('headers', 'body', 'request'))
            request.write_bytes(bytes(5))
            # curl receives the secret through stdin, never process arguments.
            configuration = 'header = ' + json.dumps('Authorization: ' + self._authorization) + '\n'
            options = {}
            if proxy is not None:
                configuration += 'proxy = ' + json.dumps(proxy, ensure_ascii=False) + '\nnoproxy = ""\n'
                options['env'] = {key: value for key, value in os.environ.items() if key != VERSION_PROXY_ENV}
            command = ['curl', '--disable', '--config', '-', '--http2', '--proto', '=https',
                       '--max-time', '30', '--max-filesize', '1048576', '--silent', '--show-error',
                       '--dump-header', str(headers), '--output', str(body),
                       '-H', 'Content-Type: application/grpc', '-H', 'TE: trailers',
                       '-H', 'x-client-version: ' + self.client_version, '-H', 'x-platform: android',
                       '-H', 'x-request-id: ' + uuid.uuid4().hex,
                       '--user-agent', 'OurNotes/' + self.client_version,
                       '--data-binary', '@' + str(request), API_ROOT + '/' + method]
            try:
                completed = subprocess.run(command, input=configuration.encode(), capture_output=True, timeout=35, **options)
            except (OSError, subprocess.TimeoutExpired):
                raise TransportError('JP read-only RPC transport failed') from None
            if completed.returncode:
                raise TransportError('JP read-only RPC transport failed (' + str(completed.returncode) + ')')
            raw_headers = headers.read_text()
            safe_headers, payload = decode_grpc(raw_headers, body.read_bytes())
            # The service can refresh the short-lived CDN password. Keep it in
            # memory and out of the returned observation and error messages.
            private_headers = {m[1].lower(): m[2].strip() for m in re.finditer(
                r'^([\w-]+):\s*([^\r\n]*)', raw_headers, re.M)
                if m[1].lower() in ('x-sirius-env', 'x-sirius-cred')}
            self._refresh_cdn_authorization(private_headers)
            return safe_headers, payload

    def _refresh_cdn_authorization(self, headers):
        root, password = headers.get('x-sirius-env'), headers.get('x-sirius-cred')
        if root is not None and root != CDN_ROOT:
            raise ProtocolError('JP service returned an untrusted CDN root')
        if password is None:
            return
        if (root != CDN_ROOT or not password or len(password) > 2048
                or any(ord(char) < 32 or ord(char) > 126 for char in password)):
            raise ProtocolError('invalid JP service CDN credential binding')
        username = base64.b64decode(self._authorization[6:]).split(b':', 1)[0]
        credential = base64.b64encode(username + b':' + password.encode('ascii')).decode('ascii')
        self._authorization = 'Basic ' + credential

    def _transport(self, url, limit):
        allowed_url(url, ('static.bang-dream-on.jp',))
        # Never redirect authenticated requests, including HTTPS-to-HTTP on this host.
        opener = urllib.request.build_opener(_NoRedirect())
        return HttpTransport(allowed_hosts=('static.bang-dream-on.jp',),
                             connect_timeout_seconds=30, read_timeout_seconds=30,
                             max_response_bytes=limit,
                             sender=lambda request, timeout: opener.open(request, timeout=timeout))

    def _headers(self):
        return {'Authorization': self._authorization, 'User-Agent': 'OurNotes/' + self.client_version}

    def get(self, url, limit, *, method='GET'):
        if method not in {'GET', 'HEAD'}:
            raise ProtocolError('unsupported JP resource method')
        response = self._transport(url, limit).request(HttpRequest(method, url, self._headers()))
        if response.status != 200:
            raise ProtocolError('JP resource HTTP ' + str(response.status))
        return response

    def download(self, url, stream, limit):
        response = self._transport(url, limit).download(HttpRequest('GET', url, self._headers()), stream)
        if response.status != 200:
            raise ProtocolError('JP resource HTTP ' + str(response.status))
        return response

    def discover(self):
        # JP VersionResponse has only field 1; resource version arrives in a header.
        # Live access is still gated by the official API; do not fall back to a cached
        # version and label it current when this request is refused.
        headers, payload = self.rpc('app.masterdata.MasterdataService/Version')
        master = string_field(protobuf_fields(payload), 1)
        resource = resource_version(headers.get('x-asset-version'), self.client_version)
        version_parts(master)
        _, digest = version_parts(resource)
        recommended = headers.get('x-client-recommended-version')
        if recommended and recommended != self.client_version:
            raise ProtocolError('JP client version changed; a verified client intake is required')
        return {'schemaVersion': 1, 'environmentId': 'jp-production', 'region': 'jp',
                'observedAt': utc_now(), 'clientVersion': self.client_version,
                'masterVersion': master, 'resourceVersion': resource, 'catalogHash': digest,
                'apiRoot': API_ROOT, 'cdnRoot': CDN_ROOT,
                'catalogUrl': asset_directory(resource) + '/catalog_main.bin',
                'masterManifestUrl': CDN_ROOT + '/master/' + master + '/MasterManifest.json',
                'responseHeaders': headers, 'authentication': 'authorized_client_builtin'}
