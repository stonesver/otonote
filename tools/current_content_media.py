"""Generate supplementary website modules from the same current resource context."""
from __future__ import annotations
import gc
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

from tools.global_remote_sync import file_hash, read_json, write_json
from tools.build_remote_global_inputs import ROOT, contained
from tools.current_input_cache import verified_link as verified_copy


def gallery(resources, output):
    from tools.gallery_sources import TABLES, asset_reference
    assets = []
    old_root = resources.prior_supplemental / 'public/gallery' if getattr(resources, 'prior_supplemental', None) else ROOT / 'site/public/gallery'
    old = read_json(old_root / 'manifest.json') if (old_root / 'manifest.json').exists() else {'assets': []}
    prior = {(x['kind'], x['id']): x for x in old['assets']}
    output.mkdir(parents=True, exist_ok=True)
    for kind, table in TABLES.items():
        for row in resources.rows(table):
            ref = asset_reference(kind, row)
            if ref not in resources.by_key:
                assets.append({'kind': kind, 'id': row['_id'], 'asset': ref, 'status': 'missing', 'reason': 'not_in_resource_catalog'})
                continue
            loc = resources.locate(ref, 'UnityEngine.Texture2D')
            bundles = [resources.locate(n) for n in loc.dependencies if n.endswith('.bundle')]
            if len(bundles) != 1: raise ValueError('ambiguous gallery dependency')
            bundle = bundles[0]
            previous = prior.get((kind, row['_id']))
            if previous and previous.get('bundle') == bundle.primary_key and previous.get('container') == loc.internal_id:
                for key, sha in [('image', 'sha256'), ('thumbnail', 'thumbnailSha256')]:
                    verified_copy(contained(old_root, previous[key]), contained(output, previous[key]), previous[sha])
                assets.append(previous)
                continue
            _, data = resources.texture(bundle, loc.internal_id)
            image = data.image.convert('RGBA')
            name = f"{kind}-{row['_id']}"
            image.save(output / (name + '.png'))
            thumbnail = image.copy(); thumbnail.thumbnail((720, 720) if kind == 'comics' else (320, 320))
            thumbnail.save(output / (name + '.webp'), 'WEBP', quality=90)
            assets.append({'kind': kind, 'id': row['_id'], 'asset': ref, 'status': 'available', 'image': name + '.png',
                'thumbnail': name + '.webp', 'sha256': file_hash(output / (name + '.png')), 'thumbnailSha256': file_hash(output / (name + '.webp')),
                'width': image.width, 'height': image.height, 'bundle': bundle.primary_key,
                'bundleSha256': resources.used[bundle.primary_key]['sha256'], 'container': loc.internal_id})
    write_json(output / 'manifest.json', {'schemaVersion': 2, 'resourceVersion': resources.report['observation']['resourceVersion'],
        'catalogSha256': resources.report['catalogSha256'], 'masterSha256': {n: file_hash(resources.master / (n + '.json')) for n in TABLES.values()}, 'assets': assets})
    return len(assets)


def costume_icons(resources, output):
    from tools.costume_assets import extract_costume_icons
    return extract_costume_icons(resources, output)


def mission_images(resources, public):
    from tools.system_details import SystemContext, build_missions
    groups = build_missions(SystemContext(resources.master, 'zh-CN'))
    rewards = {r['imagePath'] for g in groups for s in g['stages'] for r in s['rewards'] if r['resourceType'] in (17,19) and r['imagePath']}
    banners = {loc.primary_key for loc in resources.catalog.locations if loc.resource_type == 'UnityEngine.Texture2D'
               and 'limited_mission_banner_' in loc.primary_key}
    for group, references in [('mission-rewards', rewards), ('system-banners', banners)]:
        output = public / group; output.mkdir(parents=True, exist_ok=True)
        records = []
        for reference in sorted(references):
            loc = resources.locate(reference, 'UnityEngine.Texture2D')
            _, data = resources.image(reference)
            image = data.image
            name = reference.rsplit('/', 1)[-1]
            if not re.fullmatch('[A-Za-z0-9_-]+', name): raise ValueError('unsafe mission image name')
            image.save(output / (name + '.webp'), 'WEBP', quality=92)
            records.append({'name': name, 'imagePath': reference, 'file': name + '.webp',
                'sha256': file_hash(output / (name + '.webp')), 'width': image.width, 'height': image.height})
        write_json(output / 'manifest.json', records)


def live2d(resources, release, stories, public, data_root):
    from tools.live2d_discovery import discover_models, story_character_labels
    from tools.prepare_live2d import export_model
    from tools.live2d_assets import verify_live2d_assets
    from tools.resource_pipeline.catalog_adapter import CatalogAdapter
    models = discover_models(resources.catalog.locations, resources.rows('MasterCharacterCostume'))
    story_index = read_json(stories / 'index.json')
    documents = (read_json(contained(stories, r['path'])) for r in story_index['documents'])
    characters = story_character_labels(models, resources.rows('MasterText'), documents)
    old_path = resources.prior_supplemental / 'data/live2d-catalog.json' if getattr(resources, 'prior_supplemental', None) else ROOT / 'site/src/data/live2d-catalog.json'
    old = read_json(old_path) if old_path.exists() else {'models': []}
    prior = {m['id']: m for m in old['models']}
    capture = resources.prior_catalog if getattr(resources, 'prior_supplemental', None) else ROOT / 'input/global/device-files/2026-09-24-v1.0.1-25/RemoteCatalog/catalog_main.bin'
    old_locations = CatalogAdapter().parse(capture) if capture.exists() and file_hash(capture) == old.get('catalogSha256') else None
    output = public / 'live2d' / release; output.mkdir(parents=True, exist_ok=True)
    entries = []
    for model in models:
        addressable_path = 'Character/Live2D/' + model['modelPath']
        loc = resources.locate(addressable_path)
        names = [n for n in loc.dependencies if n.startswith('character-live2d_')]
        if len(names) != 1: raise ValueError('ambiguous Live2D bundle')
        name = names[0]
        previous = prior.get(model['id'])
        previous_loc = None
        if previous and previous.get('state') == 'available' and old_locations:
            try:
                previous_loc = old_locations.location_for_key(addressable_path)
            except KeyError:
                # A current model absent from the prior catalog needs a fresh export.
                pass
        reuse = previous and previous.get('state') == 'available' and previous_loc and name in previous_loc.dependencies
        if reuse:
            origin = (resources.prior_supplemental / 'public' if getattr(resources, 'prior_supplemental', None) else ROOT / 'site/public') / previous['root'].lstrip('/')
            manifest = read_json(origin / 'manifest.json')
            folder = origin.name
            target = output / folder
            for row in manifest['resources']:
                verified_copy(contained(origin, row['file']), contained(target, row['file']), row['sha256'])
            write_json(target / 'manifest.json', manifest)
            sha = previous['sourceSha256']
        else:
            env = resources.environment(name)
            sha = resources.used[name]['sha256']
            folder = f"{model['id']}-{sha[:12]}-v1"
            target = output / folder
            manifest = export_model(env, target, model['modelPath'].rsplit('/', 1)[-1])
        entries.append({**model, 'state': 'available', 'root': f'/live2d/{release}/{folder}/', 'bytes': manifest['totalBytes'],
            'motions': len(manifest['motions']), 'blockedMotions': manifest['blockedMotionCount'], 'expressions': manifest['expressionCount'],
            'physics': manifest['physics'], 'sourceSha256': sha})
    payload = {'schemaVersion': 2, 'releaseId': release, 'catalogSha256': resources.report['catalogSha256'],
        'storyIndexSha256': file_hash(stories / 'index.json'), 'characters': characters, 'models': entries}
    verify_live2d_assets(payload, public, release)
    write_json(data_root / 'live2d-catalog.json', payload)
    return len(entries)


def immersive(resources, release, public, data_root):
    from tools.export_immersive_scenes import export_scene
    from tools.resource_pipeline.localization import resolve_text
    destination = public / 'immersive'; destination.mkdir(parents=True, exist_ok=True)
    texts = {r['_id']: r for r in resources.rows('MasterText')}
    scenes = []
    old_root = resources.prior_supplemental / 'public/immersive' if getattr(resources, 'prior_supplemental', None) else ROOT / 'site/public/immersive'
    old_catalog_path = resources.prior_supplemental / 'data/immersive-scenes.json' if getattr(resources, 'prior_supplemental', None) else ROOT / 'site/src/data/immersive-scenes.json'
    old_catalog = read_json(old_catalog_path) if old_catalog_path.exists() else {'scenes': []}
    old_scenes = {row['id']: row for row in old_catalog['scenes']}
    for spot in resources.rows('MasterHomeSpot'):
        thumbnail = destination / 'thumbnails' / f"{spot['_id']}.webp"
        thumbnail.parent.mkdir(exist_ok=True)
        _, data = resources.image(spot['_thumbnailAssetPath'])
        image = data.image; image = image.crop(image.getbbox()); image.thumbnail((720,480))
        image.save(thumbnail, 'WEBP', quality=88)
        names = sorted({d for k in ('_backgroundAssetPath','_situationAssetPath') for d in resources.locate(spot[k]).dependencies if d.startswith('spot_')})
        sources = {n: {'bundle': n, 'sha256': file_hash(resources.get(resources.locate(n)))} for n in names}
        previous = old_scenes.get(spot['_id'])
        origin = old_root / Path(previous['assetRoot'].rstrip('/')).name if previous and previous.get('assetRoot') else None
        old_manifest = read_json(origin / 'manifest.json') if origin and (origin / 'manifest.json').exists() else None
        prior_sources = {r['bundle']: r['sha256'] for r in old_manifest.get('sources', [])} if old_manifest else {}
        if old_manifest and prior_sources == {n: r['sha256'] for n, r in sources.items()}:
            folder = origin.name
            target = destination / folder
            manifest = {**old_manifest, 'contentReleaseId': release, 'verifiedReuseCatalogSha256': resources.report['catalogSha256']}
            for record in manifest['files']:
                original = (origin / record['path']).resolve()
                copy = (target / record['path']).resolve()
                if old_root.resolve() not in original.parents or destination.resolve() not in copy.parents:
                    raise ValueError('scene resource escapes media root')
                if copy.exists() and file_hash(copy) != record['sha256']:
                    raise ValueError('conflicting shared scene resource')
                verified_copy(original, copy, record['sha256'])
            write_json(target / 'manifest.json', manifest)
        else:
            export_scene(spot, resources.locations, sources, resources.clear, public=destination, release=release)
            folder = f"scene-{spot['_id']}-v1"
            manifest = read_json(destination / folder / 'manifest.json')
        label = texts[spot['_nameTextId']]
        scenes.append({'id': spot['_id'], 'bandId': spot['_bandId'], 'name': resolve_text(label,locale='zh-CN'), 'nameEn': resolve_text(label,locale='en'),
            'poster': f"/immersive/thumbnails/{spot['_id']}.webp", 'assetRoot': f'/immersive/{folder}/', 'duration': manifest['durationSeconds'],
            'bytes': sum(f['bytes'] for f in manifest['files']), 'missingBundles': 0, 'totalBundles': len(names), 'background': spot['_backgroundAssetPath']})
        gc.collect()
    bands = [{'id': b['_id'], 'name': resolve_text(texts[b['_nameTextID']],locale='zh-CN'), 'nameEn': resolve_text(texts[b['_nameTextID']],locale='en')} for b in resources.rows('MasterBand')]
    write_json(data_root / 'immersive-scenes.json', {'contentReleaseId': release, 'catalogSha256': resources.report['catalogSha256'],
        'sourceCapture': 'public-protocol', 'backgroundCount': len({s['background'] for s in scenes}), 'bands': bands, 'scenes': scenes})
    return len(scenes)


def auto_stage(resources, public, data_root):
    from tools.prepare_auto_stage import PREFIXES, export_bundles
    bundles, sources = [], []
    for loc in resources.catalog.locations:
        name = loc.primary_key
        if not name.startswith(PREFIXES) or not loc.provider_id.endswith('.AssetBundleCryptProvider'): continue
        prefix = next(p for p in PREFIXES if name.startswith(p)); suffix = name[len(prefix):]
        pattern = r'(lane_base|lane_tap_area|out_side_line)_[a-f0-9]{32}\.bundle' if prefix == 'live_assets_live_lane_skin001_' else r'(?:[0-9]_)?[a-f0-9]{32}\.bundle' if 'sp_combo_perfect_' in prefix else r'[a-f0-9]{32}\.bundle'
        if not re.fullmatch(pattern, suffix): continue
        clear = resources.clear(name); receipt = resources.used[name]
        bundles.append((name, receipt, clear)); sources.append({'bundle': name, 'sha256': receipt['sha256']})
    destination = public / 'auto-stage/skin001'; destination.mkdir(parents=True, exist_ok=True)
    payload = export_bundles(bundles, sources, destination, data_root / 'auto-stage-skin.json', resources.report['catalogSha256'])
    return len(payload['images'])
