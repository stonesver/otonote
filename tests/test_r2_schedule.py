"""Exercise the actual workflow eligibility, serialization and selection script."""
import os
import json
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

from tools.r2_schedule import UTC_HOURS


WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/content-r2.yml'


def expression(source, context):
    # Evaluate the comparisons, boolean operators, format and fromJSON used here.
    # Evaluate that restricted subset after replacing all context lookups; no
    # external input is executed and no workflow actions run in these tests.
    source = re.sub(r'\b(?:github|inputs|vars|matrix|needs)(?:\.[A-Za-z_][A-Za-z_0-9]*)+',
                    lambda match: repr(context.get(match[0], '')), source)
    source = source.replace('&&', ' and ').replace('||', ' or ')
    return eval(source, {'__builtins__': {}, 'format': lambda value, *args: value.format(*args),
                         'fromJSON': json.loads})


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.crons = re.findall(r"- cron: '([^']+)'", cls.text)
        cls.eligibility = ' '.join(cls.text.split('    if: >-\n', 1)[1].split('    runs-on:', 1)[0].split())
        cls.group = re.search(r'group: content-r2-\$\{\{ (.+) \}\}', cls.text)[1]
        cls.regions = re.search(r'        region: \$\{\{ (.+) \}\}', cls.text)[1]
        step = cls.text.split('      - name: Select region and publication mode\n', 1)[1]
        cls.selection = textwrap.dedent(step.split('        run: |\n', 1)[1].split('      - name:', 1)[0])

    def context(self, **changes):
        result = {'github.ref': 'refs/heads/main', 'github.event.repository.default_branch': 'main',
                  'github.event_name': 'schedule',
                  'vars.CONTENT_R2_ENABLED_GLOBAL': 'true', 'vars.CONTENT_R2_ENABLED_JP': 'true'}
        result.update(changes)
        regions = [r for r in ('global','jp') if result.get('vars.CONTENT_R2_ENABLED_'+r.upper()) == 'true']
        if result['github.event_name'] == 'workflow_dispatch':
            regions = [result.get('inputs.region')] if result.get('inputs.region') in regions else []
        result['needs.select.outputs.regions'] = json.dumps(regions or ['global'])
        return result

    def test_shared_schedule_selects_only_enabled_editions(self):
        self.assertNotIn('CONTENT_R2_FAST_POLL', self.text)
        for global_enabled in ('', 'false', 'true'):
            for jp_enabled in ('', 'false', 'true'):
                context = self.context(**{'vars.CONTENT_R2_ENABLED_GLOBAL': global_enabled,
                                           'vars.CONTENT_R2_ENABLED_JP': jp_enabled})
                expected = [region for region, enabled in (('global', global_enabled), ('jp', jp_enabled))
                            if enabled == 'true']
                self.assertEqual(bool(expression(self.eligibility, context)), bool(expected))
                if expected:
                    self.assertEqual(expression(self.regions, context), expected)

    def test_manual_and_scheduled_runs_share_region_lock_without_cancelling_running_publish(self):
        self.assertIn('      cancel-in-progress: false', self.text)
        self.assertIn('      fail-fast: false', self.text)
        for region in ('global', 'jp'):
            for event in ('schedule', 'workflow_dispatch'):
                context = self.context(**{'github.event_name': event, 'inputs.region': region,
                                           'matrix.region': region})
                self.assertEqual(expression(self.group, context), region)
                self.assertEqual(expression(self.regions, context),
                                 [region] if event == 'workflow_dispatch' else ['global', 'jp'])
                self.assertTrue(expression(self.eligibility, context))
                context['github.ref'] = 'refs/heads/unreviewed'
                self.assertFalse(expression(self.eligibility, context))

    def test_manual_cannot_run_a_disabled_or_invalid_edition(self):
        for region in ('global', 'jp'):
            context = self.context(**{'github.event_name': 'workflow_dispatch', 'inputs.region': region,
                                      'vars.CONTENT_R2_ENABLED_' + region.upper(): 'false'})
            self.assertFalse(expression(self.eligibility, context))
        context = self.context(**{'github.event_name': 'workflow_dispatch', 'inputs.region': 'invalid'})
        self.assertFalse(expression(self.eligibility, context))
        self.assertFalse(expression(self.eligibility, self.context(**{'github.event_name': 'push'})))

    def test_three_daily_triggers_and_registered_dates_match_health_schedule(self):
        self.assertEqual(self.crons, ['0 6,11,19 * * *'])
        self.assertNotIn("*/5", self.text)
        self.assertNotIn("Install boundary selector dependencies", self.text)
        self.assertIn("needs: select", self.text)
        self.assertIn("if: needs.select.outputs.run == 'true'", self.text)
        minute, hours, *days = self.crons[0].split()
        self.assertEqual(minute, '0')
        self.assertEqual(days, ['*', '*', '*'])
        self.assertEqual(tuple(map(int, hours.split(','))), UTC_HOURS)
        self.assertEqual([(hour + 8) % 24 for hour in UTC_HOURS], [14, 19, 3])
        for region in ('global', 'jp'):
            timer = WORKFLOW.parents[2] / f'deploy/ournotes-update-trigger-{region}.timer'
            self.assertIn('OnCalendar=*-*-* 06,11,19:00:00 UTC', timer.read_text())

    def select(self, event, cron='', region='', mode='', auto='true', global_workers='', jp_workers='',
               selected_region=None):
        with tempfile.TemporaryDirectory() as folder:
            env_path, summary = Path(folder) / 'env', Path(folder) / 'summary'
            env = dict(os.environ, EVENT_NAME=event, SCHEDULE=cron, INPUT_REGION=region,
                       SELECTED_REGION=region if selected_region is None else selected_region,
                       INPUT_MODE=mode, AUTO_PROMOTE_GLOBAL=auto, AUTO_PROMOTE_JP=auto,
                       RESTORE_WORKERS_GLOBAL=global_workers, RESTORE_WORKERS_JP=jp_workers,
                       GITHUB_ENV=str(env_path), GITHUB_STEP_SUMMARY=str(summary), GITHUB_RUN_ID='123')
            result = subprocess.run(['bash', '-c', self.selection], env=env, capture_output=True)
            return result.returncode, env_path.read_text() if env_path.exists() else '', summary.read_text() if summary.exists() else ''

    def test_actual_selection_script_preserves_auto_promote_and_manual_mode(self):
        for region in ('global', 'jp'):
            for cron in self.crons:
                for auto in ('true', 'false', ''):
                    status, env, summary = self.select('schedule', cron=cron, region=region, auto=auto)
                    self.assertEqual(status, 0)
                    self.assertIn('REGION=' + region, env)
                    self.assertIn('MODE=' + ('promote' if auto == 'true' else 'shadow'), env)
                    self.assertIn('03:00, 14:00, 19:00', summary)
                    self.assertIn('three fixed triggers/day', summary)
                    self.assertIn('Selection started at (UTC)', summary)
        status, env, _ = self.select('workflow_dispatch', region='jp', mode='shadow')
        self.assertEqual((status, env), (0, 'REGION=jp\nMODE=shadow\nRESTORE_WORKERS=8\n'))
        self.assertNotEqual(self.select('schedule', cron='unknown')[0], 0)
        self.assertNotEqual(self.select('workflow_dispatch', region='invalid', mode='promote')[0], 0)
        self.assertNotEqual(self.select('schedule', cron=self.crons[0], region='invalid')[0], 0)
        self.assertNotEqual(self.select('workflow_dispatch', region='jp', mode='promote', selected_region='global')[0], 0)

    def test_external_auto_dispatch_uses_current_auto_promote_setting(self):
        for region in ('global', 'jp'):
            for auto in ('true', 'false', ''):
                status, env, _ = self.select('workflow_dispatch', region=region, mode='auto', auto=auto)
                self.assertEqual(status, 0)
                self.assertIn('MODE=' + ('promote' if auto == 'true' else 'shadow'), env)

    def test_boundary_poll_does_not_start_archive_work(self):
        block = self.text.split('  archive:\n', 1)[1]
        condition = ' '.join(block.split('    if: >-\n', 1)[1].split('    strategy:', 1)[0].split())
        for cron, expected in [('0 6,11,19 * * *', True), ('0 3 29 10 *', False)]:
            context = self.context(**{'github.event.schedule': cron, 'vars.CONTENT_ARCHIVE_ENABLED_GLOBAL': 'true'})
            self.assertEqual(bool(expression(condition, context)), expected)

    def test_restore_concurrency_is_bounded_per_region_before_expensive_work(self):
        for region in ('global', 'jp'):
            for workers in ('4', '8', '12'):
                options = {region + '_workers': workers}
                status, env, _ = self.select('workflow_dispatch', region=region, mode='shadow', **options)
                self.assertEqual(status, 0)
                self.assertIn('RESTORE_WORKERS=' + workers + '\n', env)
            for bad in ('0', '16', '8\nEXTRA=value', '$(exit 0)', 'invalid'):
                status, env, _ = self.select('workflow_dispatch', region=region, mode='shadow',
                                             **{region + '_workers': bad})
                self.assertNotEqual(status, 0)
                self.assertEqual(env, '')
        status, env, _ = self.select('workflow_dispatch', region='jp', mode='shadow', global_workers='12')
        self.assertEqual(status, 0)
        self.assertIn('RESTORE_WORKERS=8\n', env)


if __name__ == '__main__':
    unittest.main()
