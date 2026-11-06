import datetime as dt
import json
import unittest
from tools import r2_run_record as record
from tests.test_r2_content import MemoryBucket

class RunRecordTests(unittest.TestCase):
    def setUp(self):
        self.bucket = MemoryBucket()
        self.now = dt.datetime(2026, 10, 13, tzinfo=dt.timezone.utc)

    def publish(self, run, status, attempt=1, **steps):
        return record.publish(self.bucket, 'global', run, attempt, 'a' * 40, status, steps, self.now)

    def current(self):
        return json.loads(self.bucket.get(record.key('global'))[0])

    def test_repeated_and_late_finalization_cannot_duplicate_failure(self):
        self.publish(1, 'running')
        self.publish(1, 'failure', restore={'outcome': 'failure', 'outputs': {'internal': 'private-value'}})
        self.assertEqual(self.current()['consecutiveFailures'], 1)
        self.assertEqual(self.current()['failedStage'], 'restore')
        self.assertNotIn('private-value', json.dumps(self.current()))
        self.assertEqual(self.publish(1, 'failure')['status'], 'superseded')
        self.publish(2, 'running')
        self.assertEqual(self.publish(1, 'success')['status'], 'superseded')
        self.publish(2, 'failure')
        self.assertEqual(self.current()['consecutiveFailures'], 2)
        self.publish(3, 'success', light_gate={'outcome': 'success'})
        self.assertEqual(self.current()['outcome'], 'unchanged')
        self.assertEqual(self.current()['consecutiveFailures'], 0)

    def test_retry_same_run_uses_attempt(self):
        self.publish(1, 'failure')
        self.publish(1, 'running', attempt=2)
        self.assertEqual(self.current()['status'], 'running')
        self.publish(1, 'success', attempt=2, promote={'outcome': 'success'})
        self.assertEqual(self.current()['outcome'], 'promoted')
        self.assertIsNotNone(self.current()['lastSuccessAt'])

    def test_cross_region_fails_closed(self):
        self.publish(1, 'running')
        raw = self.current();raw['region'] = 'jp'
        self.bucket.objects[record.key('global')] = json.dumps(raw).encode()
        with self.assertRaisesRegex(ValueError, 'cross-region'):
            self.publish(2, 'running')
        self.assertNotIn('content/operations/jp/latest.json', self.bucket.objects)

    def test_manual_runs_preserve_native_schedule_timestamp(self):
        record.publish(self.bucket, 'global', 1, 1, 'a'*40, 'success', {}, self.now, event='schedule')
        scheduled = self.current()['lastScheduledAt']
        later = self.now + dt.timedelta(hours=2)
        record.publish(self.bucket, 'global', 2, 1, 'a'*40, 'success', {}, later, event='workflow_dispatch')
        self.assertEqual(self.current()['lastScheduledAt'], scheduled)
        self.assertNotEqual(self.current()['observedAt'], scheduled)
        self.assertEqual(self.current()['event'], 'workflow_dispatch')

    def test_external_schedule_keeps_planned_time_separate_from_actual_start(self):
        planned = '2026-10-13T06:00:00Z'
        started = self.now + dt.timedelta(hours=6, minutes=2)
        record.publish(self.bucket,'global',1,1,'a'*40,'success',{},started,scheduled_for=planned)
        self.assertEqual(self.current()['scheduledFor'],planned)
        self.assertEqual(self.current()['lastScheduledAt'],planned)
        record.publish(self.bucket,'global',2,1,'a'*40,'success',{},started+dt.timedelta(hours=1))
        self.assertEqual(self.current()['lastScheduledAt'],planned)
        self.assertNotIn('scheduledFor',self.current())
        with self.assertRaisesRegex(ValueError,'external schedule'):
            record.build('global',3,1,'a'*40,'success',{},now=started,scheduled_for='2026-10-14T06:00:00Z')
