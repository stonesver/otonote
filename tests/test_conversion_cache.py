import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools import conversion_cache as cache
from tools.global_remote_sync import file_hash


class CacheTests(unittest.TestCase):
    def test_image_recipe_binds_encoder_versions(self):
        from tools.build_site_catalog import load_pillow
        load_pillow()
        cache.image_recipe.cache_clear()
        try:
            with patch('PIL.features.version', return_value='encoder-a'):
                first = cache.image_recipe('responsive-v1')
            cache.image_recipe.cache_clear()
            with patch('PIL.features.version', return_value='encoder-b'):
                self.assertNotEqual(cache.image_recipe('responsive-v1'), first)
        finally:
            cache.image_recipe.cache_clear()

    def test_content_reuse_recipe_changes_and_corruption(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'OURNOTES_CONVERSION_CACHE': folder + '/cache'}):
            source, target = Path(folder) / 'source', Path(folder) / 'target'
            source.write_bytes(b'converted media')
            sha = 'a' * 64
            cache.save(sha, 'recipe-1', source)
            self.assertTrue(cache.restore(sha, 'recipe-1', target))
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertFalse(cache.restore(sha, 'recipe-2', target))
            self.assertFalse(cache.restore('b' * 64, 'recipe-1', target))
            (cache.directory(sha, 'recipe-1') / 'content').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
                cache.restore(sha, 'recipe-1', target)
