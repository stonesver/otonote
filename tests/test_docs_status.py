from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.docs_status import public_markdown, validate_status_index


class DocsStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / "docs/reference").mkdir(parents=True)
        self.page = self.root / "docs/reference/example.md"
        self.page.write_text("# Example\n", encoding="utf-8")
        self.index = self.root / "docs/README.md"
        self.row = "| [Example](reference/example.md) | `reference` | `current` |"
        self.write_index(self.row)

    def write_index(self, *rows: str) -> None:
        self.index.write_text("# Documents\n\n| Document | Role | Status |\n| --- | --- | --- |\n" + "\n".join(rows) + "\n", encoding="utf-8")

    def validate(self) -> list[str]:
        return validate_status_index(self.root, self.index)

    def test_repository_index_and_public_documents(self) -> None:
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(validate_status_index(root, root / "docs/README.md"), [])

    def test_valid_index_in_source_archive_without_git(self) -> None:
        self.assertEqual(self.validate(), [])

    def test_rejects_unknown_role_and_lifecycle(self) -> None:
        self.write_index("| [Example](reference/example.md) | `anything` | `deployed` |")
        errors = self.validate()
        self.assertIn("line 5: unknown document role: anything", errors)
        self.assertIn("line 5: unknown document status: deployed", errors)

    def test_requires_new_document_registration(self) -> None:
        (self.root / "docs/reference/new.md").write_text("# New\n")
        self.assertIn("document is not registered: docs/reference/new.md", self.validate())

    def test_missing_and_duplicate_registered_documents(self) -> None:
        self.write_index(self.row, self.row, "| [Missing](missing.md) | `reference` | `current` |")
        errors = self.validate()
        self.assertIn("line 6: duplicate document entry", errors)
        self.assertIn("line 7: registered document does not exist", errors)

    def test_checks_moved_document_links_and_reference_images(self) -> None:
        self.page.write_text("# Example\n[old](../gone.md)\n![image][pic]\n[pic]: missing.png\n")
        self.assertEqual(self.validate(), [
            "docs/reference/example.md:2: local link target does not exist",
            "docs/reference/example.md:4: local link target does not exist",
        ])

    def test_allows_technical_sources_anchors_and_repository_files(self) -> None:
        (self.root / "LICENSE").write_text("License\n")
        (self.root / "docs/reference/with space.txt").write_text("sample\n")
        self.page.write_text('# Example\n[License](../../LICENSE)\n[source](https://example.org/doc)\n[anchor](#example)\n[route](/global/zh-CN/)\n[file](with%20space.txt "example")\n[angle](<with space.txt>)\n')
        self.assertEqual(self.validate(), [])

    def test_rejects_registry_and_link_escape(self) -> None:
        self.write_index(self.row, "| [Outside](../../outside.md) | `reference` | `current` |")
        self.page.write_text("[outside](../../../outside.md)\n")
        errors = self.validate()
        self.assertIn("line 6: registry path leaves repository", errors)
        self.assertIn("docs/reference/example.md:1: local link leaves repository", errors)

    def test_rejects_personal_locator_without_echoing_it(self) -> None:
        self.page.write_text("Config lives at /Users/alice/private/runtime.json\n")
        errors = self.validate()
        self.assertEqual(errors, ["docs/reference/example.md: personal filesystem path"])
        self.assertNotIn("alice", " ".join(errors))

    def test_rejects_external_site_design_reference(self) -> None:
        self.page.write_text("布局参考 https://example.invalid/design\n")
        self.assertEqual(self.validate(), ["docs/reference/example.md: external site design reference"])

    def test_keeps_protocol_sources_and_required_attribution(self) -> None:
        self.page.write_text("协议参考 https://example.org/protocol\n第三方许可证见 https://example.org/LICENSE\n")
        self.assertEqual(self.validate(), [])

    def test_rejects_process_archive_even_if_registered(self) -> None:
        folder = self.root / "docs/plans"
        folder.mkdir()
        (folder / "completed.md").write_text("# Completed\n")
        self.write_index(self.row, "| [Completed](plans/completed.md) | `reference` | `current` |")
        self.assertIn("docs/plans/completed.md: process records do not belong in public docs", self.validate())

    def test_symlink_is_not_a_public_document(self) -> None:
        link = self.root / "docs/reference/alias.md"
        link.symlink_to(self.page)
        self.assertIn("docs/reference/alias.md: public document must not be a symlink", self.validate())

    def test_git_ignores_private_notes_but_checks_tracked_ignored_files(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text("private/\n")
        private = self.root / "private/notes.md"
        private.parent.mkdir()
        private.write_text("# Private\n")
        self.assertNotIn(private, public_markdown(self.root))
        subprocess.run(["git", "-C", str(self.root), "add", "-f", "private/notes.md"], check=True)
        self.assertIn(private, public_markdown(self.root))
        self.assertIn("document is not registered: private/notes.md", self.validate())
        # Working deletion is intentional; the missing tracked path is not read.
        private.unlink()
        self.assertEqual(self.validate(), [])

    def test_gate_does_not_change_config_templates_or_json_attachments(self) -> None:
        samples = {
            "config/runtime.example.json": b'{"enabled":false}\n',
            "deploy/task.service": b"[Service]\nExecStart=/bin/true\n",
            "docs/reference/fixture.json": b'{"input":1}\n',
        }
        for name, data in samples.items():
            path = self.root / name
            path.parent.mkdir(exist_ok=True, parents=True)
            path.write_bytes(data)
        self.assertEqual(self.validate(), [])
        for name, data in samples.items():
            self.assertEqual((self.root / name).read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
