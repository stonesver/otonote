import json
import gzip
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from tools.growth_diagnostics_snapshot import build_snapshot, read_access_logs


class GrowthDiagnosticsSnapshotTests(unittest.TestCase):
    def test_reads_date_rotated_logs_across_midnight(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / 'growth.access.log'
            previous = Path(str(base) + '-20261010')
            older = Path(str(base) + '-20261009.gz')
            older.write_bytes(gzip.compress(b'older\n'))
            previous.write_text('previous\n')
            base.write_text('current\n')
            os.utime(str(older), (1, 1))
            os.utime(str(previous), (2, 2))
            self.assertEqual(read_access_logs(str(base)), 'older\n\nprevious\n\ncurrent\n')

    def test_correlates_failures_without_copying_private_fields(self):
        now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
        request_id = 'a' * 32
        access = '\n'.join(json.dumps(row) for row in [
            {'time': '2026-10-09T19:00:00+08:00', 'requestId': request_id,
             'route': 'growth_export', 'method': 'POST', 'status': 422,
             'account': 'private@example.com', 'upstreamStatus': '422'},
            {'time': '2026-10-09T19:01:00+08:00', 'requestId': 'b' * 32,
             'route': 'growth_export', 'method': 'POST', 'status': 408},
            {'time': '2026-10-09T19:02:00+08:00', 'requestId': 'c' * 32,
             'route': 'growth_export', 'method': 'GET', 'status': 200}])
        gateway = json.dumps({'time': '2026-10-09T11:00:01+00:00', 'requestId': request_id,
                              'event': 'finish', 'route': 'growth', 'stage': 'sdk_login',
                              'error': 'sdk_service_500002', 'reason': 'unclassified',
                              'message': '帳號或密碼錯誤', 'messageState': 'original',
                              'extra': 'fixture-sensitive-canary'})+'\n'+json.dumps({
                                  'time':'2026-10-09T11:01:01+00:00','requestId':'b'*32,
                                  'event':'finish','route':'growth','stage':'sdk_login',
                                  'error':'password_private', 'reason':'fixture-sensitive-canary'})
        result = build_snapshot(access, gateway, now=now)
        self.assertEqual(result['requests'], 2)
        self.assertEqual(result['statusCounts'], {'422': 1, '408': 1})
        self.assertEqual(result['errorCounts'], {'sdk_service_500002': 1})
        self.assertIsNone(result['recentFailures'][0]['error'])
        self.assertEqual(result['recentFailures'][1]['reason'], 'unclassified')
        self.assertEqual(result['recentFailures'][1]['message'], '帳號或密碼錯誤')
        unsafe=json.dumps({'time':'2026-10-09T11:00:01+00:00','requestId':request_id,
                           'event':'finish','route':'growth','stage':'sdk_login',
                           'error':'sdk_service_500002','message':'user@example.invalid',
                           'messageState':'original'})
        hidden=build_snapshot(access, unsafe, now=now)
        self.assertIsNone(hidden['recentFailures'][1]['message'])
        self.assertEqual(hidden['recentFailures'][1]['messageState'], 'omitted')
        self.assertNotIn('private@example.com', json.dumps(result))
        self.assertNotIn('fixture-sensitive-canary', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
