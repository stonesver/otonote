import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.update_archive import ledger
from backend.update_archive.models import ArchiveError, Conflict
from backend.update_archive.store import ArchiveRepository, LocalBucket
from backend.update_archive.worker import run_once


class WriterAdmissionTests(unittest.TestCase):
    def test_other_region_cannot_starve_an_observation_through_repeated_revision_changes(self):
        with tempfile.TemporaryDirectory() as root:
            repo = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            other = ArchiveRepository(LocalBucket(root), clock=lambda: 100)
            repo.migrate()
            class Source:
                region = 'jp'
                def snapshot(self, **kw):
                    return {'region': 'jp', 'sources': ['remote_asset'], 'files': [{
                        'source': 'remote_asset', 'key': 'new-jp', 'size': 3, 'sha256': 'a'*64}],
                        'observation': {'clientVersion': '1.1.0'}}
            original_commit, original_write = repo.ledger.commit, repo.ledger.write_root
            active, races, seen, threads, errors = [False], [0], set(), [], []
            def commit(state, *args):
                active[0] = any(e.get('key') == 'new-jp' for e in state['entries'].values())
                try:
                    return original_commit(state, *args)
                finally:
                    active[0] = False
            def write(value, etag):
                result = original_write(value, etag)
                fresh = {key for key, row in value.get('_storage', {}).get('writers', {}).items() if row['keys']} - seen
                seen.update(fresh)
                if active[0] and fresh and races[0] < 32:
                    races[0] += 1
                    done = threading.Event()
                    def update():
                        try:
                            other.mutate(lambda s: s['modes'].update({'global': 'auto'}))
                        except BaseException as e:
                            errors.append(e)
                        finally:
                            done.set()
                    thread = threading.Thread(target=update)
                    thread.start()
                    threads.append(thread)
                    done.wait(.08)
                return result
            with patch.object(repo.ledger, 'commit', side_effect=commit), \
                    patch.object(repo.ledger, 'write_root', side_effect=write):
                result = run_once(repo, Source(), clock=lambda: 100, mode='record')
            for thread in threads:
                thread.join(10)
            self.assertFalse(any(t.is_alive() for t in threads))
            self.assertFalse(errors)
            self.assertEqual(result['status'], 'recorded')
            self.assertEqual(repo.state()[0]['modes']['global'], 'auto')
            self.assertEqual(len(repo.state()[0]['entries']), 1)

    def test_readers_remain_available_and_other_writer_waits_for_page_publication(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            first = ArchiveRepository(bucket)
            second = ArchiveRepository(bucket)
            first.migrate()
            entered, release, finished, errors = threading.Event(), threading.Event(), threading.Event(), []
            original = bucket.replace
            def replace(key, raw, etag):
                if key.startswith('control/shards/') and not entered.is_set():
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('test uploader was not released')
                return original(key, raw, etag)
            def put(repo, region, done=None):
                try:
                    repo.mutate(lambda s: s['modes'].update({region: 'auto'}))
                except BaseException as e:
                    errors.append(e)
                finally:
                    if done:
                        done.set()
            with patch.object(bucket, 'replace', side_effect=replace):
                a = threading.Thread(target=put, args=(first, 'jp'))
                a.start()
                self.assertTrue(entered.wait(3))
                b = threading.Thread(target=put, args=(second, 'global', finished))
                b.start()
                try:
                    self.assertEqual(second.state()[0]['modes'], {})
                    self.assertFalse(finished.wait(.05))
                finally:
                    release.set()
                    a.join(5)
                    b.join(5)
            self.assertFalse(errors)
            self.assertFalse(a.is_alive() or b.is_alive())
            self.assertEqual(second.state()[0]['modes'], {'jp': 'auto', 'global': 'auto'})

    def test_expired_writer_does_not_block_recovery_and_busy_timeout_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            bucket = LocalBucket(root)
            repo = ArchiveRepository(bucket, clock=lambda: 100)
            repo.migrate()
            raw, etag = bucket.get(ledger.ROOT)
            value = ledger.unpack(raw, 128*1024**2)
            value['_storage']['writers']['abandoned'] = {
                'keys': [], 'until': 101, 'admission': True, 'order': 1}
            repo.ledger.write_root(value, etag)
            with patch.object(ledger, 'WRITER_WAIT_SECONDS', 0):
                with self.assertRaisesRegex(ArchiveError, 'ledger_writer_busy'):
                    repo.mutate(lambda s: s['modes'].update({'jp': 'manual'}))
            self.assertEqual(repo.state()[0]['modes'], {})
            recovered = ArchiveRepository(bucket, clock=lambda: 102)
            recovered.mutate(lambda s: s['modes'].update({'jp': 'auto'}))
            self.assertEqual(recovered.state()[0]['modes'], {'jp': 'auto'})
