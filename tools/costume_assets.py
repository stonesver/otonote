"""Export the exact Sprite rectangle for each wearable costume icon."""
from __future__ import annotations

import hashlib
import io

from tools.costume_catalog import table, unique
from tools.global_remote_sync import file_hash, write_json


def extract_costume_icons(resources, output):
    output.mkdir(parents=True, exist_ok=True)
    source = resources.master / 'MasterCharacterCostumeGroup.json'
    groups = unique(table(resources.master, 'MasterCharacterCostumeGroup'), '_id', 'costume group')
    records = []
    for identifier, group in sorted(groups.items()):
        if not group['_isChangeable']:
            continue
        reference = group.get('_iconPath') or ''
        record = {'groupId': identifier, 'imagePath': reference, 'state': 'unavailable'}
        locations = [loc for loc in resources.by_key.get(reference, []) if loc.resource_type == 'UnityEngine.Sprite']
        if not locations:
            record['reason'] = 'sprite_not_in_catalog'
        else:
            if len(locations) != 1:
                raise ValueError('ambiguous costume sprite location')
            location = locations[0]
            bundles = [name for name in location.dependencies if name.endswith('.bundle')]
            if len(bundles) != 1:
                raise ValueError('ambiguous costume sprite bundle')
            environment = resources.environment(bundles[0])
            matches = [obj for path, obj in environment.container.items()
                       if path == location.internal_id and obj.type.name == 'Sprite']
            if len(matches) != 1:
                raise ValueError('missing unique costume Sprite object')
            try:
                # UnityPy Sprite.image applies the sprite rect/atlas rotation;
                # Texture2D.image would incorrectly publish the entire atlas.
                image = matches[0].read().image.convert('RGBA')
            except NotImplementedError:
                record['reason'] = 'unsupported_sprite'
            else:
                data = io.BytesIO()
                image.save(data, 'WEBP', lossless=True)
                sha = hashlib.sha256(data.getvalue()).hexdigest()
                filename = f'{identifier}-{sha}.webp'
                (output / filename).write_bytes(data.getvalue())
                record.update(state='available', file=filename, sha256=sha,
                              width=image.width, height=image.height)
        records.append(record)
    write_json(output / 'manifest.json', {'schemaVersion': 1,
               'masterSha256': file_hash(source) if source.is_file() else None,
               'catalogSha256': resources.report['catalogSha256'], 'icons': records})
    return sum(row['state'] == 'available' for row in records)
