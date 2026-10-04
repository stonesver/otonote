"""Stage a verified JP 1.0.4 client seed under output/r2-jp for R2 checkpointing."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
from uuid import uuid4

from tools.global_remote_sync import file_hash, write_json
from tools.jp_phone_inputs import (JP_CERTIFICATE_SHA256, JP_METADATA_SHA256,
                                   JP_REVIEWED_PACKAGE_SET_SHA256)
from tools.resource_pipeline.package_intake import build_package_set_manifest

UNITY_VERSION = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")


def prepare(metadata: Path, apk_root: Path, unity_version_file: Path, output: Path) -> dict:
    metadata, apk_root, unity_version_file, output = map(Path, (metadata, apk_root, unity_version_file, output))
    if output.name != "r2-jp" or output.parent.name != "output" or not output.is_absolute():
        raise ValueError("JP seed destination must be an absolute output/r2-jp path")
    if output.exists() or output.is_symlink():
        raise ValueError("JP seed destination already exists")
    for source in (metadata, apk_root, unity_version_file):
        if source.is_symlink() or not source.exists():
            raise ValueError("JP seed source is missing or linked")
    if file_hash(metadata) != JP_METADATA_SHA256:
        raise ValueError("JP metadata does not match the reviewed decoder")
    package = build_package_set_manifest(apk_root, region="jp", channel="production")
    if (package["packageName"] != "com.bushiroad.sirius" or
            package["versionName"] != "1.0.4" or package["versionCode"] != 10053 or
            package["certificateSha256"] != JP_CERTIFICATE_SHA256 or
            package.get("packageSetSha256") != JP_REVIEWED_PACKAGE_SET_SHA256):
        raise ValueError("JP package differs from the reviewed 1.0.4 client")
    unity = unity_version_file.read_text(encoding="utf-8").strip()
    if not UNITY_VERSION.fullmatch(unity):
        raise ValueError("invalid JP Unity identity")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = output.with_name(".r2-jp-" + uuid4().hex)
    stage.mkdir(mode=0o700)
    try:
        shutil.copyfile(metadata, stage / "metadata.v39.dat")
        (stage / "unity-version.txt").write_text(unity + "\n", encoding="utf-8")
        (stage / "apks").mkdir()
        copies = {}
        for source in sorted(apk_root.glob("*.apk")):
            if source.is_symlink():
                raise ValueError("linked JP split APK")
            target = stage / "apks" / source.name
            shutil.copyfile(source, target)
            copies[source.name] = file_hash(target)
            if copies[source.name] != file_hash(source):
                raise ValueError("JP split APK changed during seed copy")
        if file_hash(stage / "metadata.v39.dat") != JP_METADATA_SHA256:
            raise ValueError("JP metadata changed during seed copy")
        report = {"schemaVersion": 1, "region": "jp", "status": "verified_seed",
                  "clientVersion": "1.0.4", "versionCode": 10053,
                  "certificateSha256": JP_CERTIFICATE_SHA256,
                  "metadataSha256": JP_METADATA_SHA256,
                  "packageSetSha256": package["packageSetSha256"],
                  "unityVersion": unity, "apks": copies}
        write_json(stage / "seed-manifest.json", report)
        stage.rename(output)
        return report
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--apk-root", type=Path, required=True)
    parser.add_argument("--unity-version-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    report = prepare(args.metadata, args.apk_root, args.unity_version_file, args.output)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
