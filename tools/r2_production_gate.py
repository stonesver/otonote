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

from tools.global_remote_sync import file_hash
from tools.resource_pipeline.adapters.global_public import version_identity


ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
IMAGE = re.compile(r".+@sha256:([a-f0-9]{64})\Z")
RECEIPT_FIELD = "r2ProductionReceipt"
RECEIPT_SCHEMA = 1
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


def code_fingerprints(root: Path) -> tuple[str, str]:
    # JP's fingerprint covers the complete production tool tree and build inputs.
    # Include the orchestration file because workflow changes can alter behavior.
    from tools.jp_update import fingerprint
    if root != ROOT:
        raise GateError("source fingerprint ROOT differs from checkout")
    producer = fingerprint()
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
            JP_CERTIFICATE_SHA256, JP_METADATA_SHA256, JP_REVIEWED_PACKAGE_SET_SHA256,
        )
        from tools.resource_pipeline.package_intake import build_package_set_manifest
        metadata = safe_path(root, paths["metadata"])
        unity = safe_path(root, paths["unityVersion"])
        package = build_package_set_manifest(safe_path(root, paths["apkRoot"], directory=True),
                                             region="jp", channel="production")
        if (file_hash(metadata) != JP_METADATA_SHA256 or
                package.get("packageSetSha256") != JP_REVIEWED_PACKAGE_SET_SHA256 or
                package.get("certificateSha256") != JP_CERTIFICATE_SHA256 or
                package.get("versionName") != "1.0.4" or package.get("versionCode") != 10053):
            raise GateError("unreviewed JP package or metadata")
        values = {"metadata": JP_METADATA_SHA256, "unityVersion": file_hash(unity),
                  "packageSetSha256": package["packageSetSha256"]}
        return digest(canonical(values)), package_identity("jp", package)
    raise GateError("invalid region")


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
        package = discover_package(client)
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
        if observation.get("clientVersion") != "1.0.4":
            raise GateError("JP client upgrade requires a reviewed profile")
    producer_code_sha, code_sha = code_fingerprints(root)
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
        producer, code_sha = code_fingerprints(root)
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
    receipt = {"schemaVersion": RECEIPT_SCHEMA, "region": region,
               "sourceSha256": observed["sourceSha256"], "packageSha256": observed["packageSha256"],
               "codeSha256": observed["codeSha256"], "inputSha256": observed["inputSha256"],
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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("probe", "check", "record"))
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
        else:
            if not all((args.probe, args.production, args.upload, args.store)):
                parser.error("record requires --probe, --production, --upload and --store")
            result = record(stable_root(args.root), args.region, read_json(args.probe),
                            read_json(args.production), read_json(args.upload), args.store,
                            image=image)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        # Never echo an upstream exception: it may contain a request URL or
        # credential-bearing response. CI only needs a bounded error category.
        print(json.dumps({"status": "blocked", "errorType": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
