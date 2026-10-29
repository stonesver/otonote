"""Small reviewed game badges travel with immutable Arena content, never code."""
import base64
import hashlib
from pathlib import Path


def validate_rank_icons(records):
    if not isinstance(records, list) or len(records) > 7:
        raise ValueError('invalid_arena_rank_icons')
    seen = set()
    for row in records:
        if (not isinstance(row, dict) or set(row) != {'tier', 'image', 'sha256'}
                or type(row['tier']) is not int or not 1 <= row['tier'] <= 7 or row['tier'] in seen
                or not isinstance(row['image'], str) or not row['image'].startswith('data:image/webp;base64,')
                or len(row['image']) > 90_000):
            raise ValueError('invalid_arena_rank_icon')
        raw = base64.b64decode(row['image'].split(',', 1)[1], validate=True)
        if len(raw) > 65536 or raw[:4] != b'RIFF' or raw[8:12] != b'WEBP' or hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise ValueError('invalid_arena_rank_icon_bytes')
        seen.add(row['tier'])


def project_rank_icons(root, review):
    records = []
    root = Path(root).resolve()
    for spec in review:
        path = (root / spec['path']).resolve()
        if root not in path.parents or path.stat().st_size > 65536:
            raise ValueError('invalid_arena_rank_icon_path')
        raw = path.read_bytes()
        records.append(dict(tier=spec['tier'], sha256=spec['sha256'], image='data:image/webp;base64,' + base64.b64encode(raw).decode()))
    validate_rank_icons(records)
    return records
