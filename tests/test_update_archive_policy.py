import unittest
from backend.update_archive.policy import decisions
from backend.update_archive.models import ArchiveError, file_record, safe_name


class PolicyTests(unittest.TestCase):
    def test_major_client_unit_does_not_block_small_hot_update(self):
        rows = [{'source': s, 'key': s, 'size': 10, 'needsDownload': True, 'change': 'added'}
                for s in ('client_entry', 'remote_asset', 'master')]
        result = decisions(rows, old_client='1.0.1', new_client='2.0.0')
        self.assertEqual(result[('client_entry', 'client_entry')], 'waiting_manual')
        self.assertEqual(result[('remote_asset', 'remote_asset')], 'pending')

    def test_oversized_unit_is_selectable_but_small_other_source_continues(self):
        rows = [{'source': 'remote_asset', 'key': str(i), 'size': 200 * 1024 ** 2,
                 'needsDownload': True, 'change': 'added'} for i in range(3)]
        rows.append({'source': 'master', 'key': 'master', 'size': 2, 'needsDownload': True, 'change': 'added'})
        result = decisions(rows)
        self.assertEqual(result[('remote_asset', '1')], 'waiting_manual')
        self.assertEqual(result[('master', 'master')], 'pending')

    def test_unsafe_path_and_unknown_size_are_rejected(self):
        for value in ('../x', '/root', 'a//b', 'a/./b', 'a\\b'):
            with self.assertRaises(ArchiveError): safe_name(value)
        with self.assertRaises(ArchiveError):
            file_record({'source': 'master', 'key': 'x', 'size': None})

    def test_record_mode_does_not_erase_major_or_oversize_manual_gate(self):
        rows=[{'source':'client_entry','key':'client','size':4,'needsDownload':True,'change':'added'},
              {'source':'master','key':'small','size':4,'needsDownload':True,'change':'added'}]
        result=decisions(rows,mode='record',old_client='1.0.1',new_client='2.0.0')
        self.assertEqual(result[('client_entry','client')],'waiting_manual')
        self.assertEqual(result[('master','small')],'deferred_auto')
        big=[{'source':'remote_asset','key':str(i),'size':200*1024**2,'needsDownload':True,'change':'added'} for i in range(3)]
        self.assertEqual(set(decisions(big,mode='record').values()),{'waiting_manual'})
