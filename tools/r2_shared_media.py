"""Versioned logical media paths backed by verified, shared immutable R2 bytes.

A catalog is evidence of an earlier complete SHA-256 readback. Reuse additionally
requires a fresh strongly consistent listing with the same object ETag and size.
Neither a filename hash nor self-declared object metadata is first-use evidence.
"""
from __future__ import annotations

import json
import mimetypes
from pathlib import Path
import re

from tools.r2_content import (SHA256, RELEASE, canonical, digest, check_public_path,
                              file_hash, same_object, _run_bounded)

LAYOUT = "shared-media-v1"
MAX_INDEX = 4 * 1024 * 1024
MAX_FILES = 100_000


def is_shared(name):
    # This includes model/motion JSON: internal blob reads preserve the logical
    # response URL, so relative texture and animation URLs keep their base.
    return name.startswith("public/")


def shard_name(name):
    return digest(name.encode())[0]


def descriptor_key(release_id):
    if not RELEASE.fullmatch(release_id):
        raise ValueError("invalid shared media release")
    return f"content/storage/{release_id}/descriptor.json"


def blob_key(sha):
    if not isinstance(sha, str) or not SHA256.fullmatch(sha):
        raise ValueError("invalid shared media digest")
    return "content/blobs/" + sha


def _json(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_INDEX:
        raise ValueError("invalid shared media index size")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate shared media index key")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise ValueError("invalid shared media index")
    return value


def _record(record):
    if (not isinstance(record, dict) or set(record) != {"sha256", "bytes", "etag", "contentType"}
            or not isinstance(record["sha256"], str) or not SHA256.fullmatch(record["sha256"])
            or type(record["bytes"]) is not int or record["bytes"] < 0
            or not isinstance(record["etag"], str) or not re.fullmatch(r'"[A-Za-z0-9-]{1,128}"', record["etag"])
            or not isinstance(record["contentType"], str)
            or not re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+", record["contentType"])):
        raise ValueError("invalid shared media record")
    return record


class SharedMediaResolver:
    """Bounded per-release control reader, also used by the prerender S3 adapter."""
    def __init__(self, control, release_id, manifest_raw):
        self.control, self.release_id = control, release_id
        self.prefix = descriptor_key(release_id).rsplit("/", 1)[0] + "/"
        raw = control(descriptor_key(release_id))
        self.descriptor = None
        self.cache = {}
        if raw is None:
            return
        value = _json(raw)
        if (value.get("schemaVersion") != 1 or value.get("layout") != LAYOUT
                or value.get("releaseId") != release_id
                or value.get("manifestSha256") != digest(manifest_raw)
                or not isinstance(value.get("inventorySha256"), str)
                or not SHA256.fullmatch(value["inventorySha256"])
                or not isinstance(value.get("shards"), dict) or len(value["shards"]) > 16):
            raise ValueError("shared media descriptor binding mismatch")
        for name, spec in value["shards"].items():
            if (not re.fullmatch("[a-f0-9]", name) or not isinstance(spec, dict)
                    or set(spec) != {"sha256", "bytes"} or not isinstance(spec["sha256"], str)
                    or not SHA256.fullmatch(spec["sha256"]) or type(spec["bytes"]) is not int
                    or not 0 < spec["bytes"] <= MAX_INDEX):
                raise ValueError("invalid shared media shard descriptor")
        self.descriptor = value

    def shard(self, name):
        if name in self.cache:
            return self.cache[name]
        spec = self.descriptor["shards"].get(name)
        if spec is None:
            return {}
        raw = self.control(self.prefix + name + ".json")
        if raw is None or len(raw) != spec["bytes"] or digest(raw) != spec["sha256"]:
            raise ValueError("shared media shard is missing or damaged")
        value = _json(raw)
        files = value.get("files")
        if (value.get("schemaVersion") != 1 or value.get("releaseId") != self.release_id
                or not isinstance(files, dict) or len(files) > MAX_FILES):
            raise ValueError("invalid shared media shard")
        for path, record in files.items():
            check_public_path(path)
            if not is_shared(path) or shard_name(path) != name:
                raise ValueError("invalid shared media logical path")
            _record(record)
        self.cache[name] = files
        return files

    def resolve(self, name):
        check_public_path(name)
        if self.descriptor is None or not is_shared(name):
            return None
        record = self.shard(shard_name(name)).get(name)
        if record is None:
            raise FileNotFoundError("shared media path is absent")
        return {**record, "key": blob_key(record["sha256"])}

    def all_records(self):
        if self.descriptor is None:
            return {}
        files = {}
        for name in self.descriptor["shards"]:
            files.update(self.shard(name))
            if len(files) > MAX_FILES:
                raise ValueError("shared media inventory exceeds limit")
        return files


def _control(bucket):
    def read(key):
        value = bucket.get(key)
        return value[0] if value else None
    return read


def _verified_etag(bucket, key, sha, size):
    if hasattr(bucket, "verified_etag"):
        return bucket.verified_etag(key, sha, size)
    value = bucket.get(key)
    return value[1] if value and len(value[0]) == size and digest(value[0]) == sha else None


def _immutable(bucket, key, raw, *, mime="application/json"):
    if len(raw) > MAX_INDEX:
        raise ValueError("shared media control object exceeds limit")
    old = bucket.get(key)
    if old is None:
        bucket.put_new(key, raw, content_type=mime, cache_control="public, max-age=31536000, immutable", sha256=digest(raw))
        old = bucket.get(key)
    if old is None or old[0] != raw:
        raise ValueError("immutable shared media index differs")


def _catalogs(bucket, release_id, manifest_raw):
    read = _control(bucket)
    candidates = {release_id: manifest_raw}
    # Both regions may reuse each other's already verified immutable bytes.
    for key in ("content/current.json", "content/previous.json", "content/jp/current.json", "content/jp/previous.json"):
        pointer_raw = read(key)
        if pointer_raw is None:
            continue
        pointer = _json(pointer_raw)
        match = re.fullmatch(r"/content/releases/([a-f0-9]{24})/manifest.json", pointer.get("manifest", ""))
        if pointer.get("schemaVersion") != 1 or not match or not isinstance(pointer.get("sha256"), str) or not SHA256.fullmatch(pointer["sha256"]):
            raise ValueError("invalid shared media reuse pointer")
        raw = read(pointer["manifest"].lstrip("/"))
        if raw is None or digest(raw) != pointer["sha256"]:
            raise ValueError("shared media reuse manifest is missing or damaged")
        candidates[match[1]] = raw
    known = {}
    for identifier, raw in candidates.items():
        resolver = SharedMediaResolver(read, identifier, raw)
        for record in resolver.all_records().values():
            key = blob_key(record["sha256"])
            value = (record["bytes"], record["etag"])
            if key in known and known[key] != value:
                raise ValueError("conflicting shared media validation records")
            known[key] = value
    return known


def upload(bucket, release, pointer_bytes, manifest, files, workers, progress=None):
    release_id = manifest["root"].split("/")[-2]
    base = f"content/releases/{release_id}/"
    manifest_raw = (release / "manifest.json").read_bytes()
    old_descriptor = bucket.get(descriptor_key(release_id))
    if old_descriptor is None and bucket.get(base + "manifest.json") is not None:
        raise ValueError("existing direct release cannot change its storage layout")
    known = _catalogs(bucket, release_id, manifest_raw)
    # Listing compares present object identities with previous complete readbacks.
    present = bucket.list_identities("content/blobs/") if known else {}
    media = {name: sha for name, sha in files.items() if is_shared(name)}
    unique = {}
    for name, sha in media.items():
        path = release / name
        size = path.stat().st_size
        if sha in unique and unique[sha][1] != size:
            raise ValueError("inconsistent shared media size")
        unique[sha] = (path, size)

    def transfer(item):
        sha, (path, size) = item
        key = blob_key(sha)
        if key in known and known[key][0] == size and present.get(key) == known[key]:
            return sha, known[key][1], False, True
        etag = _verified_etag(bucket, key, sha, size)
        created = False
        if etag is None:
            opts = dict(content_type="application/octet-stream", cache_control="public, max-age=31536000, immutable", sha256=sha)
            created = (bucket.put_file_new(key, path, size=size, **opts) if hasattr(bucket, "put_file_new")
                       else bucket.put_new(key, path.read_bytes(), **opts))
            etag = _verified_etag(bucket, key, sha, size)
            if etag is None:
                raise ValueError("immutable shared media blob has different bytes")
        _record({"sha256": sha, "bytes": size, "etag": etag, "contentType": "application/octet-stream"})
        return sha, etag, created, False

    outcomes = _run_bounded(sorted(unique.items()), transfer, workers, progress=progress)
    identities = {sha: etag for sha, etag, _, _ in outcomes}
    shards = {}
    for name, sha in sorted(media.items()):
        record = {"sha256": sha, "bytes": (release / name).stat().st_size,
                  "etag": identities[sha], "contentType": mimetypes.guess_type(name)[0] or "application/octet-stream"}
        shards.setdefault(shard_name(name), {})[name] = _record(record)

    def direct(item):
        name, sha = item
        path = release / name
        size = path.stat().st_size
        key = base + name
        if same_object(bucket, key, sha, size):
            return False
        opts = dict(content_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
                    cache_control="public, max-age=31536000, immutable", sha256=sha)
        created = (bucket.put_file_new(key, path, size=size, **opts) if hasattr(bucket, "put_file_new")
                   else bucket.put_new(key, path.read_bytes(), **opts))
        if not same_object(bucket, key, sha, size):
            raise ValueError("immutable R2 content key has different bytes")
        return created

    direct_outcomes = _run_bounded(sorted((name, sha) for name, sha in files.items()
                                         if not is_shared(name) and name != "manifest.json"), direct, workers, progress=progress)
    from tools.content_publication import verify_tree
    verify_tree(release, files, exclude=(".receipt.json",))
    descriptor = {"schemaVersion": 1, "layout": LAYOUT, "releaseId": release_id,
                  "manifestSha256": digest(manifest_raw), "inventorySha256": digest(canonical(files)), "shards": {}}
    prefix = descriptor_key(release_id).rsplit("/", 1)[0] + "/"
    for name, records in sorted(shards.items()):
        raw = canonical({"schemaVersion": 1, "releaseId": release_id, "files": records})
        _immutable(bucket, prefix + name + ".json", raw)
        descriptor["shards"][name] = {"sha256": digest(raw), "bytes": len(raw)}
    _immutable(bucket, descriptor_key(release_id), canonical(descriptor))
    direct_outcomes.append(direct(("manifest.json", files["manifest.json"])))
    return {"region": manifest.get("region", "global"), "releaseId": release_id,
            "pointerSha256": digest(pointer_bytes), "files": len(files), "layout": LAYOUT,
            "uploaded": sum(direct_outcomes) + sum(row[2] for row in outcomes),
            "reused": len(direct_outcomes) - sum(direct_outcomes) + sum(not row[2] for row in outcomes),
            "mediaFiles": len(media), "uniqueMedia": len(unique), "mediaWithoutReadback": sum(row[3] for row in outcomes)}


def verify_release(bucket, release, manifest, files, workers, progress=None):
    """Validate the complete logical inventory before pointer CAS; legacy fallback."""
    release_id = manifest["root"].split("/")[-2]
    resolver = SharedMediaResolver(_control(bucket), release_id, (release / "manifest.json").read_bytes())
    if resolver.descriptor is None:
        return False
    if resolver.descriptor["inventorySha256"] != digest(canonical(files)):
        raise ValueError("shared media inventory binding mismatch")
    media = resolver.all_records()
    expected = {name: sha for name, sha in files.items() if is_shared(name)}
    if set(media) != set(expected):
        raise ValueError("shared media inventory is incomplete")
    present = bucket.list_identities("content/blobs/")
    for name, record in media.items():
        size = (release / name).stat().st_size
        if record["sha256"] != expected[name] or record["bytes"] != size:
            raise ValueError("shared media inventory differs from local content")
        if present.get(blob_key(record["sha256"])) != (size, record["etag"]):
            raise ValueError("verified shared media object is missing or changed")
    base = f"content/releases/{release_id}/"
    def verify(item):
        name, sha = item
        if not same_object(bucket, base + name, sha, (release / name).stat().st_size):
            raise ValueError("R2 release is incomplete or changed")
    _run_bounded(((name, sha) for name, sha in files.items() if not is_shared(name)), verify, workers, progress=progress)
    return True
