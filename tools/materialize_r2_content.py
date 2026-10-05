"""Materialize the small R2 content subset needed by the local prerenderer.

The public bucket is read with an S3 read-only credential. A pointer is made
visible locally only after its immutable release has been downloaded and
checked. The R2 release omits the publisher's private ``.receipt.json``.
"""
from __future__ import annotations

import argparse
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from tools.r2_content import SHA256, check_public_path, pointer_key


RELEASE = re.compile(r"/content/releases/([a-f0-9]{24})/manifest\.json\Z")
MAX_CONTROL_BYTES = 4 * 1024 * 1024
MAX_OBJECTS = 100_000
MAX_RELEASE_BYTES = 8 * 1024 ** 3
RECEIPT_NAME = ".r2-materialization-receipt.json"
MAX_RECEIPT_BYTES = 32 * 1024 * 1024
LOADING_SOURCE = Path(__file__).resolve().parents[1] / "site/src/runtime/loading-presentation.mjs"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class R2Reader:
    """Only object read permissions are needed by this adapter."""

    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    @classmethod
    def from_environment(cls):
        import boto3
        from botocore.config import Config
        account = os.environ["R2_ACCOUNT_ID"]
        client = boto3.client(
            "s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto", config=Config(signature_version="s3v4",
                                              retries={"mode": "standard", "max_attempts": 5}),
        )
        return cls(client, os.environ["R2_PUBLIC_BUCKET"])

    @staticmethod
    def _missing(error):
        return error.response.get("Error", {}).get("Code", "") in {"404", "NoSuchKey", "NotFound"}

    def control(self, key: str) -> bytes | None:
        from botocore.exceptions import ClientError
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return None
            raise
        body = response["Body"]
        try:
            if response.get("ContentLength", 0) > MAX_CONTROL_BYTES:
                raise ValueError("R2 control object is too large")
            value = body.read(MAX_CONTROL_BYTES + 1)
            if len(value) > MAX_CONTROL_BYTES:
                raise ValueError("R2 control object is too large")
            return value
        finally:
            body.close()

    def head(self, key: str) -> tuple[str, int] | None:
        from botocore.exceptions import ClientError
        try:
            response = self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if self._missing(error):
                return None
            raise
        checksum = response.get("Metadata", {}).get("sha256", "")
        size = response.get("ContentLength")
        if not SHA256.fullmatch(checksum) or not isinstance(size, int) or size < 0:
            raise ValueError("R2 release object lacks valid SHA-256 metadata")
        return checksum, size

    def download(self, key: str, target: Path) -> tuple[str, int]:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        declared = response.get("Metadata", {}).get("sha256", "")
        if not SHA256.fullmatch(declared):
            response["Body"].close()
            raise ValueError("R2 release object lacks SHA-256 metadata")
        checksum = hashlib.sha256()
        total = 0
        body = response["Body"]
        try:
            with target.open("xb") as output:
                for block in iter(lambda: body.read(1024 * 1024), b""):
                    checksum.update(block)
                    output.write(block)
                    total += len(block)
        finally:
            body.close()
        if total != response.get("ContentLength") or checksum.hexdigest() != declared:
            raise ValueError("R2 release object failed readback validation")
        return declared, total


def parse_pointer(raw: bytes, region: str) -> tuple[dict, str]:
    try:
        pointer = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid R2 content pointer") from error
    if not isinstance(pointer, dict):
        raise ValueError("invalid R2 content pointer")
    match = RELEASE.fullmatch(pointer.get("manifest", "")) if isinstance(pointer.get("manifest"), str) else None
    checksum = pointer.get("sha256")
    if (pointer.get("schemaVersion") != 1 or not match or
            not isinstance(checksum, str) or not SHA256.fullmatch(checksum)):
        raise ValueError("invalid R2 content pointer")
    release_id = match[1]
    if region not in {"global", "jp"}:
        raise ValueError("unsupported content region")
    return pointer, release_id


def parse_manifest(raw: bytes, pointer: dict, release_id: str, region: str) -> dict:
    if sha256(raw) != pointer["sha256"]:
        raise ValueError("R2 manifest digest differs from current pointer")
    try:
        manifest = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid R2 content manifest") from error
    if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or
            manifest.get("region", "global") != region or
            manifest.get("root") != f"/content/releases/{release_id}/" or
            manifest.get("contentReleaseId") != pointer.get("contentReleaseId")):
        raise ValueError("R2 manifest does not match content pointer")
    return manifest


def required_records(manifest: dict) -> dict[str, tuple[str, int]]:
    locales = manifest.get("locales")
    if not isinstance(locales, dict) or set(locales) != {"en", "zh-CN"}:
        raise ValueError("invalid R2 content locales")
    required = {}
    for locale, sections in locales.items():
        if not isinstance(sections, dict):
            raise ValueError("invalid R2 content records")
        for section in ("files", "groups"):
            records = sections.get(section)
            if not isinstance(records, dict):
                raise ValueError("invalid R2 content records")
            for record in records.values():
                if not isinstance(record, dict):
                    raise ValueError("invalid R2 content record")
                name, checksum, size = record.get("path"), record.get("sha256"), record.get("bytes")
                if (not isinstance(name, str) or not name.startswith(locale + "/") or
                        not isinstance(checksum, str) or not SHA256.fullmatch(checksum) or
                        not isinstance(size, int) or isinstance(size, bool) or size < 0):
                    raise ValueError("invalid R2 content record")
                check_public_path(name)
                expected = (checksum, size)
                if name in required and required[name] != expected:
                    raise ValueError("conflicting R2 content records")
                required[name] = expected
    return required


def loading_art_files(source: Path = LOADING_SOURCE) -> tuple[str, ...]:
    """Read the renderer's shared artwork names; fail closed if its shape changes."""
    match = re.search(r"export\s+const\s+loadingArtFiles\s*=\s*(\[[^\]]*\])\s*;",
                      source.read_text(encoding="utf-8"))
    if not match:
        raise ValueError("cannot read renderer loadingArtFiles")
    try:
        files = ast.literal_eval(match[1])
    except (ValueError, SyntaxError) as error:
        raise ValueError("cannot read renderer loadingArtFiles") from error
    if (not isinstance(files, list) or not files or
            any(not isinstance(name, str) or "/" in name or "\\" in name for name in files) or
            len(set(files)) != len(files)):
        raise ValueError("invalid renderer loadingArtFiles")
    for name in files:
        check_public_path("public/gallery/" + name)
    return tuple(files)


def _safe_local_file(root: Path, name: str) -> Path:
    target = root / name
    for parent in (root, *target.parents):
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError("linked local content path")
    if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("unsafe local content path")
    return target


def _check_existing_release(release: Path, objects: dict[str, tuple[str, int]]) -> None:
    if release.is_symlink() or not release.is_dir():
        raise ValueError("local content release is linked or invalid")
    for path in release.rglob("*"):
        if path.is_symlink():
            raise ValueError("linked local content path")
    for name, (checksum, size) in objects.items():
        target = _safe_local_file(release, name)
        if not target.is_file() or target.stat().st_size != size:
            raise ValueError("local content release is incomplete")
        actual = hashlib.sha256()
        with target.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                actual.update(block)
        if actual.hexdigest() != checksum:
            raise ValueError("local content release differs from R2")


def _receipt_bytes(region: str, release_id: str, pointer_raw: bytes,
                   manifest_raw: bytes, candidates: set[str],
                   objects: dict[str, tuple[str, int]]) -> bytes:
    value = {
        "schemaVersion": 1, "region": region, "releaseId": release_id,
        "pointerSha256": sha256(pointer_raw), "manifestSha256": sha256(manifest_raw),
        "candidates": sorted(candidates),
        "objects": {name: {"sha256": checksum, "bytes": size}
                    for name, (checksum, size) in sorted(objects.items())},
    }
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _cached_objects(release: Path, region: str, release_id: str, pointer_raw: bytes,
                    manifest_raw: bytes, candidates: set[str],
                    required: dict[str, tuple[str, int]]) -> dict[str, tuple[str, int]] | None:
    if release.is_symlink():
        raise ValueError("local content release is linked or invalid")
    receipt_path = release / RECEIPT_NAME
    if not receipt_path.exists() and not receipt_path.is_symlink():
        return None
    if receipt_path.is_symlink() or not receipt_path.is_file() or receipt_path.stat().st_size > MAX_RECEIPT_BYTES:
        raise ValueError("invalid local materialization receipt")
    try:
        receipt = json.loads(receipt_path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid local materialization receipt") from error
    if (not isinstance(receipt, dict) or receipt.get("schemaVersion") != 1 or
            receipt.get("region") != region or receipt.get("releaseId") != release_id or
            receipt.get("pointerSha256") != sha256(pointer_raw) or
            receipt.get("manifestSha256") != sha256(manifest_raw) or
            receipt.get("candidates") != sorted(candidates)):
        return None
    recorded = receipt.get("objects")
    if not isinstance(recorded, dict) or not set(recorded).issubset(candidates) or not ({"manifest.json"} | set(required)).issubset(recorded):
        raise ValueError("invalid local materialization receipt")
    objects = {}
    total = 0
    for name, record in recorded.items():
        check_public_path(name)
        if (not isinstance(record, dict) or set(record) != {"sha256", "bytes"} or
                not isinstance(record["sha256"], str) or not SHA256.fullmatch(record["sha256"]) or
                not isinstance(record["bytes"], int) or isinstance(record["bytes"], bool) or record["bytes"] < 0):
            raise ValueError("invalid local materialization receipt")
        objects[name] = (record["sha256"], record["bytes"])
        total += record["bytes"]
        if len(objects) > MAX_OBJECTS or total > MAX_RELEASE_BYTES:
            raise ValueError("local materialization receipt exceeds limit")
    if (objects["manifest.json"] != (sha256(manifest_raw), len(manifest_raw)) or
            any(objects[name] != expected for name, expected in required.items())):
        raise ValueError("local materialization receipt differs from manifest")
    return objects


def _write_receipt(release: Path, payload: bytes) -> None:
    if len(payload) > MAX_RECEIPT_BYTES:
        raise ValueError("local materialization receipt exceeds limit")
    temporary = release / (RECEIPT_NAME + ".next")
    if temporary.exists() or temporary.is_symlink():
        raise ValueError("materialization receipt staging path exists")
    try:
        with temporary.open("xb") as output:
            output.write(payload)
        temporary.chmod(0o600)
        os.replace(temporary, release / RECEIPT_NAME)
    finally:
        temporary.unlink(missing_ok=True)


def _materialize(reader, store: Path, regions=("global", "jp"), *, allow_missing_jp=True) -> dict:
    store = Path(store).resolve()
    if not regions or any(region not in {"global", "jp"} for region in regions) or len(set(regions)) != len(regions):
        raise ValueError("invalid content regions")
    releases = store / "releases"
    if releases.is_symlink():
        raise ValueError("linked local releases directory")
    releases.mkdir(parents=True, exist_ok=True)
    pending = []
    outcomes = {}
    for region in regions:
        key = pointer_key(region)
        pointer_raw = reader.control(key)
        if pointer_raw is None:
            if region == "jp" and allow_missing_jp:
                if (store / "jp/current.json").exists():
                    raise ValueError("R2 JP pointer is missing while a local JP pointer exists")
                outcomes[region] = {"status": "absent"}
                continue
            raise ValueError(f"R2 {region} current pointer is missing")
        pointer, release_id = parse_pointer(pointer_raw, region)
        prefix = f"content/releases/{release_id}/"
        manifest_raw = reader.control(prefix + "manifest.json")
        if manifest_raw is None:
            raise ValueError("R2 current release manifest is missing")
        manifest = parse_manifest(manifest_raw, pointer, release_id, region)
        required = required_records(manifest)
        # The renderer fetches manifest-record projection/group files, and
        # shared-gallery may fetch its public manifest. Loading art only needs
        # the two files named by the renderer module. Other media stays in R2.
        names = {"manifest.json", *required, "public/gallery/manifest.json",
                 *("public/gallery/" + name for name in loading_art_files())}
        release = releases / release_id
        selected = _cached_objects(release, region, release_id, pointer_raw,
                                   manifest_raw, names, required) if release.exists() or release.is_symlink() else None
        reused_receipt = selected is not None
        if selected is None:
            selected = {}
            total = 0
            for name in sorted(names):
                check_public_path(name)
                metadata = reader.head(prefix + name)
                if metadata is None:
                    if name == "manifest.json" or name in required:
                        raise ValueError("R2 release omits a manifest record")
                    continue
                checksum, size = metadata
                if not isinstance(checksum, str) or not SHA256.fullmatch(checksum) or not isinstance(size, int) or size < 0:
                    raise ValueError("invalid R2 release object metadata")
                selected[name] = (checksum, size)
                total += size
                if len(selected) > MAX_OBJECTS or total > MAX_RELEASE_BYTES:
                    raise ValueError("R2 content release exceeds materialization limit")
            if selected["manifest.json"] != (pointer["sha256"], len(manifest_raw)):
                raise ValueError("R2 manifest differs from current pointer")
            if any(selected[name] != expected for name, expected in required.items()):
                raise ValueError("R2 release record differs from manifest")
        else:
            total = sum(size for _, size in selected.values())
        if release.exists() or release.is_symlink():
            _check_existing_release(release, selected)
            if not reused_receipt:
                _write_receipt(release, _receipt_bytes(region, release_id, pointer_raw,
                                                       manifest_raw, names, selected))
        else:
            stage = Path(tempfile.mkdtemp(prefix=".materialize-", dir=releases))
            try:
                for name, expected in selected.items():
                    target = _safe_local_file(stage, name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if reader.download(prefix + name, target) != expected:
                        raise ValueError("R2 release changed during materialization")
                _write_receipt(stage, _receipt_bytes(region, release_id, pointer_raw,
                                                     manifest_raw, names, selected))
                for path in stage.rglob("*"):
                    path.chmod(0o755 if path.is_dir() else 0o600 if path.name == RECEIPT_NAME else 0o644)
                stage.chmod(0o755)
                stage.rename(release)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        if reader.control(key) != pointer_raw:
            raise ValueError("R2 pointer changed during materialization")
        pending.append((region, pointer_raw))
        outcomes[region] = {"status": "ready", "releaseId": release_id, "files": len(selected), "bytes": total}
    for region, pointer_raw in pending:
        if reader.control(pointer_key(region)) != pointer_raw:
            raise ValueError("R2 pointer changed before local promotion")
    for region, pointer_raw in pending:
        pointer_path = store / ("current.json" if region == "global" else "jp/current.json")
        if pointer_path.is_symlink() or pointer_path.parent.is_symlink():
            raise ValueError("linked local content pointer")
        pointer_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = pointer_path.with_name("." + pointer_path.name + ".next")
        if temporary.exists() or temporary.is_symlink():
            raise ValueError("content pointer staging path exists")
        try:
            with temporary.open("xb") as output:
                output.write(pointer_raw)
            os.replace(temporary, pointer_path)
        finally:
            temporary.unlink(missing_ok=True)
    return outcomes


def materialize(reader, store: Path, regions=("global", "jp"), *, allow_missing_jp=True) -> dict:
    """Fetch and validate all selected releases, then atomically switch pointers."""
    store = Path(store).resolve()
    store.mkdir(parents=True, exist_ok=True)
    with (store / ".r2-materialize.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _materialize(reader, store, regions, allow_missing_jp=allow_missing_jp)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, required=True, help="Existing local content store")
    parser.add_argument("--region", choices=("all", "global", "jp"), default="all")
    args = parser.parse_args(argv)
    regions = ("global", "jp") if args.region == "all" else (args.region,)
    result = materialize(R2Reader.from_environment(), args.store, regions)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
