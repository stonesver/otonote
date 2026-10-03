"""Master resource bindings survive localization and missing image exports."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from tools.gallery import project_gallery
from tools.gallery_sources import TABLES, asset_reference

class GalleryIdentityTests(unittest.TestCase):
    def test_projection_retains_verified_master_resource_for_each_domain(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); master = root / 'master'; images = root / 'images'
            master.mkdir(); images.mkdir()
            row = {'_id': 1, '_imageAsset': 'comic_fixture', '_stampAsset': 'Image/Stamp/one',
                   '_imagePath': 'Image/Degree/one', '_assetPath': 'Image/Background/one',
                   '_nameTextId': 1, '_characterIds': [1]}
            hashes = {}
            for table in TABLES.values():
                path = master / (table + '.json'); path.write_text(json.dumps({'_allData': [row]}))
                hashes[table] = hashlib.sha256(path.read_bytes()).hexdigest()
            for table, rows in [('MasterText', []), ('MasterCharacter', [{'_id': 1, '_nameTextID': 1, '_bandID': 1}]), ('MasterBand', [{'_id': 1, '_nameTextID': 1}])]:
                (master / (table + '.json')).write_text(json.dumps({'_allData': rows}))
            assets = [{'kind': kind, 'id': 1, 'asset': asset_reference(kind, row), 'status': 'missing', 'reason': 'not_in_resource_catalog'} for kind in TABLES]
            (images / 'manifest.json').write_text(json.dumps({'schemaVersion': 2, 'resourceVersion': 'fixture', 'masterSha256': hashes, 'assets': assets}))
            for locale in ['zh-CN', 'en']:
                result = project_gallery(master, 'fixture', locale, images)
                for kind in TABLES:
                    self.assertEqual(result[kind][0]['sourceResource'], asset_reference(kind, row))
                    self.assertIsNone(result[kind][0]['image'])
