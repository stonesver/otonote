import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from tests.test_release_candidate import candidate
from tools import static_site, sync_static_origin


class SitePackageTests(unittest.TestCase):
    def test_origin_handshake_retry_reads_fresh_code(self):
        origin = "https://example.invalid"
        receipt = {"codeId": "a" * 24, "revision": "b" * 40, "receiptSha256": "c" * 64}
        error = HTTPError(origin, 525, "SSL handshake failed", {}, None)
        with (
            patch.object(
                static_site,
                "urlopen",
                side_effect=[error, io.BytesIO(json.dumps(receipt).encode())],
            ),
            patch("time.sleep"),
        ):
            self.assertEqual(static_site.read_code(origin), receipt)

    def test_origin_retries_are_bounded_and_specific_to_handshake_failures(self):
        origin = "https://example.invalid"
        for status, attempts in ((525, 3), (403, 1)):
            with (
                self.subTest(status=status),
                patch.object(
                    static_site,
                    "urlopen",
                    side_effect=HTTPError(origin, status, "", {}, None),
                ) as send,
                patch("time.sleep"),
            ):
                with self.assertRaises(HTTPError) as raised:
                    static_site.read_code(origin)
                self.assertEqual(raised.exception.code, status)
                self.assertEqual(send.call_count, attempts)

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
                root, assets, "https://example.invalid", "example-worker", "HEAD"
            )
            cfg = json.loads((root / "wrangler.json").read_text())
            self.assertFalse(cfg["assets"]["run_worker_first"])
            self.assertFalse({"routes", "route"} & cfg.keys())
            headers_text = (assets / "_headers").read_text()
            self.assertNotIn("noindex", headers_text)
            self.assertIn("/global/*\n  Cache-Control: private, max-age=30, must-revalidate\n", headers_text)
            self.assertIn("/jp/*\n  Cache-Control: private, max-age=30, must-revalidate\n", headers_text)
            self.assertIn("/site-status/*\n  Cache-Control: no-store\n", headers_text)
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
                        "GITHUB_SHA": "b" * 40,
                        "STATIC_ROOT": tmp,
                        "STATIC_SITE_ORIGIN": "https://example.invalid",
                        "R2_PRIVATE_BUCKET": "private",
                    },
                ),
                patch("sys.argv", ["static_site", "guard"]),
                patch.object(static_site, "main_revision", return_value="b" * 40),
                patch.object(static_site.R2Reader, "from_environment"),
                patch.object(static_site, "snapshot", return_value={"code": "next"}),
                self.assertRaisesRegex(ValueError, "superseded"),
            ):
                static_site.main()

    def test_main_ci_artifact_is_pinned_cached_and_reusable_without_origin(self):
        revision = "a" * 40
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def download(args, *, check):
                output = Path(args[args.index("--dir") + 1])
                output.mkdir()
                self.assertEqual(args[:4], ["gh", "run", "download", "123"])
                if output.name == "approval":
                    source, receipt = candidate(root / "fixture")
                    metadata = json.loads((source / "code-release.json").read_bytes())
                    (output / "code.json").write_text(json.dumps({
                        "codeId": metadata["codeId"], "revision": revision, "receiptSha256": receipt,
                    }))
                else:
                    (root / "fixture").rename(output / "code-candidate")

            with (
                patch.dict("os.environ", GITHUB_SHA=revision, GITHUB_REPOSITORY="example/repo",
                           VERIFIED_CI_RUN="123", VERIFIED_REVISION=revision),
                patch.object(static_site.subprocess, "run", side_effect=download),
            ):
                code = static_site.approved_code(root, {})
            store = Mock()
            release = static_site.install_code(store, root, code)
            self.assertEqual(release.name, code["codeId"])
            archive = (root / "code.tar.gz").read_bytes()
            store.client.download_file.side_effect = lambda bucket, key, name: Path(name).write_bytes(archive)
            restored = static_site.install_code(store, root / "second-run", code)
            self.assertEqual((restored / "verification.json").read_bytes(), (release / "verification.json").read_bytes())
            with self.assertRaisesRegex(ValueError, "receipt digest mismatch"):
                static_site.install_code(store, root / "wrong-receipt", dict(code, receiptSha256="0" * 64))

    def test_content_update_uses_live_code_during_unverified_merge(self):
        code = {"codeId": "a" * 24, "revision": "b" * 40, "receiptSha256": "c" * 64}
        live = {"inputs": {"code": code}}
        with (
            patch.dict("os.environ", GITHUB_SHA="d" * 40, CONTENT_ONLY="true"),
            patch.object(static_site.subprocess, "check_output") as lookup,
        ):
            self.assertEqual(static_site.approved_code(Path("."), live), code)
            lookup.assert_not_called()
        with (
            patch.dict("os.environ", GITHUB_SHA="d" * 40, CONTENT_ONLY="false",
                       VERIFIED_REVISION=code["revision"]),
        ):
            self.assertEqual(static_site.approved_code(Path("."), live), code)
            with self.assertRaisesRegex(ValueError, "First delivery"):
                static_site.approved_code(Path("."), {})

    def test_fallback_sync_only_records_matching_origin_and_worker(self):
        code = {"codeId": "a" * 24, "revision": "b" * 40, "receiptSha256": "c" * 64}
        pairs = {"global": "global-pair", "jp": "jp-pair"}
        live = {"inputs": {"code": code}, "pairs": pairs}
        config = {"sshHost": "example"}
        store = Mock()
        with (
            patch.object(sync_static_origin, "read_live", return_value=live),
            patch.object(sync_static_origin, "read_code", side_effect=[dict(code, codeId="d" * 24), code]),
            patch.object(sync_static_origin, "install_code", return_value=Path("candidate")),
            patch.object(sync_static_origin, "deploy") as publish,
            patch.object(sync_static_origin, "origin_pairs", side_effect=[{}, pairs]),
            patch.object(sync_static_origin, "check_worker") as check,
            patch("time.sleep"),
        ):
            sync_static_origin.sync(store, config, "origin", "worker", Path("."))
            publish.assert_called_once_with(Path("candidate"), config, code["receiptSha256"], "d" * 24)
            self.assertEqual(check.call_count, 2)
            self.assertEqual(json.loads(store.client.put_object.call_args.kwargs["Body"]), pairs)

    def test_changed_worker_blocks_origin_publication(self):
        code = {"codeId": "a" * 24, "revision": "b" * 40, "receiptSha256": "c" * 64}
        live = {"inputs": {"code": code}, "pairs": {"global": "old", "jp": "old"}}
        response = io.BytesIO(b'{"pair":"new"}')
        response.headers = {"X-OurNotes-Delivery": "static-assets"}
        store = Mock()
        with (
            patch.object(sync_static_origin, "read_live", return_value=live),
            patch.object(sync_static_origin, "read_code", return_value=dict(code, codeId="d" * 24)),
            patch.object(sync_static_origin, "install_code"),
            patch.object(sync_static_origin, "open_delivery_receipt", return_value=response),
            patch.object(sync_static_origin, "deploy") as publish,
            self.assertRaisesRegex(ValueError, "moved away"),
        ):
            sync_static_origin.sync(store, {}, "origin", "worker", Path("."))
        publish.assert_not_called()
        store.client.put_object.assert_not_called()

    def test_unchanged_inputs_and_stale_ci_skip_delivery(self):
        code = {"codeId": "a" * 24, "revision": "b" * 40, "receiptSha256": "c" * 64}
        inputs = {"code": code, "pointers": {}}
        pairs = {"global": "g", "jp": "j"}
        live = {"inputs": inputs, "pairs": pairs}
        with tempfile.TemporaryDirectory() as tmp:
            outputs = Path(tmp) / "outputs"
            with (
                patch.dict("os.environ", GITHUB_SHA=code["revision"], STATIC_ROOT=tmp,
                           GITHUB_OUTPUT=str(outputs), STATIC_SITE_ORIGIN="https://example.invalid"),
                patch("sys.argv", ["static_site", "prepare"]),
                patch.object(static_site.R2Reader, "from_environment"),
                patch.object(static_site, "state_reader") as reader,
                patch.object(static_site, "main_revision") as head,
                patch.object(static_site, "read_live", return_value=live),
                patch.object(static_site, "snapshot", return_value=inputs),
                patch.object(static_site, "build") as build,
            ):
                for revision in (code["revision"], "d" * 40):
                    outputs.write_text("")
                    head.return_value = revision
                    static_site.main()
                    self.assertEqual(outputs.read_text().splitlines(), ["changed=false"])
                reader.return_value.control.assert_not_called()
                build.assert_not_called()
