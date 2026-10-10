#!/usr/bin/env python3
"""Local, throwaway UI study: python3 site/prototypes/tools-redesign/serve.py."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse

ROOT = Path(__file__).resolve().parent


class PrototypeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/", "/tools", "/tools/"):
            self.path = "/index.html"
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OtoNote tools UI prototype (local only)")
    parser.add_argument("--port", type=int, default=4328)
    args = parser.parse_args()
    print(f"OtoNote prototype: http://127.0.0.1:{args.port}/tools/?variant=A", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), PrototypeHandler).serve_forever()
