"""Protect the admitted producer while adding a separately disabled consumer."""
import ast
import hashlib
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProductionIsolationTests(unittest.TestCase):
    def test_existing_producer_job_is_unchanged(self):
        text = (ROOT / '.github/workflows/content-r2.yml').read_text()
        job = re.search(r'^  produce:\n.*?(?=^  [A-Za-z_][\w-]*:\n|\Z)', text, re.M | re.S)[0]
        self.assertEqual(hashlib.sha256(job.encode()).hexdigest(),
                         '5278fe35bd35b820a67ca5a8d3ead0da2197690326c9648a1ef4b1f6c4a2266f')

    def test_producers_do_not_import_archive(self):
        for base in ('tools', 'analysis/crypto'):
            for path in (ROOT / base).rglob('*.py'):
                tree = ast.parse(path.read_text())
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom):
                        self.assertFalse((node.module or '').startswith('backend.update_archive'), str(path))
                    if isinstance(node, ast.Import):
                        self.assertFalse(any(x.name.startswith('backend.update_archive') for x in node.names), str(path))


    def test_archive_job_is_disabled_by_default_and_has_no_producer_dependency(self):
        import yaml
        workflow=yaml.safe_load((ROOT/'.github/workflows/content-r2.yml').read_text())
        archive=workflow['jobs']['archive']
        self.assertNotIn('needs',archive)
        self.assertEqual(archive['runs-on'],'ubuntu-latest')
        self.assertEqual(archive['concurrency']['group'],'content-archive-${{ matrix.region }}')
        self.assertFalse(archive['concurrency']['cancel-in-progress'])
        self.assertIn("vars.CONTENT_ARCHIVE_ENABLED_GLOBAL == 'true'",archive['if'])
        self.assertIn("vars.CONTENT_ARCHIVE_ENABLED_JP == 'true'",archive['if'])
        self.assertNotIn('CONTENT_R2_ENABLED',archive['if'])
        steps='\n'.join(s.get('run','') for s in archive['steps'])
        self.assertNotIn('tools.r2_',steps)
        self.assertIn('timeout --signal=TERM',steps)
