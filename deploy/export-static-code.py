"""Project the active, approved code identity for the static delivery runner."""

import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path


def export(current, target):
    release = current.resolve(strict=True)
    manifest = (release / "code-release.json").read_bytes()
    receipt = (release / "verification.json").read_bytes()
    metadata = json.loads(manifest)
    identity = metadata["codeId"]
    revision = metadata["provenance"]["source"]["commit"]
    artifact = json.loads(receipt)["artifact"]
    if (
        not re.fullmatch("[0-9a-f]{24}", identity)
        or release.name != identity
        or not re.fullmatch("[0-9a-f]{40}", revision)
        or artifact["codeId"] != identity
        or artifact["manifestSha256"] != hashlib.sha256(manifest).hexdigest()
    ):
        raise ValueError("Active code receipt does not match the release")
    data = json.dumps(
        {
            "codeId": identity,
            "revision": revision,
            "receiptSha256": hashlib.sha256(receipt).hexdigest(),
        }
    ).encode()
    if target.exists() and target.read_bytes() == data:
        return
    with tempfile.NamedTemporaryFile(dir=str(target.parent), delete=False) as tmp:
        tmp.write(data)
        os.fchmod(tmp.fileno(), 0o644)
    os.replace(tmp.name, str(target))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    export(args.current, args.output)
