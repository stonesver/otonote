"""Private completion evidence for direct, immutable public R2 releases.

The completion object is written only after every release object was read back
and checked with SHA-256. Later use also requires a fresh exact R2 listing with
the recorded size and ETag; object metadata alone is never first-use evidence.
This namespace is deliberately separate from the shared-media Worker layout.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from tools.r2_content import (RELEASE, SHA256, canonical, check_public_path,
                              digest)

LAYOUT = "direct-verified-v1"
MAX_INDEX = 4 * 1024 * 1024
MAX_FILES = 100_000
ETAG = re.compile(r'"[A-Za-z0-9-]{1,128}"\Z')


def catalog_prefix(release_id: str) -> str:
    if not RELEASE.fullmatch(release_id):
        raise ValueError("invalid verified release id")
    return f"content/verification/{release_id}/"


def completion_key(release_id: str) -> str:
    return catalog_prefix(release_id) + "complete.json"


def _json(raw: bytes) -> dict:
    if not isinstance(raw, bytes) or len(raw) > MAX_INDEX:
        raise ValueError("invalid verified release index size")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate verified release index key")
            value[key] = item
        return value

    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError("invalid verified release index")
    return value


def _identity(name: str, sha: str, size: int, etag: str) -> dict:
    check_public_path(name)
    if (not isinstance(sha, str) or not SHA256.fullmatch(sha)
            or type(size) is not int or size < 0
            or not isinstance(etag, str) or not ETAG.fullmatch(etag)):
        raise ValueError("invalid verified release file identity")
    return {"sha256": sha, "bytes": size, "etag": etag}


def _release(release: Path, manifest: dict, files: dict[str, str]):
    release_id = manifest["root"].split("/")[-2]
    if (not RELEASE.fullmatch(release_id) or release.name != release_id
            or manifest["root"] != f"/content/releases/{release_id}/"
            or len(files) > MAX_FILES or "manifest.json" not in files):
        raise ValueError("invalid verified release binding")
    inventory = {}
    for name, sha in files.items():
        check_public_path(name)
        if not isinstance(sha, str) or not SHA256.fullmatch(sha):
            raise ValueError("invalid verified release inventory")
        inventory[name] = {"sha256": sha, "bytes": (release / name).stat().st_size}
    return release_id, inventory


def _immutable(bucket, key: str, raw: bytes):
    if len(raw) > MAX_INDEX:
        raise ValueError("verified release index exceeds limit")
    existing = bucket.get(key)
    if existing is None:
        bucket.put_new(key, raw, content_type="application/json",
                       cache_control="no-store", sha256=digest(raw))
        existing = bucket.get(key)
    if existing is None or existing[0] != raw:
        raise ValueError("immutable verified release index differs")


def upload_catalog(bucket, release: Path, manifest: dict, files: dict[str, str],
                   etags: dict[str, str]) -> None:
    """Internal: seal ETags from full SHA GETs over sealed_release's inventory.

    The caller must obtain each ETag from the same response whose body passed
    SHA and size verification. HEAD/LIST metadata is not first-use evidence.
    """
    release_id, inventory = _release(release, manifest, files)
    if set(etags) != set(files):
        raise ValueError("verified release evidence is incomplete")
    shards: dict[str, dict] = {}
    for name, entry in sorted(inventory.items()):
        record = _identity(name, entry["sha256"], entry["bytes"], etags[name])
        shards.setdefault(digest(name.encode())[0], {})[name] = record
    prefix = catalog_prefix(release_id)
    completion = {"schemaVersion": 1, "layout": LAYOUT, "releaseId": release_id,
                  "root": manifest["root"], "manifestSha256": files["manifest.json"],
                  "inventorySha256": digest(canonical(inventory)), "fileCount": len(files),
                  "shards": {}}
    for shard, records in sorted(shards.items()):
        raw = canonical({"schemaVersion": 1, "releaseId": release_id, "files": records})
        _immutable(bucket, prefix + shard + ".json", raw)
        completion["shards"][shard] = {"sha256": digest(raw), "bytes": len(raw)}
    _immutable(bucket, completion_key(release_id), canonical(completion))


def _catalog(bucket, release: Path, manifest: dict, files: dict[str, str]) -> dict | None:
    release_id, inventory = _release(release, manifest, files)
    item = bucket.get(completion_key(release_id))
    if item is None:
        return None
    completion = _json(item[0])
    if (set(completion) != {"schemaVersion", "layout", "releaseId", "root", "manifestSha256",
                            "inventorySha256", "fileCount", "shards"}
            or completion["schemaVersion"] != 1 or completion["layout"] != LAYOUT
            or completion["releaseId"] != release_id or completion["root"] != manifest["root"]
            or completion["manifestSha256"] != files["manifest.json"]
            or completion["inventorySha256"] != digest(canonical(inventory))
            or type(completion["fileCount"]) is not int or completion["fileCount"] != len(files)
            or not isinstance(completion["shards"], dict) or not 0 < len(completion["shards"]) <= 16):
        raise ValueError("verified release completion binding mismatch")
    records = {}
    for shard, spec in completion["shards"].items():
        if (not re.fullmatch(r"[a-f0-9]", shard) or not isinstance(spec, dict)
                or set(spec) != {"sha256", "bytes"} or not isinstance(spec["sha256"], str)
                or not SHA256.fullmatch(spec["sha256"]) or type(spec["bytes"]) is not int
                or not 0 < spec["bytes"] <= MAX_INDEX):
            raise ValueError("invalid verified release shard reference")
        raw_item = bucket.get(catalog_prefix(release_id) + shard + ".json")
        if raw_item is None or len(raw_item[0]) != spec["bytes"] or digest(raw_item[0]) != spec["sha256"]:
            raise ValueError("verified release shard is missing or damaged")
        value = _json(raw_item[0])
        if (set(value) != {"schemaVersion", "releaseId", "files"}
                or value["schemaVersion"] != 1 or value["releaseId"] != release_id
                or not isinstance(value["files"], dict) or len(value["files"]) > MAX_FILES):
            raise ValueError("invalid verified release shard")
        for name, record in value["files"].items():
            if (name in records or digest(name.encode())[0] != shard
                    or not isinstance(record, dict) or set(record) != {"sha256", "bytes", "etag"}
                    or _identity(name, record["sha256"], record["bytes"], record["etag"]) != record):
                raise ValueError("invalid verified release record")
            records[name] = record
            if len(records) > MAX_FILES:
                raise ValueError("verified release inventory exceeds limit")
    if (set(records) != set(inventory) or any(
            {key: records[name][key] for key in ("sha256", "bytes")} != entry
            for name, entry in inventory.items())):
        raise ValueError("verified release inventory binding mismatch")
    return records


def verify_release(bucket, release: Path, manifest: dict, files: dict[str, str]) -> bool:
    """Return false only for absent evidence or a bucket without listing support."""
    records = _catalog(bucket, release, manifest, files)
    if records is None or not hasattr(bucket, "list_identities"):
        return False
    release_id = release.name
    prefix = f"content/releases/{release_id}/"
    present = bucket.list_identities(prefix)
    expected = {prefix + name: (record["bytes"], record["etag"])
                for name, record in records.items()}
    if present != expected:
        raise ValueError("verified release object is missing or changed")
    return True
