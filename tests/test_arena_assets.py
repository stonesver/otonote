import base64
import hashlib
import tempfile
import unittest
from pathlib import Path
from tools.arena_assets import project_rank_icons, validate_rank_icons

class ArenaAssetTests(unittest.TestCase):
    def test_reviewed_bytes_hash_and_contained_path(self):
        raw=b'RIFF'+b'\x08\0\0\0'+b'WEBP'
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'rank.webp').write_bytes(raw)
            spec=dict(tier=1,path='rank.webp',sha256=hashlib.sha256(raw).hexdigest())
            result=project_rank_icons(root,[spec]);validate_rank_icons(result)
            self.assertEqual(base64.b64decode(result[0]['image'].split(',')[1]),raw)
            for change in ({'path':'../rank.webp'},{'sha256':'a'*64},{'tier':True}):
                with self.assertRaises((ValueError,OSError)):project_rank_icons(root,[{**spec,**change}])
            with self.assertRaises(ValueError):project_rank_icons(root,[spec,spec])
            with self.assertRaises(ValueError):validate_rank_icons([{**result[0],'image':'javascript:bad'}])
            with self.assertRaises(ValueError):validate_rank_icons([{**result[0],'private':'discard'}])
