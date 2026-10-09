"""Validated deployment configuration; public collectors never load node secrets."""
from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ID = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")


def loopback_url(value):
    parsed = urlsplit(value)
    try:
        valid = ipaddress.ip_address(parsed.hostname or "").is_loopback
        port = parsed.port
    except ValueError:
        valid, port = False, None
    if not valid or parsed.scheme not in {"http", "https"} or not port or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("service URLs must use a literal loopback address and explicit port")
    return value.rstrip("/")


def secret(reference):
    if not isinstance(reference, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{2,100}", reference):
        raise ValueError("a secret environment reference is required")
    value = os.environ.get(reference, "")
    if len(value) < 32 or any(c.isspace() for c in value):
        raise ValueError("secret is absent or too short")
    return value


def load_config(path, role=None):
    path = Path(path).resolve()
    config = json.loads(path.read_text())
    config = validate_config(config, role)
    # All filesystem paths are deployment settings, never HTTP parameters.
    def resolve(value):
        return str((path.parent / value).resolve())
    for key in ("database",):
        if key in config:
            config[key] = resolve(config[key])
    for site in config.get("sites", []):
        for key in ("accessLog", "catalogFile", "growthDiagnosticsFile"):
            if site.get(key):
                site[key] = resolve(site[key])
        if site.get("catalogFile"):
            catalog = json.loads(Path(site["catalogFile"]).read_text())
            site["paths"] = catalog["paths"]
            site["resources"] = catalog.get("resources", [])
    for profile in config.get("profiles", []):
        for key in ("configFile", "workspace"):
            if profile.get(key):
                profile[key] = resolve(profile[key])
        if profile.get("stateWorkspace"):
            profile["stateWorkspace"] = resolve(profile["stateWorkspace"])
    if "repository" in config:
        config["repository"] = resolve(config["repository"])
    return config


def validate_config(source, role=None):
    c = copy.deepcopy(source)
    if c.get("schemaVersion") != 1 or c.get("role") not in {"admin", "collector", "node"}:
        raise ValueError("unsupported configuration")
    if role and c["role"] != role:
        raise ValueError("wrong configuration role")
    if c.get("host", "127.0.0.1") != "127.0.0.1":
        raise ValueError("services must bind to 127.0.0.1")
    c["host"] = "127.0.0.1"
    if type(c.get("port")) is not int or not 1024 <= c["port"] <= 65535:
        raise ValueError("invalid service port")
    for key in ("sites", "sources", "nodes", "profiles", "loadSources"):
        rows = c.get(key, [])
        if not isinstance(rows, list) or len(rows) > 32:
            raise ValueError("invalid collection: " + key)
        ids = [row.get("id", "") for row in rows]
        if any(not ID.fullmatch(x) for x in ids) or len(ids) != len(set(ids)):
            raise ValueError("invalid or duplicate IDs: " + key)
    for row in c.get("sources", []) + c.get("nodes", []):
        row["url"] = loopback_url(row["url"])
    for row in c.get("loadSources", []):
        if row.get("statusUrl"):
            loopback_url(row["statusUrl"])
        for interface in row.get("interfaces", []):
            if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,32}", interface):
                raise ValueError("invalid network interface")
        for key in ("rxLimitMbps", "txLimitMbps"):
            if row.get(key) is not None and (type(row[key]) not in (int, float) or not 0 < row[key] <= 1000000):
                raise ValueError("invalid bandwidth limit")
    for row in c.get('nodes', []) + c.get('profiles', []):
        if row.get('productionSource') == 'github-actions-r2':
            # Migrated profiles are observers, even if an old deployment still
            # carries capabilities or publication users from the local worker.
            row['capabilities'] = []
        actions = row.get('capabilities', ['check'])
        if not isinstance(actions, list) or not set(actions) <= {'check', 'fetch', 'build', 'publish'}:
            raise ValueError('invalid resource capabilities')
        if 'publish' in actions and not row.get('publishUsers'):
            raise ValueError('publication requires an explicit actor allowlist')
        if row.get('productionSource') not in (None, 'github-actions-r2'):
            raise ValueError('unknown production source')
    for site in c.get("sites", []):
        ZoneInfo(site.get("timezone", "Asia/Shanghai"))
        for key in ('pathPatterns', 'resourcePatterns'):
            patterns = site.get(key, [])
            if not isinstance(patterns, list) or len(patterns) > 256:
                raise ValueError('invalid catalog patterns')
            for pattern in patterns:
                if not isinstance(pattern, str) or len(pattern) > 1024:
                    raise ValueError('invalid catalog pattern')
                re.compile(pattern)
        for origin in site.get("origins", []):
            u = urlsplit(origin)
            if u.scheme not in {"https", "http"} or not u.hostname or u.path or u.query or u.fragment or u.username:
                raise ValueError("origins must contain only scheme, host and port")
    c.setdefault("sampleSeconds", 5)
    if type(c["sampleSeconds"]) is not int or not 5 <= c["sampleSeconds"] <= 60:
        raise ValueError("sampleSeconds must be 5..60")
    c.setdefault("maxDatabaseBytes", 1024 ** 3)
    if type(c["maxDatabaseBytes"]) is not int or c["maxDatabaseBytes"] < 1024 ** 2:
        raise ValueError("invalid storage limit")
    if c["role"] == "collector" and any(c.get(k) for k in ("nodes", "profiles", "repository", "sources")):
        raise ValueError("collector configuration cannot include control-plane settings")
    if c["role"] == "admin":
        if c.get("auth", {}).get("mode") not in {"proxy", "preview"}:
            raise ValueError("explicit proxy or preview authentication required")
        c["origin"] = loopback_url(c["origin"])
        available = {x["id"] for x in c.get("sources", [])}
        nodes = {x["id"] for x in c.get("nodes", [])}
        for site in c.get("sites", []):
            if site.get("source") not in available or any(x not in nodes for x in site.get("nodes", [])):
                raise ValueError("unknown site source or node")
    return c
