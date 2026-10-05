"""Bound image conversion concurrency without changing catalog ordering."""
from concurrent.futures import ThreadPoolExecutor
import os


def map_images(operation, values):
    workers = int(os.environ.get('OURNOTES_MEDIA_WORKERS', min(4, os.cpu_count() or 1)))
    if not 1 <= workers <= 8:
        raise ValueError('OURNOTES_MEDIA_WORKERS must be between 1 and 8')
    if workers == 1:
        return list(map(operation, values))
    # Pillow releases the GIL in libwebp. Each task owns its image and output
    # paths; map retains input order for deterministic catalog serialization.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(operation, values))
