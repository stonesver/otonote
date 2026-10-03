"""Build localized comic, stamp and profile decoration indexes from verified Master-to-image bindings."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from tools.resource_pipeline.localization import resolve_localized_text

ROOT = Path(__file__).resolve().parents[1]
from tools.gallery_sources import TABLES, asset_reference

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def project_gallery(master: Path, release_id: str, locale: str, asset_root: Path | None = None) -> dict:
    asset_root = asset_root or ROOT / 'site/public/gallery'
    result = {'schemaVersion': 2, 'sourceReleaseId': release_id, 'locale': locale,
              'resourceVersion': '', 'comics': [], 'stamps': [], 'stickers': [], 'backgrounds': [], 'characters': [], 'bands': []}
    if not all((master / f'{name}.json').exists() for name in TABLES.values()):
        return result
    manifest = json.loads((asset_root / 'manifest.json').read_text())
    if manifest.get('schemaVersion') != 2:
        raise ValueError('Unsupported gallery manifest')
    for table in TABLES.values():
        if digest(master / f'{table}.json') != manifest['masterSha256'][table]:
            raise ValueError(f'Gallery must be reverified for changed {table}')
    bindings = {}
    for asset in manifest['assets']:
        key = (asset['kind'], asset['id'])
        if key in bindings:
            raise ValueError('Duplicate gallery asset')
        if asset.get('status') == 'missing':
            if asset.get('reason') != 'not_in_resource_catalog':
                raise ValueError('Unknown missing-resource reason')
            bindings[key] = asset
            continue
        for field, hash_field in [('image', 'sha256'), ('thumbnail', 'thumbnailSha256')]:
            path = (asset_root / asset[field]).resolve()
            if path.parent != asset_root.resolve() or not path.is_file() or digest(path) != asset[hash_field]:
                raise ValueError('Gallery file missing or digest mismatch')
        bindings[key] = asset
    def rows(name):
        return json.loads((master / f'{name}.json').read_text())['_allData']
    texts = {row['_id']: row for row in rows('MasterText')}
    def label(key, fallback):
        return resolve_localized_text(texts.get(key), locale, fallback).text
    characters = {row['_id']: {'id': row['_id'], 'name': label(row['_nameTextID'], str(row['_id'])), 'bandId': row['_bandID']} for row in rows('MasterCharacter')}
    result['characters'] = list(characters.values())
    result['bands'] = [{'id': row['_id'], 'name': label(row['_nameTextID'], str(row['_id']))} for row in rows('MasterBand')]
    result['resourceVersion'] = manifest['resourceVersion']
    for kind, table in TABLES.items():
        for row in sorted(rows(table), key=lambda r: (r.get('_order', r.get('_priority', r.get('_orderNum', 0))), r['_id'])):
            asset = bindings.get((kind, row['_id']))
            ref = asset_reference(kind, row)
            if not asset or asset['asset'] != ref:
                raise ValueError(f'Gallery binding missing: {kind}/{row["_id"]}')
            ids = row.get('_characterIds', [])
            if any(id not in characters for id in ids):
                raise ValueError('Unknown gallery character')
            cast = ' / '.join(characters[id]['name'] for id in ids)
            fallback_names = {'stamps': ('未命名表情', 'Unnamed stamp'), 'stickers': ('未命名贴纸', 'Unnamed sticker'), 'backgrounds': ('未命名背景', 'Unnamed background')}
            fallback = f"{fallback_names.get(kind, ('漫画', 'Comic'))[locale == 'en']} #{row['_id']}"
            title = (f'{cast} · ' + ('Comic' if locale == 'en' else '漫画')) if kind == 'comics' else label(row['_nameTextId'], fallback)
            result[kind].append({'id': row['_id'], 'title': title, 'characterIds': ids,
                'bandIds': sorted({characters[id]['bandId'] for id in ids}),
                'sourceResource': ref,
                'category': kind if kind in ('stickers', 'backgrounds') else str(row.get('_stampCategory', 0)), 'mediaType': kind,
                'status': asset['status'], 'description': label(row.get('_descriptionTextId', ''), ''), 'startAt': row.get('_startAt'), 'endAt': row.get('_endAt'),
                'image': '/gallery/' + asset['image'] if asset['status'] == 'available' else None,
                'thumbnail': '/gallery/' + asset['thumbnail'] if asset['status'] == 'available' else None,
                'sourceSha256': asset.get('sha256'), 'width': asset.get('width'), 'height': asset.get('height')})
    return result
