import copy
import unittest

from backend.update_archive.history import upgrade


class HistoryTests(unittest.TestCase):
    def test_existing_version_links_replace_redundant_previous_copies(self):
        old = {'source': 'master', 'key': 'table', 'size': 3, 'sha256': 'a' * 64}
        entries = {
            'old': {'id': 'old', 'file': old},
            'new': {'id': 'new', 'previousEntryId': 'old',
                    'file': {**old, 'sha256': 'b' * 64, 'previous': copy.deepcopy(old)}},
            'unlinked': {'id': 'unlinked', 'previousEntryId': None,
                         'file': {**old, 'previous': copy.deepcopy(old)}},
            'different': {'id': 'different', 'previousEntryId': 'old',
                          'file': {**old, 'previous': {**old, 'url': 'https://example.com/old'}}},
        }
        state = {'schemaVersion': 2, 'entries': entries, 'objects': {}}
        upgrade(state)
        self.assertNotIn('previous', entries['new']['file'])
        self.assertEqual(entries['old']['file'], old)
        self.assertEqual(entries['unlinked']['file']['previous'], old)
        self.assertIn('previous', entries['different']['file'])
        self.assertEqual(entries['new']['previousEntryId'], 'old')
        again = copy.deepcopy(state)
        upgrade(state)
        self.assertEqual(state, again)
