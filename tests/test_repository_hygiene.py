from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from tools.repository_hygiene import (
    HygieneError, classify_path, export_source, private_report, scan_bytes, scan_source,
)


class RepositoryHygieneTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "source"
        self.root.mkdir()

    def put(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)

    def init_git(self):
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")

    def test_actual_configuration_and_runtime_never_selected(self):
        for name in ("config/release-inputs.json", "config/global-update.server.json", "config/environments/global-production.toml", ".env", ".env.production", "deploy/qqbot.env", "deploy/qqbot.env copy.example", "packaging/growth-tool/sdk.bhk.xml", "output/result.json", ".git/config", ".claude/settings.json", "site/src/data/generated/rules.json", "site/src/data/scoring-evidence-global-report.json", "site/public/gallery/private.webp"):
            with self.subTest(path=name):
                self.assertIsNotNone(classify_path(name))

    def test_public_constants_schema_and_templates_are_candidates(self):
        for name in ("config/site-product.json", "config/performance/gates.product-v1.json", "config/examples/updater.example.json", "deploy/qqbot.env.example", "packages/scoring/data/rules.json", "tools/runtime_bundle.py", "analysis/crypto/decrypt_master.py", "deploy/player-rankings-capture.Dockerfile"):
            self.assertIsNone(classify_path(name), name)
        self.assertFalse(scan_bytes("deploy/qqbot.env.example", b"APP_SECRET=replace-with-your-secret\n"))

    def test_private_key_and_provider_token_have_value_free_findings(self):
        key = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
        credential_value = "ghp_" + "a" * 36
        for value, rule in ((key, "private-key"), (credential_value, "github-token")):
            result = scan_bytes("tools/source.py", ("#\n" + value).encode())
            self.assertEqual(result[0].line, 2)
            self.assertEqual(result[0].rule, rule)
            self.assertNotIn(value, repr(result))

    def test_public_project_documents_export_with_content_checks(self):
        for name in ("CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"):
            self.put(name, "# Public project documentation\n")
        self.put("private-notes.md", "# Private notes\n")
        manifest = export_source(self.root, self.base / "public-docs")
        self.assertEqual([item["path"] for item in manifest["files"]],
                         ["CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"])
        self.put("CONTRIBUTING.md", "ghp_" + "a" * 36)
        with self.assertRaises(HygieneError):
            export_source(self.root, self.base / "unsafe-docs")

    def test_template_does_not_bypass_credentials(self):
        value = "unapproved-long-value"
        payload = json.dumps({"app_" + "secret": value}).encode()
        self.assertTrue(scan_bytes("config/examples/service.example.json", payload))
        self.assertTrue(scan_bytes("tools/app.py", payload))

    def test_known_fixture_exception_is_path_scoped(self):
        payload = json.dumps({"pass" + "word": "PRIVATE-PASSWORD"}).encode()
        self.assertFalse(scan_bytes("tests/test_growth_web.py", payload))
        self.assertTrue(scan_bytes("backend/app.py", payload))

    def test_embedded_game_parameters_rejected(self):
        values = ["DEFAULT_KEY = bytes.fromhex(\n" + repr("a" * 64) + "\n)", "CURRENT_USM_KEY = " + "1_234_567_890"]
        for value in values:
            result = scan_bytes("analysis/crypto/decrypt_master.py", value.encode())
            self.assertIn("embedded-crypto-parameter", [x.rule for x in result])

    def test_staged_scan_reads_index_not_clean_worktree(self):
        self.init_git()
        self.put("tools/app.py", "pass\n")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        self.put("tools/app.py", json.dumps({"pass" + "word": "unapproved-long-value"}))
        self.git("add", "tools/app.py")
        self.put("tools/app.py", "pass\n")
        report = scan_source(self.root, "staged")
        self.assertFalse(report["ok"])
        self.assertEqual(report["findings"][0]["path"], "tools/app.py")
        self.assertTrue(scan_source(self.root, "working")["ok"])

    def test_tracked_config_reported_even_if_ignored(self):
        self.init_git()
        self.put("config/private.json", "{}")
        self.git("add", "config/private.json")
        self.git("commit", "-qm", "legacy config")
        self.put(".gitignore", "config/\n")
        self.assertFalse(scan_source(self.root, "tracked")["ok"])
        self.assertTrue(scan_source(self.root, "staged")["ok"])

    def test_export_filters_private_and_is_reproducible(self):
        self.put("tools/app.py", "pass\n")
        self.put("config/service.json", json.dumps({"pass" + "word": "not-public"}))
        self.put(".git/config", "private")
        self.put("input/package.apk", b"private bytes")
        a, b = self.base / "a", self.base / "b"
        first = export_source(self.root, a)
        second = export_source(self.root, b)
        self.assertEqual(first, second)
        self.assertEqual([item["path"] for item in first["files"]], ["tools/app.py"])
        self.assertFalse((a / ".git").exists())
        self.assertFalse((a / "config").exists())
        self.assertEqual((a / "source-manifest.json").read_bytes(), (b / "source-manifest.json").read_bytes())

    def test_export_refuses_symlink_file_and_directory(self):
        self.put("tools/app.py", "pass\n")
        secret = self.base / "outside.py"
        secret.write_text("pass\n")
        (self.root / "tools/link.py").symlink_to(secret)
        with self.assertRaises(HygieneError):
            export_source(self.root, self.base / "a")
        (self.root / "tools/link.py").unlink()
        (self.root / "tools/escape.py").symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(HygieneError):
            export_source(self.root, self.base / "b")

    def test_failed_export_never_leaves_partial_destination(self):
        self.put("tools/app.py", json.dumps({"pass" + "word": "unapproved-long-value"}))
        destination = self.base / "destination"
        with self.assertRaises(HygieneError):
            export_source(self.root, destination)
        self.assertFalse(destination.exists())

    def test_export_from_commit_ignores_uncommitted_bytes(self):
        self.init_git()
        self.put("tools/app.py", "pass\n")
        self.git("add", ".")
        self.git("commit", "-qm", "source")
        self.put("tools/app.py", json.dumps({"pass" + "word": "unapproved-long-value"}))
        destination = self.base / "release"
        manifest = export_source(self.root, destination, "HEAD")
        self.assertEqual((destination / "tools/app.py").read_text(), "pass\n")
        self.assertEqual(len(manifest["gitCommit"]), 40)

    def test_report_permissions_and_symlink_refusal(self):
        path = self.base / "private.json"
        private_report(path, {"ok": True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        linked = self.base / "linked.json"
        linked.symlink_to(path)
        with self.assertRaises(OSError):
            private_report(linked, {"ok": False})

    def test_path_traversal_denied(self):
        for path in ("../tools/app.py", "/tools/app.py", "tools/../../app.py", "tools\\app.py"):
            self.assertEqual(classify_path(path), "unsafe-path")


if __name__ == "__main__":
    unittest.main()
