"""Measure a dual-region render against an isolated, immutable R2 prefix."""
import functools
import gzip
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from tools.code_publication import verify_code
from tools.materialize_r2_content import R2Reader, materialize
from tools.publish_prerender import read_inputs
from tools.r2_content import pointer_key


ROOT = Path(os.environ.get("TRIAL_ROOT", "."))
CODE = ROOT / "code"
CONTENT = ROOT / "content"
RENDERED = ROOT / "rendered"
MIRROR = ROOT / "readback"
REGIONS = ("global", "jp")


def deliveries():
    return json.loads(os.environ["DELIVERIES"])


def prepare():
    source = ROOT / "candidate/code-candidate"
    identity, _ = verify_code(source, require_verified=True,
                              expected_receipt_sha256=os.environ["RECEIPT_SHA256"])
    for region in REGIONS:
        record = deliveries()[region]
        if record["region"] != region or record["codeId"] != identity:
            raise ValueError("candidate differs from serving release")
    release = CODE / "releases" / identity
    release.parent.mkdir(parents=True)
    source.rename(release)
    (CODE / "current").symlink_to(Path("releases") / identity)


class ServingReader(R2Reader):
    """Replay the selected serving pointers even if a newer batch is released."""
    def control(self, key):
        for region in REGIONS:
            if key == pointer_key(region):
                pointer = deliveries()[region]["pointer"].copy()
                pointer.pop("libraryPointers", None)
                return json.dumps(pointer, ensure_ascii=False, separators=(",", ":")).encode()
        return super().control(key)


def fetch_inputs():
    materialize(ServingReader.from_environment(), CONTENT, allow_missing_jp=False)
    for region in REGIONS:
        _, _, _, pair = read_inputs(CODE, CONTENT, region)
        if pair != deliveries()[region]["pair"]:
            raise ValueError("materialized content differs from serving HTML")


def render():
    subprocess.run([sys.executable, "-m", "tools.publish_prerender", "--region", "all",
                    "--code-root", str(CODE), "--content", str(CONTENT),
                    "--output", str(RENDERED)], check=True)


def tree(directory, prefix):
    for source in sorted(directory.rglob("*")):
        if source.is_file():
            yield prefix + source.relative_to(directory).as_posix(), source


def objects():
    current = (CODE / "current").resolve()
    yield from tree(current / "compiled", f"app/releases/{current.name}/")
    yield "index.html", current / "index.html"
    for region in REGIONS:
        pair = deliveries()[region]["pair"]
        release = RENDERED / "releases" / pair
        completion = release / "complete.json"
        if json.loads(completion.read_bytes()) != deliveries()[region]:
            raise ValueError("rendered completion differs from serving receipt")
        yield f"site-status/{region}.json", completion
        yield from tree(release / region, region + "/")
        yield from tree(release / "payloads", f"rendered/releases/{pair}/payloads/")


def prefix():
    run, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    if not all(re.fullmatch(r"[0-9]+", value) for value in (run, attempt)):
        raise ValueError("invalid trial run identity")
    return f"tests/prerender/{run}/{attempt}/"


def transfer(verify):
    reader = R2Reader.from_environment()
    base = prefix()

    def process(item):
        name, source = item
        data = source.read_bytes()
        key = base + name
        compress = name.endswith(".html")
        if verify:
            response = reader.client.get_object(Bucket=reader.bucket, Key=key)
            with response["Body"] as stream:
                wire = stream.read()
            encoding = response.get("ContentEncoding")
            if encoding != ("gzip" if compress else None):
                raise ValueError("incorrect content encoding")
            decoded = gzip.decompress(wire) if compress else wire
            if decoded != data:
                raise ValueError("readback differs from rendered bytes")
            target = MIRROR / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(decoded)
        else:
            wire = gzip.compress(data, compresslevel=6, mtime=0) if compress else data
            metadata = {"ContentEncoding": "gzip"} if compress else {}
            reader.client.put_object(Bucket=reader.bucket, Key=key, Body=wire, IfNoneMatch="*",
                                     ContentType=mimetypes.guess_type(name)[0] or "application/octet-stream",
                                     **metadata)
        return len(data), len(wire)

    with ThreadPoolExecutor(max_workers=8) as pool:
        sizes = list(pool.map(process, objects()))
    return {"objects": len(sizes), "sourceBytes": sum(n for n, _ in sizes),
            "wireBytes": sum(n for _, n in sizes), "prefix": base}


def browser():
    from playwright.sync_api import sync_playwright

    origin = urlsplit(os.environ["CONTENT_ORIGIN"])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
        raise ValueError("expected a public HTTPS origin")
    # Code, HTML and payloads come exclusively from the independently read-back mirror.
    # Use the pinned local content projection; media outside it stays on the public gateway.
    (MIRROR / "content").symlink_to(CONTENT)
    code_id = deliveries()["global"]["codeId"]
    for region in REGIONS:
        for locale in ("zh-CN", "en"):
            directory = MIRROR / region / locale
            for name in ("brand", "images", "vendor", "favicon.svg"):
                asset = MIRROR / "app/releases" / code_id / name
                if asset.exists() and not (directory / name).exists():
                    (directory / name).symlink_to(asset)
    class Preview(SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Preview, directory=MIRROR))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    pages = []
    with sync_playwright() as playwright:
        chrome = playwright.chromium.launch(executable_path=shutil.which("google-chrome"))
        page = chrome.new_page()
        def content_request(route):
            path = urlsplit(route.request.url).path
            local = CONTENT / path.removeprefix("/content/")
            if local.is_file():
                route.continue_()
            elif path == "/content/global/current.json":
                route.fulfill(path=CONTENT / "current.json", content_type="application/json")
            else:
                # Browser request overrides cannot change the loopback HTTP scheme.
                route.fulfill(response=route.fetch(url=f"https://{origin.netloc}{path}"))
        page.route("**/content/**", content_request)
        for region in REGIONS:
            for locale in ("zh-CN", "en"):
                for suffix in ("", "tools/song-ranking/"):
                    path = f"/{region}/{locale}/{suffix}"
                    response = page.goto(f"http://127.0.0.1:{server.server_port}{path}",
                                         wait_until="domcontentloaded", timeout=60000)
                    if not response or response.status != 200:
                        raise ValueError("page failed to open: " + path)
                    page.locator('main').first.wait_for(state="visible")
                    if not page.locator('[data-prerendered="true"]').count():
                        raise ValueError("page missing its rendered view")
                    if suffix:
                        page.locator("song-ranking:not([inert]):not([data-tool-pending])").wait_for(state="visible")
                        page.locator("song-ranking tbody tr").first.wait_for(state="visible")
                    pages.append(path)
        chrome.close()
    server.shutdown()
    return {"pages": pages}


def report():
    samples = [tuple(map(int, line.split())) for line in (ROOT / "disk").read_text().splitlines()
               if re.fullmatch(r"\s*\d+\s+\d+\s*", line)]
    results = {path.stem.removeprefix("metric-"): json.loads(path.read_text())
               for path in ROOT.glob("metric-*.json")}
    if samples:
        peak = max(used for used, _ in samples)
        results["disk"] = {"baselineUsed": samples[0][0], "peakUsed": peak,
                           "increase": peak - samples[0][0], "minAvailable": min(free for _, free in samples),
                           "samples": len(samples)}
    output = json.dumps(results, indent=2)
    print(output)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("\n```json\n" + output + "\n```\n")


if __name__ == "__main__":
    phase = sys.argv[1]
    if phase == "report":
        report()
    else:
        actions = {"prepare": prepare, "materialize": fetch_inputs, "render": render,
                   "upload": lambda: transfer(False), "verify": lambda: transfer(True), "browser": browser}
        start = time.monotonic()
        result = actions[phase]() or {}
        result["seconds"] = round(time.monotonic() - start, 2)
        (ROOT / f"metric-{phase}.json").write_text(json.dumps(result))
        print(json.dumps(result))
