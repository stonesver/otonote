import fcntl
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import tarfile
import unittest

from tools.operations import AuditError
from tools import render_retention as retention


class RenderRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve(); self.root = self.base/'rendered'; self.root.mkdir()
        self.archive = self.base/'archive.tar.gz'
        self.old = self.release(1, 'global'); self.jp = self.release(2, 'jp')
        self.live = self.release(3, 'global'); self.previous = self.release(4, 'global')
        for name, release in [('current', self.live), ('previous', self.previous), ('current-jp', self.jp)]:
            (self.root/name).symlink_to(release.relative_to(self.root))
        self.cutoff = int(time.time()) - 7*86400

    def release(self, number, region):
        pair = ('%024x' % number) + '-' + 'a'*24
        folder = self.root/'releases'/pair
        html = folder/region/'en/index.html'; html.parent.mkdir(parents=True); html.write_text('historical HTML')
        (folder/'complete.json').write_text(json.dumps({'pair': pair, 'codeId': pair[:24], 'region': region}))
        payload = folder/'payloads'/('f'*64+'.json'); payload.parent.mkdir(); payload.write_text('open-tab payload')
        old = time.time() - 8*86400; os.utime(folder, (old, old))
        return folder

    def test_archive_then_retire_preserves_all_public_payloads_and_protected_views(self):
        plan = retention.plan(self.root, self.cutoff)
        self.assertEqual(len(plan['views']), 1)
        result = retention.archive_html(self.root, plan, self.archive)
        self.assertEqual(result['status'], 'archived')
        self.assertTrue((self.old/'global').exists())
        retention.apply(self.root, plan, self.archive)
        self.assertFalse((self.old/'global').exists())
        self.assertTrue((self.old/'complete.json').is_file())
        for folder in (self.old, self.live, self.previous, self.jp):
            self.assertEqual(next((folder/'payloads').iterdir()).read_text(), 'open-tab payload')
        for folder, region in ((self.live, 'global'), (self.previous, 'global'), (self.jp, 'jp')):
            self.assertTrue((folder/region/'en/index.html').is_file())
        self.assertEqual(retention.plan(self.root, self.cutoff)['views'], [])
        retention.verify_archive(self.archive, plan)

    def test_pending_and_young_views_are_protected(self):
        (self.root/'.pending.json').write_text(json.dumps({'serving': str(self.old.relative_to(self.root)),
            'target': str(self.previous.relative_to(self.root))}))
        self.assertEqual(retention.plan(self.root, self.cutoff)['views'], [])
        (self.root/'.pending.json').unlink(); os.utime(self.old, None)
        self.assertEqual(retention.plan(self.root, self.cutoff)['views'], [])

    def test_no_archive_or_corrupt_archive_cannot_remove_html(self):
        plan = retention.plan(self.root, self.cutoff)
        with self.assertRaises(OSError): retention.apply(self.root, plan, self.archive)
        retention.archive_html(self.root, plan, self.archive)
        self.archive.write_bytes(b'bad')
        with self.assertRaises(tarfile.TarError): retention.apply(self.root, plan, self.archive)
        self.assertTrue((self.old/'global/en/index.html').is_file())

    def test_changed_pointer_or_changed_html_requires_new_plan(self):
        for change in ('pointer', 'html'):
            with self.subTest(change=change):
                plan = retention.plan(self.root, self.cutoff)
                if self.archive.exists(): self.archive.unlink()
                retention.archive_html(self.root, plan, self.archive)
                if change == 'pointer':
                    (self.root/'previous-jp').symlink_to(self.old.relative_to(self.root))
                else:
                    (self.old/'global/en/index.html').write_text('changed')
                with self.assertRaisesRegex(AuditError, 'reaudit'): retention.apply(self.root, plan, self.archive)
                self.assertTrue((self.old/'global/en/index.html').exists())
                if change == 'pointer': (self.root/'previous-jp').unlink()

    def test_links_and_unknown_files_fail_closed(self):
        for name in ('secret.json', 'link.html'):
            target = self.old/'global'/name
            if name.endswith('.json'): target.write_text('{}')
            else: target.symlink_to(self.old/'complete.json')
            with self.assertRaises(AuditError): retention.plan(self.root, self.cutoff)
            target.unlink()

    def test_both_publication_locks_are_respected(self):
        for name in ('.render.lock', '.r2-prerender.lock'):
            with (self.root/name).open('a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(AuditError, 'render_in_progress'):
                    retention.plan(self.root, self.cutoff)

    def test_hardlinked_html_is_archived_as_independent_verified_files(self):
        original = self.old/'global/en/index.html'
        os.link(original, self.old/'global/en/another.html')
        plan = retention.plan(self.root, self.cutoff)
        retention.archive_html(self.root, plan, self.archive)
        retention.verify_archive(self.archive, plan)
        retention.apply(self.root, plan, self.archive)
        self.assertFalse((self.old/'global').exists())
