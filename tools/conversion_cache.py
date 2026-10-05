"""Digest-checked reusable conversion outputs; recipes change on encoder changes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import errno
from functools import lru_cache

from tools.global_remote_sync import file_hash, read_json, write_json


@lru_cache(maxsize=None)
def image_recipe(recipe):
    """Do not reuse an encoding made by a different Pillow/libwebp build."""
    from PIL import __version__, features
    return f'{recipe}-pillow{__version__}-webp{features.version("webp")}'


def directory(source_sha, recipe):
    root = Path(os.environ.get('OURNOTES_CONVERSION_CACHE', str(Path(__file__).resolve().parents[1] / 'output/global-update-workflow/conversions')))
    key = hashlib.sha256((recipe + ':' + source_sha).encode()).hexdigest()
    return root / key[:2] / key


def restore(source_sha, recipe, target):
    root = directory(source_sha, recipe)
    if not (root / 'receipt.json').exists(): return False
    record = read_json(root / 'receipt.json')
    blob = root / 'content'
    if record['sourceSha256'] != source_sha or record['recipe'] != recipe or not blob.is_file() or file_hash(blob) != record['sha256']:
        raise ValueError('conversion cache integrity mismatch')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(blob, target)
    return True


def save(source_sha, recipe, source):
    root = directory(source_sha, recipe)
    if (root / 'receipt.json').exists(): return
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.conversion-', dir=root.parent) as folder:
        stage = Path(folder) / 'entry'; stage.mkdir()
        shutil.copyfile(source, stage / 'content')
        write_json(stage / 'receipt.json', {'sourceSha256': source_sha, 'recipe': recipe, 'sha256': file_hash(stage / 'content')})
        try:
            stage.rename(root)
        except OSError as exc:
            # Identical source images can be converted concurrently. The first
            # completed entry wins only when its bytes match this conversion.
            if exc.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            existing = read_json(root / 'receipt.json')
            expected = read_json(stage / 'receipt.json')
            if existing != expected or file_hash(root / 'content') != expected['sha256']:
                raise ValueError('conversion cache concurrent output mismatch') from exc
