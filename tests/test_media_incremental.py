"""Changed media builds reuse only matching verified encodings."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.build_site_catalog import write_media, load_pillow
from tools.media_derivatives import generate_image_derivatives
from tools.media_parallel import map_images


class IncrementalMediaTests(unittest.TestCase):
    def test_changed_source_parallel_build_matches_clean_serial_bytes(self):
        Image = load_pillow()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = [root / f'source-{i}.png' for i in range(3)]
            for i, path in enumerate(sources):
                # Two identical inputs exercise simultaneous cache insertion.
                Image.new('RGB', (400, 240), (10 if i < 2 else 90, 20, 30)).save(path)

            def compile(name, cache, workers):
                public = root / name
                with patch.dict(os.environ, {'OURNOTES_CONVERSION_CACHE': str(root / cache),
                                              'OURNOTES_MEDIA_WORKERS': str(workers)}):
                    def make(item):
                        i, source = item
                        write_media({'source_file': str(source)}, f'asset-{i}', public / 'media', False)
                        return {'id': f'asset-{i}', 'originalUrl': f'/media/originals/asset-{i}.png'}
                    assets = map_images(make, enumerate(sources))
                    index = generate_image_derivatives({'assets': assets}, public)
                hashes = {str(path.relative_to(public)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in public.rglob('*') if path.is_file()}
                return index, hashes

            first = compile('first', 'retained-cache', 4)
            # A fresh candidate directory models the next ephemeral runner.
            with patch.object(Image.Image, 'save', side_effect=AssertionError('unchanged image reencoded')):
                self.assertEqual(compile('warm', 'retained-cache', 4), first)
            # Replace instead of mutating an inode that an old candidate owns.
            changed = root / 'changed.png'
            Image.new('RGB', (400, 240), (90, 80, 30)).save(changed)
            changed.replace(sources[2])
            incremental = compile('incremental', 'retained-cache', 4)
            self.assertNotEqual(incremental, first)
            self.assertEqual(incremental, compile('clean', 'new-cache', 1))
            for name, old_sha in first[1].items():
                if 'asset-2' not in name:
                    self.assertEqual(old_sha, incremental[1][name])

    def test_worker_bound_and_order(self):
        with patch.dict(os.environ, {'OURNOTES_MEDIA_WORKERS': '3'}):
            self.assertEqual(map_images(lambda x: x * 2, range(10)), list(range(0, 20, 2)))
        with patch.dict(os.environ, {'OURNOTES_MEDIA_WORKERS': '99'}):
            with self.assertRaisesRegex(ValueError, 'between 1 and 8'):
                map_images(str, range(3))
