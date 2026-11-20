"""Allow an initial Wrangler deployment only if the named Worker does not exist."""

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    name = os.environ["STATIC_WORKER_NAME"]
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{name}/settings"
    req = Request(
        url, headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}
    )
    try:
        with urlopen(req, timeout=20):
            pass
    except HTTPError as error:
        if error.code == 404 and any(
            e.get("code") == 10007 for e in json.load(error).get("errors", [])
        ):
            return
        raise
    raise ValueError(
        "Worker already exists; rerun without bootstrap to verify before activation"
    )


if __name__ == "__main__":
    main()
