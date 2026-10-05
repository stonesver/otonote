#!/usr/bin/env python3
"""Fail-closed source selection and value-free credential checks.

This is a publication boundary, not a claim that arbitrary files are secret-free.
See docs/CONFIGURATION_POLICY.md. Reports contain locations/rules, never matches.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
from dataclasses import asdict, dataclass

POLICY_VERSION = 1
PUBLIC_CONFIG = frozenset({"config/site-product.json", "config/performance/gates.product-v1.json",
                           "config/performance/gates.v1.json", "config/performance/browser-baseline.v1.json"})
SOURCE_ROOTS = frozenset({"backend", "tools", "tests", "scripts", "analysis", "shared", "packages", "docs", "deploy", "config", "site", "packaging", "catalog", ".github", ".githooks"})
ROOT_FILES = frozenset({"README.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "LICENSE.md", "AGENTS.md", ".gitignore", ".dockerignore", ".nvmrc", "pyproject.toml", "pytest.ini", "package.json", "package-lock.json"})
EXCLUDED_PARTS = frozenset({".git", ".codex", ".claude", ".agents", ".superpowers", "node_modules", "__pycache__", ".pytest_cache", ".playwright-cli", ".astro", ".venv", "venv", ".deps"})
PRIVATE_ROOTS = frozenset({"input", "output", "outputs", "data", "files", "アワーノーツ"})
GENERATED_PREFIXES = ("deploy/admin/aliyun/", "docs/reports/", "docs/history/", "docs/research/", "docs/superpowers/", "site/dist/", "site/dist-matrix/", "site/output/", "site/src/data/", "site/public/auto-stage/", "site/public/growth/", "site/public/immersive/", "site/public/mission-rewards/", "site/public/system-banners/", "site/public/images/filter-bands/", "site/public/data/", "site/public/media/", "site/public/live2d/", "catalog/generated/", "catalog/site-data/")
REVIEWED_ARENA_EVIDENCE = "catalog/evidence/arena-client.json"
REVIEWED_ARENA_EVIDENCE_SHA256 = "2fa9fc8a8ba121b4fcbb486a4f2b88d6dcf1754720ad1dfe2371740387a8bfb0"
TEXT_SUFFIXES = frozenset({".py", ".sh", ".mjs", ".cjs", ".mts", ".cts", ".java", ".js", ".ts", ".tsx", ".jsx", ".astro", ".css", ".html", ".svg", ".json", ".toml", ".yaml", ".yml", ".md", ".txt", ".conf", ".cfg", ".service", ".timer", ".path", ".example", ".template", ".xml", ".cmd", ".command", ".dockerignore", ".Dockerfile", ".logrotate", ".sql"})


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    line: int
    rule: str


class HygieneError(ValueError):
    def __init__(self, findings: list[Finding]):
        self.findings = sorted(set(findings))
        super().__init__("Source hygiene check failed; inspect value-free findings")


def is_template(path: str) -> bool:
    p = PurePosixPath(path)
    return ("examples" in p.parts or bool(re.search(r"(?:^|[.])(?:example|template)(?:[.]|$)", p.name))) and " copy" not in p.name


def classify_path(path: str) -> str | None:
    """None means an allowed source candidate; contents still need checking."""
    p = PurePosixPath(path)
    parts = p.parts
    if not parts or p.is_absolute() or ".." in parts or "\\" in path or any(ord(c) < 32 for c in path):
        return "unsafe-path"
    if any(part in EXCLUDED_PARTS for part in parts) or parts[0] in PRIVATE_ROOTS:
        return "private-or-generated"
    if p.name in {".DS_Store", ".coverage"} or path.startswith(GENERATED_PREFIXES):
        return "private-or-generated"
    if path.startswith("catalog/evidence/") and path != REVIEWED_ARENA_EVIDENCE:
        return "private-or-generated"
    if p.name in {"anontokyo-media.json", "anontokyo-private-media.json"}:
        return "private-or-generated"
    if p.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".credentials", ".secret", ".apk", ".zip", ".sqlite", ".db", ".log", ".pyc"} or p.name in {"id_rsa", "id_ed25519", "credentials", "credentials.json"}:
        return "credential-or-runtime-file"
    template = is_template(path)
    if " copy" in p.name:
        return "unreviewed-copy"
    if parts[0] == "analysis" and not (p.suffix == ".py" or p.name == "requirements.txt"):
        return "private-or-generated"
    if parts[0] == "analysis" and "vendor" in parts:
        return "third-party-runtime"
    if path.startswith("site/public/vendor/live2d/") and p.suffix != ".md":
        return "third-party-runtime"
    if path.startswith("site/public/gallery/") and path != "site/public/gallery/loading-mark.svg":
        return "game-resource"
    if (p.name == ".env" or p.name.startswith(".env.") or ".env" in p.suffixes) and not template:
        return "actual-configuration"
    if re.search(r"(?:^|[.-])(?:local|server|production|credentials)(?:[.-]|$)", p.name) and p.suffix in {".json", ".toml", ".yaml", ".yml", ".xml", ".ini", ".cfg", ".conf"} and not template:
        return "actual-configuration"
    if parts[0] == "config" and path not in PUBLIC_CONFIG and not template:
        return "actual-configuration"
    if path == "packaging/growth-tool/sdk.bhk.xml" or (p.name.startswith("sdk.") and p.suffix == ".xml" and not template):
        return "actual-configuration"
    # Deployment descriptors are source templates; resolved host-specific config is private.
    if parts[0] == "deploy" and p.suffix in {".json", ".toml", ".yaml", ".yml", ".env", ".cfg"} and not template:
        return "actual-configuration"
    if len(parts) == 1:
        if (template and p.suffix in TEXT_SUFFIXES) or path in ROOT_FILES or p.name.startswith("Dockerfile.") or re.fullmatch(r"requirements(?:-[a-z-]+)?[.]txt", p.name):
            return None
        return "outside-source-allowlist"
    if parts[0] not in SOURCE_ROOTS:
        return "outside-source-allowlist"
    if p.suffix in TEXT_SUFFIXES or p.name in {"Dockerfile", "LICENSE", "pre-commit"} or p.name.startswith("Dockerfile."):
        return None
    # Static design assets only, never binaries elsewhere or game/runtime data.
    if path.startswith("site/src/assets/") and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2"}:
        return None
    return "outside-source-allowlist"


TOKEN_PATTERNS = (
    ("private-key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")),
    ("github-token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("cloud-access-key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{16,}\b")),
    ("api-secret-token", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("jwt-token", re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{12,}\b")),
    ("url-credentials", re.compile(rb"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:\"'<>]+:[^\s/@\"'<>]+@")),
)
# Only literals, not references such as os.getenv(), variable names or schema fields.
SECRET_KEY = r"(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|app[_-]?secret|client[_-]?secret|auth[_-]?key|cookie)(?:[_-]?(?:value|key|secret|token))?"
ASSIGNMENT = re.compile(r"(?im)(?<![A-Za-z0-9_])(?:[\"']?(?P<key>" + SECRET_KEY + r")[\"']?\s*[:=]\s*)(?P<quote>[\"'])(?P<value>[^\r\n]*?)(?P=quote)")
ENV_ASSIGNMENT = re.compile(r"(?im)^\s*(?:export\s+)?(?P<key>[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|COOKIE))\s*=\s*(?P<value>[^\s\"'][^\r\n#]*)")
BEARER = re.compile(r"(?i)\bBearer\s+([A-Za-z0-9._~+/-]{12,}=*)")


def placeholder(value: str) -> bool:
    value = value.strip().strip("\"'")
    lower = value.lower()
    return (not value or lower in {"none", "null", "false", "true", "secret", "token", "password", "redacted", "changeme", "***", "test", "test-secret", "test-token", "test-password", "dummy", "dummy-secret", "dummy-token", "{", "}"}
            or lower.startswith(("replace-", "replace_", "your-", "your_", "example-", "example_", "placeholder", "dummy-", "test-", "synthetic-", "fake-", "fake_", "fixture-"))
            or lower.endswith(("-fixture-only", "-super-secret"))
            or bool(re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|<[A-Z_ -]+>|__[A-Z_]+__", value)))


# Exact, reviewed synthetic fixture values from the already-public tests. This is
# deliberately path scoped: these strings in application code are still denied.
SYNTHETIC_TEST_VALUES = {
    "site/tests/account-growth-import.test.mjs": {"PRIVATE"},
    "tests/test_growth_levels.py": {"PRIVATE"},
    "tests/test_player_ranking_collection.py": {"PRIVATE-PASSWORD"},
    "tests/test_growth_login.py": {"fake"},
    "tests/test_growth_web.py": {"PRIVATE-PASSWORD", "reject", "b"},
    "tests/test_preview_growth.py": {"PRIVATE-PASSWORD"},
    "tests/test_identity_binding.py": {"secret-token", "correct-token", "qq-token", "onebot-token"},
    "tests/test_qqbot.py": {"new"},
    "tests/test_resource_platform_models.py": {"must-not-be-here"},
    "tests/test_resource_transport.py": {"session=top-secret"},
}


def scan_bytes(path: str, data: bytes) -> list[Finding]:
    found: set[Finding] = set()
    if path == REVIEWED_ARENA_EVIDENCE and hashlib.sha256(data).hexdigest() != REVIEWED_ARENA_EVIDENCE_SHA256:
        found.add(Finding(path, 0, "reviewed-evidence-digest"))
    for rule, pattern in TOKEN_PATTERNS:
        for match in pattern.finditer(data):
            found.add(Finding(path, data.count(b"\n", 0, match.start()) + 1, rule))
    # Refuse non-text in a declared text file (binary assets still get token checks).
    if PurePosixPath(path).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2"}:
        return sorted(found)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return sorted(found | {Finding(path, 0, "non-utf8-source")})
    for pattern in (ASSIGNMENT, ENV_ASSIGNMENT):
        for match in pattern.finditer(text):
            value = match.group("value").strip().strip("\"'")
            if placeholder(value) or value in SYNTHETIC_TEST_VALUES.get(path, set()):
                continue
            if path.endswith("package-lock.json") and match.group("key").lower() == "cookie" and re.fullmatch(r"[~^]?[0-9]+(?:[.][0-9]+){1,2}", value):
                continue
            # Template literals/references are code, not credentials. Literal values
            # still get provider token checks above, even within comments/fixtures.
            if value and not value.startswith(("$", "os.", "process.", "self.", "config.")):
                found.add(Finding(path, text.count("\n", 0, match.start()) + 1, "literal-secret"))
    crypto = re.compile(r"(?im)^\s*(?:DEFAULT_(?:KEY|IV|SALT)|CURRENT_USM_KEY|CRI_KEY|MASTER_KEY)\s*=\s*(?:bytes[.]fromhex\(\s*[\"'][0-9a-f]{16,}[\"']|0x[0-9a-f]{8,}|[0-9][0-9_]{9,})")
    for match in crypto.finditer(text):
        found.add(Finding(path, text.count("\n", 0, match.start()) + 1, "embedded-crypto-parameter"))
    for match in BEARER.finditer(text):
        if not placeholder(match.group(1)):
            found.add(Finding(path, text.count("\n", 0, match.start()) + 1, "bearer-credential"))
    return sorted(found)


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise ValueError("Git source unavailable (command output withheld)")
    return result.stdout


def source_entries(root: Path, source: str) -> list[tuple[str, str, str]]:
    """(path, mode, object id); working includes ignored files for path inventory."""
    if source == "working":
        entries = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            relative = Path(directory).relative_to(root)
            for name in list(dirs):
                path = relative / name
                full = root / path
                if full.is_symlink():
                    entries.append((path.as_posix(), "120000", ""))
                    dirs.remove(name)
                elif name in EXCLUDED_PARTS or path.as_posix() == "analysis/vendor" or (relative == Path(".") and name in PRIVATE_ROOTS) or (path.as_posix() + "/").startswith(GENERATED_PREFIXES):
                    dirs.remove(name)
            for name in files:
                path = relative / name
                mode = (root / path).lstat().st_mode
                entries.append((path.as_posix(), "120000" if stat.S_ISLNK(mode) else ("100755" if mode & 0o111 else "100644"), ""))
        return sorted(entries)
    if source == "index":
        result = []
        for row in git(root, "ls-files", "--stage", "-z").split(b"\0"):
            if row:
                metadata, path = row.split(b"\t", 1)
                mode, oid, stage = metadata.decode().split()
                if stage != "0":
                    raise ValueError("Unmerged index cannot be exported")
                result.append((os.fsdecode(path), mode, oid))
        return sorted(result)
    # Restrict revision inputs to immutable commits via Git's option terminator.
    revision = git(root, "rev-parse", "--verify", "--end-of-options", source + "^{commit}").decode().strip()
    result = []
    for row in git(root, "ls-tree", "-r", "-z", revision).split(b"\0"):
        if row:
            metadata, path = row.split(b"\t", 1)
            mode, kind, oid = metadata.decode().split()
            result.append((os.fsdecode(path), mode if kind == "blob" else "160000", oid))
    return sorted(result)


def read_entry(root: Path, entry: tuple[str, str, str], source: str) -> bytes:
    path, mode, oid = entry
    if mode not in {"100644", "100755"}:
        raise HygieneError([Finding(path, 0, "symlink-or-nonregular")])
    if source != "working":
        return git(root, "cat-file", "blob", oid)
    full = root / path
    if full.resolve() != full.absolute() or not full.is_file():
        raise HygieneError([Finding(path, 0, "symlink-or-nonregular")])
    # No-follow protects the final component if replaced during the check.
    fd = os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise HygieneError([Finding(path, 0, "symlink-or-nonregular")])
        return stream.read()


def scan_source(root: Path, scope: str) -> dict:
    root = root.resolve()
    source = "index" if scope in {"staged", "tracked"} else "working"
    entries = source_entries(root, source)
    if scope == "staged":
        selected = {os.fsdecode(x) for x in git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(b"\0") if x}
        entries = [e for e in entries if e[0] in selected]
    findings = []
    inspected = 0
    for entry in entries:
        path = entry[0]
        reason = classify_path(path)
        if reason:
            # Working tree is expected to contain private files. Track/index scans
            # report every forbidden file so .gitignore cannot hide tracked config.
            if scope != "working":
                findings.append(Finding(path, 0, reason))
            continue
        inspected += 1
        try:
            findings.extend(scan_bytes(path, read_entry(root, entry, source)))
        except HygieneError as exc:
            findings.extend(exc.findings)
    return {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "scope": scope, "inspectedFiles": inspected,
            "ok": not findings, "findings": [asdict(item) for item in sorted(set(findings))]}


def export_source(root: Path, destination: Path, source: str = "working") -> dict:
    root = root.resolve()
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Export destination must not exist")
    if destination == root or root in destination.parents:
        raise ValueError("Export destination must be outside source root")
    entries = source_entries(root, source)
    selected = []
    findings = []
    excluded = []
    for entry in entries:
        path, mode, _ = entry
        reason = classify_path(path)
        if reason:
            excluded.append({"path": path, "rule": reason})
            continue
        try:
            data = read_entry(root, entry, source)
        except HygieneError as exc:
            findings.extend(exc.findings)
            continue
        findings.extend(scan_bytes(path, data))
        selected.append((path, mode, data))
    if findings:
        raise HygieneError(findings)
    if not selected:
        raise ValueError("Export contains no allowed source files")
    # Read and validate once, then write those exact bytes (no second source read).
    records = [{"path": path, "mode": mode, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for path, mode, data in selected]
    canonical = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    revision = None
    if source not in {"working", "index"}:
        revision = git(root, "rev-parse", "--verify", "--end-of-options", source + "^{commit}").decode().strip()
    manifest = {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "source": source, "gitCommit": revision,
                "sourceSha256": hashlib.sha256(canonical).hexdigest(), "files": records}
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".ournotes-source-", dir=destination.parent))
    try:
        for path, mode, data in selected:
            target = temporary / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
        (temporary / "source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return manifest


def private_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("scan")
    scan.add_argument("--root", type=Path, default=Path.cwd())
    scan.add_argument("--scope", choices=("working", "staged", "tracked"), default="staged")
    scan.add_argument("--report", type=Path)
    export = commands.add_parser("export")
    export.add_argument("--root", type=Path, default=Path.cwd())
    export.add_argument("--source", default="working", help="working, index, or a Git revision")
    export.add_argument("--destination", type=Path, required=True)
    export.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            report = scan_source(args.root, args.scope)
        else:
            manifest = export_source(args.root, args.destination, args.source)
            report = {"ok": True, "sourceSha256": manifest["sourceSha256"], "fileCount": len(manifest["files"])}
    except HygieneError as exc:
        report = {"ok": False, "findings": [asdict(x) for x in exc.findings]}
    except (OSError, ValueError):
        report = {"ok": False, "error": "source-operation-failed", "detail": "Check arguments, source availability and destination permissions; raw exception withheld"}
    if args.report:
        private_report(args.report, report)
        print(json.dumps({"ok": report["ok"], "findingCount": len(report.get("findings", [])), "reportWritten": True}))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
