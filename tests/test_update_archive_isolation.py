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
        # Keep the original reviewed digest. Normalize only four exact, approved
        # Arena scheduling changes; every other byte of the producer stays pinned.
        replacements = [
            ("    needs: select\n    if: needs.select.outputs.run == 'true'\n", """    if: >-
      github.ref == format('refs/heads/{0}', github.event.repository.default_branch) &&
      (
        (github.event_name == 'schedule' &&
          (vars.CONTENT_R2_ENABLED_GLOBAL == 'true' || vars.CONTENT_R2_ENABLED_JP == 'true')) ||
        (github.event_name == 'workflow_dispatch' &&
          ((inputs.region == 'global' && vars.CONTENT_R2_ENABLED_GLOBAL == 'true') ||
           (inputs.region == 'jp' && vars.CONTENT_R2_ENABLED_JP == 'true')))
      )
"""),
            ("        region: ${{ fromJSON(needs.select.outputs.regions) }}", "        region: ${{ fromJSON((github.event_name == 'workflow_dispatch' && format('[\"{0}\"]', inputs.region)) || ((vars.CONTENT_R2_ENABLED_GLOBAL == 'true' && vars.CONTENT_R2_ENABLED_JP == 'true') && '[\"global\",\"jp\"]') || (vars.CONTENT_R2_ENABLED_GLOBAL == 'true' && '[\"global\"]') || '[\"jp\"]') }}"),
            ("""            python3 - "$SCHEDULE" <<'PY'
          import json, sys
          from tools.arena_sync import CALENDAR, FIXED_CRON, scheduled_crons
          if sys.argv[1] != FIXED_CRON and sys.argv[1] not in scheduled_crons(json.loads(CALENDAR.read_text())):
              raise SystemExit('Unregistered content schedule')
          PY
""", "            [[ \"$SCHEDULE\" == '0 1,6,11 * * *' ]] || exit 1\n"),
            ("`03:00, 14:00, 19:00` (three fixed triggers/day plus registered activity dates; actual starts may be delayed).", "`09:00, 14:00, 19:00` (three triggers/day; actual starts may be delayed)."),
        ]
        for expected, original in replacements:
            self.assertEqual(job.count(expected), 1, 'reviewed schedule fragment changed')
            job = job.replace(expected, original, 1)
        self.assertEqual(hashlib.sha256(job.encode()).hexdigest(),
                         'c85ee3a1709f1f87c5ede4be596782e245e39813767bba42e851de3e284bdb3f')

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
