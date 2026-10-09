"""Verified Global Android discovery protocol; no account credentials required.

Wire evidence: Global 1.0.1 (25), 2026-09-27. The two unary RPCs have empty
protobuf requests. A missing client-version header yields an empty server list.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

from ..transport import HttpRequest, HttpTransport, TransportError

BOOTSTRAP = "https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com"
API_HOSTS = ("l14-prod-hk-all-gs-sirius.gamerfusiontech.com", "l12-prod-hk-all-gs-sirius.gamerfusiontech.com")
CDN_HOSTS = ("l14-prod-hk-patch-sirius.gamerfusiontech.com", "l12-prod-hk-patch-sirius.gamerfusiontech.com")
WEB_HOSTS = ("bdon.biligames.com", "s1.biligames.com", "l12-pkg-download.biligames.com")
APK_HOSTS = ("pkg.biligame.com",)
APK_USER_AGENT = "Android"
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){1,4}")
HASH = re.compile(r"[0-9a-f]{32}")


class ProtocolError(ValueError):
    pass


class ClientUpdateRequired(ProtocolError):
    def __init__(self, version: str, url: str | None):
        super().__init__("Global client update required")
        self.version = version
        self.url = url


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def allowed_url(url: str, hosts: tuple[str, ...]) -> str:
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in hosts or p.port not in (None, 443) or p.username or p.password or p.fragment:
        raise ProtocolError("unexpected source URL")
    if p.query or any(part in (".", "..") for part in p.path.split("/")) or "%" in p.path or "\\" in p.path:
        raise ProtocolError("unexpected source path")
    return url


def protobuf_fields(data: bytes) -> dict[int, list[bytes | int]]:
    """Read bounded protobuf fields, retaining repeats and skipping fixed values."""
    pos = 0
    result: dict[int, list[bytes | int]] = {}

    def varint() -> int:
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos == len(data):
                raise ProtocolError("truncated protobuf varint")
            byte = data[pos]
            pos += 1
            if shift == 63 and byte > 1:
                raise ProtocolError("protobuf varint overflow")
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
        raise ProtocolError("protobuf varint overflow")

    while pos < len(data):
        tag = varint()
        field, wire = tag >> 3, tag & 7
        if not 0 < field < 2**29:
            raise ProtocolError("invalid protobuf field")
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if pos + size > len(data):
                raise ProtocolError("truncated protobuf value")
            value = data[pos:pos + size]
            pos += size
        else:
            raise ProtocolError("unsupported protobuf wire type")
        result.setdefault(field, []).append(value)
    return result


def string_field(fields: dict, number: int) -> str:
    values = fields.get(number, [])
    if len(values) != 1 or not isinstance(values[0], bytes):
        raise ProtocolError(f"missing or repeated string field {number}")
    try:
        return values[0].decode("utf-8")
    except UnicodeError as exc:
        raise ProtocolError("invalid protobuf text") from exc


def _safe_grpc_message(value: str) -> str:
    """Keep bounded upstream diagnostics without echoing URLs or credentials."""
    decoded = unquote(value[:2048], errors="replace")
    decoded = re.sub(r"(?i)\b(authorization|token|password|secret|credential|cookie|api[_-]?key)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+",
                     r"\1=[redacted]", decoded)
    decoded = re.sub(r"(?i)\b(bearer|basic)\s+[^\s,;]+", r"\1 [redacted]", decoded)
    decoded = re.sub(r"https?://[^\s]+", "[url]", decoded, flags=re.IGNORECASE)
    decoded = re.sub(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?\b", "[address]", decoded)
    decoded = re.sub(r"\b[A-Za-z0-9_+/=-]{24,}\b", "[redacted]", decoded)
    # Restrict logs/artifacts to short printable diagnostics. This also removes
    # CR/LF and other control characters from the untrusted response header.
    allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.,:;!?()[]{}'/-"
    decoded = "".join(char if char in allowed else " " for char in decoded)
    return " ".join(decoded.split())[:240]


def decode_grpc(headers: str, body: bytes) -> tuple[dict[str, str], bytes]:
    statuses = re.findall(r"^HTTP/\S+ (\d+)", headers, re.M)
    parsed = {m[1].lower(): m[2].strip() for m in re.finditer(r"^([\w-]+):\s*([^\r\n]*)", headers, re.M)}
    if not statuses or statuses[-1] != "200":
        raise ProtocolError(f"RPC HTTP status {statuses[-1] if statuses else 'missing'}")
    if parsed.get("grpc-status") != "0":
        if parsed.get("grpc-status") == "2" and _safe_grpc_message(parsed.get("grpc-message", "")) == "client update required":
            version = parsed.get("x-client-recommended-version", "")
            url = parsed.get("x-client-download-url", "")
            if not VERSION.fullmatch(version):
                raise ProtocolError("client update required without a valid recommended version")
            if url:
                if len(url) > 512:
                    raise ProtocolError("client update URL is too long")
                allowed_url(url, APK_HOSTS)
                match = re.fullmatch(r"/games/BanGDreamOurNotes_([0-9]+(?:\.[0-9]+){1,4})_[0-9_]+\.apk", urlsplit(url).path)
                if not match or match.group(1) != version:
                    raise ProtocolError("client update URL does not match the recommended version")
            raise ClientUpdateRequired(version, url or None)
        raw_status = parsed.get("grpc-status", "missing")
        status = raw_status if re.fullmatch(r"[0-9]{1,3}", raw_status) else "invalid"
        message = _safe_grpc_message(parsed.get("grpc-message", ""))
        detail = f"RPC grpc-status {status}"
        if message:
            detail += f": {message}"
        raise ProtocolError(detail)
    if not parsed.get("content-type", "").startswith("application/grpc"):
        raise ProtocolError("RPC returned a non-gRPC response")
    if len(body) < 5 or body[0] != 0 or int.from_bytes(body[1:5], "big") != len(body) - 5:
        raise ProtocolError("invalid or unsupported unary gRPC frame")
    # Do not persist authentication/cookie headers if the service adds them later.
    safe = {k: v for k, v in parsed.items() if k in {
        "x-server-time", "x-client-recommended-version", "x-client-download-url",
        "x-asset-version", "content-type", "grpc-status",
    }}
    return safe, body[5:]


class GlobalPublicClient:
    def __init__(self, client_version: str = "1.0.1"):
        if not VERSION.fullmatch(client_version):
            raise ProtocolError("invalid client version")
        self.client_version = client_version

    def rpc(self, root: str, method: str) -> tuple[dict, bytes]:
        allowed_url(root, API_HOSTS)
        if method not in ("app.playerlogin.PlayerLoginService/GetServerList", "app.masterdata.MasterdataService/Version"):
            raise ProtocolError("unsupported read-only RPC")
        with tempfile.TemporaryDirectory(prefix="ournotes-rpc-") as tmp:
            header_path, body_path = Path(tmp) / "headers", Path(tmp) / "body"
            command = ["curl", "--disable", "--http2", "--proto", "=https", "--max-time", "30",
                       "--max-filesize", "1048576", "--silent", "--show-error",
                       "--dump-header", str(header_path), "--output", str(body_path),
                       "-H", "Content-Type: application/grpc", "-H", "TE: trailers",
                       "-H", f"x-client-version: {self.client_version}", "-H", "x-platform: Android",
                       "--data-binary", "@-", f"{root}/{method}"]
            completed = subprocess.run(command, input=bytes(5), capture_output=True, timeout=35)
            if completed.returncode:
                raise TransportError(f"read-only RPC transport failed ({completed.returncode})")
            return decode_grpc(header_path.read_text(), body_path.read_bytes())

    def get(self, url: str, limit: int, *, method: str = "GET"):
        allowed_url(url, CDN_HOSTS + WEB_HOSTS)
        transport = HttpTransport(allowed_hosts=CDN_HOSTS + WEB_HOSTS, connect_timeout_seconds=30,
                                  read_timeout_seconds=30, max_response_bytes=limit)
        response = transport.request(HttpRequest(method, url))
        if response.status != 200:
            raise ProtocolError(f"HTTP {response.status}: {url}")
        return response

    def official_apk(self, notice: ClientUpdateRequired) -> dict:
        if not notice.url:
            raise ProtocolError("official APK URL is unavailable")
        transport = HttpTransport(allowed_hosts=APK_HOSTS, connect_timeout_seconds=30,
                                  read_timeout_seconds=30, max_response_bytes=1024)
        response = transport.request(HttpRequest("HEAD", notice.url, {"User-Agent": APK_USER_AGENT}))
        if response.status != 200 or response.headers.get("content-type", "").split(";", 1)[0] != "application/vnd.android.package-archive":
            raise ProtocolError("official APK metadata is unavailable")
        try:
            size = int(response.headers.get("content-length", "0"))
        except ValueError:
            raise ProtocolError("invalid official APK size") from None
        etag, modified = response.headers.get("etag"), response.headers.get("last-modified")
        if not 0 < size <= 2_000_000_000 or not etag or not modified:
            raise ProtocolError("incomplete official APK metadata")
        return {"observedAt": utc_now(), "source": BOOTSTRAP, "url": notice.url,
                "byteSize": size, "etag": etag, "lastModified": modified,
                "clientVersion": notice.version, "status": "official_download_available",
                "packageIdentityVerified": False}

    def discover(self) -> dict:
        _, payload = self.rpc(BOOTSTRAP, "app.playerlogin.PlayerLoginService/GetServerList")
        servers = []
        for row in protobuf_fields(payload).get(1, []):
            if not isinstance(row, bytes):
                raise ProtocolError("invalid server record")
            fields = protobuf_fields(row)
            if string_field(fields, 8) == "2":
                servers.append(fields)
        if len(servers) != 1 or string_field(servers[0], 1) != "TW/HK/MO":
            raise ProtocolError("expected exactly one TW/HK/MO production server")
        cdn = string_field(servers[0], 2).split("|")[0]
        api = string_field(servers[0], 3).split("|")[0]
        allowed_url(cdn, CDN_HOSTS)
        allowed_url(api, API_HOSTS)
        if not re.fullmatch(r"/prod/hk_[0-9a-f]{32}", urlsplit(cdn).path):
            raise ProtocolError("unexpected Global production CDN root")
        headers, payload = self.rpc(api, "app.masterdata.MasterdataService/Version")
        fields = protobuf_fields(payload)
        master_version, resource_version = string_field(fields, 1), string_field(fields, 2)
        if not HASH.fullmatch(master_version) or not VERSION.fullmatch(resource_version):
            raise ProtocolError("unexpected Master/resource version")
        catalog_base = f"{cdn}/asset/Android/catalog_{resource_version}"
        catalog_hash = self.get(catalog_base + ".hash", 256).body.decode("ascii").strip()
        if not HASH.fullmatch(catalog_hash):
            raise ProtocolError("invalid catalog hash")
        return {"schemaVersion": 1, "environmentId": "global-production", "serverAreaId": "2",
                "observedAt": utc_now(), "clientVersion": self.client_version, "apiRoot": api,
                "cdnRoot": cdn, "masterVersion": master_version, "resourceVersion": resource_version,
                "catalogHash": catalog_hash, "catalogUrl": catalog_base + ".bin",
                "masterManifestUrl": f"{cdn}/master/{master_version}/MasterManifest.json",
                "responseHeaders": headers, "authentication": "not_required"}


def version_identity(value: dict) -> tuple:
    return tuple(value.get(k) for k in ("environmentId", "serverAreaId", "clientVersion", "cdnRoot",
                                       "masterVersion", "resourceVersion", "catalogHash"))


def discover_package(client: GlobalPublicClient, previous: dict | None = None) -> dict:
    """Use the game's upgrade signal; reuse the prior package while accepted."""
    upgrade = None
    try:
        client.rpc(BOOTSTRAP, "app.playerlogin.PlayerLoginService/GetServerList")
    except ClientUpdateRequired as notice:
        upgrade = notice
        if notice.url:
            try:
                return client.official_apk(notice)
            except (ProtocolError, TransportError):
                # The legacy official website is a secondary source. Its APK
                # still has to match the recommended version during intake.
                pass
    if upgrade is None and previous is not None:
        if (not isinstance(previous, dict) or not isinstance(previous.get("url"), str)
                or type(previous.get("byteSize")) is not int or not 0 < previous["byteSize"] <= 2_000_000_000
                or not isinstance(previous.get("etag"), str) or not previous["etag"]
                or not isinstance(previous.get("lastModified"), str) or not previous["lastModified"]):
            raise ProtocolError("previous official package identity is invalid")
        allowed_url(previous["url"], WEB_HOSTS + APK_HOSTS)
        return previous
    page_url = "https://bdon.biligames.com/"
    page = client.get(page_url, 1_000_000).body.decode("utf-8")
    scripts = []
    for src in re.findall(r'<script[^>]+src=["\']([^"\']+)', page):
        url = "https:" + src if src.startswith("//") else src
        p = urlsplit(url)
        if p.hostname == "s1.biligames.com" and re.fullmatch(
            r"/fe-static/game-global-bangdreamon/gw/js/(?:index|chunk-common)\.[a-f0-9]+\.js", p.path
        ):
            scripts.append(url)
    if not scripts:
        raise ProtocolError("official download scripts were not found")
    links, evidence = set(), []
    for url in sorted(set(scripts)):
        body = client.get(url, 5_000_000).body
        evidence.append({"url": url, "sha256": sha256(body)})
        links.update(re.findall(rb'https://l12-pkg-download\.biligames\.com/sirius/apk/[A-Za-z0-9_.-]+\.apk', body))
    if len(links) != 1:
        raise ProtocolError("official site must expose exactly one Android APK")
    url = links.pop().decode("ascii")
    head = client.get(url, 1024, method="HEAD")
    size = int(head.headers.get("content-length", "0"))
    if not 0 < size <= 2_000_000_000:
        raise ProtocolError("unexpected APK size")
    return {"observedAt": utc_now(), "source": page_url, "scripts": evidence, "url": url,
            "byteSize": size, "etag": head.headers.get("etag"),
            "lastModified": head.headers.get("last-modified"),
            **({"clientVersion": upgrade.version} if upgrade else {}),
            "status": "official_download_available", "packageIdentityVerified": False}
