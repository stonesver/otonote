import hashlib
import tempfile
import unittest
from pathlib import Path
from backend.update_archive.store import ArchiveRepository, LocalBucket
from backend.update_archive.worker import run_once


class Source:
    region = 'global'
    def __init__(self):
        self.files = []
        self.fetched = []
    def snapshot(self, previous=None):
        return {'region': self.region, 'observation': {'clientVersion': '1.0.1'},
                'files': self.files, 'sources': ['remote_asset']}
    def fetch(self, record, target):
        self.fetched.append(record['key'])
        target.write_bytes(record['key'].encode())


class WorkerTests(unittest.TestCase):
    def test_version_history_does_not_duplicate_previous_file_records(self):
        from backend.update_archive.worker import observe
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source()
            for version in range(3):
                source.files = [{'source': 'remote_asset', 'key': 'asset', 'size': 3,
                                 'sha256': str(version) * 64}]
                observe(repo, source.snapshot(), now=100 + version, mode='record')
            entries = sorted(repo.state()[0]['entries'].values(), key=lambda e: e['observedAt'])
            self.assertEqual(len(entries), 3)
            self.assertEqual(entries[1]['previousEntryId'], entries[0]['id'])
            self.assertEqual(entries[2]['previousEntryId'], entries[1]['id'])
            self.assertTrue(all('previous' not in e['file'] for e in entries))

    def test_control_limit_failure_is_visible_without_exposing_source_errors(self):
        from backend.update_archive.models import ArchiveError
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            for error, expected in ((ArchiveError('control_too_large'), 'control_too_large'),
                                    (OSError('private source URL'), 'archive_run_failed')):
                with patch.object(Source, 'snapshot', side_effect=error):
                    result = run_once(repo, Source(), clock=lambda: 100)
                self.assertEqual(result['error'], expected)
                self.assertEqual(result['failureStage'], 'snapshot')
                self.assertNotIn('private', str(result))

    def test_busy_claim_reports_safe_reason_without_releasing_someone_elses_run(self):
        from backend.update_archive.models import ArchiveError
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            with patch.object(repo, 'mutate', side_effect=ArchiveError('ledger_writer_busy')) as write, \
                    patch.object(repo, 'compact') as compact:
                result = run_once(repo, Source(), clock=lambda: 100)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error'], 'ledger_writer_busy')
            self.assertEqual(result['failureStage'], 'claim')
            self.assertEqual(write.call_count, 1)
            compact.assert_not_called()

    def test_exhausted_observation_conflicts_are_not_hidden_as_source_failure(self):
        from backend.update_archive.models import Conflict
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            with patch('backend.update_archive.worker.observe', side_effect=Conflict('archive_busy')):
                result = run_once(repo, Source(), clock=lambda: 100)
            self.assertEqual(result['error'], 'archive_busy')
            self.assertEqual(result['failureStage'], 'observe')

    def test_manual_baseline_does_not_read_the_ledger_once_per_entry(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source()
            source.files = [{'source': 'remote_asset', 'key': f'baseline-{i}',
                             'size': 3} for i in range(200)]
            run_once(repo, source, clock=lambda: 100)
            with patch.object(repo.bucket, 'get', wraps=repo.bucket.get) as reads:
                result = run_once(repo, source, clock=lambda: 101)
            self.assertEqual(result['status'], 'unchanged')
            self.assertEqual(source.fetched, [])
            self.assertLess(reads.call_count, 50)

    def test_preview_only_backfills_without_source_detection_download_or_queued_cleanup(self):
        from backend.update_archive.requests import cleanup_plan, confirm_cleanup
        with tempfile.TemporaryDirectory() as root:
            repo=ArchiveRepository(LocalBucket(root),clock=lambda:100)
            source=Source();run_once(repo,source,clock=lambda:100)
            source.files=[{'source':'remote_asset','key':'note.txt','size':8,
                           'sha256':hashlib.sha256(b'note.txt').hexdigest()}]
            run_once(repo,source,clock=lambda:101)
            e=repo.entries('global',now=102)[0]
            plan=cleanup_plan(repo,[e['id']],actor='owner',now=102)
            confirm_cleanup(repo,plan['id'],plan['digest'],actor='owner',now=102)
            before=repo.state()[0]['baselines']
            source.prepare=lambda:None
            source.snapshot=lambda **kw:(_ for _ in ()).throw(AssertionError('no source detection'))
            source.fetch=lambda *a:(_ for _ in ()).throw(AssertionError('no original download'))
            def preview(r,entry,**kw):
                p=Path(root)/'preview.txt';p.write_bytes(b'view')
                r.save_previews(entry['id'],[{'role':'preview_'+'a'*16,'path':p,'mime':'text/plain','name':'text'}],now=103)
            result=run_once(repo,source,clock=lambda:103,previewer=preview,previews_only=True)
            self.assertEqual(result['previewed'],1)
            self.assertEqual(repo.state()[0]['baselines'],before)
            self.assertEqual(repo.state()[0]['cleanup'][plan['id']]['status'],'queued')
            self.assertEqual(repo.content(e['id'],now=103),b'note.txt')

    def test_new_content_is_saved_without_admin_and_unchanged_is_cheap(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source()
            run_once(repo, source, clock=lambda: 100)
            source.files = [{'source': 'remote_asset', 'key': 'new', 'size': 3,
                             'sha256': hashlib.sha256(b'new').hexdigest()}]
            result = run_once(repo, source, clock=lambda: 101)
            self.assertEqual(result['saved'], 1)
            self.assertEqual(repo.content(repo.entries('global', now=102)[0]['id'], now=102), b'new')
            self.assertEqual(run_once(repo, source, clock=lambda: 102)['status'], 'unchanged')
            self.assertEqual(source.fetched, ['new'])

    def test_record_mode_preserves_backlog_then_auto_resumes_without_rebaseline(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source()
            run_once(repo, source, clock=lambda: 100)
            source.files = [{'source': 'remote_asset', 'key': 'new', 'size': 3,
                             'sha256': hashlib.sha256(b'new').hexdigest()}]
            run_once(repo, source, clock=lambda: 101, mode='record')
            self.assertEqual(source.fetched, [])
            result = run_once(repo, source, clock=lambda: 102)
            self.assertEqual(result['saved'], 1)

    def test_cleaned_files_need_explicit_request_and_have_no_expiry(self):
        from backend.update_archive.requests import queue_save
        from backend.update_archive.models import WINDOW
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source(); run_once(repo, source, clock=lambda: 100)
            source.files = [{'source': 'remote_asset', 'key': 'new', 'size': 3,
                             'sha256': hashlib.sha256(b'new').hexdigest()}]
            run_once(repo, source, clock=lambda: 101)
            e = repo.entries('global', now=102)[0]
            repo.remove([e['id']], reason='cleaned_manual', now=102)
            run_once(repo, source, clock=lambda: 103)
            self.assertEqual(len(source.fetched), 1)
            queue_save(repo, [e['id']], actor='owner', key='restore', now=104, max_bytes=6)
            run_once(repo, source, clock=lambda: 105)
            current = repo.entry(e['id'], now=105)
            self.assertEqual(current['status'], 'saved')
            self.assertNotIn('expiresAt', current)
            self.assertEqual(current['firstArchivedAt'], 101)
            self.assertEqual(current['storedAt'], 105)

    def test_failure_cannot_write_production_keys_or_abort_another_region(self):
        class Broken(Source):
            def snapshot(self, previous=None):
                raise ValueError('synthetic failure')
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            self.assertEqual(run_once(repo, Broken(), clock=lambda: 100)['status'], 'failed')
            jp = Source(); jp.region = 'jp'
            self.assertEqual(run_once(repo, jp, clock=lambda: 101)['status'], 'unchanged')
            from backend.update_archive.models import ArchiveError
            for key in ('state/global/current.json', 'content/operations/global/latest.json'):
                with self.assertRaises(ArchiveError):
                    repo.bucket.replace(key, b'bad', None)

    def test_transient_download_is_retried_once_inside_the_same_budget(self):
        class Retry(Source):
            count=0
            def fetch(self,record,target):
                self.count+=1
                if self.count==1:raise OSError('synthetic timeout')
                super().fetch(record,target)
        with tempfile.TemporaryDirectory() as root:
            repo=ArchiveRepository(LocalBucket(root),clock=lambda:100)
            source=Retry();run_once(repo,source,clock=lambda:100)
            source.files=[{'source':'remote_asset','key':'new','size':3,'sha256':hashlib.sha256(b'new').hexdigest()}]
            result=run_once(repo,source,clock=lambda:101)
            self.assertEqual(result['saved'],1)
            self.assertEqual(source.count,2)
            self.assertEqual(result['budgetBytes'],12)

    def test_cleanup_failure_does_not_suppress_new_observation(self):
        from backend.update_archive.models import ArchiveError
        class BadDelete(LocalBucket):
            def delete(self,key):raise ArchiveError('synthetic_delete_failed')
        with tempfile.TemporaryDirectory() as root:
            repo=ArchiveRepository(BadDelete(root),clock=lambda:100)
            source=Source();run_once(repo,source,clock=lambda:100)
            old=repo.add('jp','old',b'old',observed_at=1,now=1)
            from backend.update_archive.requests import cleanup_plan, confirm_cleanup
            plan = cleanup_plan(repo, [old], actor='owner', now=2)
            confirm_cleanup(repo, plan['id'], plan['digest'], actor='owner', now=2)
            from backend.update_archive.models import WINDOW
            source.files=[{'source':'remote_asset','key':'new','size':3,'sha256':hashlib.sha256(b'new').hexdigest()}]
            result=run_once(repo,source,clock=lambda:WINDOW+2)
            self.assertEqual(result['saved'],1)
            self.assertTrue(result['maintenanceErrors'])
            self.assertEqual(repo.state()[0]['baselines']['global:remote_asset']['files'][0]['key'],'new')
