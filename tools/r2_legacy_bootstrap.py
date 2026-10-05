"""Move the two sealed legacy public releases through isolated private R2 state.

This is a one-time transport. It does not produce new Global or JP resources,
publish public pointers, or alter the normal private updater checkpoints.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys

from tools import r2_content, r2_state

NAMESPACE = "migration/legacy-public/"
RECORDED_ROOT = Path("/srv/ournotes-legacy-bootstrap")
SELECTIONS = ["content"]
STATE_REGION = "global"
RELEASE_IDS = {
    "global": "ac630c24b69b23fd89da8821",
    "jp": "98d922dbc6fca1d5d8d991d8",
}
FREE_RESERVE = 2 * 1024**3


class NamespaceBucket:
    """Apply a fixed namespace to every private state control and data key."""

    def __init__(self, bucket):
        self.bucket = bucket

    @staticmethod
    def _key(key: str) -> str:
        if (not isinstance(key, str) or not key.startswith("state/") or "\\" in key
                or any(part in {"", ".", ".."} for part in key.split("/"))):
            raise ValueError("invalid legacy bootstrap state key")
        return NAMESPACE + key

    def read_small(self, key):
        return self.bucket.read_small(self._key(key))

    def put_small_new(self, key, data):
        return self.bucket.put_small_new(self._key(key), data)

    def replace_small(self, key, data, etag):
        return self.bucket.replace_small(self._key(key), data, etag)

    def read_manifest(self, key):
        return self.bucket.read_manifest(self._key(key))

    def put_manifest_new(self, key, data):
        return self.bucket.put_manifest_new(self._key(key), data)

    def put_file_new(self, key, path, sha, size):
        return self.bucket.put_file_new(self._key(key), path, sha, size)

    def verify_file(self, key, sha, size):
        return self.bucket.verify_file(self._key(key), sha, size)

    def download_file(self, key, target, sha, size):
        return self.bucket.download_file(self._key(key), target, sha, size)


def validate_legacy_store(root: Path) -> dict:
    root = r2_state.stable_root(root)
    store = root / "content"
    if store.is_symlink() or not store.is_dir():
        raise ValueError("legacy content store is missing or linked")
    if {path.name for path in store.iterdir()} != {"current.json", "jp", "releases"}:
        raise ValueError("legacy content store contains unexpected top-level paths")
    jp = store / "jp"
    releases = store / "releases"
    if (jp.is_symlink() or not jp.is_dir() or {path.name for path in jp.iterdir()} != {"current.json"}
            or releases.is_symlink() or not releases.is_dir()
            or {path.name for path in releases.iterdir()} != set(RELEASE_IDS.values())):
        raise ValueError("legacy content store must contain exactly the two pinned releases")
    if any(path.name == ".DS_Store" for path in store.rglob("*")):
        raise ValueError("legacy content store contains unsealed metadata")
    summary = {}
    for region, release_id in RELEASE_IDS.items():
        release, pointer, _, files = r2_content.sealed_release(store, region)
        if release.name != release_id:
            raise ValueError(f"legacy {region} pointer does not select the pinned release")
        summary[region] = {"releaseId": release_id, "pointerSha256": r2_state.digest(pointer),
                           "files": len(files)}
    return summary


def seed(bucket, root: Path, expected_current: str = "none", *, workers: int = 1) -> dict:
    summary = validate_legacy_store(root)
    result = r2_state.checkpoint(NamespaceBucket(bucket), Path(root), STATE_REGION,
                                 SELECTIONS, expected_current, RECORDED_ROOT, workers=workers)
    return {"status": result["status"], "state": result, "releases": summary,
            "namespace": NAMESPACE}


def restore(bucket, root: Path, *, workers: int = 1, free_bytes: int | None = None) -> dict:
    root = r2_state.stable_root(root)
    if root != RECORDED_ROOT:
        raise ValueError("legacy restore ROOT differs from recorded ROOT")
    if (root / "content").exists() or (root / "content").is_symlink():
        raise ValueError("legacy restore requires an empty content destination")
    namespaced = NamespaceBucket(bucket)
    report = r2_state.inspect(namespaced, root, STATE_REGION, SELECTIONS)
    free = shutil.disk_usage(root).free if free_bytes is None else free_bytes
    required = report["requiredBytes"] + FREE_RESERVE
    if free < required:
        raise ValueError("runner disk is too small for legacy content restore and reserve")
    result = r2_state.restore(namespaced, root, STATE_REGION, SELECTIONS, workers=workers)
    summary = validate_legacy_store(root)
    return {"status": result["status"], "state": result, "releases": summary,
            "requiredBytes": required, "freeBytes": free, "namespace": NAMESPACE}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "restore"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--expected-current", default="none",
                        help="seed only: namespaced pointer SHA-256 or 'none' for first seed")
    parser.add_argument("--workers", type=int, default=8, help="parallel R2 object transfers (1-16)")
    args = parser.parse_args(argv)
    try:
        r2_state.worker_count(args.workers)
        bucket = r2_state.PrivateS3Bucket.from_environment(args.workers)
        if args.action == "seed":
            result = seed(bucket, args.root, args.expected_current, workers=args.workers)
        else:
            if args.expected_current != "none":
                parser.error("--expected-current is only valid for seed")
            result = restore(bucket, args.root, workers=args.workers)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
