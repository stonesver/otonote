import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import static_site


class SitePackageTests(unittest.TestCase):
    def test_delivery_receipt_identifies_the_release_client(self):
        with patch.object(static_site, "urlopen") as send:
            static_site.open_delivery_receipt(
                "https://example.invalid/receipt", timeout=15
            )
        request = send.call_args.args[0]
        self.assertEqual(
            request.get_header("User-agent"), "OurNotes-Static-Delivery/1.0"
        )

    def test_rankings_shell_and_retained_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            code = root / "code/releases" / ("a" * 24)
            (code / "compiled/brand").mkdir(parents=True)
            (code / "compiled/brand/logo.svg").write_bytes(b"logo")
            (code / "index.html").write_bytes(b"approved entry")
            (root / "code/current").symlink_to(code)
            releases = {}
            for region in static_site.REGIONS:
                release = root / "rendered" / region
                for lang in ("zh-CN", "en"):
                    directory = release / region / lang / "rankings"
                    directory.mkdir(parents=True)
                    (directory / "index.html").write_bytes(b"old prerender")
                (release / "complete.json").write_text("{}")
                (release / "payloads").mkdir()
                releases[region] = release
            assets = root / "assets"
            static_site.public_artifacts(assets, code, releases)
            static_site.package(
                root, assets, "https://example.invalid", "example-worker"
            )
            cfg = json.loads((root / "wrangler.json").read_text())
            self.assertFalse(cfg["assets"]["run_worker_first"])
            self.assertFalse({"routes", "route"} & cfg.keys())
            self.assertNotIn("noindex", (assets / "_headers").read_text())
            for region in static_site.REGIONS:
                self.assertEqual(
                    (assets / region / "en/rankings/index.html").read_bytes(),
                    b"approved entry",
                )
                self.assertEqual(
                    (assets / region / "en/brand/logo.svg").read_bytes(), b"logo"
                )
                self.assertEqual(
                    (releases[region] / region / "en/rankings/index.html").read_bytes(),
                    b"old prerender",
                )

    def test_origin_export_is_limited_to_three_fields(self):
        import hashlib
        from runpy import run_path

        export = run_path(str(static_site.DEPLOY / "export-static-code.py"))["export"]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            code = root / ("a" * 24)
            code.mkdir()
            manifest = json.dumps(
                {
                    "codeId": code.name,
                    "provenance": {
                        "source": {"commit": "b" * 40, "files": {"private-note": "x"}}
                    },
                }
            ).encode()
            (code / "code-release.json").write_bytes(manifest)
            receipt = json.dumps(
                {
                    "artifact": {
                        "codeId": code.name,
                        "manifestSha256": hashlib.sha256(manifest).hexdigest(),
                    }
                }
            ).encode()
            (code / "verification.json").write_bytes(receipt)
            out = root / "code.json"
            export(code, out)
            self.assertEqual(
                json.loads(out.read_bytes()),
                {
                    "codeId": code.name,
                    "revision": "b" * 40,
                    "receiptSha256": hashlib.sha256(receipt).hexdigest(),
                },
            )

    def test_superseded_release_rejected_before_activation(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "release.json").write_text('{"inputs":{"code":"previous"}}')
            with (
                patch.dict(
                    "os.environ",
                    {
                        "STATIC_ROOT": tmp,
                        "STATIC_SITE_ORIGIN": "https://example.invalid",
                        "R2_PRIVATE_BUCKET": "private",
                    },
                ),
                patch("sys.argv", ["static_site", "guard"]),
                patch.object(static_site.R2Reader, "from_environment"),
                patch.object(static_site, "snapshot", return_value={"code": "next"}),
                self.assertRaisesRegex(ValueError, "superseded"),
            ):
                static_site.main()
