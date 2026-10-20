"""Check the public document index, local links and bounded prose rules."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROLES = {"entry", "governance", "reference", "runbook", "decision", "backlog", "legal", "release"}
STATUSES = {"current", "draft"}
TABLE_ROW = re.compile(
    r"^\|\s*\[[^\]]+\]\((?P<document>[^)]+)\)\s*"
    r"\|\s*`(?P<role>[^`]+)`\s*\|\s*`(?P<status>[^`]+)`\s*\|$"
)
INLINE_LINK = re.compile(r"\]\((<[^>]+>|[^\s)]+)(?:\s+[\"'][^\n]*[\"'])?\)")
REFERENCE_LINK = re.compile(r"^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)", re.MULTILINE)
RETIRED_DIRECTORIES = {"plans", "designs", "reviews", "history", "reports", "research", "superpowers"}
PROSE_RULES = (
    ("personal filesystem path", re.compile(r"/Users/(?!USER(?:/|\b)|USERNAME(?:/|\b))[^/\s`]+/|~/Documents/")),
    ("private workspace path", re.compile(r"/private/tmp/(?:otonote|ournotes)-[\w-]+|\.codex/worktrees/")),
    ("external site design reference", re.compile(
        r"(?:布局|配色|视觉|交互设计).{0,12}(?:参考|对标|复刻|模仿).{0,40}https?://"
        r"|(?:design|layout|appearance)\s+(?:inspired by|copied from|modeled after)\s+https?://",
        re.IGNORECASE,
    )),
)


def public_markdown(repo_root: Path) -> list[Path]:
    """Include tracked and new non-ignored Markdown, excluding working deletions."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, check=True,
        )
        paths = {repo_root / name.decode("utf-8") for name in result.stdout.split(b"\0") if name.endswith(b".md")}
    except (OSError, subprocess.CalledProcessError):
        # Standalone source archives and isolated test repositories have no .git.
        paths = set(repo_root.rglob("*.md"))
        paths = {p for p in paths if not any(part.startswith(".") or part in {"node_modules", "output", "outputs"} for part in p.relative_to(repo_root).parts)}
    return sorted(p for p in paths if p.is_file())


def local_target(repo_root: Path, document: Path, raw: str) -> Path | None:
    """Return a bounded local target. External URLs and anchors have no file target."""
    parsed = urlsplit(raw.strip("<>"))
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    # Root-relative browser routes do not identify repository files.
    if parsed.path.startswith("/"):
        return None
    target = (document.parent / unquote(parsed.path)).resolve()
    if not target.is_relative_to(repo_root.resolve()):
        raise ValueError("local link leaves repository")
    return target


def validate_status_index(repo_root: Path, status_path: Path) -> list[str]:
    """Validate document roles/lifecycle, without claiming deployment verification."""
    repo_root = repo_root.resolve()
    status_path = status_path.resolve()
    errors: list[str] = []
    if not status_path.is_relative_to(repo_root):
        return ["document index leaves repository"]
    try:
        index_text = status_path.read_text(encoding="utf-8")
    except OSError:
        return ["cannot read document index"]
    registered: set[Path] = set()
    for number, line in enumerate(index_text.splitlines(), 1):
        match = TABLE_ROW.match(line)
        if not match:
            continue
        for field, allowed in (("role", ROLES), ("status", STATUSES)):
            if match[field] not in allowed:
                errors.append(f"line {number}: unknown document {field}: {match[field]}")
        try:
            target = local_target(repo_root, status_path, match["document"])
        except ValueError:
            errors.append(f"line {number}: registry path leaves repository")
            continue
        if target is None or target.suffix != ".md":
            errors.append(f"line {number}: registry entry must be a local Markdown file")
            continue
        if target in registered:
            errors.append(f"line {number}: duplicate document entry")
        registered.add(target)
        if not target.is_file():
            errors.append(f"line {number}: registered document does not exist")
    if not registered:
        errors.append("document index contains no document entries")

    documents = public_markdown(repo_root)
    for document in documents:
        relative = document.relative_to(repo_root).as_posix()
        if document.is_symlink() or not document.resolve().is_relative_to(repo_root):
            errors.append(f"{relative}: public document must not be a symlink")
            continue
        if document.resolve() != status_path and document.resolve() not in registered:
            errors.append(f"document is not registered: {relative}")
        parts = Path(relative).parts
        if len(parts) > 2 and parts[0] == "docs" and parts[1] in RETIRED_DIRECTORIES:
            errors.append(f"{relative}: process records do not belong in public docs")
        text = document.read_text(encoding="utf-8")
        for rule, pattern in PROSE_RULES:
            if pattern.search(text):
                errors.append(f"{relative}: {rule}")
        # Check inline/image and reference links, including code examples; heading
        # anchors and external URL reachability deliberately remain outside this gate.
        for match in list(INLINE_LINK.finditer(text)) + list(REFERENCE_LINK.finditer(text)):
            number = text.count("\n", 0, match.start()) + 1
            try:
                target = local_target(repo_root, document, match[1])
            except ValueError:
                errors.append(f"{relative}:{number}: local link leaves repository")
                continue
            if target is not None and not target.exists():
                errors.append(f"{relative}:{number}: local link target does not exist")
    # Preserve stable ordering while avoiding duplicate errors for repeated links.
    return list(dict.fromkeys(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--status", type=Path, help="Optional index path; defaults to docs/README.md")
    args = parser.parse_args()
    root = args.repo_root.resolve()
    errors = validate_status_index(root, args.status or root / "docs/README.md")
    if errors:
        for error in errors:
            print(error)
        return 1
    print("Validated public document index, local links and prose rules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
