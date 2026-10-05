"""Checkpoint private updater inputs and state on an immutable R2 object graph.

The caller supplies a finite set of paths relative to a stable, absolute ROOT.
Restores require that exact canonical ROOT: existing updater JSON records contain
absolute paths and are deliberately not rewritten. The caller must include every
file those records refer to. This module does not decide which game inputs belong
in a checkpoint, and must only be used with the private state bucket.
"""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from uuid import uuid4

SHA256 = re.compile(r"[a-f0-9]{64}\Z")
REGIONS = {"global", "jp"}
CHUNK = 1024 * 1024
SMALL_LIMIT = 16 * 1024 * 1024
MANIFEST_LIMIT = 128 * 1024 * 1024
MAX_WORKERS = 16
MAX_LIST_PAGES = 1000


def worker_count(raw: int) -> int:
    if type(raw) is not int or not 1 <= raw <= MAX_WORKERS:
        raise ValueError(f"workers must be between 1 and {MAX_WORKERS}")
    return raw


def _run_bounded(items, task, workers: int) -> list:
    """Run at most twice the worker count in flight, joining before return/error."""
    workers = worker_count(workers)
    if workers == 1:
        return [task(item) for item in items]
    source = iter(items)
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = set()
        for _ in range(workers * 2):
            try:
                pending.add(pool.submit(task, next(source)))
            except StopIteration:
                break
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                results.append(future.result())
                try:
                    pending.add(pool.submit(task, next(source)))
                except StopIteration:
                    pass
    return results


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> tuple[str, int]:
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            sha.update(chunk)
            size += len(chunk)
    return sha.hexdigest(), size


def region_name(region: str) -> str:
    if region not in REGIONS:
        raise ValueError("unsupported state region")
    return region


def safe_relative(raw: str) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        raise ValueError("unsafe checkpoint path")
    parts = raw.split("/")
    if any(part in {"", ".", ".."} for part in parts) or PurePosixPath(raw).is_absolute():
        raise ValueError("unsafe checkpoint path")
    if parts[0].startswith(".r2-state-stage-"):
        raise ValueError("checkpoint cannot include restore staging")
    return raw


def stable_root(root: Path) -> Path:
    root = Path(root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError("ROOT must be an existing absolute directory, not a symlink")
    resolved = root.resolve(strict=True)
    if resolved != root:
        raise ValueError("ROOT must be canonical and identical across Actions runs")
    return root


def _inside(root: Path, relative: str) -> Path:
    relative = safe_relative(relative)
    path = root
    for part in relative.split("/"):
        path = path / part
        if path.is_symlink():
            raise ValueError("symlink in checkpoint path")
    if not path.is_relative_to(root):
        raise ValueError("checkpoint path escaped ROOT")
    return path


def inventory(root: Path, selections: list[str]) -> tuple[list[str], list[dict]]:
    if not selections:
        raise ValueError("at least one checkpoint path is required")
    directories: set[str] = set()
    files: dict[str, dict] = {}
    for raw in selections:
        name = safe_relative(raw)
        path = _inside(root, name)
        if not path.exists():
            raise ValueError(f"checkpoint path missing: {name}")
        for candidate in [path, *path.rglob("*")] if path.is_dir() else [path]:
            relative = candidate.relative_to(root).as_posix()
            _inside(root, relative)
            mode = candidate.lstat().st_mode
            if stat.S_ISDIR(mode):
                directories.add(relative)
            elif stat.S_ISREG(mode):
                sha, size = hash_file(candidate)
                files[relative] = {"path": relative, "sha256": sha, "size": size}
            else:
                raise ValueError(f"unsupported checkpoint file type: {relative}")
    if not files:
        raise ValueError("checkpoint has no regular files")
    ordered = [files[name] for name in sorted(files)]
    first_by_inode: dict[tuple[int, int], str] = {}
    for entry in ordered:
        source = _inside(root, entry["path"])
        mode = source.lstat()
        if not stat.S_ISREG(mode.st_mode):
            raise ValueError(f"checkpoint source changed: {entry['path']}")
        inode = (mode.st_dev, mode.st_ino)
        first = first_by_inode.get(inode)
        if first is None:
            first_by_inode[inode] = entry["path"]
        else:
            if (files[first]["sha256"], files[first]["size"]) != (entry["sha256"], entry["size"]):
                raise ValueError("hard-linked checkpoint source changed during inventory")
            entry["hardlinkTo"] = first
    return sorted(directories), ordered


def object_key(sha: str) -> str:
    if not isinstance(sha, str) or not SHA256.fullmatch(sha):
        raise ValueError("invalid object SHA-256")
    return f"state/objects/{sha}"


def pointer_key(region: str) -> str:
    return f"state/{region_name(region)}/current.json"


def _pointer(bucket, region: str) -> tuple[dict | None, str, str | None]:
    item = bucket.read_small(pointer_key(region))
    if item is None:
        return None, "none", None
    data, etag = item
    pointer = json.loads(data)
    if not isinstance(pointer, dict) or pointer.get("schemaVersion") != 1 or pointer.get("region") != region:
        raise ValueError("invalid private state pointer")
    sha = pointer.get("sha256")
    if not isinstance(sha, str) or not SHA256.fullmatch(sha) or pointer.get("manifest") != f"state/manifests/{region}/{sha}.json":
        raise ValueError("invalid private state manifest reference")
    return pointer, digest(data), etag


def current_sha(bucket, region: str) -> str:
    return _pointer(bucket, region_name(region))[1]


def _verification_identity(bucket):
    identity = getattr(bucket, "verification_identity", None)
    listing = getattr(bucket, "list_verified_objects", None)
    if not callable(identity) or not callable(listing):
        return None
    try:
        value = identity()
    except NotImplementedError:
        return None
    return value if isinstance(value, str) and value else None


def _verification_cache_path(raw: Path, root: Path) -> Path:
    path = Path(raw)
    if (not path.is_absolute() or path.resolve() != path or path.is_relative_to(root)
            or not path.parent.is_dir()):
        raise ValueError("verification cache must be a canonical path outside ROOT")
    if path.exists():
        _check_cache_stat(path.lstat())
    return path


def _check_cache_stat(info):
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.geteuid() or info.st_nlink != 1):
        raise ValueError("verification cache must be a private owned regular file with mode 600")


def _etag(value) -> bool:
    # ETags are opaque version validators, never substitutes for a first SHA read.
    return isinstance(value, str) and 0 < len(value) <= 1024 and not any(ord(c) < 32 for c in value)


def _write_verification_cache(path: Path, value: dict):
    data = canonical(value)
    if len(data) > MANIFEST_LIMIT:
        raise ValueError("verification cache is too large")
    temporary = path.with_name(path.name + ".tmp-" + uuid4().hex)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _verified_reuse(bucket, root: Path, recorded_root: Path, region: str, paths: list[str],
                    expected_current: str, raw_cache: Path | None) -> dict:
    identity = _verification_identity(bucket) if raw_cache is not None else None
    if identity is None:
        return {}
    cache = _verification_cache_path(raw_cache, root)
    if not cache.exists():
        return {}
    fd = os.open(cache, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        _check_cache_stat(os.fstat(stream.fileno()))
        data = stream.read(MANIFEST_LIMIT + 1)
    if len(data) > MANIFEST_LIMIT:
        raise ValueError("verification cache is too large")
    proof = json.loads(data)
    if (not isinstance(proof, dict) or proof.get("schemaVersion") != 1
            or proof.get("bucketIdentity") != identity or proof.get("root") != str(root)
            or recorded_root != root or proof.get("region") != region
            or proof.get("selections") != sorted(set(paths))
            or proof.get("pointerSha256") != expected_current):
        raise ValueError("verification cache belongs to another bucket, ROOT, region, or baseline")
    pointer, actual, _ = _pointer(bucket, region)
    if (pointer is None or actual != expected_current
            or proof.get("manifestSha256") != pointer["sha256"]):
        raise ValueError("verification cache manifest or pointer baseline differs")
    objects = proof.get("objects")
    if not isinstance(objects, dict):
        raise ValueError("invalid verification cache objects")
    for key, item in objects.items():
        if (not isinstance(item, dict) or key != object_key(item.get("sha256"))
                or type(item.get("size")) is not int or item["size"] < 0 or not _etag(item.get("etag"))):
            raise ValueError("invalid verification cache object evidence")
    if not objects:
        return {}
    try:
        listed = bucket.list_verified_objects(set(objects))
    except NotImplementedError:
        return {}
    return {key: item for key, item in objects.items()
            if listed.get(key) == {"size": item["size"], "etag": item["etag"]}}


def _manifest(bucket, root: Path, region: str, expected_paths: list[str], *, with_reference=False):
    pointer, pointer_sha, _ = _pointer(bucket, region)
    if pointer is None:
        raise ValueError("private state pointer is missing")
    item = bucket.read_manifest(pointer["manifest"])
    if item is None or digest(item[0]) != pointer["sha256"]:
        raise ValueError("private state manifest missing or damaged")
    manifest = json.loads(item[0])
    if (not isinstance(manifest, dict) or manifest.get("schemaVersion") not in (1, 2)
            or manifest.get("region") != region or manifest.get("root") != str(root)):
        raise ValueError("private state belongs to another ROOT or region")
    expected = sorted(set(safe_relative(name) for name in expected_paths))
    if not expected or manifest.get("selections") != expected:
        raise ValueError("private state selections differ from the restore allowlist")
    directories, files = manifest.get("directories"), manifest.get("files")
    if not isinstance(directories, list) or not isinstance(files, list) or not files:
        raise ValueError("invalid private state inventory")
    seen: set[str] = set()
    for directory in directories:
        if not isinstance(directory, str):
            raise ValueError("invalid private state directory")
        safe_relative(directory)
        if directory in seen:
            raise ValueError("duplicate private state path")
        if not any(directory == name or directory.startswith(name + "/") for name in expected):
            raise ValueError("private state directory outside restore allowlist")
        seen.add(directory)
    file_by_path: dict[str, dict] = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ValueError("invalid private state file")
        safe_relative(entry["path"])
        if (entry["path"] in seen or not isinstance(entry.get("sha256"), str)
                or not SHA256.fullmatch(entry["sha256"]) or type(entry.get("size")) is not int
                or entry["size"] < 0):
            raise ValueError("invalid or duplicate private state file")
        if not any(entry["path"] == name or entry["path"].startswith(name + "/") for name in expected):
            raise ValueError("private state file outside restore allowlist")
        link_to = entry.get("hardlinkTo")
        if link_to is not None:
            if manifest["schemaVersion"] != 2 or not isinstance(link_to, str):
                raise ValueError("invalid private state hard link")
            source = file_by_path.get(link_to)
            if (source is None or source.get("hardlinkTo") is not None
                    or (source["sha256"], source["size"]) != (entry["sha256"], entry["size"])):
                raise ValueError("invalid private state hard link")
        file_by_path[entry["path"]] = entry
        seen.add(entry["path"])
    if with_reference:
        return manifest, {"pointerSha256": pointer_sha, "manifestSha256": pointer["sha256"]}
    return manifest


def checkpoint(bucket, root: Path, region: str, paths: list[str], expected_current: str,
               recorded_root: Path | None = None, *, workers: int = 1,
               verification_cache: Path | None = None) -> dict:
    root = stable_root(root)
    worker_count(workers)
    if recorded_root is None:
        recorded_root = root
    else:
        recorded_root = Path(recorded_root)
        if (not recorded_root.is_absolute() or str(recorded_root) != os.path.normpath(str(recorded_root))
                or recorded_root.is_symlink()):
            raise ValueError("recorded ROOT must be an absolute canonical path")
    region_name(region)
    if expected_current != "none" and not SHA256.fullmatch(expected_current):
        raise ValueError("expected current must be 'none' or SHA-256")
    paths = [safe_relative(name) for name in paths]
    directories, files = inventory(root, paths)
    manifest = {"schemaVersion": 2, "region": region, "root": str(recorded_root),
                "selections": sorted(set(paths)), "directories": directories, "files": files}
    manifest_bytes = canonical(manifest)
    if len(manifest_bytes) > MANIFEST_LIMIT:
        raise ValueError("private state manifest is too large")
    unique_objects: dict[tuple[str, int], dict] = {}
    for entry in files:
        identity = (entry["sha256"], entry["size"])
        unique_objects.setdefault(identity, entry)
    verified = _verified_reuse(bucket, root, recorded_root, region, paths, expected_current,
                               verification_cache)
    verified_reuse = 0
    for sha, size in unique_objects:
        item = verified.get(object_key(sha))
        if item is not None and (item["sha256"], item["size"]) == (sha, size):
            verified_reuse += 1

    def upload_and_verify(entry):
        path = _inside(root, entry["path"])
        key = object_key(entry["sha256"])
        evidence = verified.get(key)
        if evidence is not None and (evidence["sha256"], evidence["size"]) == (entry["sha256"], entry["size"]):
            return False
        if bucket.verify_file(key, entry["sha256"], entry["size"]):
            return False
        created = bucket.put_file_new(key, path, entry["sha256"], entry["size"])
        if not bucket.verify_file(key, entry["sha256"], entry["size"]):
            raise ValueError("private state object missing or damaged")
        return created

    transferred = _run_bounded(unique_objects.values(), upload_and_verify, workers)
    uploaded = sum(transferred)
    reused = len(files) - uploaded
    # A mutable source is checked again only after every remote transfer has joined.
    for entry in files:
        path = _inside(root, entry["path"])
        if hash_file(path) != (entry["sha256"], entry["size"]):
            raise ValueError("checkpoint source changed during upload")
        if "hardlinkTo" in entry:
            original = _inside(root, entry["hardlinkTo"])
            source_stat, original_stat = path.lstat(), original.lstat()
            if ((source_stat.st_dev, source_stat.st_ino) !=
                    (original_stat.st_dev, original_stat.st_ino)):
                raise ValueError("hard-linked checkpoint source changed during upload")
    manifest_sha = digest(manifest_bytes)
    manifest_key = f"state/manifests/{region}/{manifest_sha}.json"
    existing_manifest = bucket.read_manifest(manifest_key)
    if existing_manifest is None or existing_manifest[0] != manifest_bytes:
        if not bucket.put_manifest_new(manifest_key, manifest_bytes):
            item = bucket.read_manifest(manifest_key)
            if item is None or item[0] != manifest_bytes:
                raise ValueError("immutable private state manifest conflict")
    item = bucket.read_manifest(manifest_key)
    if item is None or item[0] != manifest_bytes:
        raise ValueError("private state manifest readback failed")
    pointer = canonical({"schemaVersion": 1, "region": region, "manifest": manifest_key,
                         "sha256": manifest_sha})
    _, actual, etag = _pointer(bucket, region)
    if actual != expected_current:
        raise ValueError("private state pointer differs from expected baseline")
    if actual == digest(pointer):
        return {"status": "unchanged", "region": region, "manifestSha256": manifest_sha,
                "files": len(files), "uploaded": uploaded, "reused": reused, "verifiedReuse": verified_reuse}
    bucket.replace_small(pointer_key(region), pointer, etag)
    return {"status": "checkpointed", "region": region, "manifestSha256": manifest_sha,
            "pointerSha256": digest(pointer), "files": len(files), "uploaded": uploaded, "reused": reused,
            "verifiedReuse": verified_reuse}


def restore(bucket, root: Path, region: str, expected_paths: list[str], *, workers: int = 1,
            verification_cache: Path | None = None) -> dict:
    root = stable_root(root)
    worker_count(workers)
    region_name(region)
    cache = _verification_cache_path(verification_cache, root) if verification_cache is not None else None
    if cache is not None:
        # A failed restore must not leave reusable evidence from an earlier attempt.
        cache.unlink(missing_ok=True)
    bucket_identity = _verification_identity(bucket) if cache is not None else None
    manifest, reference = _manifest(bucket, root, region, expected_paths, with_reference=True)
    directories = manifest["directories"]
    files = manifest["files"]
    for name in directories:
        path = _inside(root, name)
        if path.exists() and not path.is_dir():
            raise ValueError("restore directory collides with a local file")
    for entry in files:
        if _inside(root, entry["path"]).exists():
            raise ValueError("restore requires absent destination files")
    stage = root / f".r2-state-stage-{uuid4().hex}"
    stage.mkdir(mode=0o700)
    try:
        import shutil
        staged_objects: dict[tuple[str, int], Path] = {}
        download_entries = []
        for entry in files:
            if "hardlinkTo" not in entry:
                identity = (entry["sha256"], entry["size"])
                if identity not in staged_objects:
                    target = stage / entry["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    staged_objects[identity] = target
                    download_entries.append(entry)

        def download(entry):
            identity = (entry["sha256"], entry["size"])
            target = staged_objects[identity]
            evidence = bucket.download_file(object_key(entry["sha256"]), target, entry["sha256"], entry["size"])
            if hash_file(target) != identity:
                raise ValueError("private state object missing or damaged")
            if (isinstance(evidence, dict) and evidence.get("sha256") == entry["sha256"]
                    and type(evidence.get("size")) is int and evidence["size"] == entry["size"]
                    and _etag(evidence.get("etag"))):
                return object_key(entry["sha256"]), {"sha256": entry["sha256"], "size": entry["size"],
                                                    "etag": evidence["etag"]}
            return None

        # All independent remote objects finish and pass local checks first.
        verified_objects = dict(item for item in _run_bounded(download_entries, download, workers) if item is not None)
        for entry in files:
            target = stage / entry["path"]
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            link_to = entry.get("hardlinkTo")
            if link_to is not None:
                os.link(stage / link_to, target)
            else:
                shutil.copyfile(staged_objects[(entry["sha256"], entry["size"])], target)
        # All remote bytes are verified before any destination is changed.
        for name in directories:
            _inside(root, name).mkdir(parents=True, exist_ok=True)
        for entry in files:
            destination = _inside(root, entry["path"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise ValueError("restore destination changed during download")
            os.replace(stage / entry["path"], destination)
    finally:
        shutil.rmtree(stage)
    if cache is not None and bucket_identity is not None:
        _write_verification_cache(cache, {"schemaVersion": 1, "bucketIdentity": bucket_identity,
                                        "root": str(root), "region": region, "selections": manifest["selections"],
                                        **reference, "objects": verified_objects})
    return {"status": "restored", "region": region, "files": len(files),
            "manifestSha256": digest(canonical(manifest))}


def inspect(bucket, root: Path, region: str, expected_paths: list[str]) -> dict:
    """Read a verified manifest before allocating space for a restore."""
    root = stable_root(root)
    manifest = _manifest(bucket, root, region_name(region), expected_paths)
    return {"status": "ready", "region": region, "files": len(manifest["files"]),
            "totalBytes": sum(entry["size"] for entry in manifest["files"]),
            "requiredBytes": sum(entry["size"] for entry in manifest["files"] if "hardlinkTo" not in entry),
            "manifestSha256": digest(canonical(manifest))}


class PrivateS3Bucket:
    """Streaming S3 adapter; boto3 is only required for live R2 operations."""

    def __init__(self, client, bucket: str):
        self.client, self.bucket = client, bucket

    def verification_identity(self):
        endpoint = getattr(getattr(self.client, "meta", None), "endpoint_url", None)
        if not isinstance(endpoint, str) or not endpoint or not self.bucket:
            return None
        return digest(canonical({"endpoint": endpoint, "bucket": self.bucket}))

    def list_verified_objects(self, keys: set[str]) -> dict:
        """Fetch fresh opaque validators, retaining only previously verified keys."""
        result = {}
        token = None
        seen_tokens = set()
        for _ in range(MAX_LIST_PAGES):
            options = {"ContinuationToken": token} if token is not None else {}
            page = self.client.list_objects_v2(Bucket=self.bucket, Prefix="state/objects/",
                                               MaxKeys=1000, **options)
            entries = page.get("Contents", [])
            if not isinstance(entries, list) or len(entries) > 1000 or type(page.get("IsTruncated")) is not bool:
                raise ValueError("invalid private state object listing")
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("Key"), str):
                    raise ValueError("invalid private state listed object")
                key = entry["Key"]
                if key not in keys:
                    continue
                if key in result:
                    raise ValueError("duplicate private state object listing")
                if type(entry.get("Size")) is int and entry["Size"] >= 0 and _etag(entry.get("ETag")):
                    result[key] = {"size": entry["Size"], "etag": entry["ETag"]}
            if not page["IsTruncated"]:
                return result
            token = page.get("NextContinuationToken")
            if not isinstance(token, str) or not token or token in seen_tokens:
                raise ValueError("invalid private state listing continuation")
            seen_tokens.add(token)
        raise ValueError("private state object listing exceeds page limit")

    @classmethod
    def from_environment(cls, workers: int = 1):
        import boto3
        from botocore.config import Config
        workers = worker_count(workers)
        account = os.environ["R2_ACCOUNT_ID"]
        client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                              aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                              aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                              region_name="auto", config=Config(signature_version="s3v4",
                              retries={"mode": "standard", "max_attempts": 5},
                              max_pool_connections=workers))
        return cls(client, os.environ["R2_PRIVATE_BUCKET"])

    @staticmethod
    def _code(error):
        return error.response.get("Error", {}).get("Code", "")

    @classmethod
    def _missing(cls, error):
        return cls._code(error) in {"404", "NoSuchKey", "NotFound"}

    @classmethod
    def _precondition(cls, error):
        return error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412

    def _read_control(self, key: str, limit: int):
        from botocore.exceptions import ClientError
        try:
            result = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return None
            raise
        body = result["Body"]
        try:
            data = body.read(limit + 1)
        finally:
            body.close()
        if len(data) > limit:
            raise ValueError("private state control object is too large")
        return data, result["ETag"]

    def read_small(self, key: str):
        return self._read_control(key, SMALL_LIMIT)

    def read_manifest(self, key: str):
        return self._read_control(key, MANIFEST_LIMIT)

    def _put_control_new(self, key: str, data: bytes, limit: int) -> bool:
        from botocore.exceptions import ClientError
        if len(data) > limit:
            raise ValueError("private state control object is too large")
        try:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data),
                                   ContentType="application/json", CacheControl="no-store", IfNoneMatch="*")
            return True
        except ClientError as error:
            if self._precondition(error):
                return False
            raise

    def put_small_new(self, key: str, data: bytes) -> bool:
        return self._put_control_new(key, data, SMALL_LIMIT)

    def put_manifest_new(self, key: str, data: bytes) -> bool:
        return self._put_control_new(key, data, MANIFEST_LIMIT)

    def replace_small(self, key: str, data: bytes, etag: str | None) -> None:
        from botocore.exceptions import ClientError
        condition = {"IfMatch": etag} if etag is not None else {"IfNoneMatch": "*"}
        try:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data),
                                   ContentType="application/json", CacheControl="no-store", **condition)
        except ClientError as error:
            if self._precondition(error):
                raise ValueError("private state pointer changed during checkpoint") from None
            raise

    def put_file_new(self, key: str, path: Path, sha: str, size: int) -> bool:
        from botocore.exceptions import ClientError
        try:
            with path.open("rb") as stream:
                self.client.put_object(Bucket=self.bucket, Key=key, Body=stream, ContentLength=size,
                                       ContentType="application/octet-stream", CacheControl="no-store",
                                       Metadata={"sha256": sha}, IfNoneMatch="*")
            return True
        except ClientError as error:
            if self._precondition(error):
                return False
            raise

    def _stream(self, key: str, target: Path | None, sha: str, size: int, *, verification=False):
        from botocore.exceptions import ClientError
        try:
            result = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return False
            raise
        body = result["Body"]
        hasher = hashlib.sha256()
        count = 0
        try:
            if target is None:
                while chunk := body.read(CHUNK):
                    hasher.update(chunk)
                    count += len(chunk)
                    if count > size:
                        return False
            else:
                with target.open("xb") as output:
                    while chunk := body.read(CHUNK):
                        hasher.update(chunk)
                        count += len(chunk)
                        if count > size:
                            raise ValueError("private state object exceeds expected size")
                        output.write(chunk)
        finally:
            body.close()
        if count != size or hasher.hexdigest() != sha:
            return False
        # Only metadata from this exact, fully SHA-verified GET is reusable.
        # S3 user Metadata and object names alone never establish byte integrity.
        if (verification and type(result.get("ContentLength")) is int and result["ContentLength"] == size
                and _etag(result.get("ETag"))):
            return {"sha256": sha, "size": size, "etag": result["ETag"]}
        return True

    def verify_file(self, key: str, sha: str, size: int) -> bool:
        return self._stream(key, None, sha, size)

    def download_file(self, key: str, target: Path, sha: str, size: int) -> dict | None:
        evidence = self._stream(key, target, sha, size, verification=True)
        if not evidence:
            raise ValueError("private state object missing or damaged")
        return evidence if isinstance(evidence, dict) else None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("current", "checkpoint", "restore", "inspect"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--region", choices=sorted(REGIONS), required=True)
    parser.add_argument("--path", action="append", default=[], help="ROOT-relative input path; repeat as needed")
    parser.add_argument("--expected-current", help="current pointer SHA-256 or 'none' for the first checkpoint")
    parser.add_argument("--recorded-root", type=Path,
                        help="checkpoint only: ROOT to record for Actions restore when source files are staged locally")
    parser.add_argument("--workers", type=int, default=1,
                        help=f"parallel object transfers for checkpoint/restore (1-{MAX_WORKERS}; default: 1)")
    parser.add_argument("--verification-cache", type=Path,
                        help="private same-run restore evidence file outside ROOT, reused by checkpoint")
    args = parser.parse_args(argv)
    try:
        worker_count(args.workers)
        if args.verification_cache is not None and args.action not in {"restore", "checkpoint"}:
            parser.error("--verification-cache is only valid for restore/checkpoint")
        bucket = PrivateS3Bucket.from_environment(args.workers)
        if args.action == "current":
            if args.recorded_root is not None:
                parser.error("--recorded-root is only valid for checkpoint")
            result = {"region": args.region, "currentSha256": current_sha(bucket, args.region)}
        elif args.action == "checkpoint":
            if args.expected_current is None:
                parser.error("checkpoint requires --expected-current")
            result = checkpoint(bucket, args.root, args.region, args.path, args.expected_current,
                                args.recorded_root, workers=args.workers, verification_cache=args.verification_cache)
        elif args.action == "restore":
            if args.recorded_root is not None:
                parser.error("--recorded-root is only valid for checkpoint")
            result = restore(bucket, args.root, args.region, args.path, workers=args.workers,
                             verification_cache=args.verification_cache)
        else:
            if args.recorded_root is not None:
                parser.error("--recorded-root is only valid for checkpoint")
            result = inspect(bucket, args.root, args.region, args.path)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
