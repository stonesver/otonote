"""Project wearable costume groups from one release; models are variants, not outfits."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from tools.resource_pipeline.localization import resolve_text


def table(root, name):
    path = Path(root) / (name + '.json')
    return json.loads(path.read_text())['_allData'] if path.is_file() else []


def unique(rows, key, label):
    result = {}
    for row in rows:
        value = row[key]
        if value in result:
            raise ValueError('duplicate ' + label + ': ' + str(value))
        result[value] = row
    return result


def costume_icons(root, master):
    if root is None or not (Path(root) / 'manifest.json').is_file():
        return {}
    root = Path(root)
    manifest = json.loads((root / 'manifest.json').read_text())
    source = Path(master) / 'MasterCharacterCostumeGroup.json'
    expected = hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None
    if manifest.get('schemaVersion') != 1 or manifest.get('masterSha256') != expected:
        raise ValueError('costume icons do not match Master groups')
    result = unique(manifest['icons'], 'groupId', 'costume icon')
    for item in result.values():
        if item['state'] != 'available':
            continue
        name = item['file']
        if not re.fullmatch(r'\d+-[a-f0-9]{64}\.webp', name):
            raise ValueError('unsafe costume icon filename')
        target = root / name
        if target.is_symlink() or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('costume icon integrity mismatch')
        if item['width'] <= 0 or item['height'] <= 0:
            raise ValueError('invalid costume icon dimensions')
    return result


def project_costumes(master, catalog, *, live2d=None, icons_root=None):
    release = catalog['release']
    payload = {'schemaVersion': 1, 'contentReleaseId': release['id'],
               'region': release['region'], 'locale': release['locale'],
               'status': 'unavailable', 'costumes': []}
    if not (Path(master) / 'MasterCharacterCostumeGroup.json').is_file():
        return payload
    groups = unique(table(master, 'MasterCharacterCostumeGroup'), '_id', 'costume group')
    costumes = unique(table(master, 'MasterCharacterCostume'), '_id', 'costume model')
    texts = unique(table(master, 'MasterText'), '_id', 'text')
    characters = unique(catalog['characters'], 'masterId', 'character')
    cards = unique(catalog['memberCards'], 'masterId', 'member card')
    icons = costume_icons(icons_root, master)
    if live2d is not None and live2d.get('releaseId') != release['id']:
        raise ValueError('costume models do not match content release')
    models = unique((live2d or {}).get('models', []), 'modelPath', 'published model path')
    by_group = {}
    for row in costumes.values():
        group = groups.get(row.get('_groupID'))
        if group is None or group['_characterID'] != row['_characterID']:
            raise ValueError('invalid costume model group or character')
        by_group.setdefault(group['_id'], []).append(row)
    for group_id, group in sorted(groups.items()):
        character = characters.get(group['_characterID'])
        if character is None:
            raise ValueError('costume references missing character')
        card_id = group.get('_specialConditionMemberCardId', 0)
        card = cards.get(card_id)
        if card_id and (card is None or card['characterId'] != character['id']):
            raise ValueError('costume references invalid unlock card')
        if not group['_isChangeable']:
            continue
        icon = icons.get(group_id)
        if icon and icon['imagePath'] != group.get('_iconPath', ''):
            raise ValueError('costume icon reference mismatch')
        variants = []
        for row in sorted(by_group.get(group_id, []), key=lambda r: (r['_costumeType'], r['_id'])):
            model = models.get(row['_live2dPath'])
            if model and str(model['characterId']) != str(character['masterId']):
                raise ValueError('published costume model character mismatch')
            available = bool(model and model.get('state') == 'available')
            variants.append({'masterId': row['_id'], 'typeCode': row['_costumeType'],
                             'modelPath': row['_live2dPath'], 'modelId': model['id'] if available else None,
                             'state': 'available' if available else 'unavailable'})
        name = resolve_text(texts.get(group['_costumeNameTextId']),
                            ('Costume #' if release['locale'] == 'en' else '服装 #') + str(group_id),
                            locale=release['locale'])
        payload['costumes'].append({
            'id': f'costume-group-{group_id}', 'masterId': group_id, 'name': name,
            'characterId': character['id'], 'characterMasterId': character['masterId'],
            'bandId': character['bandId'], 'isInitial': bool(group['_isInitial']),
            'unlockMemberCardId': card['id'] if card else None,
            'startAt': group.get('_startAt') or None,
            'icon': {'url': '/costumes/' + icon['file'], 'width': icon['width'], 'height': icon['height']}
                    if icon and icon['state'] == 'available' else None,
            'models': variants,
        })
    payload['status'] = 'available'
    return payload
