import hashlib
import tempfile
import unittest
from backend.update_archive.store import ArchiveRepository, LocalBucket
from backend.update_archive.requests import cleanup_plan, confirm_cleanup, process_cleanups, queue_save
from backend.update_archive.worker import run_once
from tests.test_update_archive_worker import Source


class RequestTests(unittest.TestCase):
    def test_cleanup_waits_for_confirmation_and_never_autorefills(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            eid = repo.add('global', 'a', b'abc', now=100, observed_at=100)
            p = cleanup_plan(repo, [eid], actor='owner', now=101)
            process_cleanups(repo, now=102)
            self.assertEqual(repo.content(eid, now=102), b'abc')
            confirm_cleanup(repo, p['id'], p['digest'], actor='owner', now=103)
            process_cleanups(repo, now=104)
            self.assertEqual(repo.entry(eid, now=104)['status'], 'cleaned_manual')
            self.assertEqual(repo.state()[0]['cleanup'][p['id']]['releasedBytes'], 3)
            repo.add('global', 'a', b'abc', now=105, observed_at=100)
            self.assertEqual(repo.summary(now=105)['storedBytes'], 0)

    def test_manual_budget_is_shared_by_all_selected_files(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            source = Source()
            run_once(repo, source, clock=lambda: 100, mode='manual')
            source.files = [{'source': 'remote_asset', 'key': key, 'size': 3,
                             'sha256': hashlib.sha256(key.encode()).hexdigest()} for key in ('one', 'two')]
            run_once(repo, source, clock=lambda: 101, mode='manual')
            ids = [e['id'] for e in repo.entries('global', now=102)]
            queue_save(repo, ids, actor='owner', key='choice', now=102, max_bytes=8)
            run_once(repo, source, clock=lambda: 103, mode='manual')
            self.assertEqual(len(source.fetched), 1)
