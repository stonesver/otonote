import asyncio
import gzip
import tempfile
import unittest
from unittest.mock import patch

from backend.admin.archive import ArchiveAdmission
from backend.update_archive.models import ArchiveError
from backend.update_archive.store import ArchiveRepository, LocalBucket, LEDGER


class ControlTests(unittest.TestCase):
    def test_large_inventory_is_bounded_in_storage_and_survives_cas_updates(self):
        with tempfile.TemporaryDirectory() as folder:
            bucket = LocalBucket(folder)
            repo = ArchiveRepository(bucket)
            # A new client can change every row while retaining the old baseline.
            rows = [{'key': f'asset/{i:05d}/' + 'long-path/' * 15, 'size': 1000,
                     'url': 'https://cdn.example/Android/' + 'asset-directory/' * 15,
                     'sha256': f'{i:064x}'} for i in range(60000)]
            repo.mutate(lambda s: s['baselines'].update({'synthetic': {'files': rows}}))
            raw, _ = bucket.get(LEDGER)
            self.assertTrue(raw.startswith(b'\x1f\x8b'))
            self.assertGreater(len(gzip.decompress(raw)), 24 * 1024 ** 2)
            self.assertLess(len(raw), 24 * 1024 ** 2)
            repo.mutate(lambda s: s['modes'].update({'global': 'manual'}))
            state, _ = repo.state()
            self.assertEqual(state['baselines']['synthetic']['files'][-1], rows[-1])
            self.assertEqual(state['modes']['global'], 'manual')

    def test_decompression_limit_applies_before_json_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            bucket = LocalBucket(folder)
            bucket.replace(LEDGER, gzip.compress(b' ' * 2048), None)
            with patch('backend.update_archive.store.MAX_EXPANDED_CONTROL', 1024):
                with self.assertRaisesRegex(ArchiveError, 'control_too_large'):
                    ArchiveRepository(bucket).state()

    def test_archive_admission_serializes_memory_without_blocking_other_routes(self):
        async def check():
            active = 0
            peak = 0
            other_seen = False
            async def app(scope, receive, send):
                nonlocal active, peak, other_seen
                if scope['path'].startswith('/api/archive/'):
                    active += 1
                    peak = max(peak, active)
                    await asyncio.sleep(.01)
                    active -= 1
                else:
                    other_seen = active > 0
            boundary = ArchiveAdmission(app)
            async def other():
                await asyncio.sleep(.001)
                await boundary({'type': 'http', 'path': '/api/health'}, None, None)
            await asyncio.gather(*(boundary({'type': 'http', 'path': '/api/archive/summary'}, None, None)
                                   for _ in range(4)), other())
            self.assertEqual(peak, 1)
            self.assertTrue(other_seen)
        asyncio.run(check())
