"""Private, bounded diagnostics for failed Global content compilation."""

import hashlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from tools import r2_diagnostics


class FakeClient:
    def __init__(self):
        self.objects = {}
        self.corrupt_readback = False

    def put_object(self, *, Bucket, Key, Body, Metadata, **_kwargs):
        if (Bucket, Key) in self.objects:
            raise AssertionError('unexpected duplicate diagnostic upload')
        self.objects[(Bucket, Key)] = (bytes(Body), dict(Metadata))

    def get_object(self, *, Bucket, Key):
        body, metadata = self.objects[(Bucket, Key)]
        if self.corrupt_readback:
            body = b'corrupt' + body[7:]
        return {'Body': io.BytesIO(body), 'Metadata': metadata,
                'ContentLength': len(body)}


class R2DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        temporary_root = Path('/private/tmp') if Path('/private/tmp').is_dir() else Path('/tmp')
        self.temporary = TemporaryDirectory(dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name) / 'output/global-update-workflow'
        self.run = self.workspace / 'runs/2026-10-05T03-10-52.064880+00-00-eaf4fc14'
        self.run.mkdir(parents=True)
        self.journal = self.workspace / 'latest-run.json'
        self.log = self.run / 'compile-data.log'
        self.write_journal(self.run)

    def write_journal(self, run):
        self.journal.write_text(json.dumps({'status': 'failed', 'failedStep': 'compile-data',
                                            'runDirectory': str(run)}))

    def test_bounded_log_uploads_to_fixed_key_and_verifies_complete_readback(self):
        self.log.write_bytes(b'safe diagnostic bytes')
        client = FakeClient()
        result = r2_diagnostics.preserve(self.workspace, client, 'private', '12345', '2')
        self.assertEqual(result['key'], 'diagnostics/global/12345/2/compile-data.log')
        self.assertEqual(result['sha256'], hashlib.sha256(self.log.read_bytes()).hexdigest())
        self.assertEqual(result['bytes'], 21)
        self.assertEqual(result['originalBytes'], 21)
        self.assertFalse(result['truncated'])
        self.assertEqual(client.objects[('private', result['key'])][0], self.log.read_bytes())

    def test_large_log_saves_only_last_four_mib_and_records_original_size(self):
        prefix = b'first-secret-marker' + b'x' * (r2_diagnostics.MAX_LOG_BYTES - 19)
        tail = b'last-cause-marker'
        self.log.write_bytes(prefix + tail)
        client = FakeClient()
        result = r2_diagnostics.preserve(self.workspace, client, 'private', '12345', '1')
        body = client.objects[('private', result['key'])][0]
        self.assertEqual(len(body), r2_diagnostics.MAX_LOG_BYTES)
        self.assertTrue(body.endswith(tail))
        self.assertNotIn(b'first-secret-marker', body)
        self.assertEqual(result['originalBytes'], len(prefix + tail))
        self.assertTrue(result['truncated'])

    def test_rejects_path_traversal_and_nested_run_directories(self):
        self.log.write_bytes(b'failure')
        for bad in (self.workspace / 'runs/../outside',
                    self.run / 'nested',
                    Path(self.temporary.name) / 'outside'):
            with self.subTest(bad=str(bad)):
                self.write_journal(bad)
                with self.assertRaises(ValueError):
                    r2_diagnostics.read_compile_failure(self.workspace)

    def test_rejects_symlinked_run_log_and_journal(self):
        self.log.write_bytes(b'failure')
        real = self.log.with_name('real.log')
        self.log.rename(real)
        self.log.symlink_to(real)
        with self.assertRaises(OSError):
            r2_diagnostics.read_compile_failure(self.workspace)
        self.log.unlink()
        self.journal.rename(self.workspace / 'real-journal.json')
        self.journal.symlink_to(self.workspace / 'real-journal.json')
        with self.assertRaises(OSError):
            r2_diagnostics.read_compile_failure(self.workspace)

    def test_rejects_symlinked_run_directory(self):
        self.log.write_bytes(b'failure')
        old = self.run.with_name('real-run')
        self.run.rename(old)
        self.run.symlink_to(old, target_is_directory=True)
        with self.assertRaises(OSError):
            r2_diagnostics.read_compile_failure(self.workspace)

    def test_rejects_symlinked_runs_parent(self):
        self.log.write_bytes(b'failure')
        old = self.workspace / 'real-runs'
        (self.workspace / 'runs').rename(old)
        (self.workspace / 'runs').symlink_to(old, target_is_directory=True)
        with self.assertRaises(OSError):
            r2_diagnostics.read_compile_failure(self.workspace)

    def test_failed_readback_is_never_reported_as_saved(self):
        self.log.write_bytes(b'failure details')
        client = FakeClient()
        client.corrupt_readback = True
        with self.assertRaises(ValueError):
            r2_diagnostics.preserve(self.workspace, client, 'private', '12345', '1')

    def test_invalid_run_ids_are_rejected_before_upload(self):
        self.log.write_bytes(b'failure')
        client = FakeClient()
        for run_id, attempt in (('../other', '1'), ('12345', '../other'),
                                ('0', '1'), ('12345', '0'), ('a123', '1')):
            with self.subTest(run_id=run_id, attempt=attempt), self.assertRaises(ValueError):
                r2_diagnostics.preserve(self.workspace, client, 'private', run_id, attempt)
        self.assertEqual(client.objects, {})

    def test_other_failed_step_has_no_compile_diagnostic(self):
        self.log.write_bytes(b'old contents')
        self.journal.write_text(json.dumps({'status': 'failed', 'failedStep': 'verify-client',
                                            'runDirectory': str(self.run)}))
        self.assertIsNone(r2_diagnostics.read_compile_failure(self.workspace))

    def test_cli_never_prints_exception_message(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch('tools.r2_state.PrivateS3Bucket.from_environment',
                   side_effect=ValueError('PRIVATE_DIAGNOSTIC_DETAIL_SENTINEL')):
            with redirect_stdout(output), redirect_stderr(errors):
                code = r2_diagnostics.main(['--workspace', str(self.workspace),
                                            '--run-id', '12345', '--attempt', '1'])
        self.assertEqual(code, 1)
        self.assertNotIn('PRIVATE_DIAGNOSTIC_DETAIL_SENTINEL', output.getvalue() + errors.getvalue())
        self.assertIn('ValueError', errors.getvalue())


if __name__ == '__main__':
    unittest.main()
