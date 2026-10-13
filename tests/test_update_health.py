import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from tools import update_health as health
from deploy.admin.export_ranking_health import export as export_ranking
from tools import r2_run_record as records
from backend.admin.update_health import read_health
from tests.test_r2_content import MemoryBucket

class HealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1791876000
        self.observed = {'conditions': [], 'runs': {}, 'versions': {}, 'diskFreeBytes': 5000, 'diskRequiredBytes': 4000}

    def test_duration_dedup_recovery(self):
        self.observed['conditions'] = [{'id': 'jp:run_failed', 'region': 'jp', 'code': 'run_failed', 'grace': 900}]
        first, log = health.advance(self.observed, {}, self.now)
        self.assertEqual(first['status'], 'waiting');self.assertEqual(log, [])
        firing, log = health.advance(self.observed, first, self.now + 901)
        self.assertEqual(firing['status'], 'attention');self.assertEqual(log[0]['transition'], 'opened')
        repeated, log = health.advance(self.observed, firing, self.now + 1200)
        self.assertEqual(log, [])
        self.observed['conditions'] = []
        recovered, log = health.advance(self.observed, repeated, self.now + 1300)
        self.assertEqual(recovered['status'], 'healthy');self.assertEqual(log[0]['transition'], 'recovered')
        self.assertEqual(len(recovered['history']), 2)

    def test_private_view_rejects_stale_future_and_invalid_data_and_strips_secrets(self):
        report, _ = health.advance(self.observed, {}, self.now)
        report['secret'] = 'never-display'
        path = self.root / 'update-health.json'
        health.write_atomic(path, report)
        with patch('backend.admin.update_health.time.time', return_value=self.now):
            self.assertEqual(read_health(self.root)['status'], 'healthy')
            self.assertNotIn('never-display', json.dumps(read_health(self.root)))
        for clock in (self.now + 361, self.now - 61):
            with patch('backend.admin.update_health.time.time', return_value=clock):
                self.assertEqual(read_health(self.root), {'status': 'unavailable'})
        report['alerts'] = [{'code': 'private-value', 'region': 'jp'}]
        health.write_atomic(path, report)
        with patch('backend.admin.update_health.time.time', return_value=self.now):
            self.assertEqual(read_health(self.root), {'status': 'unavailable'})

    def test_running_grace_and_release_lag_are_separate(self):
        bucket = MemoryBucket()
        stamp = dt.datetime.fromtimestamp(self.now - 4000, dt.timezone.utc)
        for region in ('global', 'jp'):
            records.publish(bucket, region, 1, 1, 'a' * 40, 'running' if region == 'jp' else 'success', {}, now=stamp)
            pointer = {'schemaVersion': 1, 'manifest': '/content/releases/' + 'a' * 24 + '/manifest.json', 'sha256': 'b' * 64}
            bucket.put_new('content/current.json' if region == 'global' else 'content/jp/current.json', json.dumps(pointer).encode())
        ranking = self.root / 'ranking.json'
        ranking.write_text(json.dumps({'status': 'complete', 'observedAt': dt.datetime.fromtimestamp(self.now, dt.timezone.utc).isoformat()}))
        with patch('tools.update_health.read_json', side_effect=lambda path, *_: json.loads(Path(path).read_text())):
            result = health.sample(bucket, self.root / 'missing', ranking, self.root, 1, self.now)
        codes = {c['id'] for c in result['conditions']}
        self.assertIn('global:poll_stale', codes)
        self.assertNotIn('jp:poll_stale', codes)
        self.assertNotIn('jp:run_stuck', codes)
        self.assertIn('all:delivery_unknown', codes)
        self.assertIn('jp:delivery_lag', codes)
        self.assertNotIn('all:ranking_stale', codes)

    def test_retry_start_does_not_claim_recovery_before_success(self):
        bucket = MemoryBucket()
        stamp = dt.datetime.fromtimestamp(self.now, dt.timezone.utc)
        records.publish(bucket, 'jp', 1, 1, 'a' * 40, 'failure', {'restore': {'outcome': 'failure'}}, now=stamp)
        records.publish(bucket, 'jp', 2, 1, 'a' * 40, 'running', {}, now=stamp)
        result = health.sample(bucket, self.root / 'absent', self.root / 'absent', self.root, 1, self.now)
        self.assertIn('jp:run_failed', {c['id'] for c in result['conditions']})
        self.assertEqual(result['runs']['jp']['failedStage'], 'restore')

    def test_ranking_export_is_whitelisted_and_replaces_broken_success(self):
        source = self.root / 'capture.json';target = self.root / 'export.json'
        source.write_text(json.dumps({'status': 'complete', 'paused': False, 'observedAt': '2026-10-13T07:25:00Z', 'account': 'private'}))
        export_ranking(source, target)
        self.assertEqual(set(json.loads(target.read_text())), {'status', 'paused', 'observedAt'})
        source.write_text('')
        export_ranking(source, target)
        self.assertEqual(json.loads(target.read_text()), {'status': 'unavailable'})

    def test_sampling_cannot_wait_for_long_running_publication_units(self):
        unit = Path(__file__).resolve().parents[1] / 'deploy/admin/ournotes-update-health.service'
        relationships = [line for line in unit.read_text().splitlines() if line.startswith(('After=', 'Requires=', 'Wants='))]
        self.assertFalse(any('prerender' in line or 'delivery-state' in line for line in relationships))

    def test_recent_manual_success_does_not_mask_a_stale_native_schedule(self):
        bucket = MemoryBucket()
        old = dt.datetime.fromtimestamp(self.now-7200, dt.timezone.utc)
        current = dt.datetime.fromtimestamp(self.now, dt.timezone.utc)
        records.publish(bucket, 'jp', 1, 1, 'a'*40, 'success', {}, now=old, event='schedule')
        records.publish(bucket, 'jp', 2, 1, 'a'*40, 'success', {}, now=current, event='workflow_dispatch')
        result = health.sample(bucket, self.root/'missing', self.root/'missing', self.root, 1, self.now)
        codes = {item['id'] for item in result['conditions']}
        self.assertIn('jp:schedule_stale', codes)
        self.assertNotIn('jp:poll_stale', codes)


class WorkerHealthTests(unittest.TestCase):
    def setUp(self):
        from deploy.admin import worker_health
        self.collect = worker_health.collect
        self.now = 1791876000
        self.rows = {'recent': [{'sum': {'requests': 500, 'errors': 8}, 'quantiles': {'cpuTimeP99': 1234}}],
                     'daily': [{'sum': {'requests': 8500, 'errors': 8}}]}

    def query(self, *_):
        return {'data': {'viewer': {'accounts': [self.rows]}}}

    def test_valid_empty_unconfigured_and_failed_queries_are_distinct(self):
        result = self.collect('account', 'inert', self.now, 10000, self.query)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['recentErrors'], 8)
        self.assertEqual(result['cpuTimeP99Us'], 1234)
        self.rows = {'recent': [], 'daily': []}
        self.assertEqual(self.collect('account', 'inert', self.now, query=self.query)['recentRequests'], 0)
        self.assertEqual(self.collect('account', None, self.now)['status'], 'not_configured')
        def failed(*_): raise OSError('private transport detail')
        result = self.collect('account', 'inert', self.now, query=failed)
        self.assertEqual(result, {'schemaVersion': 1, 'observedAt': self.now, 'status': 'unavailable'})
        result = self.collect('account', 'inert', self.now, query=lambda *_: {'errors': [{'message': 'private'}]})
        self.assertNotIn('private', json.dumps(result))

    def test_malformed_or_contradictory_metrics_are_unavailable(self):
        for bad in (-1, True, float('nan'), float('inf'), '8', 501):
            self.rows['recent'][0]['sum']['errors'] = bad
            self.assertEqual(self.collect('account', 'inert', self.now, query=self.query)['status'], 'unavailable')

    def test_alert_dedup_recovery_and_staleness(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);target = root/'worker.json'
            def sample(report):
                target.write_text(json.dumps(report))
                import os
                os.utime(target, (self.now, self.now))
                return health.sample(MemoryBucket(), root/'absent', root/'absent', root, 1, self.now, target)
            observed = sample(self.collect('account', 'inert', self.now, 10000, self.query))
            relevant = lambda value: [c for c in value['conditions'] if c['code'].startswith('worker_')]
            self.assertEqual({c['code'] for c in relevant(observed)}, {'worker_errors', 'worker_budget'})
            observed['conditions'] = relevant(observed)
            fired, log = health.advance(observed, {}, self.now)
            self.assertEqual(len(log), 2)
            repeated, log = health.advance(observed, fired, self.now+120)
            self.assertEqual(log, [])
            self.rows['recent'][0]['sum']['errors'] = 0
            recovered = sample(self.collect('account', 'inert', self.now, 0, self.query))
            recovered['conditions'] = relevant(recovered)
            report, log = health.advance(recovered, repeated, self.now+240)
            self.assertEqual([r['transition'] for r in log], ['recovered', 'recovered'])
            health.write_atomic(root/'update-health.json', report)
            with patch('backend.admin.update_health.time.time', return_value=self.now+240):
                self.assertEqual(read_health(root)['worker']['recentErrors'], 0)
            stale = sample(self.collect('account', 'inert', self.now-361, query=self.query))
            self.assertEqual([c['code'] for c in relevant(stale)], ['worker_metrics_stale'])
            unconfigured = sample(self.collect('account', None, self.now))
            self.assertEqual(relevant(unconfigured), [])
            self.assertEqual(unconfigured['worker']['status'], 'not_configured')
