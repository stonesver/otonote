"""Export all verified home scene dependencies into browser scene packages."""
from pathlib import Path
import argparse
from functools import lru_cache
import json
import hashlib
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.prepare_immersive_catalog import CAPTURE, MASTER, PUBLIC, RELEASE, write, animation_times
from analysis.crypto.decrypt_global_formal_scores import (CatalogAdapter, MetadataV39, UnityPy, KEY_FIELD_USAGE,
    NONCE_SEED_FIELD_USAGE, METADATA_SHA256, CATALOG_SHA256, field_bytes, decrypt_header, text_payload, sha256)
from UnityPy.helpers.MeshHelper import MeshHandler


def _read_binary_animations(skeleton: Path, atlas: Path):
    try:
        result = subprocess.run(
            ['node', str(ROOT / 'tools/read_spine_animations.mjs'), str(skeleton), str(atlas), 'binary'],
            capture_output=True, text=True, check=True,
        )
    except subprocess.CalledProcessError as error:
        # Node stderr can contain absolute input paths and environment details.
        # Keep only a bounded error category and a known Node error code.
        stderr = (error.stderr or '')[-4096:]
        if 'spine-core runtime missing' in stderr or 'ERR_MODULE_NOT_FOUND' in stderr:
            detail = 'Node module unavailable (ERR_MODULE_NOT_FOUND)'
        elif match := re.search(r'\b(ERR_[A-Z0-9_]{1,63}|ENOENT)\b', stderr):
            detail = f'Node error {match.group(1)}'
        elif match := re.search(r'\b(SyntaxError|TypeError|RangeError|ReferenceError)\b', stderr):
            detail = f'Node {match.group(1)}'
        else:
            detail = 'Spine parser or runtime error'
        raise ValueError(f'Spine animation helper failed: {detail}') from None
    return json.loads(result.stdout)


def export_scene(spot, locations, sources, load_bytes, *, public=PUBLIC, release=RELEASE):
    destination = public / f'scene-{spot["_id"]}-v1'
    destination.mkdir(parents=True, exist_ok=True)
    dependencies = sorted({d for k in ('_backgroundAssetPath', '_situationAssetPath') for d in locations[spot[k]].dependencies if d.startswith('spot_')})
    if (destination / 'manifest.json').exists():
        existing = json.loads((destination / 'manifest.json').read_text())
        if existing.get('contentReleaseId') == release and existing.get('sources') == [sources[n] for n in dependencies] and all((destination / f['path']).is_file() and sha256(destination / f['path']) == f['sha256'] for f in existing['files']):
            print('Reused', spot['_id'], flush=True); return
    roots = [locations[spot[k]].dependencies[0] for k in ('_backgroundAssetPath', '_situationAssetPath')]
    env = UnityPy.Environment(); authored = []
    for name in dependencies:
        bundle = env.load_file(load_bytes(name))
        if name in roots: authored.extend(bundle.get_objects())
    objects = {o.path_id: o for o in env.objects}
    texture_files = {}; texture_names = {}
    shared = public / 'shared'; shared.mkdir(exist_ok=True)
    for obj in env.objects:
        if obj.type.name != 'Texture2D': continue
        texture = obj.read(); filename = f't-{obj.path_id}-' + hashlib.sha256('|'.join(sources[n]['sha256'] for n in dependencies).encode()).hexdigest()[:12] + '.webp'; target = shared / filename
        if not target.exists():
            texture.image.save(target, 'WEBP', lossless=True, method=3)
        texture_files[str(obj.path_id)] = '../shared/' + filename
        texture_names[texture.m_Name + '.png'] = str(obj.path_id)
    scene = {'schemaVersion': 2, 'nodes': [], 'meshes': {}, 'hide': [], 'textures': texture_files, 'materials': {}, 'atlases': {}, 'calibration': {'verticalFov': 30, 'referenceAspect': 16 / 9}}
    files = set(texture_files.values()); durations = []
    for obj in env.objects:
        if obj.type.name != 'Material': continue
        tree = obj.read_typetree(); properties = tree.get('m_SavedProperties', {})
        maps = dict(properties.get('m_TexEnvs', [])); colors = dict(properties.get('m_Colors', []))
        entry = next((maps[k] for k in ('_MainTex', '_BaseMap', '_BaseColorMap') if k in maps), None)
        texture = str(entry['m_Texture']['m_PathID']) if entry else None
        scene['materials'][str(obj.path_id)] = {'texture': texture if texture in texture_files else None, 'color': colors.get('_Color', {'r': 1, 'g': 1, 'b': 1, 'a': 1})}
    for obj in authored:
        if obj.type.name != 'Transform': continue
        transform = obj.read(); game = transform.m_GameObject.read()
        row = {'id': str(obj.path_id), 'gameObjectId': str(game.object_reader.path_id), 'parent': str(transform.m_Father.path_id),
               'name': game.m_Name, 'active': bool(game.m_IsActive), 'position': [getattr(transform.m_LocalPosition, k) for k in 'xyz'],
               'rotation': [getattr(transform.m_LocalRotation, k) for k in 'xyzw'], 'scale': [getattr(transform.m_LocalScale, k) for k in 'xyz']}
        if game.m_Name == spot['_backgroundAssetPath'].split('/')[-1]: row['backgroundRoot'] = True
        for pointer in game.m_Component:
            component = pointer.component.read(); kind = component.object_reader.type.name
            if kind == 'MeshFilter' and component.m_Mesh.path_id: row['mesh'] = str(component.m_Mesh.path_id)
            if kind == 'MeshRenderer': row.update(order=component.m_SortingOrder, enabled=bool(component.m_Enabled), materials=[str(p.path_id) for p in component.m_Materials])
            if kind != 'MonoBehaviour': continue
            tree = component.object_reader.read_typetree()
            for situation in tree.get('_situationObjects', []):
                if situation['SituationName'] == spot['_situationAssetPath'].split('/')[-1]: scene['hide'] = [str(x['m_PathID']) for x in situation['HideObjects']]
            if 'skeletonDataAsset' not in tree or not tree['skeletonDataAsset']['m_PathID']: continue
            sd = objects[tree['skeletonDataAsset']['m_PathID']].read_typetree()
            text = objects[sd['skeletonJSON']['m_PathID']].read(); raw = text_payload(text.m_Script)
            binary = not raw.lstrip().startswith(b'{')
            payload = None if binary else json.loads(raw)
            skeleton_name = 's-' + str(sd['skeletonJSON']['m_PathID'])
            skeleton_file = skeleton_name + ('.skel' if binary else '.json')
            if binary: (destination / skeleton_file).write_bytes(raw)
            else: write(destination / skeleton_file, payload)
            files.add(skeleton_file)
            atlas_key = 'a-' + '-'.join(str(p['m_PathID']) for p in sd['atlasAssets'])
            if atlas_key not in scene['atlases']:
                atlas_texts = []
                for p in sd['atlasAssets']:
                    atlas_asset = objects[p['m_PathID']].read_typetree()
                    atlas_texts.append(text_payload(objects[atlas_asset['atlasFile']['m_PathID']].read().m_Script).decode('utf-8'))
                atlas_text = '\n\n'.join(atlas_texts)
                pages = {name: texture_id for name, texture_id in texture_names.items() if name in atlas_text.splitlines()}
                if not pages: raise ValueError('No atlas texture page resolved')
                (destination / (atlas_key + '.atlas')).write_text(atlas_text)
                scene['atlases'][atlas_key] = {'file': atlas_key + '.atlas', 'pages': pages}; files.add(atlas_key + '.atlas')
            if binary:
                animations = _read_binary_animations(destination / skeleton_file, destination / (atlas_key + '.atlas'))
            else: animations = {name: max(animation_times(value), default=0) for name, value in payload.get('animations', {}).items()}
            animation = (tree['_animationName'] or next(iter(animations), None)) if animations else None
            if animation and animation not in animations: raise ValueError(f'Missing animation: {spot["_id"]} {animation}')
            if animation: durations.append(animations[animation])
            row.update(spine=skeleton_name, spineFormat='binary' if binary else 'json', atlas=atlas_key, spineScale=sd['scale'], animation=animation); row.pop('mesh', None)
        scene['nodes'].append(row)
    for mesh_id in {n['mesh'] for n in scene['nodes'] if 'mesh' in n}:
        mesh = objects[int(mesh_id)].read(); handler = MeshHandler(mesh); handler.process()
        stride = 4 if getattr(mesh, 'm_IndexFormat', 0) else 2
        groups = [{'start': sub.firstByte // stride, 'count': sub.indexCount, 'materialIndex': i} for i, sub in enumerate(mesh.m_SubMeshes)]
        scene['meshes'][mesh_id] = {'name': mesh.m_Name, 'positions': handler.m_Vertices, 'uv': handler.m_UV0, 'indices': handler.m_IndexBuffer, 'groups': groups}
    if not durations: raise ValueError(f'Scene {spot["_id"]} has no supported character animation')
    write(destination / 'scene.json', scene); files.add('scene.json')
    from shutil import copy2
    copy2(public / 'thumbnails' / f'{spot["_id"]}.webp', destination / 'poster.webp'); files.add('poster.webp')
    records = [{'path': name, 'bytes': (destination / name).stat().st_size, 'sha256': sha256(destination / name)} for name in sorted(files)]
    write(destination / 'manifest.json', {'schemaVersion': 2, 'sceneId': spot['_id'], 'contentReleaseId': release, 'durationSeconds': max(durations), 'approximateCamera': True, 'files': records, 'sources': [sources[n] for n in dependencies]})
    print(f'Exported {spot["_id"]}: {len(scene["nodes"])} nodes, {len(durations)} Spine layers, {len(texture_files)} textures, {max(durations)}s', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'input/global/remote-immersive/2026-09-27-catalog-39b5d81f')
    parser.add_argument('--scene', type=int)
    args = parser.parse_args()
    manifest = json.loads((args.source / 'manifest.json').read_text())
    if manifest['catalogSha256'] != CATALOG_SHA256 or manifest['masterSha256'] != sha256(MASTER / 'MasterHomeSpot.json'): raise ValueError('Scene acquisition has a different catalog binding')
    sources = {x['bundle']: x for x in manifest['files']}
    metadata_path = ROOT / 'input/global/decrypted/2026-09-22-v1.0.1-25/il2cpp/global-metadata.v39.dat'
    if sha256(metadata_path) != METADATA_SHA256: raise ValueError('Metadata changed')
    metadata = MetadataV39(metadata_path); key = field_bytes(metadata, KEY_FIELD_USAGE, 16); seed = field_bytes(metadata, NONCE_SEED_FIELD_USAGE, 8)
    @lru_cache(maxsize=24)
    def load_bytes(name):
        path = ROOT / sources[name]['path']
        if sha256(path) != sources[name]['sha256']: raise ValueError(f'Acquired bundle integrity mismatch: {name}')
        return decrypt_header(path.read_bytes(), name, key, seed)
    locations = {x.primary_key: x for x in CatalogAdapter().parse(CAPTURE / 'RemoteCatalog/catalog_main.bin').locations}
    spots = json.loads((MASTER / 'MasterHomeSpot.json').read_text())['_allData']
    failures = []
    for spot in spots:
        if args.scene and spot['_id'] != args.scene: continue
        if spot['_id'] in (10001, 10007): continue  # preserve the visually accepted initial reproductions
        try: export_scene(spot, locations, sources, load_bytes)
        except Exception as error:
            import traceback
            traceback.print_exc()
            failures.append({'sceneId': spot['_id'], 'error': str(error)}); print('FAILED', failures[-1], flush=True)
    catalog_path = ROOT / 'site/src/data/immersive-scenes.json'; catalog = json.loads(catalog_path.read_text())
    for scene in catalog['scenes']:
        root = PUBLIC / f'scene-{scene["id"]}-v1'
        if (root / 'manifest.json').exists():
            data = json.loads((root / 'manifest.json').read_text())
            scene.update(assetRoot=f'/immersive/scene-{scene["id"]}-v1/', duration=data['durationSeconds'], bytes=sum(x['bytes'] for x in data['files']), missingBundles=0)
    catalog['assetSource'] = 'device-capture-plus-cdn'; catalog['acquisitionManifest'] = str((args.source / 'manifest.json').relative_to(ROOT))
    write(catalog_path, catalog)
    write(args.source / 'export-report.json', {'failures': failures, 'playable': sum(bool(s['assetRoot']) for s in catalog['scenes'])})
    if failures: raise SystemExit(1)


if __name__ == '__main__': main()
