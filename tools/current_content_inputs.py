"""Master-driven extractors for an entire supported Global content release."""
from __future__ import annotations
import copy
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

from tools.global_remote_sync import file_hash, read_json, write_json
from tools.build_remote_global_inputs import ROOT, APK, METADATA, contained, release_id
from tools.current_resources import CurrentResources
from tools.current_input_cache import verified_link as verified_copy


def core_image_targets(resources):
    """Discover current records; never derive coverage from the old ID set."""
    targets = {}
    def add(prefix, reference):
        loc = resources.prefix(prefix)
        container = 'Assets/AddressableResources/' + reference + '.png'
        targets[container] = loc
    for row in resources.rows('MasterCharacter'):
        identifier = row['_id']
        for name in ('character_thumbnail', 'character_sprite', 'character_face_icon'):
            add(f'character-image_assets_character-image-{identifier}everythinginitialdownload_', f'Character/Image/{identifier}/{name}')
    for table, prefix, directory, name in (
        ('MasterMemberCard', 'membercard_assets_membercard_{id}_member_full_', 'MemberCard', 'member_full'),
        ('MasterSupportCard', 'supportcard_assets_supportcard_{id}_snap_full_', 'SupportCard', 'snap_full')):
        for identifier in sorted({r['_assetID'] for r in resources.rows(table)}):
            add(prefix.format(id=identifier), f'{directory}/{identifier}/{name}')
    for name in sorted({r['_jacketAssetName'] for r in resources.rows('MasterLiveMusic')}):
        add(f'image_assets_image_jacket_{name}_', f'Image/Jacket/{name}')
    # Event artwork follows the same pinned catalog and media publication path.
    for reference in sorted({r[field] for r in resources.rows('MasterEvent')
                             for field in ('_logoAsset', '_backgroundAsset') if r.get(field)}):
        path = 'Image/Event/' + reference
        add('image_assets_' + path.lower().replace('/', '_') + '_', path)
    for reference in sorted({r['_bannerAssetName'] for r in resources.rows('MasterGacha')}):
        add('gacha_assets_' + reference.lower().replace('/', '_') + '_', reference)
    for reference in sorted({r['_imagePath'] for r in resources.rows('MasterItem') if r.get('_imagePath')}):
        add('item_assets_all_', reference)
    for row in resources.rows('MasterBandItem'):
        band, item = row['_bandId'], row['_id']
        add(f'band_assets_band_{band}_banditem_{item}_band_item_', f'Band/{band}/BandItem/{item}/band_item')
    # Band and skill icons are current catalog entries, not a fixed count.
    for loc in resources.catalog.locations:
        if loc.resource_type != 'UnityEngine.Texture2D': continue
        if re.match(r'Assets/AddressableResources/(Character/Skill/|Band/\d+/band_logo)', loc.internal_id):
            bundles = [resources.locate(n) for n in loc.dependencies if n.endswith('.bundle')]
            if len(bundles) != 1: raise ValueError('ambiguous UI icon dependency')
            targets[loc.internal_id] = bundles[0]
    return targets


def extract_images(resources, previous, output, *, same_apk=True):
    old = read_json(ROOT / previous['assetManifest'])['assets']
    old_by_container = {r['container_path']: r for r in old if r['container_path']}
    assets = []
    for container, loc in sorted(core_image_targets(resources).items(), key=lambda x: (x[1].primary_key, x[0])):
        prior = old_by_container.get(container)
        if prior and prior['bundle'] == loc.primary_key:
            verified_copy(contained(ROOT / previous['extractedRoot'], prior['exported_file']), contained(output, prior['exported_file']), prior['sha256'])
            assets.append(prior)
            continue
        obj, data = resources.texture(loc, container)
        image = data.image
        exported = 'png/' + hashlib.sha256(container.encode()).hexdigest()[:24] + '.png'
        target = output / exported
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, 'PNG')
        assets.append({'type': obj.type.name, 'name': data.m_Name, 'bundle': loc.primary_key,
                       'path_id': obj.path_id, 'container_path': container, 'exported_file': exported,
                       'width': image.width, 'height': image.height, 'sha256': file_hash(target)})
    # Packaged taxonomy sprites have no remote address. Keep their pinned APK
    # extraction only while the selected APK digest is unchanged.
    for row in old:
        if not row['container_path']:
            if same_apk:
                verified_copy(contained(ROOT / previous['extractedRoot'], row['exported_file']), contained(output, row['exported_file']), row['sha256'])
                assets.append(row)
            else:
                import zipfile
                from tools.build_remote_global_inputs import bundle_stem
                with zipfile.ZipFile(resources.apk) as archive:
                    names = [Path(n).name for n in archive.namelist() if n.endswith('.bundle') and bundle_stem(Path(n).name) == bundle_stem(row['bundle'])]
                if len(names) != 1: raise ValueError('packaged taxonomy bundle changed structure')
                env = resources.environment(names[0])
                objects = [o for o in env.objects if o.type.name == row['type'] and o.read().m_Name == row['name']]
                if len(objects) != 1: raise ValueError('packaged taxonomy sprite changed structure')
                obj = objects[0]; image = obj.read().image
                target = contained(output, row['exported_file']); target.parent.mkdir(parents=True, exist_ok=True)
                image.save(target, 'PNG')
                assets.append({**row, 'bundle': names[0], 'path_id': obj.path_id, 'width': image.width, 'height': image.height, 'sha256': file_hash(target)})
    write_json(output / 'manifest.json', {'assets': assets})
    return len(assets)


def extract_scores(resources, source, output):
    from tools.music_catalog import DIFFICULTIES
    from tools.score_inputs import write_score_inputs
    from analysis.crypto.decrypt_global_formal_scores import text_payload
    rows = {r['_id']: r for r in resources.rows('MasterLiveMusicScore')}
    scores = {}
    for song in resources.rows('MasterLiveMusic'):
        for _, field in DIFFICULTIES:
            logical = rows[song[field]]['_musicScoreTextFileName']
            stem = 'live_assets_live_musicscore_' + logical.lower().replace('/', '_') + '_'
            loc = resources.prefix(stem)
            env = resources.environment(loc.primary_key)
            payloads = [text_payload(o.read().m_Script) for o in env.objects if o.type.name == 'TextAsset']
            if len(payloads) != 1 or not isinstance(json.loads(gzip.decompress(payloads[0])).get('score'), dict):
                raise ValueError('invalid current score: ' + logical)
            scores[logical + '.bytes'] = payloads[0]
    write_score_inputs(source, scores, output)
    return len(scores)


def extract_stories(resources, source, output):
    from tools.extract_global_stories import command_enum
    from tools.story_text import MASTER_TABLES, LOCALE_FIELDS, parse_document
    from analysis.crypto.decrypt_global_formal_scores import text_payload
    enums = command_enum(resources.metadata)
    advs = {r['_id']: r for r in resources.rows('MasterAdv')}
    ids = sorted({r['_advId'] for table in ('MasterStoryEpisode', 'MasterStoryFriendshipEpisode') for r in resources.rows(table)})
    documents, receipts = [], []
    for identifier in ids:
        name = advs[identifier]['_advEpisodeAsset']
        payload = {'name': name}
        for suffix in ('', '-text'):
            loc = resources.prefix(f'adv_assets_adv_episode_{name}_{name}{suffix}_')
            env = resources.environment(loc.primary_key)
            found = []
            for obj in env.objects:
                if suffix and obj.type.name == 'TextAsset':
                    data = obj.read()
                    if data.m_Name == name + '-Text': found.append(json.loads(text_payload(data.m_Script))['_allData'])
                elif not suffix and obj.type.name == 'MonoBehaviour':
                    tree = obj.read_typetree()
                    if tree.get('m_Name') == name and isinstance(tree.get('Collection'), list): found.append({'Collection': tree['Collection']})
            if len(found) != 1: raise ValueError('no unique current ADV object: ' + name)
            payload['texts' if suffix else 'root'] = found[0]
            receipts.append({'bundle': loc.primary_key, 'sha256': resources.used[loc.primary_key]['sha256']})
        for locale in LOCALE_FIELDS:
            parse_document(payload['root'], payload['texts'], locale,
                           fallback_locale='ja' if source['region'] == 'jp' else None)
        destination = output / 'documents' / f'adv-{identifier}.json'
        write_json(destination, payload)
        documents.append({'advId': identifier, 'path': f'documents/adv-{identifier}.json', 'sha256': file_hash(destination)})
    write_json(output / 'index.json', {'schemaVersion': 1, 'sourceReleaseId': source['contentReleaseId'],
        'catalogSha256': resources.report['catalogSha256'], 'metadataSha256': file_hash(resources.metadata_path),
        'masterSha256': {n: file_hash(resources.master / (n + '.json')) for n in MASTER_TABLES}, 'documents': documents})
    write_json(output / 'report.json', {'stories': len(documents), 'receipts': receipts, 'commandEnum': enums})
    return len(documents)


def extract_audio(resources, source, previous, output):
    from tools.import_global_music_audio import song_bundles, find_executable, discover_split_acb, process_split_acb, process_acb, CURRENT_USM_KEY
    from tools.music_audio_inputs import read_music_audio_inputs
    prior_path = read_music_audio_inputs(previous, ROOT)
    prior = {Path(r['source']).name: r for r in read_json(prior_path)['files']} if prior_path else {}
    records = []
    for track_id, cue, loc in song_bundles(resources.master, resources.catalog.locations):
        record = copy.deepcopy(prior.get(loc.primary_key))
        if record:
            for stream in record['streams']:
                verified_copy(contained(prior_path.parent, stream['output']), contained(output, stream['output']), stream['sha256'])
        else:
            ffmpeg = find_executable(None, ('ffmpeg',))
            vgmstream = find_executable(None, ('vgmstream-cli', '/opt/homebrew/bin/vgmstream-cli'))
            bundle = resources.get(loc)
            with tempfile.TemporaryDirectory() as folder:
                (Path(folder) / bundle.name).symlink_to(bundle)
                candidates = discover_split_acb(Path(folder))
            if len(candidates) != 1 or candidates[0].cue_sheet != cue: raise ValueError('no unique current audio cue')
            candidate = candidates[0]; candidate.source = bundle
            record = process_split_acb(candidate, output, output / '_work', CURRENT_USM_KEY, vgmstream, ffmpeg, process_acb)
            record.pop('hca_key', None)
            if not record['ok'] or len(record.get('streams', [])) != 1: raise ValueError('current audio decode failed: ' + cue)
            for stream in record['streams']:
                path = Path(stream['output'])
                stream.update(sha256=file_hash(path), output=str(path.relative_to(output)))
        record.update(source='bundles/' + loc.primary_key, trackId=f'music-{track_id}')
        records.append(record)
    write_json(output / 'cri-media-report.json', {'schemaVersion': 1, 'identity': {k: source[k] for k in ('region','channel','contentReleaseId')},
        'catalogSha256': resources.report['catalogSha256'], 'files': records, 'complete': True})
    return len(records)


def refresh_current(snapshot, baseline_catalog, plan, output, *, decoder=None):
    """Prepare every supported module with independently resumable checkpoints."""
    from tools.release_preflight import load_plan, check_environment
    from tools.global_remote_sync import validate_manifest
    from tools.resource_pipeline.golden import CURRENT_SITE_MASTER_TABLES, _master_aggregate, _master_row_count
    from tools.current_content_media import gallery, mission_images, live2d, immersive, auto_stage, costume_icons
    from tools.current_bgm_inputs import extract_bgm
    from tools.current_growth_inputs import growth
    from tools.supplemental_inputs import read_supplemental
    if output.exists(): raise ValueError('current input output already exists')
    if (ROOT / 'output').resolve() not in output.resolve().parents: raise ValueError('current inputs must be under output/')
    previous = next(s for s in load_plan(plan) if s['id'] == 'global-production')
    if check_environment(previous, ROOT)['status'] != 'passed': raise ValueError('previous inputs failed validation')
    baseline = read_json(ROOT / previous['manifest'])
    report = read_json(snapshot / 'report.json')
    if file_hash(baseline_catalog) != baseline['objects']['remoteCatalog']['sha256']: raise ValueError('wrong baseline catalog')
    apk = Path(decoder['apk']) if decoder else APK
    metadata = Path(decoder['metadata']) if decoder else METADATA
    if report['observation']['clientVersion'] != (decoder['clientVersion'] if decoder else baseline['client']['versionName']): raise ValueError('client decoder compatibility must be verified first')
    same_apk = file_hash(apk) == baseline['provenance']['apkSha256']['base.apk']
    if not decoder and not same_apk: raise ValueError('decoder APK identity mismatch')
    if file_hash(snapshot / 'Master/MasterManifest.json') != report['masterManifestSha256']: raise ValueError('Master manifest mismatch')
    master_rows = validate_manifest(read_json(snapshot / 'Master/MasterManifest.json'), report['observation']['masterVersion'])
    clear = read_json(snapshot / 'master-json/master-decrypt-report.json')
    records = {Path(r['source']).name: r for r in clear['results']}
    if clear['failures'] or len(records) != len(master_rows): raise ValueError('incomplete decrypted Master')
    for row in master_rows:
        if (file_hash(snapshot / 'Master' / row['name']) != row['hash'] or records[row['name']]['encrypted_sha256'] != row['hash']
                or file_hash(snapshot / 'master-json' / (Path(row['name']).stem + '.json')) != records[row['name']]['json_sha256']):
            raise ValueError('Master decryption provenance mismatch')
    resources = CurrentResources(snapshot, ROOT / 'output/global-update-workflow/cache', metadata, apk,
        sources=[ROOT / 'input/global/device-files/2026-09-24-v1.0.1-25', ROOT / 'output/verification/gallery-supplement-104',
                 ROOT / 'input/global/remote-immersive/2026-09-27-catalog-39b5d81f'], decoder=decoder)
    resources.prior_supplemental = read_supplemental(previous, ROOT)
    resources.prior_catalog = baseline_catalog
    release = release_id(report['observation'], report['catalogSha256']) + '-c' + file_hash(apk)[:12]
    source = {**previous, 'contentReleaseId': release}
    stage = output.with_name('.' + output.name + '.working')
    stage.mkdir(parents=True, exist_ok=True)
    fingerprint = {'report': file_hash(snapshot / 'report.json'), 'plan': file_hash(plan), 'decoder': file_hash(apk),
        'bundleDecoderBindingSha256': decoder.get('bundleDecoderBindingSha256') if decoder else None,
        'code': {name: file_hash(ROOT / 'tools' / name) for name in ('bundle_decoder.py','current_resources.py','current_content_inputs.py','current_content_media.py','export_immersive_scenes.py','prepare_auto_stage.py','current_bgm_inputs.py','current_input_cache.py','current_growth_inputs.py','costume_assets.py','costume_catalog.py')}}
    identity = stage / '.identity.json'
    if identity.exists() and read_json(identity) != fingerprint:
        raise ValueError('partial inputs belong to another source/compiler; use a new output directory')
    write_json(identity, fingerprint)
    counts = {}
    def module(name, folder, operation):
        marker = stage / ('.' + name + '.complete.json')
        if marker.exists():
            saved = read_json(marker)
            actual = {str(p.relative_to(folder)): file_hash(p) for p in folder.rglob('*') if p.is_file() and p.name != '.DS_Store'}
            if actual != saved['files']: raise ValueError('completed module was modified: ' + name)
            counts[name] = saved['count']; print('Reused module:', name, flush=True); return
        if folder.exists(): shutil.rmtree(folder)
        print('Extracting module:', name, flush=True)
        count = operation()
        files = {str(p.relative_to(folder)): file_hash(p) for p in folder.rglob('*') if p.is_file() and p.name != '.DS_Store'}
        write_json(marker, {'files': files, 'count': count})
        counts[name] = count
    def copy_master():
        for row in master_rows:
            name = Path(row['name']).stem + '.json'
            verified_copy(snapshot / 'master-json' / name, stage / 'master' / name, records[row['name']]['json_sha256'])
        return len(master_rows)
    module('master', stage / 'master', copy_master)
    module('images', stage / 'assets', lambda: extract_images(resources, previous, stage / 'assets', same_apk=same_apk))
    module('scores', stage / 'scores', lambda: extract_scores(resources, source, stage / 'scores'))
    module('stories', stage / 'stories', lambda: extract_stories(resources, source, stage / 'stories'))
    module('audio', stage / 'audio', lambda: extract_audio(resources, source, previous, stage / 'audio'))
    module('bgm', stage / 'bgm', lambda: extract_bgm(resources, source, previous, stage / 'bgm'))
    supplemental = stage / 'supplemental'
    public, data = supplemental / 'public', supplemental / 'data'
    module('gallery', public / 'gallery', lambda: gallery(resources, public / 'gallery'))
    module('costumes', public / 'costumes', lambda: costume_icons(resources, public / 'costumes'))
    module('growth', public / 'growth', lambda: growth(resources, public / 'growth'))
    # Both mission groups are produced together in their own staging root.
    module('missions', supplemental / 'missions', lambda: mission_images(resources, supplemental / 'missions'))
    for group in ('system-banners','mission-rewards'):
        if (public / group).exists(): shutil.rmtree(public / group)
        shutil.copytree(supplemental / 'missions' / group, public / group)
    def models():
        return live2d(resources, release, stage / 'stories', supplemental / 'models/public', supplemental / 'models/data')
    module('live2d', supplemental / 'models', models)
    def scenes():
        return immersive(resources, release, supplemental / 'scenes/public', supplemental / 'scenes/data')
    module('immersive', supplemental / 'scenes', scenes)
    module('auto-stage', supplemental / 'stage', lambda: auto_stage(resources, supplemental / 'stage/public', supplemental / 'stage/data'))
    # Read-only hard links avoid holding duplicate converted media in staging.
    for module_name, group, catalog in [('models','live2d','live2d-catalog.json'),('scenes','immersive','immersive-scenes.json'),('stage','auto-stage','auto-stage-skin.json')]:
        target = public / group
        if target.exists(): shutil.rmtree(target)
        import os
        shutil.copytree(supplemental / module_name / 'public' / group, target, copy_function=os.link)
        data.mkdir(exist_ok=True)
        shutil.copyfile(supplemental / module_name / 'data' / catalog, data / catalog)
    assets = stage / 'assets/manifest.json'
    manifest = copy.deepcopy(baseline)
    manifest['identity']['contentReleaseId'] = release
    if decoder:
        manifest['client'].update(versionName=decoder['clientVersion'], versionCode=decoder['versionCode'], packageName=decoder['packageName'])
        manifest['provenance']['apkSha256'] = {'base.apk': decoder['apkSha256']}
        manifest['provenance']['decoderProfile'] = decoder
    table_records = [{'logicalName': p.name, 'sha256': file_hash(p)} for p in sorted((stage / 'master').glob('*.json'))]
    manifest['master']['aggregateSha256'] = _master_aggregate(table_records)
    manifest['objects']['assetManifest'] = {'sha256': file_hash(assets), 'byteSize': assets.stat().st_size}
    manifest['objects']['remoteCatalog'] = {'sha256': report['catalogSha256']}
    manifest['statistics']['criticalTableRows'] = {n: _master_row_count(read_json(stage / 'master' / (n + '.json')), n) for n in CURRENT_SITE_MASTER_TABLES}
    manifest['statistics']['masterTableCount'] = len(master_rows)
    manifest['provenance'].update(remoteCatalogSha256=report['catalogSha256'], masterManifestSha256=report['masterManifestSha256'],
        remoteCodeChanged=report['remoteCodeChanged'], remoteSnapshotReport=str((snapshot / 'report.json').resolve().relative_to(ROOT)))
    write_json(stage / 'content-release.json', manifest)
    def final(name): return str((output.resolve() / name).relative_to(ROOT))
    source.update(manifest=final('content-release.json'), manifestSha256=file_hash(stage / 'content-release.json'),
        masterRoot=final('master'), assetManifest=final('assets/manifest.json'), extractedRoot=final('assets'),
        scoreInputs={'index': final('scores/index.json'), 'sha256': file_hash(stage / 'scores/index.json')},
        storyInputs={'index': final('stories/index.json'), 'sha256': file_hash(stage / 'stories/index.json')},
        musicAudioInputs={'report': final('audio/cri-media-report.json'), 'sha256': file_hash(stage / 'audio/cri-media-report.json')})
    source['bgmAudioInputs'] = {'report': final('bgm/bgm-audio-report.json'), 'sha256': file_hash(stage / 'bgm/bgm-audio-report.json')}
    files = {str(p.relative_to(supplemental)): file_hash(p) for group in (public, data) for p in sorted(group.rglob('*')) if p.is_file() and p.name != '.DS_Store'}
    write_json(supplemental / 'manifest.json', {'schemaVersion': 1, 'contentReleaseId': release, 'catalogSha256': report['catalogSha256'], 'files': files})
    source['supplementalInputs'] = {'root': final('supplemental'), 'sha256': file_hash(supplemental / 'manifest.json')}
    resources.save_receipts(stage / 'resource-receipts.json')
    write_json(stage / 'release-inputs.json', {'schemaVersion': 1, 'environments': [source]})
    write_json(stage / 'refresh-report.json', {'contentReleaseId': release, 'modules': counts, 'remoteCodeChanged': report['remoteCodeChanged'], 'publicationReady': False})
    stage.rename(output)
    if check_environment(source, ROOT)['status'] != 'passed': raise ValueError('current inputs failed final preflight')
    return read_json(output / 'refresh-report.json')
