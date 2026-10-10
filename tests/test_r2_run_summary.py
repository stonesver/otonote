from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from tools.r2_run_summary import summarize


class SummaryTests(unittest.TestCase):
    def test_incomplete_outputs_do_not_hide_original_failure(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            for content in ('', '{', '[]', '{"status": []}', '{"status":"private-secret"}'):
                (root/'state-after.json').write_text(content)
                result = summarize(root, 'failure')
                self.assertIn('Workflow result: `failure`', result)
                self.assertNotIn('private-secret', result)

    def test_manifest_budget_is_reported_without_raw_errors(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'state-after.json').write_text('{"status":"checkpointed","manifestBytes":100,"manifestLimitBytes":120,"manifestBudgetWarning":true,"error":"secret"}')
            result = summarize(root, 'success')
            self.assertIn('manifestBytes: `100`', result)
            self.assertIn('80%', result)
            self.assertNotIn('secret', result)
