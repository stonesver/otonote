import tempfile
import unittest
from pathlib import Path

from backend.update_archive.store import LocalBucket, ArchiveRepository
from backend.update_archive.models import CONTROL_RESERVE


class ArchiveStoreTests(unittest.TestCase):
    def test_preview_capacity_never_evicts_original_and_cleanup_wins_publication(self):
        from unittest.mock import patch
        from backend.update_archive.models import ArchiveError
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);repo=ArchiveRepository(LocalBucket(root/'store'),capacity=CONTROL_RESERVE+7,clock=lambda:100)
            eid=repo.add('global','a.bundle',b'raw',observed_at=100,now=100)
            text=root/'text';text.write_bytes(b'hello')
            rows=[{'role':'preview_'+'a'*16,'path':text,'mime':'text/plain'}]
            with self.assertRaisesRegex(ArchiveError,'capacity'):repo.save_previews(eid,rows,now=100)
            self.assertEqual(repo.content(eid,now=100),b'raw')
            self.assertEqual(len(repo.state()[0]['objects']),1)
            repo=ArchiveRepository(LocalBucket(root/'race'),capacity=CONTROL_RESERVE+100,clock=lambda:100)
            eid=repo.add('global','a.bundle',b'raw',observed_at=100,now=100)
            put=repo.bucket.put_file
            def interrupted(key,path):
                repo.remove([eid],reason='cleaned_manual',now=101)
                return put(key,path)
            with patch.object(repo.bucket,'put_file',side_effect=interrupted):
                with self.assertRaisesRegex(ArchiveError,'entry_changed'):repo.save_previews(eid,rows,now=100)
            self.assertEqual(repo.entry(eid,now=102)['status'],'cleaned_manual')
            self.assertNotIn('previews',repo.entry(eid,now=102))
            # A late upload remains counted until the existing recovery grace.
            self.assertEqual(repo.used(repo.state()[0]),5)
            repo.recover(now=2021)
            self.assertEqual(repo.used(repo.state()[0]),0)

    def test_preview_batch_shares_objects_without_replacing_originals(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);repo=ArchiveRepository(LocalBucket(root/'store'),clock=lambda:100)
            a=repo.add('global','a.bundle',b'a',observed_at=100,now=100)
            b=repo.add('global','b.bundle',b'b',observed_at=100,now=100)
            context=root/'metadata';context.write_bytes(b'shared')
            text=root/'text';text.write_bytes(b'hello')
            rows=[{'role':'context_metadata','path':context},
                  {'role':'preview_'+'a'*16,'path':text,'mime':'text/plain','name':'script'}]
            repo.save_previews(a,rows,now=100,version=2)
            repo.save_previews(b,rows,now=100,version=2)
            self.assertEqual(repo.content(a,now=100),b'a')
            self.assertEqual(repo.content(b,now=100),b'b')
            state,_=repo.state()
            self.assertEqual(repo.used(state),13)
            self.assertEqual(repo.entry(a,now=100)['previewVersion'],2)
            key=repo.entry(a,now=100)['previews']['context_metadata']['key']
            self.assertEqual(set(state['objects'][key]['refs']),{a,b})

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
