import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.update_archive import ledger
from backend.update_archive.models import ArchiveError, Conflict, canonical
from backend.update_archive.store import ArchiveRepository, LocalBucket, LEDGER


def header(bucket):
    return json.loads(gzip.decompress(bucket.get(LEDGER)[0]))


class ShardTests(unittest.TestCase):
    def test_migration_preserves_legacy_history_and_readers_share_the_same_state(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket)
            repo.mutate(lambda s: s['entries'].update({f'{i:064x}': {'id': f'{i:064x}',
                'key': 'archive/' + 'path/' * 30, 'status': 'waiting_manual', 'objects': []}
                for i in range(100)}))
            before = copy.deepcopy(repo.state()[0])
            with patch.object(ledger, 'TARGET', 4096):
                repo.migrate()
            physical = header(bucket)
            self.assertEqual(physical['schemaVersion'], 3)
            self.assertNotIn('entries', physical)
            self.assertGreater(len(physical['_storage']['maps']['entries']), 1)
            after = ArchiveRepository(bucket).state()[0]
            after.pop('_controlStorageBytes')
            after['revision'] -= 1
            self.assertEqual(after, before)
            # Fresh processes also retain sharding on ordinary writes.
            fresh = ArchiveRepository(bucket)
            fresh.mutate(lambda s: s['modes'].update(jp='record'))
            self.assertEqual(header(bucket)['schemaVersion'], 3)
            self.assertEqual(repo.state()[0]['modes']['jp'], 'record')

    def test_history_can_grow_past_the_monolithic_limit_and_updates_reuse_pages(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket)
            repo.migrate()
            # Scale the former whole-ledger bound down; pages remain bounded.
            with patch('backend.update_archive.store.MAX_EXPANDED_CONTROL', 30000), patch.object(ledger, 'TARGET', 16000):
                repo.mutate(lambda s: s['entries'].update({str(i): {'key': 'file/' * 20, 'status': 'old'}
                                                         for i in range(1000)}))
                first = header(bucket)
                original = repo.state()[0]['entries']
                self.assertGreater(len(canonical(original)), 30000)
                repo.mutate(lambda s: s['entries']['25'].update(status='new'))
                second = header(bucket)
                a = {p['key'] for p in first['_storage']['maps']['entries']}
                b = {p['key'] for p in second['_storage']['maps']['entries']}
                self.assertEqual(len(a - b), 1)
                self.assertEqual(repo.state()[0]['entries']['25']['status'], 'new')
                self.assertEqual(len(ArchiveRepository(bucket).state()[0]['entries']), 1000)

    def test_partial_upload_never_publishes_and_is_accounted_until_recovered(self):
        class Interrupted(LocalBucket):
            stop = False
            def replace(self, key, data, etag):
                if self.stop and key.startswith('control/shards/'):
                    raise OSError('synthetic interrupted upload')
                return super().replace(key, data, etag)
        with tempfile.TemporaryDirectory() as root:
            bucket = Interrupted(root)
            now = [100]
            repo = ArchiveRepository(bucket, clock=lambda: now[0])
            repo.migrate()
            bucket.stop = True
            with self.assertRaises(OSError):
                repo.mutate(lambda s: s['modes'].update(jp='manual'))
            self.assertEqual(repo.state()[0]['modes'], {})
            storage = header(bucket)['_storage']
            self.assertTrue(storage['blobs'])
            self.assertTrue(storage['writers'])
            bucket.stop = False
            repo.mutate(lambda s: s['modes'].update(jp='record'))
            now[0] += ledger.GRACE + ledger.WRITER_LIFETIME
            repo.ledger.collect()
            self.assertEqual(repo.state()[0]['modes']['jp'], 'record')
            active = {p['key'] for pages in header(bucket)['_storage']['maps'].values() for p in pages}
            self.assertEqual(set(header(bucket)['_storage']['blobs']), active)

    def test_corrupt_or_missing_pages_fail_closed_in_fresh_reader(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket)
            repo.migrate()
            repo.mutate(lambda s: s['modes'].update(jp='auto'))
            key = header(bucket)['_storage']['maps']['modes'][0]['key']
            raw, etag = bucket.get(key)
            bucket.replace(key, b'corrupt', etag)
            with self.assertRaisesRegex(ArchiveError, 'ledger_page_digest_mismatch'):
                ArchiveRepository(bucket).state()
            bucket.delete(key)
            with self.assertRaisesRegex(ArchiveError, 'ledger_page_missing'):
                ArchiveRepository(bucket).state()

    def test_concurrent_logical_commit_retries_without_losing_either_region(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            first = ArchiveRepository(bucket)
            second = ArchiveRepository(bucket)
            first.migrate()
            original = first.ledger.write_root
            raced = [False]
            def race(value, etag):
                if not raced[0] and value.get('_storage', {}).get('writers'):
                    raced[0] = True
                    second.mutate(lambda s: s['modes'].update(global_='record'))
                return original(value, etag)
            with patch.object(first.ledger, 'write_root', side_effect=race):
                first.mutate(lambda s: s['modes'].update(jp='auto'))
            self.assertEqual(first.state()[0]['modes'], {'global_': 'record', 'jp': 'auto'})

    def test_delayed_delete_cannot_remove_a_recreated_generation(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            now = [100]
            first = ArchiveRepository(bucket, clock=lambda: now[0])
            first.migrate()
            first.mutate(lambda s: s['modes'].update(jp='old'))
            old = header(bucket)['_storage']['maps']['modes'][0]['key']
            first.mutate(lambda s: s['modes'].update(jp='new'))
            now[0] += ledger.GRACE + 1
            original = bucket.delete
            def recreate(key):
                if key == old:
                    ArchiveRepository(bucket, clock=lambda: now[0]).mutate(lambda s: s['modes'].update(jp='old'))
                return original(key)
            with patch.object(bucket, 'delete', side_effect=recreate):
                first.ledger.collect()
            self.assertEqual(ArchiveRepository(bucket).state()[0]['modes']['jp'], 'old')
            self.assertNotEqual(header(bucket)['_storage']['maps']['modes'][0]['key'], old)

    def test_logical_commit_after_upload_forces_replay_of_the_mutation(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            first = ArchiveRepository(bucket)
            second = ArchiveRepository(bucket)
            first.migrate()
            replace = bucket.replace
            raced = [False]
            def race(key, raw, etag):
                result = replace(key, raw, etag)
                if key.startswith('control/shards/') and not raced[0]:
                    raced[0] = True
                    second.mutate(lambda s: s['modes'].update(global_='auto'))
                return result
            with patch.object(bucket, 'replace', side_effect=race):
                first.mutate(lambda s: s['modes'].update(jp='record'))
            self.assertEqual(first.state()[0]['modes'], {'global_': 'auto', 'jp': 'record'})

    def test_migration_command_backups_can_be_read_without_the_source_store(self):
        from backend.update_archive.migration import migrate
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(Path(root) / 'source'))
            repo.mutate(lambda s: s['modes'].update(jp='auto'))
            migrate(repo, Path(root) / 'legacy-backup')
            self.assertEqual(ArchiveRepository(LocalBucket(Path(root) / 'legacy-backup')).state()[0]['modes'], {'jp': 'auto'})
            migrate(repo, Path(root) / 'sharded-backup')
            self.assertEqual(ArchiveRepository(LocalBucket(Path(root) / 'sharded-backup')).state()[0]['modes'], {'jp': 'auto'})

    def test_local_sync_reads_sharded_history_without_any_cloud_mutation(self):
        from backend.update_archive.local import Library
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(Path(root) / 'source')
            repo = ArchiveRepository(bucket)
            eid = repo.add('jp', 'asset', b'original', observed_at=100, now=100)
            repo.migrate()
            local = Library(Path(root) / 'library')
            with patch.object(bucket, 'replace', side_effect=AssertionError('read-only source')), \
                    patch.object(bucket, 'delete', side_effect=AssertionError('read-only source')):
                result = local.sync(repo)
            self.assertFalse(result['errors'])
            self.assertEqual(result['received'], 1)
            self.assertIn(eid, local.entries())
            self.assertEqual(local.object_path(repo.entry(eid)['sha256']).read_bytes(), b'original')

    def test_readback_failure_keeps_the_old_root_and_registers_pending_bytes(self):
        class Corrupt(LocalBucket):
            broken = False
            def get(self, key):
                item = super().get(key)
                return (b'wrong', item[1]) if self.broken and item and key.startswith('control/shards/') else item
        with tempfile.TemporaryDirectory() as root:
            bucket = Corrupt(root)
            repo = ArchiveRepository(bucket)
            repo.migrate()
            bucket.broken = True
            with self.assertRaisesRegex(ArchiveError, 'ledger_page_readback_failed'):
                repo.mutate(lambda s: s['modes'].update(jp='auto'))
            self.assertTrue(header(bucket)['_storage']['writers'])
            self.assertGreater(sum(v['size'] for v in header(bucket)['_storage']['blobs'].values()), 0)
            self.assertEqual(ArchiveRepository(bucket).state()[0]['modes'], {})

    def test_source_baseline_inventory_is_paged_and_retains_its_exact_order(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket)
            rows = [{'key': str(i), 'path': 'resource/' * 40} for i in range(60)]
            repo.mutate(lambda s: s['baselines'].update({'jp:remote_asset': {'files': rows, 'id': 'source'}}))
            with patch.object(ledger, 'TARGET', 2000), patch.object(ledger, 'MAX_PAGE', 4000):
                repo.migrate()
                self.assertEqual(ArchiveRepository(bucket).state()[0]['baselines']['jp:remote_asset']['files'], rows)
            self.assertGreater(len(header(bucket)['_storage']['maps']['_baselineFiles']), 1)

    def test_retired_and_pending_pages_remain_in_the_capacity_reservation(self):
        from backend.update_archive.models import CONTROL_RESERVE
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket)
            repo.migrate()
            repo.mutate(lambda s: s['modes'].update(jp='old'))
            repo.mutate(lambda s: s['modes'].update(jp='new'))
            storage = header(bucket)['_storage']
            active = {p['key'] for pages in storage['maps'].values() for p in pages}
            self.assertGreater(len(storage['blobs']), len(active))
            with patch.object(ledger, 'MAX_CONTROL', CONTROL_RESERVE):
                self.assertEqual(repo.summary()['controlReservedBytes'],
                                 CONTROL_RESERVE + sum(p['size'] for p in storage['blobs'].values()))

    def test_parallel_regions_share_the_same_data_quota_after_migration(self):
        from concurrent.futures import ThreadPoolExecutor
        from backend.update_archive.models import CONTROL_RESERVE
        with tempfile.TemporaryDirectory() as root:
            ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE+8).migrate()
            def put(i):
                repo = ArchiveRepository(LocalBucket(root), capacity=CONTROL_RESERVE+8)
                try:
                    repo.add('global' if i % 2 else 'jp', str(i), bytes([i])*4,
                             observed_at=100+i, now=100+i)
                except ArchiveError:
                    pass
                return repo.summary()['storedBytes']
            with ThreadPoolExecutor(max_workers=4) as pool:
                self.assertTrue(all(size <= 8 for size in pool.map(put, range(12))))
