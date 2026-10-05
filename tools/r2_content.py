"""Upload sealed public content to R2, then conditionally promote its pointer.

The bucket stays private. A separate read-only Worker serves the approved keys.
No production credentials or game inputs belong in this module or its output.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

from tools.content_publication import verify_tree
from tools.global_remote_sync import file_hash, read_json

RELEASE = re.compile(r"[a-f0-9]{24}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
SAFE_FILE = re.compile(r"[A-Za-z0-9_./()\-]+\Z")
PUBLIC_ROOTS = {"en", "zh-CN", "public", "recognition"}
SMALL_LIMIT = 16 * 1024 * 1024
MAX_WORKERS = 16


def worker_count(raw: int) -> int:
    if type(raw) is not int or not 1 <= raw <= MAX_WORKERS:
        raise ValueError(f"workers must be between 1 and {MAX_WORKERS}")
    return raw


def _run_bounded(items, task, workers: int) -> list:
    """Limit queued transfers and join every started worker before returning."""
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


def pointer_key(region: str) -> str:
    if region not in {"global", "jp"}:
        raise ValueError("unsupported content region")
    return "content/current.json" if region == "global" else "content/jp/current.json"


def check_public_path(name: str) -> None:
    parts = name.split("/")
    if (not SAFE_FILE.fullmatch(name) or any(not part or part in {".", ".."} or part.startswith(".") for part in parts)
            or name.lower().endswith((".apk", ".secret", ".credentials"))):
        raise ValueError("unsafe public content path")
    if name != "manifest.json" and parts[0] not in PUBLIC_ROOTS:
        raise ValueError("unexpected public content path")


def sealed_release(store: Path, region: str) -> tuple[Path, bytes, dict, dict[str, str]]:
    store = Path(store).resolve()
    local_pointer = store / ("current.json" if region == "global" else "jp/current.json")
    pointer_bytes = local_pointer.read_bytes()
    pointer = json.loads(pointer_bytes)
    match = re.fullmatch(r"/content/releases/([a-f0-9]{24})/manifest\.json", pointer.get("manifest", ""))
    if pointer.get("schemaVersion") != 1 or not match or not SHA256.fullmatch(pointer.get("sha256", "")):
        raise ValueError("invalid local content pointer")
    release = store / "releases" / match[1]
    if release.is_symlink() or not release.is_dir() or release.resolve().parent != (store / "releases").resolve():
        raise ValueError("release is missing or linked")
    manifest_bytes = (release / "manifest.json").read_bytes()
    if digest(manifest_bytes) != pointer["sha256"]:
        raise ValueError("local manifest digest mismatch")
    manifest = json.loads(manifest_bytes)
    if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1
            or manifest.get("region", "global") != region
            or manifest.get("channel") != "production"
            or manifest.get("contentReleaseId") != pointer.get("contentReleaseId")
            or not isinstance(manifest.get("locales"), dict)
            or set(manifest["locales"]) != {"en", "zh-CN"}
            or manifest.get("root") != f"/content/releases/{match[1]}/"):
        raise ValueError("content manifest does not match region or release")
    receipt = read_json(release / ".receipt.json")
    files = receipt.get("files")
    if not isinstance(files, dict) or not files or any(not isinstance(name, str) or not isinstance(sha, str) or not SHA256.fullmatch(sha)
                                                     for name, sha in files.items()):
        raise ValueError("invalid sealed content inventory")
    verify_tree(release, files, exclude=(".receipt.json",))
    for name in files:
        check_public_path(name)
    if files.get("manifest.json") != pointer["sha256"]:
        raise ValueError("manifest missing from sealed inventory")
    return release, pointer_bytes, manifest, files


class S3Bucket:
    """Small conditional-object contract; boto3 is imported only for live use."""

    def __init__(self, client, bucket: str):
        self.client, self.bucket = client, bucket

    @classmethod
    def from_environment(cls, workers: int = 1):
        import boto3
        from botocore.config import Config
        workers = worker_count(workers)
        account = os.environ["R2_ACCOUNT_ID"]
        bucket = os.environ["R2_PUBLIC_BUCKET"]
        client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                              aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                              aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                              region_name="auto", config=Config(signature_version="s3v4",
                              retries={"mode": "standard", "max_attempts": 5},
                              max_pool_connections=workers))
        return cls(client, bucket)

    @staticmethod
    def _missing(error):
        code = error.response.get("Error", {}).get("Code", "")
        return code in {"404", "NoSuchKey", "NotFound"}

    def get(self, key: str) -> tuple[bytes, str] | None:
        from botocore.exceptions import ClientError
        try:
            result = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return None
            raise
        body = result["Body"]
        try:
            data = body.read(SMALL_LIMIT + 1)
        finally:
            body.close()
        if len(data) > SMALL_LIMIT:
            raise ValueError("R2 control object exceeds size limit")
        return data, result["ETag"]

    def matches(self, key: str, expected_sha: str, expected_size: int) -> bool:
        from botocore.exceptions import ClientError
        try:
            result = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return False
            raise
        stream = result['Body']
        checksum = hashlib.sha256()
        size = 0
        try:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(block)
                size += len(block)
        finally:
            stream.close()
        return size == expected_size and checksum.hexdigest() == expected_sha

    def put_new(self, key: str, data: bytes, *, content_type: str, cache_control: str, sha256: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data),
                                   ContentType=content_type, CacheControl=cache_control,
                                   ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(),
                                   Metadata={"sha256": sha256}, IfNoneMatch="*")
            return True
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412:
                return False
            raise

    def put_file_new(self, key: str, path: Path, *, content_type: str,
                     cache_control: str, sha256: str, size: int) -> bool:
        from botocore.exceptions import ClientError
        md5 = hashlib.md5()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                md5.update(block)
        try:
            with path.open('rb') as stream:
                self.client.put_object(Bucket=self.bucket, Key=key, Body=stream,
                                       ContentLength=size, ContentType=content_type,
                                       CacheControl=cache_control,
                                       ContentMD5=base64.b64encode(md5.digest()).decode(),
                                       Metadata={"sha256": sha256}, IfNoneMatch="*")
            return True
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412:
                return False
            raise

    def replace(self, key: str, data: bytes, etag: str | None, *, content_type: str, cache_control: str):
        from botocore.exceptions import ClientError
        condition = {"IfMatch": etag} if etag is not None else {"IfNoneMatch": "*"}
        try:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data),
                                   ContentType=content_type, CacheControl=cache_control,
                                   ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(),
                                   Metadata={"sha256": digest(data)}, **condition)
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412:
                raise ValueError("content pointer changed during publication") from None
            raise


def same_object(bucket, key: str, expected_sha: str, expected_size: int) -> bool:
    if hasattr(bucket, 'matches'):
        return bucket.matches(key, expected_sha, expected_size)
    existing = bucket.get(key)
    return existing is not None and len(existing[0]) == expected_size and digest(existing[0]) == expected_sha


def baseline(bucket, region: str) -> dict:
    current = bucket.get(pointer_key(region))
    if current is None:
        return {'region':region,'currentSha256':'none','pointer':None,
                'previousSha256':'none','previousPointer':None}
    raw = current[0]
    pointer = json.loads(raw)
    if (pointer.get('schemaVersion') != 1 or
            not re.fullmatch(r'/content/releases/[a-f0-9]{24}/manifest\.json', pointer.get('manifest', '')) or
            not SHA256.fullmatch(pointer.get('sha256', ''))):
        raise ValueError('R2 current pointer is invalid')
    previous_key = "content/previous.json" if region == "global" else "content/jp/previous.json"
    previous = bucket.get(previous_key)
    previous_raw = previous[0] if previous else None
    prior = json.loads(previous_raw) if previous_raw is not None else None
    if prior is not None and (not isinstance(prior, dict) or prior.get('schemaVersion') != 1 or
            not re.fullmatch(r'/content/releases/[a-f0-9]{24}/manifest\.json', prior.get('manifest', '')) or
            not SHA256.fullmatch(prior.get('sha256', ''))):
        raise ValueError('R2 previous pointer is invalid')
    return {'region':region,'currentSha256':digest(raw),'pointer':pointer,
            'previousSha256':digest(previous_raw) if previous_raw is not None else 'none',
            'previousPointer':prior}


def upload_release(bucket, store: Path, region: str, *, dry_run=False, workers: int = 1) -> dict:
    worker_count(workers)
    release, pointer_bytes, manifest, files = sealed_release(store, region)
    release_id = manifest["root"].split("/")[-2]
    base = f"content/releases/{release_id}/"
    if dry_run:
        return {"status": "verified_local", "region": region, "releaseId": release_id,
                "pointerSha256": digest(pointer_bytes), "files": len(files),
                "bytes": sum((release / name).stat().st_size for name in files)}
    def upload_and_verify(item):
        name, expected_sha = item
        key = base + name
        path = release / name
        if file_hash(path) != expected_sha:
            raise ValueError("sealed content changed during upload")
        size = path.stat().st_size
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        options = {"content_type": mime, "cache_control": "public, max-age=31536000, immutable",
                   "sha256": expected_sha}
        created = (bucket.put_file_new(key, path, size=size, **options)
                   if hasattr(bucket, 'put_file_new') else bucket.put_new(key, path.read_bytes(), **options))
        # The full GET is required for a new object as well as an existing key.
        if not same_object(bucket, key, expected_sha, size):
            raise ValueError("immutable R2 content key has different bytes")
        if file_hash(path) != expected_sha:
            raise ValueError("sealed content changed during upload")
        return created

    ordinary = sorted((name, sha) for name, sha in files.items() if name != "manifest.json")
    outcomes = _run_bounded(ordinary, upload_and_verify, workers)
    # The manifest is always the last release object and is read back before success.
    outcomes.append(upload_and_verify(("manifest.json", files["manifest.json"])))
    uploaded = sum(outcomes)
    reused = len(outcomes) - uploaded
    return {"region": region, "releaseId": release_id, "pointerSha256": digest(pointer_bytes),
            "files": len(files), "uploaded": uploaded, "reused": reused}


def promote(bucket, store: Path, region: str, expected_current: str, *, source_run: str,
            dry_run=False, workers: int = 1) -> dict:
    worker_count(workers)
    if expected_current != "none" and not SHA256.fullmatch(expected_current):
        raise ValueError("expected current must be 'none' or SHA-256")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", source_run):
        raise ValueError("invalid source run identity")
    release, pointer_bytes, manifest, files = sealed_release(store, region)
    release_id = manifest["root"].split("/")[-2]
    base = f"content/releases/{release_id}/"
    def verify_remote(item):
        name, expected_sha = item
        key = base + name
        # A missing or mismatched immutable object must never be advertised.
        if not same_object(bucket, key, expected_sha, (release / name).stat().st_size):
            raise ValueError("R2 release is incomplete or changed")
    _run_bounded(files.items(), verify_remote, workers)
    current_key = pointer_key(region)
    current = bucket.get(current_key)
    current_bytes, current_etag = current if current is not None else (None, None)
    actual = digest(current_bytes) if current_bytes is not None else "none"
    if actual != expected_current:
        raise ValueError("R2 content pointer differs from expected baseline")
    if current_bytes == pointer_bytes:
        return {"status": "unchanged", "region": region, "releaseId": release_id}
    if dry_run:
        return {"status": "ready", "region": region, "releaseId": release_id,
                "previousSha256": actual, "pointerSha256": digest(pointer_bytes)}
    promotion = {"schemaVersion": 1, "region": region, "run": source_run,
                 "previousPointer": json.loads(current_bytes) if current_bytes else None,
                 "nextPointer": json.loads(pointer_bytes), "previousSha256": actual,
                 "nextSha256": digest(pointer_bytes)}
    journal_key = f"content/promotions/{region}/{source_run}-{uuid4().hex}.json"
    record = canonical(promotion)
    if not bucket.put_new(journal_key, record, content_type="application/json", cache_control="no-store", sha256=digest(record)):
        raise ValueError("promotion journal key collision")
    bucket.replace(current_key, pointer_bytes, current_etag, content_type="application/json", cache_control="no-store")
    previous_key = "content/previous.json" if region == "global" else "content/jp/previous.json"
    previous_status = "not_applicable"
    if current_bytes is not None:
        old_previous = bucket.get(previous_key)
        try:
            bucket.replace(previous_key, current_bytes, old_previous[1] if old_previous else None,
                           content_type="application/json", cache_control="no-store")
            previous_status = "updated"
        except ValueError:
            previous_status = "conflict_use_promotion_journal"
    return {"status": "published", "region": region, "releaseId": release_id,
            "pointerSha256": digest(pointer_bytes), "promotionJournal": journal_key,
            "previousStatus": previous_status}


def rollback(bucket, region: str, expected_current: str, *, source_run: str) -> dict:
    """Restore the prior published pointer only if its manifest still verifies."""
    if expected_current != "none" and not SHA256.fullmatch(expected_current):
        raise ValueError("expected current must be 'none' or SHA-256")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", source_run):
        raise ValueError("invalid source run identity")
    current_key = pointer_key(region)
    previous_key = "content/previous.json" if region == "global" else "content/jp/previous.json"
    current = bucket.get(current_key)
    previous = bucket.get(previous_key)
    if current is None or previous is None:
        raise ValueError("current or previous R2 content pointer is missing")
    current_bytes, current_etag = current
    previous_bytes, previous_etag = previous
    if digest(current_bytes) != expected_current:
        raise ValueError("R2 content pointer differs from expected baseline")
    if previous_bytes == current_bytes:
        raise ValueError("previous pointer already equals current")
    prior = json.loads(previous_bytes)
    if not isinstance(prior, dict):
        raise ValueError("previous R2 content pointer is invalid")
    match = re.fullmatch(r"/content/releases/([a-f0-9]{24})/manifest\.json", prior.get("manifest", ""))
    if prior.get("schemaVersion") != 1 or not match or not SHA256.fullmatch(prior.get("sha256", "")):
        raise ValueError("previous R2 content pointer is invalid")
    manifest_key = prior["manifest"].lstrip("/")
    manifest_object = bucket.get(manifest_key)
    if manifest_object is None or digest(manifest_object[0]) != prior["sha256"]:
        raise ValueError("previous R2 content manifest is missing or damaged")
    manifest = json.loads(manifest_object[0])
    if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1
            or manifest.get("region", "global") != region
            or manifest.get("channel") != "production"
            or manifest.get("root") != f"/content/releases/{match[1]}/"
            or manifest.get("contentReleaseId") != prior.get("contentReleaseId")):
        raise ValueError("previous R2 content manifest does not match pointer")
    if not isinstance(manifest.get("locales"), dict) or set(manifest["locales"]) != {"en", "zh-CN"}:
        raise ValueError("previous R2 content locales are invalid")
    for locale, projection in manifest["locales"].items():
        if locale not in {"en", "zh-CN"} or not isinstance(projection, dict):
            raise ValueError("previous R2 content locale is invalid")
        for section in ("files", "groups"):
            records = projection.get(section)
            if not isinstance(records, dict):
                raise ValueError("previous R2 content records are invalid")
            for record in records.values():
                if not isinstance(record, dict):
                    raise ValueError("previous R2 content record is invalid")
                name, sha, size = record.get("path"), record.get("sha256"), record.get("bytes")
                if (not isinstance(name, str) or not name.startswith(locale + "/")
                        or not isinstance(sha, str) or not SHA256.fullmatch(sha)
                        or type(size) is not int or size < 0):
                    raise ValueError("previous R2 content record is invalid")
                check_public_path(name)
                if not same_object(bucket, f"content/releases/{match[1]}/{name}", sha, size):
                    raise ValueError("previous R2 content record is missing or damaged")
    record = canonical({"schemaVersion": 1, "region": region, "run": source_run,
                        "action": "rollback", "previousPointer": json.loads(current_bytes),
                        "nextPointer": prior, "previousSha256": digest(current_bytes),
                        "nextSha256": digest(previous_bytes)})
    journal_key = f"content/promotions/{region}/{source_run}-{uuid4().hex}.json"
    if not bucket.put_new(journal_key, record, content_type="application/json",
                          cache_control="no-store", sha256=digest(record)):
        raise ValueError("rollback journal key collision")
    bucket.replace(current_key, previous_bytes, current_etag,
                   content_type="application/json", cache_control="no-store")
    previous_status = "updated"
    try:
        bucket.replace(previous_key, current_bytes, previous_etag,
                       content_type="application/json", cache_control="no-store")
    except ValueError:
        previous_status = "conflict_use_promotion_journal"
    return {"status": "rolled_back", "region": region, "releaseId": match[1],
            "pointerSha256": digest(previous_bytes), "promotionJournal": journal_key,
            "previousStatus": previous_status}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("baseline", "upload", "promote", "rollback"))
    parser.add_argument("--store", type=Path)
    parser.add_argument("--region", choices=("global", "jp"), required=True)
    parser.add_argument("--expected-current", help="R2 pointer SHA-256, or 'none' for initial publication")
    parser.add_argument("--source-run", help="Actions run identity")
    parser.add_argument("--dry-run", action="store_true", help="verify without changing R2")
    parser.add_argument("--workers", type=int, default=1,
                        help=f"parallel release object transfers/verification (1-{MAX_WORKERS}; default: 1)")
    args = parser.parse_args(argv)
    try:
        worker_count(args.workers)
        bucket = None if args.action == "upload" and args.dry_run else S3Bucket.from_environment(args.workers)
        if args.action == "baseline":
            if args.dry_run:
                parser.error("baseline is already read-only")
            result = baseline(bucket, args.region)
        elif args.action == "upload":
            if not args.store: parser.error('upload requires --store')
            result = upload_release(bucket, args.store, args.region, dry_run=args.dry_run, workers=args.workers)
        elif args.action == "promote":
            if not args.store or not args.expected_current or not args.source_run:
                parser.error("promote requires --store, --expected-current and --source-run")
            result = promote(bucket, args.store, args.region, args.expected_current,
                             source_run=args.source_run, dry_run=args.dry_run, workers=args.workers)
        else:
            if args.dry_run:
                parser.error("rollback does not support --dry-run")
            if not args.expected_current or not args.source_run:
                parser.error("rollback requires --expected-current and --source-run")
            result = rollback(bucket, args.region, args.expected_current, source_run=args.source_run)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
