import concurrent.futures
import tempfile
import unittest
from pathlib import Path
from backend.update_archive.models import ArchiveError, CONTROL_RESERVE, WINDOW
from backend.update_archive.store import ArchiveRepository, LocalBucket


class RetentionTests(unittest.TestCase):
    def test_read_lease_protects_physical_bytes_until_reader_finishes(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE + 6)
            eid = repo.add('global', 'a', b'1234', now=100, observed_at=100)
            with repo.reading(eid, now=101):
                with self.assertRaisesRegex(ArchiveError, 'capacity_deferred'):
                    repo.add('jp', 'b', b'5678', now=102, observed_at=102)
                self.assertEqual(repo.content(eid, now=103), b'1234')
            repo.add('jp', 'b', b'5678', now=104, observed_at=102)
            self.assertEqual(repo.entry(eid, now=104)['status'], 'evicted_fifo')

    def test_age_never_reclaims_original_or_history(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root))
            eid = repo.add('global', 'a', b'abc', now=100, observed_at=100)
            repo.mutate(lambda s: s['baselines'].update({'global:remote_asset': {'id': 'baseline'}}))
            self.assertEqual(repo.content(eid, now=100 + 1000 * WINDOW), b'abc')
            repo.expire(now=100 + WINDOW)
            repo.compact(now=100 + 1000 * WINDOW)
            self.assertEqual(repo.summary()['storedBytes'], 3)
            self.assertEqual(repo.entry(eid)['status'], 'saved')
            self.assertEqual(repo.state()[0]['baselines']['global:remote_asset']['id'], 'baseline')

    def test_parallel_regions_never_exceed_common_capacity(self):
        with tempfile.TemporaryDirectory() as root:
            def put(i):
                repo = ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE + 8)
                try:
                    repo.add('global' if i % 2 else 'jp', str(i), bytes([i]) * 4,
                             observed_at=100 + i, now=100 + i)
                except ArchiveError:
                    pass  # Capacity contention is a deferred operation, not an overdraw.
                return repo.summary(now=130)['storedBytes']
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                totals = list(pool.map(put, range(12)))
            self.assertTrue(all(n <= 8 for n in totals))

    def test_unconfirmed_delete_is_still_charged(self):
        class FailingDelete(LocalBucket):
            def delete(self, key):
                raise ArchiveError('delete_failed')
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(FailingDelete(root), capacity=CONTROL_RESERVE + 7)
            repo.add('global', 'a', b'abcd', now=100, observed_at=100)
            with self.assertRaisesRegex(ArchiveError, 'delete_failed'):
                repo.add('jp', 'b', b'12345', now=101, observed_at=101)
            self.assertEqual(repo.summary(now=102)['storedBytes'], 4)
            # Recovery must resume the deletion rather than leave permanent charged orphans.
            repo = ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE + 7)
            repo.recover(now=103)
            self.assertEqual(repo.summary(now=103)['storedBytes'], 0)

    def test_cleanup_during_upload_waits_for_uploader_quiescence(self):
        class LateUpload(LocalBucket):
            def put_file(bucket, key, path):
                repo.remove([eid], reason='cleaned_manual', now=101)
                super(LateUpload, bucket).put_file(key, path)
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LateUpload(root), capacity=CONTROL_RESERVE + 7)
            eid = 'a' * 64
            repo.register({'id': eid, 'region': 'global', 'key': 'late', 'size': 4,
                           'observedAt': 100, 'expiresAt': 100 + WINDOW,
                           'status': 'pending', 'objects': [], 'attempts': 0})
            path = Path(root) / 'input'; path.write_bytes(b'late')
            with self.assertRaises(ArchiveError):
                repo.save(eid, path, now=100)
            self.assertEqual(repo.summary(now=102)['storedBytes'], 4)
            repo.recover(now=102)
            self.assertEqual(repo.summary(now=102)['storedBytes'], 4)
            repo.recover(now=2021)
            self.assertEqual(repo.summary(now=2021)['storedBytes'], 0)
            self.assertFalse(list((Path(root) / 'global/objects').glob('*')))

    def test_shared_reference_is_counted_once_and_preview_does_not_evict_raw(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE + 5)
            a = repo.add('global', 'a', b'1234', observed_at=100, now=100)
            b = repo.add('global', 'b', b'1234', observed_at=101, now=101)
            self.assertEqual(repo.summary(now=102)['storedBytes'],4)
            repo.remove([a], reason='cleaned_manual', now=102)
            self.assertEqual(repo.summary(now=102)['storedBytes'],4)
            preview=Path(root)/'preview';preview.write_bytes(b'xyz')
            with self.assertRaisesRegex(ArchiveError,'capacity_deferred'):
                repo.save(b,preview,now=103,role='preview_'+'c'*16,evict=False)
            self.assertEqual(repo.entry(b,now=103)['status'],'saved')

    def test_upload_readback_failure_remains_charged_until_safe_recovery(self):
        class Interrupted(LocalBucket):
            broken=True
            def open(bucket,key):
                if bucket.broken:raise ArchiveError('synthetic_interrupted_readback')
                return super(Interrupted,bucket).open(key)
        with tempfile.TemporaryDirectory() as root:
            bucket=Interrupted(root);repo=ArchiveRepository(bucket)
            with self.assertRaises(ArchiveError):repo.add('global','a',b'data',observed_at=100,now=100)
            self.assertEqual(repo.summary(now=101)['storedBytes'],4)
            bucket.broken=False;repo.recover(now=2021)
            eid=repo.entries('global',now=2021)[0]['id']
            self.assertEqual(repo.content(eid,now=2021),b'data')
            key=repo.entry(eid,now=2021)['objectKey']
            self.assertEqual(repo.state()[0]['objects'][key]['signature'],bucket.signature(key))
