import tempfile
import unittest
from pathlib import Path

from backend.update_archive.store import LocalBucket, ArchiveRepository
from backend.update_archive.models import CONTROL_RESERVE


class ArchiveStoreTests(unittest.TestCase):
    def test_both_regions_share_fifo_capacity_and_deleted_content_stays_deleted(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = ArchiveRepository(LocalBucket(Path(folder)), capacity=CONTROL_RESERVE + 7)
            first = repo.add('global', 'old', b'abcd', observed_at=100, now=100)
            repo.add('jp', 'new', b'12345', observed_at=101, now=101)
            self.assertEqual(repo.summary(now=102)['storedBytes'], 5)
            self.assertEqual(repo.entry(first, now=102)['status'], 'evicted_fifo')
            self.assertEqual(repo.entries('jp', now=102)[0]['status'], 'saved')
            repo = ArchiveRepository(LocalBucket(Path(folder)), capacity=CONTROL_RESERVE + 7)
            self.assertEqual(repo.entry(first, now=102)['status'], 'evicted_fifo')
            self.assertEqual(repo.add('global', 'old', b'abcd', observed_at=100, now=103), first)
            self.assertEqual(repo.summary(now=103)['storedBytes'], 5)
