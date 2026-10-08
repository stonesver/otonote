"""Inventory captured home scenes and package the additional complete cafe scene."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from analysis.crypto.decrypt_global_formal_scores import (CatalogAdapter, MetadataV39, UnityPy,
    KEY_FIELD_USAGE, NONCE_SEED_FIELD_USAGE, METADATA_SHA256, CATALOG_SHA256, field_bytes, decrypt_header, text_payload, sha256)
from UnityPy.helpers.MeshHelper import MeshHandler

CAPTURE = ROOT / 'input/global/device-files/2026-09-24-v1.0.1-25'
MASTER = ROOT / 'input/global/decrypted/2026-09-24-v1.0.1-25/master-json'
PUBLIC = ROOT / 'site/public/immersive'
RELEASE = 'global-prod-20260924-v1-0-1-25-39b5d81f'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def package_cafe(spot, locations, cache, capture_files):
    metadata_path = ROOT / 'input/global/decrypted/2026-09-22-v1.0.1-25/il2cpp/global-metadata.v39.dat'
    if sha256(metadata_path) != METADATA_SHA256:
        raise ValueError('Unexpected metadata')
    metadata = MetadataV39(metadata_path)
    key = field_bytes(metadata, KEY_FIELD_USAGE, 16)
    seed = field_bytes(metadata, NONCE_SEED_FIELD_USAGE, 8)
    roots = [locations[spot[k]].dependencies[0] for k in ('_backgroundAssetPath', '_situationAssetPath')]
    deps = sorted({d for k in ('_backgroundAssetPath', '_situationAssetPath') for d in locations[spot[k]].dependencies if d.startswith('spot_')})
    env = UnityPy.Environment()
    authored = []
    sources = []
    for name in deps:
        raw = cache[name[:-7].rsplit('_', 1)[-1]]
        actual = sha256(raw)
        if actual != capture_files[str(raw.relative_to(CAPTURE))]['sha256']:
            raise ValueError(f'Capture integrity mismatch: {raw.name}')
        bundle = env.load_file(decrypt_header(raw.read_bytes(), name, key, seed))
        if name in roots:
            authored.extend(bundle.get_objects())
        sources.append({'bundle': name, 'sha256': actual})
    objects = {o.path_id: o for o in env.objects}
    output = PUBLIC / 'mygo-cafe-v1'
    output.mkdir(parents=True, exist_ok=True)
    text_assets = {o.read().m_Name: text_payload(o.read().m_Script).decode('utf-8') for o in env.objects if o.type.name == 'TextAsset'}
    atlases = [value for name, value in text_assets.items() if name.endswith('.atlas')]
    if len(atlases) != 1:
        raise ValueError('Cafe must have one character atlas')
    atlas = atlases[0]
    textures = [o.read() for o in env.objects if o.type.name == 'Texture2D']
    if len(textures) != 2:
        raise ValueError('Cafe must have one background and one character texture')
    for texture in textures:
        target = 'background.webp' if texture.m_Name.endswith('_texture') else 'characters.webp'
        texture.image.save(output / target, 'WEBP', lossless=True, method=4)
        atlas = atlas.replace(texture.m_Name + '.png', target)
    (output / 'characters.atlas').write_text(atlas)
    scene = {'nodes': [], 'meshes': {}, 'hide': [], 'calibration': {'verticalFov': 30, 'referenceAspect': 16 / 9, 'initialZoom': 1.18}}
    for obj in authored:
        if obj.type.name != 'Transform':
            continue
        transform = obj.read()
        game = transform.m_GameObject.read()
        row = {'id': str(obj.path_id), 'gameObjectId': str(game.object_reader.path_id), 'parent': str(transform.m_Father.path_id),
               'name': game.m_Name, 'active': bool(game.m_IsActive),
               'position': [getattr(transform.m_LocalPosition, k) for k in 'xyz'],
               'rotation': [getattr(transform.m_LocalRotation, k) for k in 'xyzw'],
               'scale': [getattr(transform.m_LocalScale, k) for k in 'xyz']}
        if game.m_Name == spot['_backgroundAssetPath'].split('/')[-1]:
            row['backgroundRoot'] = True
        for pointer in game.m_Component:
            component = pointer.component.read()
            kind = component.object_reader.type.name
            if kind == 'MeshFilter': row['mesh'] = str(component.m_Mesh.path_id)
            if kind == 'MeshRenderer': row.update(order=component.m_SortingOrder, enabled=bool(component.m_Enabled))
            if kind != 'MonoBehaviour': continue
            tree = component.object_reader.read_typetree()
            for situation in tree.get('_situationObjects', []):
                if situation['SituationName'] == spot['_situationAssetPath'].split('/')[-1]:
                    scene['hide'] = [str(x['m_PathID']) for x in situation['HideObjects']]
            if 'skeletonDataAsset' in tree:
                skeleton_data = objects[tree['skeletonDataAsset']['m_PathID']].read_typetree()
                text = objects[skeleton_data['skeletonJSON']['m_PathID']].read()
                payload = json.loads(text_payload(text.m_Script))
                write(output / (text.m_Name + '.json'), payload)
                row.update(spine=text.m_Name, spineScale=skeleton_data['scale'], animation=tree['_animationName'])
                row.pop('mesh', None)
        scene['nodes'].append(row)
    for mesh_id in {n['mesh'] for n in scene['nodes'] if 'mesh' in n}:
        mesh = objects[int(mesh_id)].read()
        handler = MeshHandler(mesh); handler.process()
        scene['meshes'][mesh_id] = {'name': mesh.m_Name, 'positions': handler.m_Vertices, 'uv': handler.m_UV0, 'indices': handler.m_IndexBuffer}
    write(output / 'scene.json', scene)
    thumbnail_bundle = locations[spot['_thumbnailAssetPath']].dependencies[0]
    raw = cache[thumbnail_bundle[:-7].rsplit('_', 1)[-1]]
    if sha256(raw) != capture_files[str(raw.relative_to(CAPTURE))]['sha256']:
        raise ValueError('Thumbnail integrity mismatch')
    thumbnail_env = UnityPy.load(decrypt_header(raw.read_bytes(), thumbnail_bundle, key, seed))
    thumbnails = [o for o in thumbnail_env.objects if o.type.name == 'Texture2D']
    if len(thumbnails) != 1: raise ValueError('Expected one cafe thumbnail')
    cover = thumbnails[0].read().image
    cover.crop(cover.getbbox()).save(output / 'poster.webp', 'WEBP', quality=90)
    files = [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in sorted(output.iterdir()) if p.is_file() and p.name != 'manifest.json']
    duration = max(t for n in scene['nodes'] if 'spine' in n for a in json.loads((output / (n['spine'] + '.json')).read_text())['animations'].values() for t in animation_times(a))
    write(output / 'manifest.json', {'schemaVersion': 1, 'sceneId': spot['_id'], 'contentReleaseId': RELEASE, 'durationSeconds': duration, 'approximateCamera': True, 'files': files, 'sources': sources})
    print('Packaged cafe:', len(scene['nodes']), 'nodes, duration', duration, flush=True)


def animation_times(value):
    if isinstance(value, dict):
        if 'time' in value: yield value['time']
        for child in value.values(): yield from animation_times(child)
    if isinstance(value, list):
        for child in value: yield from animation_times(child)


def main():
    catalog_path = CAPTURE / 'RemoteCatalog/catalog_main.bin'
    if sha256(catalog_path) != CATALOG_SHA256: raise ValueError('Unexpected resource catalog')
    locations = {x.primary_key: x for x in CatalogAdapter().parse(catalog_path).locations}
    cache = {p.name.split('_')[0]: p for p in (CAPTURE / 'EncryptedBundles').glob('*.bundle')}
    capture_files = {x['path']: x for x in json.loads((CAPTURE / 'capture.json').read_text())['files']}
    spots = json.loads((MASTER / 'MasterHomeSpot.json').read_text())['_allData']
    texts = {x['_id']: x for x in json.loads((MASTER / 'MasterText.json').read_text())['_allData']}
    package_cafe(next(x for x in spots if x['_id'] == 10001), locations, cache, capture_files)
    scenes = []
    thumbs = PUBLIC / 'thumbnails'; thumbs.mkdir(exist_ok=True)
    from PIL import Image
    for spot in spots:
        deps = {d for k in ('_backgroundAssetPath', '_situationAssetPath') for d in locations[spot[k]].dependencies if d.startswith('spot_')}
        missing = [d for d in deps if d[:-7].rsplit('_', 1)[-1] not in cache]
        name = texts[spot['_nameTextId']]
        thumbnail = ROOT / 'site/public/mission-rewards' / (spot['_thumbnailAssetPath'].split('/')[-1] + '.webp')
        if spot['_id'] == 10001: thumbnail = PUBLIC / 'mygo-cafe-v1/poster.webp'
        poster = None
        if thumbnail.exists():
            poster = f'/immersive/thumbnails/{spot["_id"]}.webp'
            cover = Image.open(thumbnail)
            cover = cover.crop(cover.getbbox())
            cover.thumbnail((720, 480), Image.Resampling.LANCZOS)
            cover.save(ROOT / 'site/public' / poster.lstrip('/'), 'WEBP', quality=88)
        assets = {10007: 'mygo-lobby-v1', 10001: 'mygo-cafe-v1'}.get(spot['_id'])
        if not assets and (PUBLIC / f'scene-{spot["_id"]}-v1/manifest.json').exists():
            assets = f'scene-{spot["_id"]}-v1'
        manifest = json.loads((PUBLIC / assets / 'manifest.json').read_text()) if assets else None
        if manifest:
            if manifest['sceneId'] != spot['_id'] or manifest['contentReleaseId'] != RELEASE:
                raise ValueError('Scene package binding mismatch')
            for file in manifest['files']:
                if sha256(PUBLIC / assets / file['path']) != file['sha256']:
                    raise ValueError(f'Scene package integrity mismatch: {assets}/{file["path"]}')
            missing = []
        scenes.append({'id': spot['_id'], 'bandId': spot['_bandId'], 'name': name['_simplifiedChinese'], 'nameEn': name['_english'],
                       'poster': poster, 'assetRoot': f'/immersive/{assets}/' if assets and not missing else None,
                       'cameraVerified': bool(manifest and manifest.get('approximateCamera') is False),
                       'duration': manifest['durationSeconds'] if manifest else None, 'bytes': sum(f['bytes'] for f in manifest['files']) if manifest else None,
                       'missingBundles': len(missing), 'totalBundles': len(deps), 'background': spot['_backgroundAssetPath']})
    bands = [{'id': b['_id'], 'name': texts[b['_nameTextID']]['_simplifiedChinese'], 'nameEn': texts[b['_nameTextID']]['_english']} for b in json.loads((MASTER / 'MasterBand.json').read_text())['_allData']]
    output_catalog = ROOT / 'site/src/data/immersive-scenes.json'
    previous = json.loads(output_catalog.read_text()) if output_catalog.exists() else {}
    provenance = {k: previous[k] for k in ('assetSource', 'acquisitionManifest') if k in previous and previous.get('contentReleaseId') == RELEASE}
    write(output_catalog, {'contentReleaseId': RELEASE, 'sourceCapture': '2026-09-24-v1.0.1-25', 'backgroundCount': len({s['background'] for s in scenes}), 'bands': bands, 'scenes': scenes, **provenance})
    print('Catalog:', len(scenes), 'scenes,', sum(bool(s['assetRoot']) for s in scenes), 'playable', flush=True)


if __name__ == '__main__': main()
