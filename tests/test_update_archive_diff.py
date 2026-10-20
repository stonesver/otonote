import unittest
from backend.update_archive.diff import compare


class ArchiveDiffTests(unittest.TestCase):
    def test_only_changed_bytes_need_acquisition_despite_changed_version_directories(self):
        before = [{'key': 'card', 'size': 10, 'hash': 'a', 'hashAlgorithm': 'UnityHash128',
                   'source': 'remote_asset', 'url': 'https://example.com/v1/a'}]
        after = [{**before[0], 'url': 'https://example.com/v2/a'},
                 {'key': 'new', 'source': 'remote_asset', 'size': 4, 'hash': 'b'}]
        changes = compare(after, before)
        self.assertEqual([(r['key'], r['change']) for r in changes],
                         [('card', 'metadata_changed'), ('new', 'added')])
        self.assertFalse(changes[0]['needsDownload'])
        self.assertTrue(changes[1]['needsDownload'])
