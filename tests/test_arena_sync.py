import hashlib
import contextlib
import io
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
import json
import unittest

from tests.test_r2_content import MemoryBucket
from tools import arena_sync as sync
from tools.arena_content import build_arena_content


def stamp(value):
    return sync.timestamp(value)


class ArenaSyncTests(unittest.TestCase):
    def setUp(self):
        self.public, self.private = MemoryBucket(), MemoryBucket()
        self.arena = build_arena_content('.', 'release', 'global')
        self.arena['capabilities']['conditions'] = True
        self.arena['regulations'] = [dict(id='1', validFrom='2026-10-29T03:00:00Z', validUntil='2026-10-30T19:00:00Z')]
        self.arena['activityPeriods'] = [dict(id='e1', validFrom='2026-10-29T03:00:00Z', validUntil='2026-10-29T06:59:59Z')]
        self.publish()

    def publish(self, region='global'):
        root = '/content/releases/' + ('a' if region == 'global' else 'b') * 24 + '/'
        arena = {**self.arena, 'region': region}
        blob = json.dumps(arena).encode()
        manifest = dict(schemaVersion=1, region=region, channel='production', root=root, contentReleaseId='release',
                        locales={'zh-CN': {'files': {'projection/arena.json': {'path': 'zh-CN/arena.json', 'sha256': hashlib.sha256(blob).hexdigest()}}}})
        raw = json.dumps(manifest).encode()
        self.public.replace(root.lstrip('/')+'zh-CN/arena.json', blob, self.public.etags.get(root.lstrip('/')+'zh-CN/arena.json'))
        self.public.replace(root.lstrip('/')+'manifest.json', raw, self.public.etags.get(root.lstrip('/')+'manifest.json'))
        name = 'content/current.json' if region == 'global' else 'content/jp/current.json'
        self.public.replace(name, json.dumps(dict(schemaVersion=1, manifest=root+'manifest.json', sha256=hashlib.sha256(raw).hexdigest())).encode(), self.public.etags.get(name))

    def calendar(self):
        return sync.compile_calendar({'global': self.arena}, '2026-10-28T00:00:00Z', '2026-11-01T00:00:00Z')

    def test_fixed_schedule_and_manual_use_existing_enabled_editions_without_a_calendar(self):
        self.assertEqual(sync.select_regions(['global', 'jp'], event='schedule', cron=sync.FIXED_CRON), ['global', 'jp'])
        self.assertEqual(sync.select_regions(['global'], event='workflow_dispatch', requested='jp'), [])
        with self.assertRaises(ValueError):
            sync.select_regions(['global'], event='schedule', cron='*/5 * * * *', calendar=self.calendar())

    def test_only_reviewed_activity_windows_become_native_crons(self):
        calendar = self.calendar()
        self.assertEqual(sync.scheduled_crons(calendar), ['0 3 29 10 *', '0 7 29 10 *'])
        # The separate daily Arena regulations do not add another timer.
        self.assertEqual(len(calendar['activityChecks']), 2)
        self.arena['activityPeriods'].append(dict(id='fixed', validFrom='2026-10-30T19:00:00Z', validUntil='2026-10-31T06:00:00Z'))
        self.assertEqual(len(self.calendar()['activityChecks']), 2)

    def test_same_time_editions_merge_and_disabled_editions_stay_excluded(self):
        jp = {**self.arena, 'region':'jp'}
        calendar = sync.compile_calendar({'global':self.arena,'jp':jp}, '2026-10-29T00:00:00Z', '2026-10-30T00:00:00Z')
        self.assertEqual(calendar['activityChecks'][0]['regions'], ['global','jp'])
        self.assertEqual(sync.select_regions(['jp'], event='schedule', cron='0 3 29 10 *', calendar=calendar,
                         now=stamp('2026-10-29T03:00:00Z')), ['jp'])

    def test_exact_year_and_bounded_start_delay_prevent_replay(self):
        calendar=self.calendar()
        for at, expected in [('2026-10-29T02:59:59Z', []),('2026-10-29T03:00:00Z',['global']),
                             ('2026-10-29T03:30:00Z',['global']),('2026-10-29T09:00:01Z',[]),
                             ('2027-10-29T03:00:00Z',[])]:
            self.assertEqual(sync.select_regions(['global'], event='schedule', cron='0 3 29 10 *',
                             calendar=calendar, now=stamp(at)), expected)

    def test_beijing_date_conversion_and_minute_rounding_never_run_early(self):
        self.arena['activityPeriods']=[dict(id='event',validFrom='2026-10-29T03:05:00+08:00',validUntil='2026-10-29T03:06:00.500000+08:00')]
        self.assertEqual(sync.scheduled_crons(self.calendar()), ['5 19 28 10 *','7 19 28 10 *'])

    def test_missing_unverified_or_malformed_activity_times_are_never_guessed(self):
        self.arena['activityPeriods']=[]
        self.assertEqual(self.calendar()['activityChecks'],[])
        self.arena['capabilities']['conditions']=False
        with self.assertRaises(ValueError):self.calendar()
        with self.assertRaises(ValueError):sync.timestamp('2026/10/29 03:00:00')
        calendar={'schemaVersion':1,'activityChecks':[{'at':'2026-10-29T03:00:00Z','regions':['other']}]}
        with self.assertRaises(ValueError):sync.validate_calendar(calendar)

    def test_hash_and_edition_are_checked_before_preparing_a_calendar(self):
        name='content/releases/'+'a'*24+'/zh-CN/arena.json'
        self.public.objects[name]+=b' '
        with self.assertRaises(ValueError):sync.published_arena(self.public,'global')
        self.publish();self.publish('jp')
        self.public.objects['content/current.json']=self.public.objects['content/jp/current.json']
        with self.assertRaises(ValueError):sync.published_arena(self.public,'global')

    def test_generator_changes_only_the_managed_block_and_is_idempotent(self):
        calendar=self.calendar();source=sync.WORKFLOW.read_text()
        rendered=sync.render_workflow(source,calendar)
        self.assertIn("    - cron: '0 3 29 10 *'",rendered)
        self.assertEqual(rendered.split(sync.END)[1],source.split(sync.END)[1])
        self.assertEqual(rendered.split(sync.BEGIN)[0],source.split(sync.BEGIN)[0])
        self.assertEqual(sync.render_workflow(rendered,calendar),rendered)
        self.assertEqual(sync.render_workflow(source,json.loads(sync.CALENDAR.read_text())),source)

    def test_calendar_command_has_an_explicit_horizon_and_only_mutates_local_files_on_apply(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);store=root/'store';store.mkdir()
            for key,value in self.public.objects.items():
                path=store/key.removeprefix('content/');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value)
            workflow=root/'workflow.yml';workflow.write_text(sync.WORKFLOW.read_text())
            calendar=root/'calendar.json';calendar.write_text(sync.CALENDAR.read_text())
            old=workflow.read_text();args=['calendar','--store',str(store),'--region','global','--after','2026-10-28T00:00:00Z','--until','2026-11-01T00:00:00Z']
            with patch.object(sync,'WORKFLOW',workflow),patch.object(sync,'CALENDAR',calendar),contextlib.redirect_stdout(io.StringIO()):
                sync.main(args);self.assertEqual(workflow.read_text(),old)
                sync.main(args+['--apply']);sync.main(['check'])
            self.assertEqual(json.loads(calendar.read_text()),self.calendar())
            self.assertIn("    - cron: '0 3 29 10 *'",workflow.read_text())

    def test_runtime_selector_needs_no_r2_credentials_network_or_private_watermark(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'output'
            env={'GITHUB_EVENT_NAME':'schedule','SCHEDULE':sync.FIXED_CRON,'GITHUB_OUTPUT':str(output),
                 'CONTENT_R2_ENABLED_GLOBAL':'true','CONTENT_R2_ENABLED_JP':'false'}
            with patch.dict(os.environ,env,clear=True),contextlib.redirect_stdout(io.StringIO()):sync.main([])
            self.assertIn('regions=["global"]',output.read_text());self.assertIn('run=true',output.read_text())
