"""Validate reusable full-body images against the exact exported model source."""
import hashlib
import json
from pathlib import Path
import re


def costume_model_key(path):
    """Game naming shared by the stage and dialogue versions of the same outfit."""
    return path.rsplit('/', 1)[-1].removeprefix('adv_').removesuffix('_low')


def matches_costume_model(model, paths):
    return model['modelPath'] in paths or (model.get('usage') == 'story'
        and costume_model_key(model['modelPath']) in {costume_model_key(path) for path in paths})


def read_posters(root):
    root = Path(root)
    if (root / 'manifest.json').is_symlink():
        raise ValueError('unsafe costume poster manifest')
    if not (root / 'manifest.json').is_file():
        return {}
    value = json.loads((root / 'manifest.json').read_text())
    if value.get('schemaVersion') != 1:
        raise ValueError('invalid costume poster manifest')
    rows = {}
    for row in value['posters']:
        identifier = row['groupId']
        if identifier in rows or not isinstance(identifier, int) or identifier <= 0:
            raise ValueError('duplicate or invalid costume poster group')
        if not re.fullmatch(str(identifier) + r'-[a-f0-9]{64}\.webp', row['file']) or row['file'] != f"{identifier}-{row['sha256']}.webp":
            raise ValueError('unsafe costume poster filename')
        path = root / row['file']
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('costume poster integrity mismatch')
        if row['width'] <= 0 or row['height'] <= 0 or not re.fullmatch('[a-f0-9]{64}', row['sourceSha256']):
            raise ValueError('invalid costume poster binding')
        rows[identifier] = row
    return rows


def poster_inputs(source, root):
    binding = source.get('costumePosterInputs')
    if not binding:
        return None
    directory = (Path(root) / binding['root']).resolve()
    if Path(root).resolve() not in directory.parents:
        raise ValueError('costume posters escape input root')
    if hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest() != binding['sha256']:
        raise ValueError('costume poster manifest integrity mismatch')
    rows = read_posters(directory)
    if {p.name for p in directory.iterdir()} != {'manifest.json', *(r['file'] for r in rows.values())}:
        raise ValueError('unlisted costume poster files')
    return directory
