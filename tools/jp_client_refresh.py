"""Refresh the restored JP production seed from its reviewed Android client.

The package mirror is only a transport source. Trust comes from the pinned
archive digest, APK signer, package-set identity, metadata digest, and Unity
identity. A new client version must be reviewed and pinned in source first.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import zipfile

from analysis.crypto.deobfuscate_paged_il2cpp_metadata import decode
from analysis.parse_ournotes_apk import parse_unityfs_header
from tools.global_remote_sync import file_hash, verify_apk_signature, write_json
from tools.jp_phone_inputs import (
    JP_APKSIG_SHA256,
    JP_CERTIFICATE_SHA256,
    JP_CLIENT_VERSION,
    JP_METADATA_SHA256,
    JP_REVIEWED_PACKAGE_SET_SHA256,
    JP_REVIEWED_XAPK_SHA256,
    JP_VERSION_CODE,
)
from tools.resource_pipeline.package_intake import PackageIntakeError, build_package_set_manifest

ROOT = Path(__file__).resolve().parents[1]
XAPK_APKS = {
    "com.bushiroad.sirius.apk": "base.apk",
    "UnityDataAssetPack.apk": "split_UnityDataAssetPack.apk",
    "config.arm64_v8a.apk": "split_config.arm64_v8a.apk",
}


def seed_is_current(seed_root: Path) -> bool:
    seed_root = Path(seed_root)
    if seed_root.is_symlink() or not seed_root.is_dir():
        return False
    try:
        manifest_path = seed_root / "seed-manifest.json"
        if manifest_path.is_symlink():
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        metadata = seed_root / "metadata.v39.dat"
        unity = seed_root / "unity-version.txt"
        apk_root = seed_root / "apks"
        if any(path.is_symlink() for path in (metadata, unity, apk_root)):
            return False
        if any(path.is_symlink() for path in apk_root.glob("*.apk")):
            return False
        package = build_package_set_manifest(apk_root, region="jp", channel="production")
        return (
            manifest.get("status") == "verified_seed"
            and manifest.get("clientVersion") == JP_CLIENT_VERSION
            and manifest.get("versionCode") == JP_VERSION_CODE
            and manifest.get("certificateSha256") == JP_CERTIFICATE_SHA256
            and manifest.get("metadataSha256") == JP_METADATA_SHA256
            and manifest.get("packageSetSha256") == JP_REVIEWED_PACKAGE_SET_SHA256
            and file_hash(metadata) == JP_METADATA_SHA256
            and package.get("packageSetSha256") == JP_REVIEWED_PACKAGE_SET_SHA256
            and package.get("certificateSha256") == JP_CERTIFICATE_SHA256
            and package.get("versionName") == JP_CLIENT_VERSION
            and package.get("versionCode") == JP_VERSION_CODE
            and unity.read_text(encoding="utf-8").strip() == "6000.3.12f1"
        )
    except (OSError, ValueError, TypeError, KeyError, PackageIntakeError):
        return False


def _extract_reviewed_package(archive: Path, apksig_jar: Path, stage: Path) -> dict:
    if file_hash(archive) != JP_REVIEWED_XAPK_SHA256:
        raise ValueError("JP client archive differs from the reviewed 1.0.5 package")
    if file_hash(apksig_jar) != JP_APKSIG_SHA256:
        raise ValueError("Android APK signature verifier digest mismatch")
    apk_root = stage / "apks"
    apk_root.mkdir()
    with zipfile.ZipFile(archive) as xapk:
        names = set(xapk.namelist())
        if not set(XAPK_APKS) <= names:
            raise ValueError("JP package archive is missing a reviewed split")
        for source_name, target_name in XAPK_APKS.items():
            info = xapk.getinfo(source_name)
            if info.is_dir() or info.file_size <= 0:
                raise ValueError("JP package archive contains an invalid split")
            target = apk_root / target_name
            with xapk.open(info) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)

    package = build_package_set_manifest(apk_root, region="jp", channel="production")
    if (
        package.get("packageName") != "com.bushiroad.sirius"
        or package.get("versionName") != JP_CLIENT_VERSION
        or package.get("versionCode") != JP_VERSION_CODE
        or package.get("certificateSha256") != JP_CERTIFICATE_SHA256
        or package.get("packageSetSha256") != JP_REVIEWED_PACKAGE_SET_SHA256
    ):
        raise ValueError("JP split APKs do not match the reviewed 1.0.5 identity")
    for apk in sorted(apk_root.glob("*.apk")):
        verify_apk_signature(apk, apksig_jar, JP_CERTIFICATE_SHA256)

    base_apk = apk_root / XAPK_APKS["com.bushiroad.sirius.apk"]
    with zipfile.ZipFile(base_apk) as apk:
        metadata_names = [name for name in apk.namelist() if name.endswith("/global-metadata.dat")]
        if len(metadata_names) != 1:
            raise ValueError("JP base APK lacks one unique IL2CPP metadata file")
        raw_metadata = apk.read(metadata_names[0])
        unity_data = apk.read("assets/bin/Data/data.unity3d")

    clear_metadata, _ = decode(
        raw_metadata, key=0x66, version=39, page_size=4096,
        period_pages=16, xor_page_residues={1, 2, 3, 4},
    )
    if struct.unpack_from("<II", clear_metadata) != (0xFAB11BAF, 39):
        raise ValueError("JP metadata is not IL2CPP v39")
    sections = [struct.unpack_from("<III", clear_metadata, 8 + index * 12) for index in range(31)]
    for offset, size, _ in sections:
        if offset > len(clear_metadata) or size > len(clear_metadata) - offset:
            raise ValueError("JP metadata section is outside the decoded file")
    for label, index, record_size in (("method", 5, 32), ("type", 19, 82), ("image", 20, 36)):
        _, section_size, count = sections[index]
        if count <= 0 or section_size // count != record_size:
            raise ValueError("JP metadata " + label + " records changed")
    metadata_path = stage / "metadata.v39.dat"
    metadata_path.write_bytes(clear_metadata)
    if file_hash(metadata_path) != JP_METADATA_SHA256:
        raise ValueError("decoded JP metadata differs from the reviewed decoder profile")
    from tools.jp_remote_sync import client_from_metadata
    client = client_from_metadata(metadata_path, authorize_builtin_credentials=True)
    if client.client_version != JP_CLIENT_VERSION:
        raise ValueError("JP NetworkConfig profile has the wrong client version")

    unity_path = stage / "data.unity3d"
    unity_path.write_bytes(unity_data)
    unity_identity = parse_unityfs_header(unity_path)
    unity_path.unlink()
    if not unity_identity or unity_identity.get("unity_version") != "6000.3.12f1":
        raise ValueError("JP Unity identity differs from the reviewed client")
    (stage / "unity-version.txt").write_text("6000.3.12f1\n", encoding="utf-8")
    seed_manifest = {
        "schemaVersion": 1,
        "region": "jp",
        "status": "verified_seed",
        "clientVersion": JP_CLIENT_VERSION,
        "versionCode": JP_VERSION_CODE,
        "certificateSha256": JP_CERTIFICATE_SHA256,
        "metadataSha256": JP_METADATA_SHA256,
        "packageSetSha256": JP_REVIEWED_PACKAGE_SET_SHA256,
        "xapkSha256": JP_REVIEWED_XAPK_SHA256,
        "unityVersion": "6000.3.12f1",
        "apks": {row["logicalName"]: row["sha256"] for row in package["splits"]},
    }
    write_json(stage / "seed-manifest.json", seed_manifest)
    return seed_manifest


def refresh(archive: Path, apksig_jar: Path, seed_root: Path) -> dict:
    archive, apksig_jar, seed_root = Path(archive), Path(apksig_jar), Path(seed_root)
    expected = (ROOT / "output" / "r2-jp").resolve()
    if seed_root.is_symlink() or seed_root.resolve() != expected or not seed_root.is_dir():
        raise ValueError("JP seed destination must be the restored output/r2-jp directory")
    for name in ("apks", "metadata.v39.dat", "unity-version.txt", "seed-manifest.json"):
        path = seed_root / name
        if path.is_symlink() or not path.exists():
            raise ValueError("restored JP seed is incomplete or linked")
    if seed_is_current(seed_root):
        return {"status": "unchanged", "clientVersion": JP_CLIENT_VERSION}

    stage = Path(tempfile.mkdtemp(prefix=".jp-client-refresh-", dir=seed_root.parent))
    backup = stage / "backup"
    backup.mkdir()
    try:
        manifest = _extract_reviewed_package(archive, apksig_jar, stage)
        replacements = ("apks", "metadata.v39.dat", "unity-version.txt", "seed-manifest.json")
        moved_old: list[str] = []
        installed_new: list[str] = []
        try:
            for name in replacements:
                os.replace(seed_root / name, backup / name)
                moved_old.append(name)
                os.replace(stage / name, seed_root / name)
                installed_new.append(name)
        except BaseException:
            for name in reversed(installed_new):
                target = seed_root / name
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
            for name in reversed(moved_old):
                os.replace(backup / name, seed_root / name)
            raise
        return {"status": "refreshed", "clientVersion": JP_CLIENT_VERSION,
                "versionCode": JP_VERSION_CODE, "packageSetSha256": manifest["packageSetSha256"],
                "metadataSha256": JP_METADATA_SHA256}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    check = subparsers.add_parser("check")
    check.add_argument("--seed-root", type=Path, required=True)
    update = subparsers.add_parser("refresh")
    update.add_argument("--archive", type=Path, required=True)
    update.add_argument("--apksig-jar", type=Path, required=True)
    update.add_argument("--seed-root", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "check":
        if not seed_is_current(args.seed_root):
            print("JP client seed refresh required")
            return 1
        print(json.dumps({"status": "current", "clientVersion": JP_CLIENT_VERSION}))
        return 0
    try:
        result = refresh(args.archive, args.apksig_jar, args.seed_root)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(str(error))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
