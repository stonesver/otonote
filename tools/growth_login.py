"""Local-only SDK login and narrowly allowlisted game reads. No ADB dependency."""
from __future__ import annotations

import base64
import hashlib
import json
import platform
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from tools.growth_export import ExportError, MAX_BYTES, extract_growth, fields

SDK_ROOT = 'https://l11-sdk-login-intl.biligame.net'
# GetServerList rejected 1.0.2 and accepted 1.0.3 on 2026-10-09.
# Keep SDK, game requests and snapshot provenance on the same version.
CLIENT_VERSION = '1.0.3'
GAME_HOSTS = {'l14-prod-hk-all-gs-sirius.gamerfusiontech.com',
              'l12-prod-hk-all-gs-sirius.gamerfusiontech.com'}
BOOTSTRAP = 'l14-prod-hk-all-gs-sirius.gamerfusiontech.com'
LOGIN_SERVICE = 'app.playerlogin.PlayerLoginService/'
READ_METHODS = {LOGIN_SERVICE + n for n in ('GetServerList', 'PlayerPreLogin', 'PlayerLogin')}
READ_METHODS |= {'app.player.PlayerService/GetPlayerData', 'app.masterdata.MasterdataService/Version'}


class LoginError(ValueError):
    """Only fixed stage names and numeric service codes; never remote error text."""

    def __init__(self, code, *, reason=None):
        super().__init__(code)
        self.reason = reason


def sdk_error_reason(message):
    """Classify a small allowlist of meanings without retaining remote text."""
    if not isinstance(message, str) or len(message) > 2048:
        return None
    lowered = message.lower()
    for reason, markers in (
        ('credentials_rejected', ('密碼錯誤', '密码错误', '密碼不正確', '密码不正确',
                                  '帳號或密碼', '账号或密码', 'incorrect password', 'wrong password')),
        ('account_not_found', ('帳號不存在', '账号不存在', 'account does not exist')),
        ('verification_required', ('驗證碼', '验证码', 'captcha')),
        ('rate_limited', ('過於頻繁', '过于频繁', 'too many requests')),
    ):
        if any(marker in lowered for marker in markers):
            return reason
    return None


@dataclass(repr=False)
class SdkIdentity:
    uid: str
    access_token: str
    id_token: str = ''


@dataclass(repr=False)
class Profile:
    app_key: str = field(repr=False)
    game_id: str = '17703'
    merchant_id: str = '1045'
    server_id: str = '16841'
    channel_id: str = '2001'
    version: str = CLIENT_VERSION

    @classmethod
    def from_resources(cls, path: Path):
        if path.stat().st_size > 4 * 1024 * 1024:
            raise LoginError('invalid_sdk_profile')
        return cls.from_xml(path.read_bytes())

    @classmethod
    def from_xml(cls, data):
        if len(data) > 4 * 1024 * 1024 or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise LoginError('invalid_sdk_profile')
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            raise LoginError('invalid_sdk_profile') from None
        if root.tag != 'resources':
            raise LoginError('invalid_sdk_profile')
        values = {e.get('name'): e.text or '' for e in root}
        for key, expected in {'appid': '17703', 'merchantid': '1045', 'serverid': '16841',
                              'channelid': '2001', 'one_global_brand_id': '5',
                              'one_global_area_id': '6'}.items():
            if values.get(key) != expected:
                raise LoginError('unsupported_sdk_profile')
        key = values.get('one_appkey', '')
        if not key or len(key) > 256:
            raise LoginError('invalid_sdk_profile')
        return cls(key)


def text_value(value, *, optional=False):
    if optional and value in (None, ''):
        return ''
    if not isinstance(value, str) or not value or len(value) > 16384:
        raise LoginError('invalid_auth_response')
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise LoginError('invalid_auth_response')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class SdkClient:
    def __init__(self, profile: Profile):
        self.profile = profile
        self.device_id = str(uuid.uuid4())
        self.opener = urllib.request.build_opener(NoRedirect)

    def parameters(self, extra):
        p = self.profile
        params = {'game_id': p.game_id, 'server_id': p.server_id, 'merchant_id': p.merchant_id,
                  'channel_id': p.channel_id, 'app_ver': p.version, 'sdk_ver': '4.2.12',
                  'platform': 'google', 'platform_type': '3', 'net': '', 'operators': '',
                  'model': 'local-export-research', 'pf_ver': '', 'udid': self.device_id,
                  'dp': '', 'adid': '', 'lang': 'zh', 'sdk_log_type': '1', 'ad_ext': '',
                  'time_zone': '+08:00', 'isRoot': '0', 'web_code': '6',
                  'timestamp': str(int(time.time() * 1000))}
        if set(extra) & set(params):
            raise LoginError('sdk_parameter_override_refused')
        params.update(extra)
        params['sign'] = hashlib.md5((''.join(params[k] for k in sorted(params)) + p.app_key).encode()).hexdigest()
        return params

    def request(self, operation, extra=None):
        if operation not in ('rsa', 'login'):
            raise LoginError('sdk_operation_refused')
        params = self.parameters(extra or {})
        req = urllib.request.Request(SDK_ROOT + '/gapi/client/' + operation,
            data=urllib.parse.urlencode(params).encode(), method='POST', headers={
                'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 BSGameSDK',
                'Api-Version': '1', 'one-sdk-ver': '1.25.0',
                'X-Game-Trace-Id': str(uuid.uuid4()), 'X-Game-Request-Id': str(uuid.uuid4())})
        try:
            with self.opener.open(req, timeout=20) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise LoginError('sdk_response_too_large')
                data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            raise LoginError('sdk_http_' + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise LoginError('sdk_network_or_tls_error') from None
        except (ValueError, UnicodeError):
            raise LoginError('invalid_sdk_response') from None
        if not isinstance(data, dict) or type(data.get('code')) is not int:
            raise LoginError('invalid_sdk_response')
        if data['code'] != 0:
            raise LoginError('sdk_service_' + str(data['code']),
                             reason=sdk_error_reason(data.get('message') or data.get('msg')))
        if not isinstance(data.get('data'), dict):
            raise LoginError('invalid_sdk_response')
        return data['data']

    def login(self, account, password):
        if not isinstance(account, str) or not account.strip() or len(account) > 320:
            raise LoginError('invalid_account_input')
        if not isinstance(password, str) or not password or len(password.encode()) > 4096:
            raise LoginError('invalid_password_input')
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        initialization = self.request('rsa')
        try:
            raw_key = initialization.get('rsa_key')
            if not isinstance(raw_key, str) or not 64 <= len(raw_key) <= 16384:
                raise LoginError('invalid_rsa_key')
            raw_key = raw_key.encode()
            if b'BEGIN PUBLIC KEY' in raw_key:
                key = serialization.load_pem_public_key(raw_key)
            else:
                key = serialization.load_der_public_key(base64.b64decode(raw_key, validate=True))
            if not isinstance(key, rsa.RSAPublicKey) or not 1024 <= key.key_size <= 8192:
                raise LoginError('invalid_rsa_key')
            prefix = text_value(initialization.get('hash'))
            ciphertext = key.encrypt((prefix + password).encode(), padding.PKCS1v15())
        except (ValueError, TypeError):
            raise LoginError('sdk_rsa_encryption_failed') from None
        result = self.request('login', {'user_id': account.strip(), 'pwd': base64.b64encode(ciphertext).decode()})
        # User.accessKey is serialized as access_key. GSCallbackHelper renames
        # it to access_token only in the Android Bundle passed to OneSDK.
        uid = result.get('uid')
        if type(uid) is int and 0 < uid < (1 << 64):
            uid = str(uid)
        return SdkIdentity(text_value(uid), text_value(result.get('access_key')),
                           text_value(result.get('id_token'), optional=True))


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    return bytes(result) + bytes([value])


def message(number, value):
    if isinstance(value, str):
        value = value.encode()
    return varint((number << 3) | 2) + varint(len(value)) + value


def integer(number, value):
    return varint(number << 3) + varint(value)


def single(data, number, wire=2, required=True):
    values = [(w, v) for n, w, v in fields(data) if n == number]
    if not values and not required:
        return None
    if len(values) != 1 or values[0][0] != wire:
        observed = '_'.join(str(w) for w, _ in values[:8]) or 'absent'
        raise LoginError('invalid_game_response_field_' + str(number)
                         + '_expected_wire_' + str(wire) + '_observed_' + observed)
    return bytes(values[0][1]) if wire == 2 else values[0][1]


def string(data, number, *, optional=False):
    try:
        value = single(data, number, required=not optional)
        return text_value(value.decode() if value is not None else '', optional=optional)
    except UnicodeError:
        raise LoginError('invalid_game_text') from None


def build_login(identity, device_id):
    # Native BuildRequest uses PlatformID 0 and leaves InitialDataGroup empty.
    return b''.join((message(1, identity.uid), message(2, identity.access_token),
        message(4, 'OurNotes local exporter'), message(5, platform.system()), message(6, CLIENT_VERSION),
        message(7, message(2, device_id)), message(8, 'com.bilibili.sirius'),
        integer(10, 2001), integer(11, 5), integer(12, 6),
        message(13, identity.id_token) if identity.id_token else b''))


class GameClient:
    read_methods = frozenset(READ_METHODS)

    def rpc(self, host, method, payload=b'', auth=()):
        if host not in GAME_HOSTS or method not in self.read_methods:
            raise LoginError('game_target_refused')
        import grpc
        metadata = [('x-client-version', CLIENT_VERSION), ('x-platform', 'android'),
                    ('x-request-id', str(uuid.uuid4()))] + list(auth)
        try:
            with grpc.secure_channel(host + ':443', grpc.ssl_channel_credentials(), options=(
                    ('grpc.enable_retries', 0), ('grpc.max_receive_message_length', MAX_BYTES))) as channel:
                call = channel.unary_unary('/' + method, request_serializer=lambda b: b,
                                           response_deserializer=lambda b: b)
                return call(payload, metadata=metadata, timeout=25, wait_for_ready=False)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNKNOWN and exc.details() == 'authentication failed':
                raise LoginError('game_authentication_failed') from None
            raise LoginError('game_rpc_' + exc.code().name.lower()) from None

    def discover(self):
        response = self.rpc(BOOTSTRAP, LOGIN_SERVICE + 'GetServerList')
        matches = []
        for n, wire, value in fields(response):
            if n != 1 or wire != 2:
                continue
            if string(value, 8) == '2' and string(value, 1) == 'TW/HK/MO':
                root = urllib.parse.urlsplit(string(value, 3).split('|')[0])
                if root.scheme != 'https' or root.hostname not in GAME_HOSTS or root.path not in ('', '/') or root.query or root.username or root.password or root.port not in (None, 443):
                    raise LoginError('unexpected_game_server')
                matches.append(root.hostname)
        if len(matches) != 1:
            raise LoginError('tw_server_not_unique')
        return matches[0]

    def authenticate(self, identity, device_id, host, progress=lambda s: None):
        payload = build_login(identity, device_id)
        auth = [('x-player-bid', identity.uid)]
        progress('checking_existing_account')
        prelogin = self.rpc(host, LOGIN_SERVICE + 'PlayerPreLogin', payload, auth)
        if single(prelogin, 1, wire=0, required=False) != 1:
            raise LoginError('no_existing_role_in_selected_server')
        progress('game_login')
        response = self.rpc(host, LOGIN_SERVICE + 'PlayerLogin', payload, auth)
        if single(response, 4, wire=0, required=False) not in (None, 0):
            raise LoginError('unexpected_new_role_response')
        credential = single(response, 1)
        player_id, token = (string(credential, n) for n in (1, 2))
        # International BiliLogin installs id + credential via SetPlayer.
        # DeviceId is an optional protobuf string, absent in the live
        # response. Do not require it or invent a server-issued device value.
        server_device_id = string(credential, 3, optional=True)
        auth += [('x-player-id', player_id), ('x-player-credential', token)]
        if server_device_id:
            auth.append(('x-device-id', server_device_id))
        return auth

    def export(self, identity, device_id, host, progress=lambda s: None):
        auth = self.authenticate(identity, device_id, host, progress)
        progress('reading_growth')
        raw = self.rpc(host, 'app.player.PlayerService/GetPlayerData', b'', auth)
        snapshot = extract_growth(raw)
        snapshot['verification'] = 'live_response_not_ui_reconciled'
        snapshot['source'] = {'kind': 'direct_game_read', 'region': 'TW/HK/MO', 'clientVersion': CLIENT_VERSION}
        return snapshot
