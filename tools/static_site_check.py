"""Check both locales of each edition on a Worker version before activation."""

import argparse
import json
import shutil
import time
from pathlib import Path
from urllib.error import HTTPError, URLError

from tools.static_site import open_delivery_receipt


def check(base, assets):
    from playwright.sync_api import sync_playwright

    for region in ("global", "jp"):
        path = "site-status/" + region + ".json"
        expected = json.loads((assets / path).read_bytes())
        for attempt in range(24):
            try:
                with open_delivery_receipt(base + "/" + path, timeout=15) as response:
                    if (
                        json.load(response) == expected
                        and response.headers.get("X-OurNotes-Delivery")
                        == "static-assets"
                    ):
                        break
            except (HTTPError, URLError, ValueError, TimeoutError):
                pass
            if attempt == 23:
                raise ValueError("Public version did not converge: " + path)
            time.sleep(5)
    with sync_playwright() as pw:
        chrome = shutil.which("google-chrome")
        browser = pw.chromium.launch(
            executable_path=str(Path(chrome).resolve()) if chrome else None
        )
        page = browser.new_page()
        for region in ("global", "jp"):
            for lang in ("zh-CN", "en"):
                for suffix in ("", "tools/song-ranking/", "rankings/"):
                    path = f"{region}/{lang}/{suffix}"
                    response = page.goto(
                        base + "/" + path, wait_until="domcontentloaded", timeout=60000
                    )
                    if (
                        response.status != 200
                        or response.headers.get("x-ournotes-delivery")
                        != "static-assets"
                    ):
                        raise ValueError("Missing static response: " + path)
                    if response.body() != (assets / path / "index.html").read_bytes():
                        raise ValueError("Public HTML differs from candidate: " + path)
                    if suffix == "tools/song-ranking/":
                        page.locator("song-ranking tbody tr").first.wait_for(
                            timeout=60000
                        )
                    print("OK", path, flush=True)
        browser.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("url")
    p.add_argument("assets", type=Path)
    args = p.parse_args()
    check(args.url.rstrip("/"), args.assets)
