"""Discover and acquire Global production updates without a phone or login.

python3 -m tools.global_remote_sync probe --output output/probe.json
python3 -m tools.global_remote_sync snapshot --output output/new-snapshot --baseline input/global/device-files/2026-09-24-v1.0.1-25
python3 -m tools.global_remote_sync package --output output/package.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from tools.resource_pipeline.adapters.global_public import (
    CDN_HOSTS, WEB_HOSTS, GlobalPublicClient, ProtocolError, allowed_url,
    discover_package, sha256, utc_now, version_identity,
)
from tools.resource_pipeline.catalog_adapter import CatalogAdapter
from tools.resource_pipeline.transport import HttpRequest, HttpTransport


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def file_hash(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def remote_path(internal_id: str) -> str:
    p = urlsplit(internal_id)
    if (p.scheme != "https" or p.netloc != "dummy.net" or p.query or p.fragment
            or not re.fullmatch(r"/asset/Android/[A-Za-z0-9_./()-]+", p.path)
            or any(x in ("", ".", "..") for x in p.path[1:].split("/"))):
        raise ProtocolError("unexpected catalog remote path")
    return p.path


def remote_assets(catalog) -> list[dict]:
    assets = {}
    for location in catalog.locations:
        if not location.internal_id.startswith(("https:", "http:")):
            continue
        path = remote_path(location.internal_id)
        if type(location.expected_size) is not int or location.expected_size <= 0:
            raise ProtocolError("remote catalog record has no positive size")
        record = {"key": location.primary_key, "path": path, "provider": location.provider_id,
                  "byteSize": location.expected_size, "catalogHash": location.expected_hash,
                  "catalogHashAlgorithm": location.expected_hash_algorithm}
        if path in assets and assets[path] != record:
            raise ProtocolError("conflicting remote catalog records")
        assets[path] = record
    return sorted(assets.values(), key=lambda x: x["path"])


def plan_assets(current, previous=None) -> dict:
    assets = remote_assets(current)
    old = {row["path"]: row for row in remote_assets(previous)} if previous else {}
    selected = [{**row, "change": "unchanged" if old.get(row["path"]) == row else "new_or_changed",
                 "remoteCode": bool(re.search(r"(?:^|/)patch[_/]|hotfix|\.dll$", row["path"], re.I))}
                for row in assets]
    paths = {x["path"] for x in selected}
    return {"assets": selected, "remoteCount": len(selected),
            "remoteBytes": sum(x["byteSize"] for x in selected),
            "changedCount": sum(x["change"] != "unchanged" for x in selected),
            "changedBytes": sum(x["byteSize"] for x in selected if x["change"] != "unchanged"),
            "removedPaths": sorted(old.keys() - paths),
            "remoteCodeChanged": any(x["remoteCode"] and x["change"] != "unchanged" for x in selected)}


def validate_manifest(value: object, version: str) -> list[dict]:
    if not isinstance(value, dict) or value.get("version") != version:
        raise ProtocolError("Master manifest version mismatch")
    rows = value.get("files")
    if not isinstance(rows, list) or not rows:
        raise ProtocolError("empty Master manifest")
    names = set()
    for row in rows:
        if not isinstance(row, dict) or not re.fullmatch(r"Master[A-Za-z0-9_]+\.bin", str(row.get("name", ""))):
            raise ProtocolError("invalid Master file name")
        if row["name"] in names:
            raise ProtocolError("duplicate Master file name")
        names.add(row["name"])
        if not re.fullmatch(r"[0-9a-f]{64}", str(row.get("hash", ""))):
            raise ProtocolError("invalid Master digest")
        if type(row.get("size")) is not int or not 0 < row["size"] <= 64_000_000:
            raise ProtocolError("invalid Master size")
    return rows


def acquire(url: str, path: Path, size: int, expected_sha: str | None = None,
            expected_etag: str | None = None, *, allowed_hosts: tuple[str, ...] = CDN_HOSTS + WEB_HOSTS,
            request_headers: dict[str, str] | None = None) -> dict:
    allowed_url(url, allowed_hosts)
    receipt_path = path.with_name(path.name + ".receipt.json")
    if path.is_symlink() or receipt_path.is_symlink():
        raise ProtocolError("refusing a symlink output")
    if path.exists():
        actual = file_hash(path)
        recorded = read_json(receipt_path) if receipt_path.exists() else {}
        if path.stat().st_size == size and (actual == expected_sha if expected_sha else (
            recorded.get("sha256") == actual and recorded.get("url") == url
            and (expected_etag is None or recorded.get("etag") == expected_etag.strip('"')))):
            return {"path": str(path), "byteSize": size, "sha256": actual, "url": url, "reused": True}
        raise ProtocolError(f"existing file does not match expected content: {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    transport = HttpTransport(allowed_hosts=allowed_hosts, connect_timeout_seconds=30,
                              read_timeout_seconds=30, max_response_bytes=size)
    with tempfile.TemporaryDirectory(prefix=".download-", dir=path.parent) as tmp:
        part = Path(tmp) / "part"
        with part.open("wb") as stream:
            response = transport.download(HttpRequest("GET", url, request_headers or {}), stream)
        if response.status != 200 or response.byte_size != size:
            raise ProtocolError(f"HTTP {response.status} or unexpected response size: {path.name}")
        actual = file_hash(part)
        if expected_sha is not None and actual != expected_sha:
            raise ProtocolError(f"SHA-256 mismatch: {path.name}")
        etag = response.headers.get("etag", "").strip('"')
        if expected_etag is not None and etag != expected_etag.strip('"'):
            raise ProtocolError(f"ETag changed during download: {path.name}")
        if re.fullmatch(r"[0-9a-fA-F]{32}", etag):
            md5 = hashlib.md5()
            with part.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    md5.update(chunk)
            if md5.hexdigest() != etag.lower():
                raise ProtocolError(f"ETag mismatch: {path.name}")
        report = {"path": str(path), "byteSize": size, "sha256": actual, "url": url,
                  "etag": etag or None, "reused": False}
        # A receipt may survive an interrupted rename; bytes are checked on resume.
        write_json(receipt_path, report)
        part.replace(path)
    return report


def compare_master(current: Path, previous: Path | None) -> dict:
    names = {p.name for p in current.glob("Master*.json")}
    old_names = {p.name for p in previous.glob("Master*.json")} if previous else set()
    changed = [name for name in sorted(names & old_names)
               if read_json(current / name) != read_json(previous / name)]
    return {"added": sorted(names - old_names), "removed": sorted(old_names - names), "changed": changed}


def verify_apk_signature(apk: Path, jar: Path, expected_certificate: str) -> dict:
    verifier = Path(__file__).parent / "resource_pipeline/VerifyApk.java"
    result = subprocess.run(["java", "-cp", str(jar), str(verifier), str(apk)], capture_output=True, text=True, timeout=120)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if result.returncode or fields.get("verified") != "true" or fields.get("certificateSha256") != expected_certificate:
        raise ProtocolError("Android APK signature verification failed")
    return {"verified": True, "v2": fields.get("v2") == "true", "v3": fields.get("v3") == "true",
            "certificateSha256": expected_certificate, "verifierJarSha256": file_hash(jar)}


def _snapshot(client, output: Path, baseline: Path | None, previous_master: Path | None,
             mode: str, budget: int) -> dict:
    observation = client.discover()
    output.mkdir(parents=True, exist_ok=True)
    observation_path = output / "observation.json"
    if observation_path.exists() and version_identity(read_json(observation_path)) != version_identity(observation):
        raise ProtocolError("snapshot belongs to a different version; choose a new output directory")
    if not observation_path.exists() and any(output.iterdir()):
        raise ProtocolError("output directory is not an initialized snapshot")
    write_json(observation_path, observation)
    write_json(output / "status.json", {"status": "acquiring", "startedAt": utc_now()})
    catalog_bytes = client.get(observation["catalogUrl"], 64_000_000).body
    catalog = CatalogAdapter().parse_bytes(catalog_bytes)
    catalog_dir = output / "RemoteCatalog"
    catalog_dir.mkdir(exist_ok=True)
    (catalog_dir / "catalog_main.bin").write_bytes(catalog_bytes)
    (catalog_dir / "catalog_main.cached_hash").write_text(observation["resourceVersion"] + "/" + observation["catalogHash"])
    previous_catalog_path = baseline / "RemoteCatalog/catalog_main.bin" if baseline else None
    previous_catalog = CatalogAdapter().parse(previous_catalog_path) if previous_catalog_path else None
    plan = plan_assets(catalog, previous_catalog)
    write_json(output / "asset-plan.json", plan)
    manifest_bytes = client.get(observation["masterManifestUrl"], 4_000_000).body
    rows = validate_manifest(json.loads(manifest_bytes), observation["masterVersion"])
    master_dir = output / "Master"
    master_dir.mkdir(exist_ok=True)
    (master_dir / "MasterManifest.json").write_bytes(manifest_bytes)
    records = []
    for index, row in enumerate(rows):
        target = master_dir / row["name"]
        previous = baseline / "Master" / row["name"] if baseline else None
        if not target.exists() and previous and previous.is_file() and previous.stat().st_size == row["size"] and file_hash(previous) == row["hash"]:
            shutil.copyfile(previous, target)
        records.append(acquire(observation["masterManifestUrl"].rsplit("/", 1)[0] + "/" + row["name"],
                               target, row["size"], row["hash"]))
        if (index + 1) % 40 == 0:
            print(f"Master {index + 1}/{len(rows)}", flush=True)
    from analysis.crypto.decrypt_master import decrypt_master_file, DEFAULT_SALT, DEFAULT_KEY, DEFAULT_IV
    clear_dir = output / "master-json"
    decrypted = []
    for row in rows:
        decrypted.append(decrypt_master_file(master_dir / row["name"], clear_dir / (Path(row["name"]).stem + ".json"),
                                            salt=DEFAULT_SALT, key=DEFAULT_KEY, iv=DEFAULT_IV))
    write_json(clear_dir / "master-decrypt-report.json", {"results": decrypted, "failures": []})
    difference = compare_master(clear_dir, previous_master)
    selected = [row for row in plan["assets"] if mode == "all" or mode == "changed" and row["change"] != "unchanged"]
    required = sum(row["byteSize"] for row in selected)
    if required > budget:
        raise ProtocolError(f"selected assets need {required} bytes, above budget {budget}; verified Master and plan retained")
    for index, row in enumerate(selected):
        path = output / "assets" / row["path"].removeprefix("/asset/Android/")
        records.append(acquire(observation["cdnRoot"] + row["path"], path, row["byteSize"]))
        if (index + 1) % 25 == 0:
            print(f"Assets {index + 1}/{len(selected)}", flush=True)
    final = client.discover()
    if version_identity(final) != version_identity(observation):
        raise ProtocolError("remote version changed during acquisition; snapshot is not publishable")
    final_manifest = client.get(observation["masterManifestUrl"], 4_000_000).body
    if final_manifest != manifest_bytes:
        raise ProtocolError("Master manifest mutated during acquisition")
    report = {"status": "verified_snapshot", "finishedAt": utc_now(), "observation": observation,
              "catalogSha256": sha256(catalog_bytes), "masterManifestSha256": sha256(manifest_bytes),
              "catalogLocations": len(catalog.locations), "masterFiles": len(rows), "masterDiff": difference,
              "assetMode": mode, "acquiredAssetCount": len(selected), "acquiredAssetBytes": required,
              "remoteAssetCount": plan["remoteCount"], "remoteAssetBytes": plan["remoteBytes"],
              "changedAssetCount": plan["changedCount"], "remoteCodeChanged": plan["remoteCodeChanged"],
              "publicationReady": False, "files": records}
    write_json(output / "report.json", report)
    write_json(output / "status.json", {"status": "verified_snapshot", "finishedAt": report["finishedAt"]})
    return {k: v for k, v in report.items() if k != "files"}


def snapshot(client, output: Path, baseline: Path | None, previous_master: Path | None, mode: str, budget: int) -> dict:
    try:
        return _snapshot(client, output, baseline, previous_master, mode, budget)
    except Exception as exc:
        if (output / "observation.json").exists():
            write_json(output / "status.json", {"status": "incomplete", "error": str(exc), "observedAt": utc_now()})
        raise


def _update(client, output: Path, baseline: Path, plan: Path, build_site: bool, *, complete_content: bool = False, decoder=None) -> dict:
    """One-shot sync: unchanged runs are cheap; successful candidates become baselines."""
    from tools.build_remote_global_inputs import refresh, ROOT
    from tools.release_build import build_release
    from tools.release_preflight import load_plan, inspect_plan
    decoder_binding = decoder.get('bundleDecoderBindingSha256') if decoder else None
    if decoder and (not isinstance(decoder_binding, str) or not re.fullmatch('[a-f0-9]{64}', decoder_binding)):
        raise ProtocolError('missing verified bundle decoder binding')
    state_path = output / "state.json"
    state = read_json(state_path) if state_path.exists() else None
    observation = client.discover()
    if state and version_identity(state["observation"]) == version_identity(observation) and (not decoder or state.get('decoderSha256') == decoder['apkSha256'] and state.get('bundleDecoderBindingSha256') == decoder_binding) and (not complete_content or state.get('pipelineVersion') == 3):
        if Path(state["inputPlan"]).is_file() and (not build_site or state.get("site") and Path(state["site"]).is_dir()):
            return {"status": "unchanged", "observation": observation, "candidate": state["inputPlan"], "site": state.get("site")}
    if state:
        baseline, plan = Path(state["snapshot"]), Path(state["inputPlan"])
    previous = next(x for x in load_plan(plan) if x["id"] == "global-production")
    if (not state and complete_content and decoder and previous.get('supplementalInputs') and previous.get('bgmAudioInputs')
            and isinstance(previous['supplementalInputs'], dict)
            and (ROOT / previous['supplementalInputs'].get('root', '') / 'public/costumes/manifest.json').is_file()):
        initial = read_json(baseline / 'observation.json')
        manifest = read_json(ROOT / previous['manifest'])
        if (version_identity(initial) == version_identity(observation)
                and manifest['provenance']['apkSha256'].get('base.apk') == decoder['apkSha256']
                and manifest['provenance'].get('decoderProfile', {}).get('bundleDecoderBindingSha256') == decoder_binding):
            from tools.supplemental_inputs import read_supplemental
            if inspect_plan(plan, require_production=True)['status'] != 'passed':
                raise ProtocolError('initial complete inputs failed validation')
            read_supplemental(previous, ROOT)
            result = {'status': 'verified_initial_inputs', 'observation': observation,
                      'snapshot': str(baseline.resolve()), 'inputPlan': str(plan.resolve()), 'site': None,
                      'decoderSha256': decoder['apkSha256'], 'bundleDecoderBindingSha256': decoder_binding, 'pipelineVersion': 3, 'publicationReady': False}
            write_json(state_path, result)
            return result
    identity = f"{observation['resourceVersion']}-{observation['masterVersion'][:8]}-{observation['catalogHash'][:8]}"
    if complete_content:
        identity += '-complete-v3'
    if decoder:
        identity += '-' + decoder['apkSha256'][:8] + '-d' + decoder_binding[:12]
    current = output / identity
    captured = current / "snapshot"
    completed = captured / "report.json"
    valid = (completed.exists() and (captured / "status.json").exists()
             and read_json(captured / "status.json").get("status") == "verified_snapshot"
             and version_identity(read_json(completed)["observation"]) == version_identity(observation))
    if not valid:
        snapshot(client, captured, baseline, ROOT / previous["masterRoot"], "none" if complete_content else "changed", 1_000_000_000)
    inputs = current / "inputs"
    if not inputs.exists():
        if complete_content:
            from tools.current_content_inputs import refresh_current
            refresh_current(captured, baseline / "RemoteCatalog/catalog_main.bin", plan, inputs, decoder=decoder)
        else:
            refresh(captured, baseline / "RemoteCatalog/catalog_main.bin", plan, inputs)
    if decoder and complete_content:
        binding_receipt = inputs / '.identity.json'
        if not binding_receipt.is_file() or read_json(binding_receipt).get('bundleDecoderBindingSha256') != decoder_binding:
            raise ProtocolError('cached inputs bundle decoder binding mismatch')
    candidate_plan = inputs / "release-inputs.json"
    # Raw CRI addresses can be reused by the upstream release. Snapshot capture
    # checks its own acquisition window; also cover the later media extraction.
    if complete_content and version_identity(client.discover()) != version_identity(observation):
        raise ProtocolError("remote version changed during content extraction; previous baseline preserved")
    if inspect_plan(candidate_plan, require_production=True)["status"] != "passed":
        raise ProtocolError("candidate input preflight failed; update baseline is unchanged")
    site_path = current / "website"
    if build_site and not site_path.exists():
        build_release(candidate_plan, site_path)
    result = {"status": "candidate_built", "observation": read_json(captured / "observation.json"),
              "snapshot": str(captured.resolve()), "inputPlan": str(candidate_plan.resolve()),
              "site": str((site_path / "site").resolve()) if build_site else None,
              "remoteCodeChanged": read_json(captured / "report.json")["remoteCodeChanged"],
              "publicationReady": False, "decoderSha256": decoder['apkSha256'] if decoder else None, "bundleDecoderBindingSha256": decoder_binding, "pipelineVersion": 3 if complete_content else 1}
    write_json(state_path, result)
    return result


def update(client, output: Path, baseline: Path, plan: Path, build_site: bool, *, complete_content: bool = False, decoder=None) -> dict:
    import fcntl
    root = Path(__file__).resolve().parents[1]
    if (root / "output").resolve() not in output.resolve().parents:
        raise ProtocolError("update state must be under repository output/")
    output.mkdir(parents=True, exist_ok=True)
    with (output / "update.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProtocolError("another update is running") from None
        return _update(client, output, baseline, plan, build_site, complete_content=complete_content, decoder=decoder)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-version", default="1.0.1")
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("probe")
    probe.add_argument("--output", type=Path, required=True)
    probe.add_argument("--previous", type=Path)
    package = commands.add_parser("package")
    package.add_argument("--output", type=Path, required=True)
    package.add_argument("--download-dir", type=Path)
    package.add_argument("--apksig-jar", type=Path, help="Google apksig library; requires Java 17+")
    capture = commands.add_parser("snapshot")
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--baseline", type=Path)
    capture.add_argument("--previous-master", type=Path)
    capture.add_argument("--assets", choices=("none", "changed", "all"), default="changed")
    capture.add_argument("--max-asset-bytes", type=int, default=1_000_000_000)
    run = commands.add_parser("update", help="discover, download, refresh inputs and optionally build a site")
    run.add_argument("--output", type=Path, required=True, help="state and candidate directory under repository output/")
    run.add_argument("--baseline", type=Path, required=True, help="initial raw resource capture; later runs use saved state")
    run.add_argument("--plan", type=Path, default=Path("config/release-inputs.json"))
    run.add_argument("--build-site", action="store_true")
    args = parser.parse_args()
    if args.command == "package" and args.apksig_jar and not args.download_dir:
        parser.error("--apksig-jar requires --download-dir")
    client = GlobalPublicClient(args.client_version)
    try:
        if args.command == "probe":
            result = client.discover()
            if args.previous:
                previous = read_json(args.previous)
                result["changed"] = version_identity(previous) != version_identity(result)
                result["changes"] = [k for k in ("clientVersion", "cdnRoot", "masterVersion", "resourceVersion", "catalogHash")
                                     if previous.get(k) != result.get(k)]
            write_json(args.output, result)
        elif args.command == "package":
            result = discover_package(client)
            if args.download_dir:
                target = args.download_dir / Path(urlsplit(result["url"]).path).name
                result["download"] = acquire(result["url"], target, result["byteSize"], expected_etag=result["etag"])
                from tools.resource_pipeline.package_intake import inspect_apk
                result["package"] = inspect_apk(target)
                if result["package"]["packageName"] not in ("com.bilibili.sirius", "com.bilibili.sirius.official"):
                    raise ProtocolError("official download has an unexpected package name")
                result["distribution"] = "official_website" if result["package"]["packageName"].endswith(".official") else "google_play"
                result["certificateMatchesKnownProduction"] = result["package"]["certificateSha256"] == "bf683e367551a3f629b90e16a63b315af74e387bcc5d94f26dcd626e7eea3637"
                if not result["certificateMatchesKnownProduction"]:
                    raise ProtocolError("package signing certificate changed; package review required")
                result["packageIdentityVerified"] = True
                result["signatureCryptographicallyVerified"] = False
                if args.apksig_jar:
                    result["signature"] = verify_apk_signature(target, args.apksig_jar, result["package"]["certificateSha256"])
                    result["signatureCryptographicallyVerified"] = True
            write_json(args.output, result)
        elif args.command == "snapshot":
            result = snapshot(client, args.output, args.baseline, args.previous_master, args.assets, args.max_asset_bytes)
        else:
            result = update(client, args.output, args.baseline, args.plan, args.build_site)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        if args.command == "snapshot" and (args.output / "observation.json").exists():
            write_json(args.output / "status.json", {"status": "incomplete", "error": str(exc), "observedAt": utc_now()})
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
