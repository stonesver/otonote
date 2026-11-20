"""Assemble both editions from approved code and sealed public content."""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from tools.code_publication import verify_code
from tools.materialize_r2_content import R2Reader, materialize
from tools.publish_prerender import publish, read_inputs
from tools.r2_content import pointer_key

REGIONS = ("global", "jp")
STATE = "web-delivery/v1"
DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def read_code(origin):
    if urlsplit(origin).scheme != "https" or urlsplit(origin).path:
        raise ValueError("Expected HTTPS site origin without a path")
    with urlopen(
        Request(
            origin + "/_site-delivery/code.json", headers={"Cache-Control": "no-cache"}
        ),
        timeout=25,
    ) as response:
        code = json.load(response)
    for field, length in (("codeId", 24), ("revision", 40), ("receiptSha256", 64)):
        if not re.fullmatch(rf"[0-9a-f]{{{length}}}", code[field]):
            raise ValueError("Invalid active code: " + field)
    return code


def snapshot(reader, origin):
    pointers = {
        region: json.loads(reader.control(pointer_key(region))) for region in REGIONS
    }
    return {"code": read_code(origin), "pointers": pointers}


def state_reader(public):
    return R2Reader(public.client, os.environ["R2_PRIVATE_BUCKET"])


def archive_key(code):
    return f"{STATE}/code/{code['codeId']}/{code['receiptSha256']}.tar.gz"


def install_code(store, root, code):
    directory = root / "code/releases" / code["codeId"]
    directory.mkdir(parents=True)
    archive = root / "code.tar.gz"
    key = archive_key(code)
    cached = store.head(key)
    if cached:
        store.client.download_file(store.bucket, key, str(archive))
        with tarfile.open(archive) as tar:
            tar.extractall(directory, filter="data")
    else:
        revision = code["revision"]
        repo = os.environ["GITHUB_REPOSITORY"]
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", revision, "HEAD"], check=True
        )
        run = subprocess.check_output(
            [
                "gh",
                "run",
                "list",
                "--repo",
                repo,
                "--workflow",
                "check.yml",
                "--event",
                "push",
                "--commit",
                revision,
                "--status",
                "success",
                "--limit",
                "1",
                "--json",
                "databaseId",
                "--jq",
                ".[0].databaseId // empty",
            ],
            text=True,
        ).strip()
        if not run.isdigit():
            raise ValueError("No approved candidate for the active code")
        subprocess.run(
            [
                "gh",
                "run",
                "download",
                run,
                "--repo",
                repo,
                "--name",
                "verified-candidates-" + revision,
                "--dir",
                str(root / "candidate"),
            ],
            check=True,
        )
        directory.rmdir()
        (root / "candidate/code-candidate").rename(directory)
    identity, _ = verify_code(
        directory, require_verified=True, expected_receipt_sha256=code["receiptSha256"]
    )
    if identity != code["codeId"]:
        raise ValueError("Source and approved candidate differ")
    if not cached:
        with tarfile.open(archive, "w:gz") as tar:
            for file in sorted(directory.iterdir()):
                tar.add(file, arcname=file.name)
        store.client.upload_file(
            str(archive),
            store.bucket,
            key,
            ExtraArgs={
                "Metadata": {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            },
        )
    (root / "code/current").symlink_to(directory)
    return directory


def link_tree(source, dest):
    for file in source.rglob("*"):
        if file.is_file():
            to = dest / file.relative_to(source)
            to.parent.mkdir(parents=True, exist_ok=True)
            if not to.exists():
                os.link(file, to)


def package(root, assets, origin, worker):
    if not re.fullmatch(r"[a-z0-9-]+", worker):
        raise ValueError("Invalid Worker name")
    shell = (root / "code/current/index.html").read_bytes()
    for region in REGIONS:
        for lang in ("zh-CN", "en"):
            ranking = assets / region / lang / "rankings/index.html"
            ranking.parent.mkdir(parents=True, exist_ok=True)
            # Replace a hard link without modifying the archived prerender.
            ranking.unlink(missing_ok=True)
            ranking.write_bytes(shell)
    (assets / "__entry").mkdir(exist_ok=True)
    (assets / "__entry/index.html").write_bytes(shell)
    (assets / "_headers").write_text(
        "/*\n  X-OurNotes-Delivery: static-assets\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: SAMEORIGIN\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "/global/*\n  Cache-Control: no-store\n/jp/*\n  Cache-Control: no-store\n"
        "/site-status/*\n  Cache-Control: no-store\n/__entry/*\n  Cache-Control: no-store\n"
        "/app/releases/*\n  Cache-Control: public, max-age=31536000, immutable\n"
        "/rendered/releases/*\n  Cache-Control: public, max-age=31536000, immutable\n"
    )
    shutil.copyfile(DEPLOY / "static-site.mjs", root / "worker.mjs")
    config = {
        "name": worker,
        "main": "worker.mjs",
        "compatibility_date": "2026-09-01",
        "compatibility_flags": ["global_fetch_private_origin"],
        "workers_dev": True,
        "preview_urls": True,
        "vars": {"SITE_ORIGIN": origin},
        "assets": {
            "directory": "assets",
            "binding": "ASSETS",
            "html_handling": "force-trailing-slash",
            "not_found_handling": "none",
            "run_worker_first": False,
        },
    }
    (root / "wrangler.json").write_text(json.dumps(config, indent=2))


def public_artifacts(assets, code, releases):
    identity = code.name
    link_tree(code / "compiled", assets / "app/releases" / identity)
    (assets / "site-status").mkdir(parents=True, exist_ok=True)
    for region, release in releases.items():
        link_tree(release / region, assets / region)
        link_tree(
            release / "payloads",
            assets / "rendered/releases" / release.name / "payloads",
        )
        shutil.copyfile(
            release / "complete.json", assets / "site-status" / (region + ".json")
        )
        for locale in ("zh-CN", "en"):
            target = assets / region / locale
            for name in ("vendor", "brand", "images"):
                link_tree(code / "compiled" / name, target / name)
            favicon = code / "compiled/favicon.svg"
            if favicon.is_file():
                shutil.copyfile(favicon, target / "favicon.svg")


def retained_key(pairs):
    digest = hashlib.sha256(json.dumps(pairs, sort_keys=True).encode()).hexdigest()
    return f"{STATE}/retained/{digest}.tar.gz"


def read_live(store):
    raw = store.control(STATE + "/live.json")
    return json.loads(raw) if raw else {}


def trial_prefix(run):
    if not run.isdigit():
        raise ValueError("Expected validated trial run ID")
    job = json.loads(
        subprocess.check_output(
            ["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run}"]
        )
    )
    if (
        job["path"] != ".github/workflows/prerender-trial.yml"
        or job["conclusion"] != "success"
        or job["head_branch"] != os.environ["DEFAULT_BRANCH"]
    ):
        raise ValueError("Referenced trial has not passed")
    return f"tests/prerender/{run}/1/"


def restore_objects(public, prefix, dest, compress_html=False):
    pages = public.client.get_paginator("list_objects_v2").paginate(
        Bucket=public.bucket, Prefix=prefix
    )
    keys = [row["Key"] for page in pages for row in page.get("Contents", [])]
    if not keys:
        raise ValueError("Missing trial directory")

    def restore(key):
        name = key[len(prefix) :]
        if any(
            not part or part.startswith(".") or chr(92) in part
            for part in name.split("/")
        ):
            raise ValueError("Invalid object name in trial")
        path = dest / name
        if path.exists():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        response = public.client.get_object(Bucket=public.bucket, Key=key)
        with response["Body"] as stream:
            data = stream.read()
        if compress_html and name.endswith(".html"):
            if response.get("ContentEncoding") != "gzip":
                raise ValueError("Unexpected encoding in validated trial")
            data = gzip.decompress(data)
        path.write_bytes(data)

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(restore, keys))


def regional_render(root, public, store, region, trial):
    content = root / "content"
    _, _, pointer, pair = read_inputs(root / "code", content, region)
    directory = root / "rendered/releases" / pair
    archive = root / (region + ".tar.gz")
    key = f"{STATE}/renders/{pair}.tar.gz"
    if store.head(key):
        store.client.download_file(store.bucket, key, str(archive))
        with tarfile.open(archive) as tar:
            tar.extractall(directory, filter="data")
    else:
        if trial:
            receipt = json.loads(public.control(trial + f"site-status/{region}.json"))
            if receipt["pair"] != pair or receipt["pointer"] != json.loads(pointer):
                raise ValueError(
                    "Trial no longer matches approved content; rerun with fresh rendering"
                )
            restore_objects(
                public, trial + region + "/", directory / region, compress_html=True
            )
            restore_objects(
                public,
                trial + "rendered/releases/" + pair + "/payloads/",
                directory / "payloads",
            )
            (directory / "complete.json").write_text(json.dumps(receipt))
        else:
            publish(root / "code", content, root / "rendered", region=region)
        with tarfile.open(archive, "w:gz", compresslevel=3) as tar:
            for entry in directory.iterdir():
                tar.add(entry, arcname=entry.name)
        with archive.open("rb") as src:
            digest = hashlib.file_digest(src, "sha256").hexdigest()
        store.client.upload_file(
            str(archive), store.bucket, key, ExtraArgs={"Metadata": {"sha256": digest}}
        )
    state = json.loads((directory / "complete.json").read_bytes())
    if (
        state["pair"] != pair
        or state["region"] != region
        or state["pointer"] != json.loads(pointer)
    ):
        raise ValueError("Regional render does not match sealed inputs")
    return directory


def build(root, public, store, desired, live, origin, worker):
    code = install_code(store, root, desired["code"])
    content = root / "content"
    materialize(public, content, allow_missing_jp=False)
    releases = {}
    trial = (
        trial_prefix(os.environ["CURRENT_TRIAL"])
        if not live and os.environ.get("CURRENT_TRIAL")
        else None
    )
    for region in REGIONS:
        actual = json.loads(read_inputs(root / "code", content, region)[2])
        actual.pop("libraryPointers", None)
        if actual != desired["pointers"][region]:
            raise ValueError("Approved inputs changed while preparing the release")
        releases[region] = regional_render(root, public, store, region, trial)
    pairs = {r: p.name for r, p in releases.items()}
    assets = root / "assets"
    public_artifacts(assets, code, releases)
    # Save only this release's hashed assets before merging its predecessor.
    archive = root / "retained.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name in ("app", "rendered"):
            tar.add(assets / name, arcname=name)
    store.client.upload_file(str(archive), store.bucket, retained_key(pairs))
    if live.get("pairs") and live["pairs"] != pairs:
        store.client.download_file(
            store.bucket, retained_key(live["pairs"]), str(archive)
        )
        retained = root / "retained"
        with tarfile.open(archive) as tar:
            tar.extractall(retained, filter="data")
        link_tree(retained, assets)
    elif not live and os.environ.get("PREVIOUS_TRIAL"):
        prefix = trial_prefix(os.environ["PREVIOUS_TRIAL"])
        for part in ("app/releases", "rendered/releases"):
            restore_objects(public, prefix + part + "/", assets / part)
    package(root, assets, origin, worker)
    (root / "release.json").write_text(json.dumps({"inputs": desired, "pairs": pairs}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "guard", "record"])
    args = parser.parse_args()
    root = Path(os.environ["STATIC_ROOT"]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    origin = os.environ["STATIC_SITE_ORIGIN"]
    public = R2Reader.from_environment()
    store = state_reader(public)
    if args.command == "record":
        payload = (root / "release.json").read_bytes()
        store.client.put_object(
            Bucket=store.bucket,
            Key=STATE + "/live.json",
            Body=payload,
            ContentType="application/json",
        )
        return
    desired = snapshot(public, origin)
    if args.command == "guard":
        if desired != json.loads((root / "release.json").read_bytes())["inputs"]:
            raise ValueError("Inputs were superseded before activation")
        return
    live = read_live(store)
    changed = desired != live.get("inputs")
    if changed:
        build(
            root, public, store, desired, live, origin, os.environ["STATIC_WORKER_NAME"]
        )
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        print("changed=" + str(changed).lower(), file=f)


if __name__ == "__main__":
    main()
