"""Choose the immutable storage layout for an already sealed release.

This is a read-only preflight for the upload workflow. The uploader still
validates the selected layout and every object before publication.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

from tools.r2_content import S3Bucket, digest, sealed_release
from tools.r2_shared_media import descriptor_key


def select_layout(bucket, store: Path, region: str, requested_shared: bool) -> str:
    if type(requested_shared) is not bool:
        raise ValueError("shared layout request must be boolean")
    if not requested_shared:
        return "direct"

    release, _, manifest, files = sealed_release(store, region)
    release_id = release.name
    remote_manifest = bucket.get(f"content/releases/{release_id}/manifest.json")
    if remote_manifest is not None and digest(remote_manifest[0]) != files["manifest.json"]:
        raise ValueError("existing immutable release manifest differs")
    shared_descriptor = bucket.get(descriptor_key(release_id))
    if shared_descriptor is not None:
        # The shared uploader validates the descriptor and its complete index.
        return "shared"
    if remote_manifest is not None:
        # An already uploaded direct release keeps its original storage layout.
        return "direct"
    return "shared"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--region", choices=("global", "jp"), required=True)
    parser.add_argument("--shared", choices=("true", "false"), required=True)
    args = parser.parse_args(argv)
    try:
        requested_shared = args.shared == "true"
        bucket = S3Bucket.from_environment() if requested_shared else None
        print(select_layout(bucket, args.store, args.region, requested_shared))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        # A storage transport exception may contain the account endpoint.
        print(f"layout selection blocked: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
