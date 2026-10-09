"""Conservative unchanged-production gate for freshly restored Actions runners.

The probe runs in the pinned producer image and emits only hashes. The check and
record actions run on the host with R2 access; no R2 credential enters the image.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit

from tools.global_remote_sync import file_hash
from tools.resource_pipeline.adapters.global_public import version_identity


ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
IMAGE = re.compile(r".+@sha256:([a-f0-9]{64})\Z")
RECEIPT_FIELD = "r2ProductionReceipt"
RECEIPT_SCHEMA = 2
PROBE_SCHEMA = 1


class GateError(ValueError):
    pass


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def image_digest(value: str) -> str:
    match = IMAGE.fullmatch(value)
    if match is None:
        raise GateError("producer image must be pinned by SHA-256")
    return match[1]


def stable_root(root: Path) -> Path:
    root = Path(root).resolve(strict=True)
    if root != ROOT:
        raise GateError("gate ROOT differs from the executing checkout")
    return root


def safe_path(root: Path, raw: str, *, directory: bool = False) -> Path:
    root = Path(root).resolve(strict=True)
    relative = Path(raw)
    if relative.is_absolute() or not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        raise GateError("unsafe gate input path")
    path = root / relative
    if path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise GateError("gate input is absent or linked")
    if path.resolve() != root and root not in path.resolve().parents:
        raise GateError("gate input escapes ROOT")
    return path


def relative_path(root: Path, raw: str | Path, *, directory: bool = False) -> str:
    root = Path(root).resolve(strict=True)
    path = Path(raw)
    if not path.is_absolute():
        path = root / path
    if path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise GateError("gate input is absent, linked, or outside ROOT")
    path = path.resolve(strict=True)
    if root not in path.parents:
        raise GateError("gate input is absent, linked, or outside ROOT")
    name = path.relative_to(root).as_posix()
    safe_path(root, name, directory=directory)
    return name


def code_fingerprints(root: Path, *, private_inputs=()) -> tuple[str, str]:
    # JP's fingerprint covers the complete production tool tree and build inputs.
    # Include the orchestration file because workflow changes can alter behavior.
    from tools.jp_update import fingerprint
    if root != ROOT:
        raise GateError("source fingerprint ROOT differs from checkout")
    producer = fingerprint(exclude_paths=private_inputs)
    workflow = file_hash(root / ".github/workflows/content-r2.yml")
    return producer, digest(canonical({"producer": producer, "workflow": workflow}))


def package_identity(region: str, value: dict) -> str:
    if region == "global":
        selected = {key: value[key] for key in ("url", "byteSize", "etag")}
        if (not isinstance(selected["url"], str) or type(selected["byteSize"]) is not int or
                selected["etag"] is not None and not isinstance(selected["etag"], str)):
            raise GateError("invalid Global package observation")
        return digest(canonical(selected))
    if region == "jp":
        selected = {key: value[key] for key in ("packageSetSha256", "versionName", "versionCode", "certificateSha256")}
        if not SHA256.fullmatch(selected["packageSetSha256"]):
            raise GateError("invalid JP package observation")
        return digest(canonical(selected))
    raise GateError("invalid region")


def source_identity(value: dict | list) -> str:
    return digest(canonical(list(version_identity(value)) if isinstance(value, dict) else value))


def input_identity(root: Path, region: str, paths: dict[str, str]) -> tuple[str, str | None]:
    if region == "global":
        if set(paths) != {"config", "decoderProfile"}:
            raise GateError("invalid Global gate input selection")
        values = {name: file_hash(safe_path(root, path)) for name, path in paths.items()}
        return digest(canonical(values)), None
    if region == "jp":
        if set(paths) != {"metadata", "apkRoot", "unityVersion"}:
            raise GateError("invalid JP gate input selection")
        from tools.jp_phone_inputs import (
            JP_CERTIFICATE_SHA256, JP_CLIENT_VERSION, JP_METADATA_SHA256,
            JP_REVIEWED_PACKAGE_SET_SHA256, JP_VERSION_CODE,
        )
        from tools.resource_pipeline.package_intake import build_package_set_manifest
        metadata = safe_path(root, paths["metadata"])
        unity = safe_path(root, paths["unityVersion"])
        package = build_package_set_manifest(safe_path(root, paths["apkRoot"], directory=True),
                                             region="jp", channel="production")
        if (file_hash(metadata) != JP_METADATA_SHA256 or
                package.get("packageSetSha256") != JP_REVIEWED_PACKAGE_SET_SHA256 or
                package.get("certificateSha256") != JP_CERTIFICATE_SHA256 or
                package.get("versionName") != JP_CLIENT_VERSION or package.get("versionCode") != JP_VERSION_CODE):
            raise GateError("unreviewed JP package or metadata")
        values = {"metadata": JP_METADATA_SHA256, "unityVersion": file_hash(unity),
                  "packageSetSha256": package["packageSetSha256"]}
        return digest(canonical(values)), package_identity("jp", package)
    raise GateError("invalid region")


def trusted_input_inventory(root: Path, region: str, paths: dict[str, str], state: dict) -> list[dict]:
    """Bind the small inputs and previously verified client package to R2 state.

    This is computed only after a full producer run. An early check can later
    match the same file hashes against the immutable private state manifest
    without downloading the package again.
    """
    names = []
    if region == "global":
        names.extend((paths["config"], paths["decoderProfile"]))
        config = read_json(safe_path(root, paths["config"]))
        if config.get("intakePackages"):
            from tools.current_client import CERTIFICATE
            from tools.global_update import load_config
            loaded = load_config(safe_path(root, paths["config"]))
            workspace = loaded["workspace"]
            sync = workspace / "sync-complete/state.json"
            sync_state = read_json(sync)
            apk_sha = sync_state.get("decoderSha256")
            binding = sync_state.get("bundleDecoderBindingSha256")
            if not isinstance(apk_sha, str) or not SHA256.fullmatch(apk_sha) or not isinstance(binding, str) or not SHA256.fullmatch(binding):
                raise GateError("verified Global decoder state is absent")
            package = state["package"]
            package_id = digest(json.dumps({key: package[key] for key in ("url", "byteSize", "etag")}, sort_keys=True).encode())[:24]
            apk = workspace / "clients/downloads" / package_id / Path(urlsplit(package["url"]).path).name
            profile = workspace / "clients" / apk_sha / "decoder.json"
            profile_data = read_json(profile)
            if (profile_data.get("apkSha256") != apk_sha or profile_data.get("signatureVerified") is not True or
                    profile_data.get("certificateSha256") != CERTIFICATE or
                    profile_data.get("bundleDecoderBindingSha256", binding) != binding or
                    profile_data.get("clientVersion") != state["observation"]["clientVersion"] or
                    file_hash(apk) != apk_sha):
                raise GateError("verified Global APK cache differs from producer state")
            metadata = Path(profile_data["metadata"])
            if file_hash(metadata) != profile_data.get("metadataSha256"):
                raise GateError("verified Global metadata differs from decoder profile")
            names.extend((relative_path(root, sync), relative_path(root, apk),
                          relative_path(root, profile), relative_path(root, metadata)))
    elif region == "jp":
        names.extend((paths["metadata"], paths["unityVersion"]))
        apk_root = safe_path(root, paths["apkRoot"], directory=True)
        apks = sorted(apk_root.glob("*.apk"))
        if not apks:
            raise GateError("reviewed JP APK set is absent")
        names.extend(relative_path(root, path) for path in apks)
    else:
        raise GateError("invalid region")
    result = []
    for name in sorted(set(names)):
        path = safe_path(root, name)
        result.append({"path": name, "sha256": file_hash(path), "size": path.stat().st_size})
    return result


def probe(root: Path, region: str, image: str, *, config: str | None = None,
          decoder_profile: str | None = None, metadata: str | None = None,
          apk_root: str | None = None, unity_version_file: str | None = None) -> dict:
    root = stable_root(root)
    if region == "global":
        if not config or not decoder_profile or any((metadata, apk_root, unity_version_file)):
            raise GateError("Global probe requires only config and decoder profile")
        paths = {"config": relative_path(root, config),
                 "decoderProfile": relative_path(root, decoder_profile)}
        from tools.global_update import load_config
        from tools.resource_pipeline.adapters.global_public import GlobalPublicClient, discover_package
        from tools.current_client import intake
        loaded = load_config(safe_path(root, paths["config"]))
        client = GlobalPublicClient(loaded["clientVersion"])
        package_path = loaded['workspace'] / 'last-package.json'
        if not package_path.exists():
            package_path = loaded.get('initialPackage')
        previous_package = read_json(package_path) if package_path and package_path.exists() else None
        package = discover_package(client, previous=previous_package)
        # Match run_update's official-package -> verify-client -> sync-inputs
        # sequence. A newer APK can change the RPC client version even while
        # the private bootstrap config still names the previous version.
        if loaded.get("intakePackages"):
            decoder = intake(package, loaded["workspace"] / "clients", root / loaded["apksigJar"])
            client = GlobalPublicClient(decoder["clientVersion"])
        observation = client.discover()
        package_sha = package_identity("global", package)
    elif region == "jp":
        if not all((metadata, apk_root, unity_version_file)) or config or decoder_profile:
            raise GateError("JP probe requires only metadata, APK root and Unity version")
        paths = {"metadata": relative_path(root, metadata),
                 "apkRoot": relative_path(root, apk_root, directory=True),
                 "unityVersion": relative_path(root, unity_version_file)}
        from tools.jp_remote_sync import client_from_metadata
        client = client_from_metadata(safe_path(root, paths["metadata"]), authorize_builtin_credentials=True)
        observation = client.discover()
        package_sha = None
    else:
        raise GateError("invalid region")
    input_sha, local_package_sha = input_identity(root, region, paths)
    if region == "jp":
        package_sha = local_package_sha
        from tools.jp_phone_inputs import JP_CLIENT_VERSION
        if observation.get("clientVersion") != JP_CLIENT_VERSION:
            raise GateError("JP client upgrade requires a reviewed profile")
    producer_code_sha, code_sha = code_fingerprints(
        root, private_inputs=tuple(paths.values()) if region == "global" else ())
    return {"schemaVersion": PROBE_SCHEMA, "region": region,
            "sourceSha256": source_identity(observation), "packageSha256": package_sha,
            "producerCodeSha256": producer_code_sha, "codeSha256": code_sha,
            "inputSha256": input_sha, "imageDigest": image_digest(image), "inputPaths": paths}


def read_json(path: Path) -> dict:
    value = json.loads(Path(path).read_bytes())
    if not isinstance(value, dict):
        raise GateError("expected JSON object")
    return value


def state_path(root: Path, region: str) -> Path:
    if region == "global":
        return root / "output/global-update-workflow/state.json"
    if region == "jp":
        return root / "output/r2-jp/workspace/state.json"
    raise GateError("invalid region")


def state_without_receipt(state: dict) -> dict:
    return {key: value for key, value in state.items() if key != RECEIPT_FIELD}


def state_plan(root: Path, region: str, state: dict) -> Path:
    if region == "global":
        raw = state.get("inputPlan")
        if not isinstance(raw, str):
            raise GateError("Global state lacks input plan")
        plan = Path(raw)
        if not plan.is_absolute() or root / "output" not in plan.parents:
            raise GateError("Global input plan escapes output")
        name = relative_path(root, plan)
    else:
        run_id = state.get("runId")
        if not isinstance(run_id, str) or not re.fullmatch(r"[a-f0-9]{24}", run_id):
            raise GateError("JP state lacks valid run identity")
        name = f"output/r2-jp/workspace/runs/{run_id}/inputs/release-inputs.json"
    plan = safe_path(root, name)
    if state.get("inputPlanSha256") != file_hash(plan):
        raise GateError("restored input plan differs from state")
    return plan


def verified_plan(root: Path, region: str, state: dict) -> bool:
    try:
        plan = state_plan(root, region, state)
        from tools.release_preflight import inspect_plan
        return inspect_plan(plan, require_production=True)["status"] == "passed"
    except (OSError, ValueError, KeyError, TypeError):
        return False


def valid_probe(value: dict, region: str) -> bool:
    fields = ("sourceSha256", "packageSha256", "producerCodeSha256", "codeSha256", "inputSha256", "imageDigest")
    return (value.get("schemaVersion") == PROBE_SCHEMA and value.get("region") == region and
            all(isinstance(value.get(name), str) and SHA256.fullmatch(value[name]) for name in fields) and
            isinstance(value.get("inputPaths"), dict))


def current_input_identity(root: Path, region: str, observed: dict) -> bool:
    try:
        producer, code_sha = code_fingerprints(
            root, private_inputs=tuple(observed["inputPaths"].values()) if region == "global" else ())
        input_sha, package_sha = input_identity(root, region, observed["inputPaths"])
        return (producer == observed["producerCodeSha256"] and code_sha == observed["codeSha256"]
                and input_sha == observed["inputSha256"]
                and (region != "jp" or package_sha == observed["packageSha256"]))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def valid_receipt(state: dict, receipt: object, observed: dict) -> bool:
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != RECEIPT_SCHEMA:
        return False
    for key in ("region", "sourceSha256", "packageSha256", "codeSha256", "inputSha256", "imageDigest"):
        if receipt.get(key) != observed.get(key):
            return False
    for name in ("stateSha256", "publicPointerSha256"):
        if not isinstance(receipt.get(name), str) or not SHA256.fullmatch(receipt[name]):
            return False
    return receipt["stateSha256"] == digest(canonical(state_without_receipt(state)))


def _manifest_matches(bucket, pointer: dict, region: str) -> None:
    path = pointer.get("manifest")
    match = re.fullmatch(r"/content/releases/([a-f0-9]{24})/manifest\.json", path or "")
    if pointer.get("schemaVersion") != 1 or match is None or not isinstance(pointer.get("sha256"), str) or not SHA256.fullmatch(pointer["sha256"]):
        raise GateError("published pointer is invalid")
    item = bucket.get(path.lstrip("/"))
    if item is None or digest(item[0]) != pointer["sha256"]:
        raise GateError("published manifest is missing or damaged")
    manifest = json.loads(item[0])
    if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or
            manifest.get("root") != f"/content/releases/{match[1]}/" or
            manifest.get("region", "global") != region or manifest.get("channel") != "production" or
            manifest.get("contentReleaseId") != pointer.get("contentReleaseId") or
            not isinstance(manifest.get("locales"), dict) or set(manifest["locales"]) != {"en", "zh-CN"}):
        raise GateError("published manifest does not match the pointer")


def check(bucket, root: Path, region: str, observed: dict, public_before: dict,
          *, image: str) -> dict:
    from tools.r2_content import pointer_key
    root = Path(root)
    if not valid_probe(observed, region):
        raise GateError("invalid production probe")
    if image_digest(image) != observed["imageDigest"]:
        return {"status": "needs_production", "skip": False, "reason": "image_changed"}
    path = state_path(root, region)
    if path.is_symlink() or not path.is_file():
        return {"status": "needs_production", "skip": False, "reason": "state_missing"}
    try:
        state = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return {"status": "needs_production", "skip": False, "reason": "state_unknown"}
    receipt = state.get(RECEIPT_FIELD)
    if not valid_receipt(state, receipt, observed):
        return {"status": "needs_production", "skip": False, "reason": "receipt_missing_or_changed"}
    if not current_input_identity(root, region, observed):
        return {"status": "needs_production", "skip": False, "reason": "input_changed"}
    if not verified_plan(root, region, state):
        return {"status": "needs_production", "skip": False, "reason": "plan_unverified"}
    if region == "global" and state.get("status") not in {"content_published", "unchanged"}:
        return {"status": "needs_production", "skip": False, "reason": "state_unfinished"}
    if region == "jp" and state.get("status") != "built":
        return {"status": "needs_production", "skip": False, "reason": "state_unfinished"}
    publication = state.get("publication")
    pointer = publication.get("pointer") if isinstance(publication, dict) else None
    if not isinstance(pointer, dict) or pointer != receipt.get("publicPointer"):
        return {"status": "needs_production", "skip": False, "reason": "publication_changed"}
    key = pointer_key(region)
    current = bucket.get(key)
    current_bytes = current[0] if current else None
    current_sha = digest(current_bytes) if current_bytes is not None else "none"
    if (public_before.get("region") != region or public_before.get("currentSha256") != current_sha or
            current_sha != receipt["publicPointerSha256"] or
            (current_bytes is not None and json.loads(current_bytes) != pointer)):
        return {"status": "needs_production", "skip": False, "reason": "public_pointer_unmatched"}
    # Once a promoted pointer matches this verified receipt, damage to its
    # referenced manifest is a hard error rather than permission to skip.
    _manifest_matches(bucket, pointer, region)
    after = bucket.get(key)
    if after is None or after[0] != current_bytes:
        return {"status": "needs_production", "skip": False, "reason": "public_pointer_changed"}
    return {"status": "unchanged", "skip": True, "region": region,
            "pointerSha256": current_sha}


def record(root: Path, region: str, observed: dict, production: dict,
           upload: dict, store: Path, *, image: str) -> dict:
    root = Path(root)
    if not valid_probe(observed, region) or image_digest(image) != observed["imageDigest"]:
        raise GateError("production probe or image changed")
    if not current_input_identity(root, region, observed):
        raise GateError("producer inputs changed during run")
    path = state_path(root, region)
    if path.is_symlink() or not path.is_file():
        raise GateError("successful producer state is missing")
    state = read_json(path)
    if not verified_plan(root, region, state):
        raise GateError("producer input plan is unverified")
    if region == "global":
        if state.get("status") not in {"content_published", "unchanged"}:
            raise GateError("Global producer did not finish")
        if production.get("status") != state["status"]:
            raise GateError("Global production output differs from saved state")
        if (source_identity(state.get("observation", {})) != observed["sourceSha256"] or
                package_identity("global", state.get("package", {})) != observed["packageSha256"]):
            raise GateError("Global observation changed after probe")
    else:
        if state.get("status") != "built" or state.get("codeFingerprint") != observed["producerCodeSha256"]:
            raise GateError("JP producer did not finish with probed code")
        if production.get("status") != "built":
            raise GateError("JP production output did not finish")
        if source_identity(state.get("versionIdentity", [])) != observed["sourceSha256"]:
            raise GateError("JP observation changed after probe")
    if region == "global":
        if (source_identity(production.get("observation", {})) != observed["sourceSha256"] or
                package_identity("global", production.get("package", {})) != observed["packageSha256"]):
            raise GateError("Global production output differs from probe")
    else:
        if (source_identity(production.get("versionIdentity", [])) != observed["sourceSha256"] or
                production.get("codeFingerprint") != observed["producerCodeSha256"]):
            raise GateError("JP production output differs from probe")
    if (production.get("publication") != state.get("publication") or
            production.get("inputPlanSha256") != state.get("inputPlanSha256")):
        raise GateError("production output differs from saved state")
    local_pointer = Path(store) / ("current.json" if region == "global" else "jp/current.json")
    if local_pointer.is_symlink() or not local_pointer.is_file():
        raise GateError("sealed local pointer is missing")
    pointer_bytes = local_pointer.read_bytes()
    pointer = json.loads(pointer_bytes)
    publication = state.get("publication")
    if not isinstance(pointer, dict) or not isinstance(publication, dict) or pointer != publication.get("pointer"):
        raise GateError("local pointer differs from producer state")
    from tools.r2_content import pointer_key
    match = re.fullmatch(r"/content/releases/([a-f0-9]{24})/manifest\.json", pointer.get("manifest", ""))
    if (pointer.get("schemaVersion") != 1 or match is None or
            upload.get("region") != region or upload.get("releaseId") != match[1] or
            upload.get("pointerSha256") != digest(pointer_bytes) or
            type(upload.get("files")) is not int or upload["files"] < 1):
        raise GateError("verified R2 upload differs from local pointer")
    manifest = Path(store) / "releases" / match[1] / "manifest.json"
    if manifest.is_symlink() or not manifest.is_file() or file_hash(manifest) != pointer.get("sha256"):
        raise GateError("local manifest differs from producer pointer")
    _ = pointer_key(region)  # Enforce region validation before modifying state.
    inventory = trusted_input_inventory(root, region, observed["inputPaths"], state)
    receipt = {"schemaVersion": RECEIPT_SCHEMA, "region": region,
               "sourceSha256": observed["sourceSha256"], "packageSha256": observed["packageSha256"],
               "producerCodeSha256": observed["producerCodeSha256"],
               "codeSha256": observed["codeSha256"], "inputSha256": observed["inputSha256"],
               "inputPaths": observed["inputPaths"], "trustedInputInventory": inventory,
               "imageDigest": observed["imageDigest"], "publicPointer": pointer,
               "publicPointerSha256": digest(pointer_bytes),
               "stateSha256": digest(canonical(state_without_receipt(state)))}
    state[RECEIPT_FIELD] = receipt
    data = canonical(state)
    descriptor, temporary = tempfile.mkstemp(prefix=".r2-production-receipt-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"status": "recorded", "region": region,
            "pointerSha256": receipt["publicPointerSha256"]}


def _needs_full(reason: str) -> dict:
    return {"status": "needs_full", "skip": False, "reason": reason}


def _stage_path(root: Path, stage: Path) -> Path:
    root = Path(root).resolve(strict=True)
    stage = Path(stage)
    if not stage.is_absolute() or stage.is_symlink():
        raise GateError("light probe stage must use the isolated runner path")
    stage = stage.parent.resolve(strict=True) / stage.name
    if stage != root / "output/tmp/r2-light":
        raise GateError("light probe stage must use the isolated runner path")
    parent = stage.parent
    if parent.is_symlink() or not parent.is_dir() or parent.resolve() != root / "output/tmp":
        raise GateError("light probe stage parent is invalid")
    return stage


def _manifest_entry(manifest: dict, name: str) -> dict:
    matches = [entry for entry in manifest["files"] if entry["path"] == name]
    if len(matches) != 1:
        raise GateError("required private state object is absent")
    return matches[0]


def _download_private(bucket, manifest: dict, name: str, target: Path) -> bytes:
    from tools.r2_state import object_key
    entry = _manifest_entry(manifest, name)
    if entry["size"] > 128 * 1024 * 1024:
        raise GateError("light probe input exceeds its size bound")
    target.parent.mkdir(parents=True, exist_ok=True)
    bucket.download_file(object_key(entry["sha256"]), target, entry["sha256"], entry["size"])
    return target.read_bytes()


def _receipt_for_light(state: dict, region: str) -> dict | None:
    receipt = state.get(RECEIPT_FIELD)
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != RECEIPT_SCHEMA:
        return None
    if receipt.get("region") != region or receipt.get("stateSha256") != digest(canonical(state_without_receipt(state))):
        raise GateError("private production receipt does not match saved state")
    for key in ("sourceSha256", "packageSha256", "producerCodeSha256", "codeSha256", "inputSha256", "imageDigest", "publicPointerSha256"):
        if not isinstance(receipt.get(key), str) or not SHA256.fullmatch(receipt[key]):
            raise GateError("private production receipt is malformed")
    if not isinstance(receipt.get("publicPointer"), dict) or not isinstance(receipt.get("inputPaths"), dict):
        raise GateError("private production receipt is malformed")
    inventory = receipt.get("trustedInputInventory")
    if not isinstance(inventory, list) or not inventory:
        raise GateError("private production receipt lacks trusted inputs")
    return receipt


def _inventory_matches_manifest(manifest: dict, receipt: dict, region: str) -> bool:
    from tools.r2_state import safe_relative
    paths = receipt["inputPaths"]
    if set(paths) != ({"config", "decoderProfile"} if region == "global" else {"metadata", "apkRoot", "unityVersion"}):
        return False
    try:
        for raw in paths.values():
            safe_relative(raw)
        actual = []
        seen = set()
        for entry in receipt["trustedInputInventory"]:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size"}:
                return False
            name = safe_relative(entry["path"])
            if name in seen or not isinstance(entry["sha256"], str) or not SHA256.fullmatch(entry["sha256"]):
                return False
            if type(entry["size"]) is not int or entry["size"] < 0:
                return False
            remote = _manifest_entry(manifest, name)
            if (entry["sha256"], entry["size"]) != (remote["sha256"], remote["size"]):
                return False
            seen.add(name)
            actual.append(entry)
        if actual != sorted(actual, key=lambda item: item["path"]):
            return False
        by_path = {item["path"]: item for item in actual}
        if region == "global":
            if not {paths["config"], paths["decoderProfile"]} <= seen:
                return False
            expected_input = digest(canonical({"config": by_path[paths["config"]]["sha256"],
                                               "decoderProfile": by_path[paths["decoderProfile"]]["sha256"]}))
        else:
            from tools.jp_phone_inputs import JP_METADATA_SHA256, JP_REVIEWED_PACKAGE_SET_SHA256
            if not {paths["metadata"], paths["unityVersion"]} <= seen or by_path[paths["metadata"]]["sha256"] != JP_METADATA_SHA256:
                return False
            apk_prefix = paths["apkRoot"] + "/"
            apks = {entry["path"] for entry in manifest["files"]
                    if entry["path"].startswith(apk_prefix) and entry["path"].endswith(".apk")}
            if not apks or {name for name in seen if name.startswith(apk_prefix)} != apks:
                return False
            expected_input = digest(canonical({"metadata": JP_METADATA_SHA256,
                                               "unityVersion": by_path[paths["unityVersion"]]["sha256"],
                                               "packageSetSha256": JP_REVIEWED_PACKAGE_SET_SHA256}))
        return expected_input == receipt["inputSha256"]
    except (KeyError, TypeError, ValueError, GateError):
        return False


def light_prepare(private_bucket, root: Path, region: str, selections: list[str],
                  stage: Path, *, image: str, config: str | None = None,
                  decoder_profile: str | None = None) -> dict:
    """Fetch only immutable control data and the JP credential metadata."""
    from tools.r2_state import _manifest, _pointer
    root = stable_root(root)
    stage = _stage_path(root, stage)
    if stage.exists():
        raise GateError("light probe stage already exists")
    pointer, pointer_sha, _ = _pointer(private_bucket, region)
    if pointer is None:
        return _needs_full("private_state_missing")
    manifest = _manifest(private_bucket, root, region, selections)
    if _pointer(private_bucket, region)[1] != pointer_sha:
        return _needs_full("private_pointer_changed")
    state_name = state_path(root, region).relative_to(root).as_posix()
    if not any(entry["path"] == state_name for entry in manifest["files"]):
        return _needs_full("producer_state_not_seeded")
    stage.mkdir(mode=0o700)
    state_bytes = _download_private(private_bucket, manifest, state_name, stage / "state.json")
    state = json.loads(state_bytes)
    if not isinstance(state, dict):
        raise GateError("private producer state is malformed")
    receipt = _receipt_for_light(state, region)
    if receipt is None:
        return _needs_full("receipt_missing_or_legacy")
    if image_digest(image) != receipt["imageDigest"]:
        return _needs_full("image_changed")
    if not _inventory_matches_manifest(manifest, receipt, region):
        return _needs_full("private_inputs_changed")
    paths = receipt["inputPaths"]
    _, code_sha = code_fingerprints(
        root, private_inputs=tuple(paths.values()) if region == "global" else ())
    if code_sha != receipt["codeSha256"]:
        return _needs_full("source_changed")
    if region == "global":
        if not config or not decoder_profile or paths != {"config": config, "decoderProfile": decoder_profile}:
            return _needs_full("configuration_changed")
        package = state.get("package")
        observation = state.get("observation")
        if (not isinstance(package, dict) or not isinstance(observation, dict) or
                source_identity(observation) != receipt["sourceSha256"] or
                package_identity("global", package) != receipt["packageSha256"] or
                not all(isinstance(package.get(key), str) and package[key] for key in ("url", "etag", "lastModified"))):
            return _needs_full("package_identity_unavailable")
        config_bytes = _download_private(private_bucket, manifest, paths["config"], stage / "config.json")
        parsed_config = json.loads(config_bytes)
        if parsed_config.get("intakePackages"):
            names = {entry["path"] for entry in receipt["trustedInputInventory"]}
            if not (any(name.endswith("/decoder.json") for name in names) and
                    any(name.endswith(".apk") for name in names) and
                    any(name.endswith("/sync-complete/state.json") for name in names)):
                return _needs_full("verified_client_inventory_missing")
        stable_package_sha = digest(canonical({key: package[key] for key in ("url", "byteSize", "etag", "lastModified")}))
        client_version = observation.get("clientVersion")
        if not isinstance(client_version, str):
            return _needs_full("client_version_unknown")
    else:
        if paths != {"metadata": "output/r2-jp/metadata.v39.dat", "apkRoot": "output/r2-jp/apks",
                     "unityVersion": "output/r2-jp/unity-version.txt"}:
            return _needs_full("trusted_jp_paths_changed")
        if (state.get("status") != "built" or source_identity(state.get("versionIdentity", [])) != receipt["sourceSha256"] or
                state.get("codeFingerprint") != receipt.get("producerCodeSha256")):
            return _needs_full("jp_state_unmatched")
        _download_private(private_bucket, manifest, paths["metadata"], stage / "metadata.v39.dat")
        stable_package_sha = None
        from tools.jp_phone_inputs import JP_CLIENT_VERSION
        client_version = JP_CLIENT_VERSION
    publication = state.get("publication")
    if (not isinstance(publication, dict) or publication.get("pointer") != receipt.get("publicPointer") or
            region == "global" and state.get("status") not in {"content_published", "unchanged"}):
        return _needs_full("publication_unmatched")
    proof = {"schemaVersion": 1, "region": region, "privatePointerSha256": pointer_sha,
             "privateManifestSha256": pointer["sha256"], "receipt": receipt,
             "clientVersion": client_version, "stablePackageSha256": stable_package_sha,
             "package": package if region == "global" else None,
             "metadataPath": str(stage / "metadata.v39.dat") if region == "jp" else None}
    proof_path = stage / "proof.json"
    proof_path.write_bytes(canonical(proof))
    return {"status": "ready", "skip": False, "proof": str(proof_path)}


def light_probe(root: Path, region: str, prepared: Path, *, image: str) -> dict:
    root = Path(stable_root(root)).resolve(strict=True)
    prepared = Path(prepared).resolve(strict=True)
    if prepared != root / "output/tmp/r2-light/proof.json":
        raise GateError("light probe proof path is invalid")
    proof = read_json(prepared)
    receipt = proof.get("receipt")
    if (proof.get("schemaVersion") != 1 or proof.get("region") != region or
            not isinstance(receipt, dict) or receipt.get("imageDigest") != image_digest(image)):
        raise GateError("light probe proof is invalid")
    if region == "global":
        from tools.resource_pipeline.adapters.global_public import ClientUpdateRequired, GlobalPublicClient
        client = GlobalPublicClient(proof["clientVersion"])
        package = proof.get("package")
        if (not isinstance(package, dict) or
                not all(isinstance(package.get(key), str) and package[key] for key in ("url", "etag", "lastModified"))):
            return _needs_full("package_identity_unavailable")
        package_sha = package_identity("global", package)
        stable_sha = digest(canonical({key: package[key] for key in ("url", "byteSize", "etag", "lastModified")}))
        if package_sha != receipt["packageSha256"] or stable_sha != proof.get("stablePackageSha256"):
            return _needs_full("package_identity_unavailable")
        try:
            observation = client.discover()
        except ClientUpdateRequired:
            # Restore the verified state before downloading and reviewing the new APK.
            return _needs_full("client_update_required")
        return {"status": "probed", "region": region, "sourceSha256": source_identity(observation),
                "packageSha256": package_sha, "stablePackageSha256": stable_sha}
    if region == "jp":
        from tools.jp_remote_sync import client_from_metadata
        metadata = Path(proof["metadataPath"])
        if metadata != Path(prepared).parent / "metadata.v39.dat" or metadata.is_symlink():
            raise GateError("JP light probe metadata path is invalid")
        client = client_from_metadata(metadata, authorize_builtin_credentials=True)
        return {"status": "probed", "region": region, "sourceSha256": source_identity(client.discover()),
                "packageSha256": receipt["packageSha256"]}
    raise GateError("invalid region")


def light_check(private_bucket, public_bucket, root: Path, region: str, prepared: Path,
                observed: dict, public_before: dict, *, image: str) -> dict:
    from tools.r2_content import pointer_key as public_key
    from tools.r2_state import current_sha
    root = Path(stable_root(root)).resolve(strict=True)
    prepared = Path(prepared).resolve(strict=True)
    if prepared != root / "output/tmp/r2-light/proof.json":
        raise GateError("light probe proof path is invalid")
    proof = read_json(prepared)
    receipt = proof.get("receipt")
    if (proof.get("schemaVersion") != 1 or proof.get("region") != region or
            not isinstance(receipt, dict) or receipt.get("schemaVersion") != RECEIPT_SCHEMA):
        raise GateError("light probe proof is invalid")
    if observed.get("status") == "needs_full":
        return _needs_full(observed.get("reason", "probe_unknown"))
    if observed.get("status") != "probed" or observed.get("region") != region:
        raise GateError("light source observation is invalid")
    code_sha = code_fingerprints(root, private_inputs=(tuple(receipt["inputPaths"].values())
        if region == "global" else ()))[1]
    if (image_digest(image) != receipt["imageDigest"] or code_sha != receipt["codeSha256"] or
            observed.get("sourceSha256") != receipt["sourceSha256"] or
            observed.get("packageSha256") != receipt["packageSha256"] or
            region == "global" and observed.get("stablePackageSha256") != proof.get("stablePackageSha256")):
        return _needs_full("source_or_inputs_changed")
    pointer = receipt["publicPointer"]
    key = public_key(region)
    item = public_bucket.get(key)
    data = item[0] if item else None
    if (data is None or digest(data) != receipt["publicPointerSha256"] or
            public_before.get("region") != region or public_before.get("currentSha256") != digest(data) or
            json.loads(data) != pointer):
        return _needs_full("public_pointer_unmatched")
    _manifest_matches(public_bucket, pointer, region)
    after = public_bucket.get(key)
    if after is None or after[0] != data or current_sha(private_bucket, region) != proof["privatePointerSha256"]:
        return _needs_full("pointer_changed")
    return {"status": "unchanged", "skip": True, "region": region,
            "pointerSha256": digest(data)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("probe", "check", "record", "light-prepare", "light-probe", "light-check"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--region", choices=("global", "jp"), required=True)
    parser.add_argument("--image", help="pinned producer image; check/record default to OURNOTES_UPDATE_IMAGE")
    parser.add_argument("--config")
    parser.add_argument("--decoder-profile")
    parser.add_argument("--metadata")
    parser.add_argument("--apk-root")
    parser.add_argument("--unity-version-file")
    parser.add_argument("--probe", type=Path)
    parser.add_argument("--public-before", type=Path)
    parser.add_argument("--production", type=Path)
    parser.add_argument("--upload", type=Path)
    parser.add_argument("--store", type=Path)
    parser.add_argument("--stage", type=Path)
    parser.add_argument("--path", action="append", default=[])
    parser.add_argument("--prepared", type=Path)
    args = parser.parse_args(argv)
    try:
        image = args.image or os.environ.get("OURNOTES_UPDATE_IMAGE", "")
        if args.action == "probe":
            result = probe(args.root, args.region, image, config=args.config,
                           decoder_profile=args.decoder_profile, metadata=args.metadata,
                           apk_root=args.apk_root, unity_version_file=args.unity_version_file)
        elif args.action == "check":
            if not args.probe or not args.public_before:
                parser.error("check requires --probe and --public-before")
            from tools.r2_content import S3Bucket
            result = check(S3Bucket.from_environment(), stable_root(args.root), args.region,
                           read_json(args.probe), read_json(args.public_before), image=image)
        elif args.action == "record":
            if not all((args.probe, args.production, args.upload, args.store)):
                parser.error("record requires --probe, --production, --upload and --store")
            result = record(stable_root(args.root), args.region, read_json(args.probe),
                            read_json(args.production), read_json(args.upload), args.store,
                            image=image)
        elif args.action == "light-prepare":
            if not args.stage or not args.path:
                parser.error("light-prepare requires --stage and exact --path selections")
            from tools.r2_state import PrivateS3Bucket
            result = light_prepare(PrivateS3Bucket.from_environment(), args.root, args.region,
                                   args.path, args.stage, image=image, config=args.config,
                                   decoder_profile=args.decoder_profile)
        elif args.action == "light-probe":
            if not args.prepared:
                parser.error("light-probe requires --prepared")
            result = light_probe(args.root, args.region, args.prepared, image=image)
        else:
            if not args.prepared or not args.probe or not args.public_before:
                parser.error("light-check requires --prepared, --probe and --public-before")
            from tools.r2_state import PrivateS3Bucket
            from tools.r2_content import S3Bucket
            result = light_check(PrivateS3Bucket.from_environment(), S3Bucket.from_environment(),
                                 args.root, args.region, args.prepared, read_json(args.probe),
                                 read_json(args.public_before), image=image)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        # Never echo an upstream exception: it may contain a request URL or
        # credential-bearing response. CI only needs a bounded error category.
        print(json.dumps({"status": "blocked", "errorType": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
