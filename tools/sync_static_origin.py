"""Synchronize the fallback with a verified, active Worker deployment."""

import argparse
import json
import os
from pathlib import Path
import tempfile
import time

from tools.deploy_code import deploy, load_config, run
from tools.static_site import (
    REGIONS, STATE, R2Reader, install_code, open_delivery_receipt, read_code,
    read_live, state_reader, validate_code_identity,
)


def check_worker(live, worker):
    for region, pair in live["pairs"].items():
        with open_delivery_receipt(f"{worker}/site-status/{region}.json", timeout=25) as response:
            if (response.headers.get("X-OurNotes-Delivery") != "static-assets"
                    or json.load(response)["pair"] != pair):
                raise ValueError("Worker has moved away from the recorded release")


def origin_pairs(host):
    # Read the origin's own render links. The public site-status routes serve the Worker.
    output = run(["ssh", "--", host, "readlink /srv/ournotes-rendered/current /srv/ournotes-rendered/current-jp"])
    return {region: Path(target).name for region, target in zip(REGIONS, output.decode().splitlines(), strict=True)}


def sync(store, config, origin, worker, root):
    live = read_live(store)
    code = validate_code_identity(live["inputs"]["code"])
    current = read_code(origin)
    if current != code:
        directory = install_code(store, root, code)
        check_worker(live, worker)
        if read_live(store) != live:
            raise ValueError("Cloudflare release changed before origin sync")
        deploy(directory, config, code["receiptSha256"], current["codeId"])

    # The existing origin timer promotes both validated HTML views.
    for attempt in range(60):
        if read_live(store) != live:
            print("A newer live delivery will synchronize the origin")
            return
        if origin_pairs(config["sshHost"]) == live["pairs"] and read_code(origin) == code:
            check_worker(live, worker)
            store.client.put_object(Bucket=store.bucket, Key=STATE + "/origin.json",
                                    Body=json.dumps(live["pairs"]).encode(), ContentType="application/json")
            return
        if attempt < 59:
            time.sleep(30)
    raise ValueError("Origin prerender has not converged to the live Worker")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as root:
        sync(state_reader(R2Reader.from_environment()), load_config(args.config),
             os.environ["STATIC_SITE_ORIGIN"], os.environ["WORKER_URL"], Path(root))
