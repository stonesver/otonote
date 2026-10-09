"""Extract the three production story categories, using cache then public CDN.

No account/session endpoint is used. Input digests and per-bundle receipts are
checked before decryption; keys remain in memory. Existing evidence downloads
can be reused via --downloads. Outputs are independent, pinned build inputs.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analysis.crypto.decrypt_global_formal_scores import (
    CATALOG_SHA256, METADATA_SHA256, KEY_FIELD_USAGE, NONCE_SEED_FIELD_USAGE,
    MetadataV39, UnityPy, decrypt_header, field_bytes,
)
from tools.download_global_public_asset import download
from tools.release_preflight import check_environment, load_plan
from tools.resource_pipeline.catalog_adapter import CatalogAdapter
from tools.story_text import MASTER_TABLES, LOCALE_FIELDS, digest, read_rows, parse_document, story_fallback_locales


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def command_enum(metadata: MetadataV39) -> dict:
    """v39 stores enum defaults as compressed signed integers, not int32s."""
    i = next(i for i in range(metadata.type_count)
             if metadata.type_name(i) == "AdvSystem.Asset.AdvCommand")
    start = struct.unpack_from("<I", metadata.data, metadata.type_offset + i * 82 + 26)[0]
    end = struct.unpack_from("<I", metadata.data, metadata.type_offset + (i + 1) * 82 + 26)[0]
    defaults = {f: d for j in range(metadata.sections[7][2]) for f, _, d in
                [struct.unpack_from("<III", metadata.data, metadata.sections[7][0] + j * 12)]}
    result = {}
    for field in range(start, end):
        if field not in defaults:
            continue
        name = metadata.string(struct.unpack_from("<I", metadata.data, metadata.sections[11][0] + field * 12)[0])
        offset = metadata.sections[8][0] + defaults[field]
        first = metadata.data[offset]
        if first < 128:
            value = first
        elif first < 192:
            value = ((first & 63) << 8) | metadata.data[offset + 1]
        else:
            raise ValueError("unsupported compressed ADV enum")
        result[name] = -(value >> 1) - 1 if value & 1 else value >> 1
    expected = {"Talk": 2, "Location": 20, "Subtitles": 28, "ChatTalk": 37,
                "ChatStamp": 38, "ChoiceSet": 40, "ChoiceShow": 41, "GoTo": 42, "ChatTyping": 65}
    if any(result.get(k) != v for k, v in expected.items()):
        raise ValueError("production ADV enum changed")
    return result


def extract(args) -> dict:
    if args.output.exists():
        raise ValueError("output exists; choose a new directory")
    source = next(r for r in load_plan(ROOT / "config/release-inputs.json") if r["id"] == "global-production")
    if check_environment(source, ROOT)["status"] != "passed":
        raise ValueError("production input preflight failed")
    master = ROOT / source["masterRoot"]
    catalog = args.capture_root / "RemoteCatalog/catalog_main.bin"
    if digest(catalog) != CATALOG_SHA256 or digest(args.metadata) != METADATA_SHA256:
        raise ValueError("unsupported production catalog/metadata digest")
    capture = json.loads((args.capture_root / "capture.json").read_text())
    recorded = {r["path"]: r for r in capture["files"]}
    cached = {p.name.split("_", 1)[0]: p for p in (args.capture_root / "EncryptedBundles").glob("*.bundle")}
    locations = {}
    for loc in CatalogAdapter().parse(catalog).locations:
        if loc.provider_id.endswith(".AssetBundleCryptProvider"):
            locations.setdefault(loc.primary_key[:-40], []).append(loc)
    meta = MetadataV39(args.metadata)
    enums = command_enum(meta)
    key, seed = field_bytes(meta, KEY_FIELD_USAGE, 16), field_bytes(meta, NONCE_SEED_FIELD_USAGE, 8)
    advs = {r["_id"]: r for r in read_rows(master, "MasterAdv")}
    ids = sorted({r["_advId"] for table in ("MasterStoryEpisode", "MasterStoryFriendshipEpisode")
                  for r in read_rows(master, table)})
    documents, receipts, line_counts = [], [], {locale: 0 for locale in LOCALE_FIELDS}
    for i, identifier in enumerate(ids):
        adv = advs[identifier]
        name = adv["_advEpisodeAsset"]
        if not re.fullmatch(r"[a-z0-9_]+", name):
            raise ValueError("unsafe ADV name")
        payload = {"name": name}
        for suffix in ("", "-text"):
            prefix = f"adv_assets_adv_episode_{name}_{name}{suffix}"
            matches = locations.get(prefix, [])
            if len(matches) != 1:
                raise ValueError(f"no unique catalog bundle: {prefix}")
            loc = matches[0]
            bundle_id = loc.primary_key[:-7].rsplit("_", 1)[-1]
            cache = cached.get(bundle_id)
            if cache:
                record = recorded[cache.relative_to(args.capture_root).as_posix()]
                if digest(cache) != record["sha256"] or cache.stat().st_size != record["size_bytes"]:
                    raise ValueError("cached bundle differs from capture")
                bundle = cache
                receipt = {"bundle": loc.primary_key, "sha256": digest(bundle), "origin": "device-cache"}
            else:
                bundle = args.downloads / loc.primary_key
                # Both the original download tool and the bounded intake probe
                # use SHA256 receipts. Never trust an unreceipted existing file.
                receipt_path = bundle.with_suffix(bundle.suffix + ".json")
                if not receipt_path.exists():
                    download(loc.primary_key, bundle)
                receipt = json.loads(receipt_path.read_text())
                if receipt.get("bundle") != loc.primary_key or digest(bundle) != receipt["sha256"]:
                    raise ValueError("download receipt mismatch")
            if bundle.stat().st_size != loc.expected_size:
                raise ValueError("bundle differs from pinned catalog size")
            receipts.append(receipt)
            env = UnityPy.load(decrypt_header(bundle.read_bytes(), loc.primary_key, key, seed))
            found = []
            for obj in env.objects:
                if suffix and obj.type.name == "TextAsset":
                    data = obj.read()
                    if data.m_Name != name + "-Text":
                        continue
                    raw = data.m_Script.encode("utf-8", errors="surrogateescape") if isinstance(data.m_Script, str) else bytes(data.m_Script)
                    found.append(json.loads(raw)["_allData"])
                elif not suffix and obj.type.name == "MonoBehaviour":
                    tree = obj.read_typetree()
                    if tree.get("m_Name") == name and isinstance(tree.get("Collection"), list):
                        found.append({"Collection": tree["Collection"]})
            if len(found) != 1:
                raise ValueError("no unique ADV object in bundle")
            payload["texts" if suffix else "root"] = found[0]
        for locale in LOCALE_FIELDS:
            projected = parse_document(payload["root"], payload["texts"], locale,
                                       fallback_locale=story_fallback_locales("global", locale))
            line_counts[locale] += sum(row["kind"] in {"dialogue", "chat", "narration", "subtitle"} for row in projected["lines"])
        destination = args.output / "documents" / f"adv-{identifier}.json"
        write(destination, payload)
        documents.append({"advId": identifier, "path": destination.relative_to(args.output).as_posix(), "sha256": digest(destination)})
        if (i + 1) % 50 == 0:
            print(f"Verified {i + 1}/{len(ids)} stories", flush=True)
    index = {"schemaVersion": 1, "sourceReleaseId": source["contentReleaseId"],
             "catalogSha256": CATALOG_SHA256, "metadataSha256": METADATA_SHA256,
             "masterSha256": {n: digest(master / f"{n}.json") for n in MASTER_TABLES}, "documents": documents}
    write(args.output / "index.json", index)
    report = {"stories": len(documents), "bundles": len(receipts), "lineCounts": line_counts,
              "commandEnum": enums, "receipts": receipts,
              "binding": {"index": str((args.output / "index.json").resolve().relative_to(ROOT)),
                          "sha256": digest(args.output / "index.json")}}
    write(args.output / "report.json", report)
    return {k: report[k] for k in ("stories", "bundles", "lineCounts", "binding")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-root", type=Path, default=ROOT / "input/global/device-files/2026-09-24-v1.0.1-25")
    parser.add_argument("--metadata", type=Path, default=ROOT / "input/global/decrypted/2026-09-22-v1.0.1-25/il2cpp/global-metadata.v39.dat")
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    print(json.dumps(extract(parser.parse_args()), indent=2))
