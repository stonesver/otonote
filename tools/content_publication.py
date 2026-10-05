"""Publish versioned JSON and media; never compile or replace frontend code."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from tools.global_remote_sync import file_hash, read_json
from tools.immutable_files import link_or_copy
from tools.live2d_transport import bundle_live2d_tree

SCHEMA = 1
ROOT = Path(__file__).resolve().parents[1]
MEDIA_GROUPS = ('media', 'gallery', 'live2d', 'immersive', 'auto-stage', 'growth', 'system-banners', 'mission-rewards', 'costumes')


def pointer_directory(store, region):
    if region not in {'global', 'jp'}: raise ValueError('unsupported content region')
    return store if region == 'global' else store / region


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def inventory(root, *, exclude=()):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.name == '.DS_Store': continue
        if path.is_symlink(): raise ValueError('symlink in sealed content')
        if path.is_file() and str(path.relative_to(root)) not in exclude:
            result[str(path.relative_to(root))] = file_hash(path)
    return result


def verify_tree(root, files, *, exclude=()):
    if inventory(root, exclude=exclude) != files: raise ValueError('content inventory or digest mismatch')


def verify_references(stage, root):
    """No content pointer may expose JSON referencing an absent local resource."""
    def visit(value):
        if isinstance(value, str) and value.startswith(root):
            name = value[len(root):].split('#', 1)[0].split('?', 1)[0]
            target = (stage/name).resolve()
            if target != stage.resolve() and stage.resolve() not in target.parents:
                raise ValueError('unsafe content reference')
            if not target.exists(): raise ValueError('missing content reference: ' + name)
        elif isinstance(value, dict):
            for key, item in value.items(): visit(key); visit(item)
        elif isinstance(value, list):
            for item in value: visit(item)
    for path in stage.glob('*-*/**/*.json'): visit(read_json(path))
    for path in (stage/'en').rglob('*.json'): visit(read_json(path))


def rewrite(value, root, locale, release):
    if isinstance(value, str):
        if value.startswith('/data/releases/' + release + '/' + locale + '/'):
            return root + locale + '/' + value.split('/data/releases/' + release + '/' + locale + '/', 1)[1]
        if value.startswith('/data/'): return root + locale + '/' + value[6:]
        if any(value.startswith('/' + group + '/') for group in MEDIA_GROUPS): return root + 'public' + value
        return value
    if isinstance(value, list): return [rewrite(v, root, locale, release) for v in value]
    if isinstance(value, dict): return {rewrite(k, root, locale, release): rewrite(v, root, locale, release) for k, v in value.items()}
    return value


def publish_content(candidate, store, *, scoring_rules=None, recognition_index=None, expected_current=None,
                    ranking_cache=None):
    candidate, store = Path(candidate).resolve(), Path(store).resolve()
    if candidate == store or candidate in store.parents or store in candidate.parents: raise ValueError('content store overlaps candidate')
    if ranking_cache is None:
        ranking_cache = store/'.derived-cache'
    else:
        raw_cache = Path(ranking_cache).absolute()
        if any(path.is_symlink() for path in (raw_cache, *raw_cache.parents)):
            raise ValueError('linked ranking cache')
        ranking_cache = raw_cache.resolve()
        for protected in (candidate, store):
            if ranking_cache == protected or ranking_cache in protected.parents or protected in ranking_cache.parents:
                raise ValueError('ranking cache overlaps candidate or content store')
    source = read_json(candidate / 'candidate.json')
    if source.get('status') != 'candidate_generated' or source.get('historicalReplay'):
        raise ValueError('content requires a verified production candidate')
    verify_tree(candidate, source['files'], exclude=('candidate.json',))
    regions = source['regions']
    if len(regions) != 1 or regions[0]['region'] not in {'global', 'jp'} or regions[0]['channel'] != 'production': raise ValueError('unsupported content region')
    region = regions[0]; release = region['contentReleaseId']
    edition = region['region']
    if not re.fullmatch('[A-Za-z0-9_-]+', release) or region['path'] != edition + '/' + release: raise ValueError('unsafe content release')
    pointers = pointer_directory(store, edition)
    pointers.mkdir(parents=True, exist_ok=True)
    source_root = candidate / region['path']
    rules_path = Path(scoring_rules) if scoring_rules else source_root/'supplemental-data/formal-scoring-rules.json'
    if scoring_rules and not rules_path.is_file(): raise ValueError('scoring rules file is missing')
    if rules_path.exists():
        rules = read_json(rules_path)
        if rules.get('sourceReleaseId') != release: raise ValueError('scoring rules content release mismatch')
    else:
        # Old sealed candidates may predate the scoring artifact. Only the
        # original audited dataset may use the bundled baseline as a fallback.
        rules = read_json(ROOT/'packages/scoring/data/formal-scoring-rules.json')
        if rules.get('sourceReleaseId') != release:
            rules = {'schemaVersion':1,'sourceReleaseId':release,'verificationStatus':'unavailable'}
    index_path = Path(recognition_index) if recognition_index else source_root/'supplemental-data/card-recognition'
    recognition = None
    if recognition_index or index_path.exists():
        from tools.card_recognition import read_index
        recognition = read_index(index_path, edition, release)
    recognition_identity = json.dumps(recognition[0],sort_keys=True) if recognition else ''
    derivative_sources = [ROOT/'tools/card_recognition.py', ROOT/'tools/library_metadata.py', ROOT/'tools/live2d_transport.py', ROOT/'tools/content_derivatives.mjs',
        ROOT/'packages/scoring/song-ranking.mjs', ROOT/'packages/scoring/song-ranking-meta.mjs',
        ROOT/'packages/scoring/song-ranking-view.mjs', ROOT/'packages/scoring/song-skill-windows.mjs',
        ROOT/'packages/scoring/scoring-engine.mjs', ROOT/'packages/scoring/scoring-release-gate.mjs',ROOT/'packages/scoring/data/formal-scoring-rules.json']
    derivative_sources += sorted((ROOT/'packages/scoring/scoring-rules').glob('*.mjs'))
    derivative_sources += sorted((ROOT/'packages/scoring/server').glob('*.mjs'))
    derivative_hash = ''.join(file_hash(p) for p in derivative_sources)
    identity = hashlib.sha256((file_hash(candidate / 'candidate.json') + file_hash(Path(__file__)) + derivative_hash + json.dumps(rules,sort_keys=True) + recognition_identity + str(SCHEMA)).encode()).hexdigest()[:24]
    public_root = '/content/releases/' + identity + '/'
    (store / 'releases').mkdir(parents=True, exist_ok=True)
    with (store / '.publication.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if expected_current is not None:
            actual = file_hash(pointers/'current.json') if (pointers/'current.json').is_file() else ''
            if actual != expected_current:
                raise ValueError('published content changed during candidate confirmation')
        final = store / 'releases' / identity
        if final.is_symlink(): raise ValueError('linked content release')
        if not final.exists():
            stage = Path(tempfile.mkdtemp(prefix='.content-', dir=store / 'releases'))
            try:
                sample = next(p for p in (source_root/'public/media').rglob('*') if p.is_file() and p.name!='.DS_Store')
                probe=stage/'.link-probe'
                try:
                    os.link(sample,probe)
                except OSError:
                    required=sum(p.stat().st_size for group in MEDIA_GROUPS for p in (source_root/'public'/group).rglob('*') if p.is_file())
                    if shutil.disk_usage(stage).free < required + 256*1024*1024:
                        raise ValueError('insufficient disk for content copy; use a shared filesystem mount')
                finally:
                    probe.unlink(missing_ok=True)
                locales = [p['locale'] for p in region['projections']]
                if sorted(locales) != ['en','zh-CN']: raise ValueError('unsupported content locales')
                contexts = [{'contentReleaseId':release,'region':edition,'channel':'production','locale':locale,
                             'catalogPath':public_root+locale+'/catalog.json'} for locale in locales]
                for group in MEDIA_GROUPS:
                    if group == 'costumes' and not (source_root / 'public' / group).exists():
                        continue
                    shutil.copytree(source_root / 'public' / group, stage / 'public' / group, copy_function=link_or_copy, ignore=shutil.ignore_patterns('.DS_Store'))
                bundle_live2d_tree(stage / 'public' / 'live2d')
                manifest = {'schemaVersion':SCHEMA,'contentReleaseId':release,'region':edition,'channel':'production','root':public_root,'locales':{},
                            'limitations':['formal_gameplay_not_verified']}
                if recognition:
                    (stage/'recognition').mkdir()
                    (stage/'recognition/features.bin.gz').write_bytes(recognition[1])
                for context in contexts:
                    locale = context['locale']; records = {'files':{},'groups':{}}
                    data = source_root / 'generated/releases' / release / locale
                    def record(path): return {'path':str(path.relative_to(stage)),'sha256':file_hash(path),'bytes':path.stat().st_size}
                    def project(name, path, value):
                        target = stage / path; write(target, rewrite(value, public_root, locale, release))
                        records['files'][name] = record(target)
                    for path in sorted(data.rglob('*.json')):
                        relative = str(path.relative_to(data)); value = read_json(path)
                        from tools.library_metadata import enrich_projection
                        value = enrich_projection(relative, value, source_root/'public', data)
                        if relative == 'catalog.json' and value.get('projectionContext') != {k:context[k] for k in ('contentReleaseId','region','channel','locale')}:
                            raise ValueError('mixed projection identity')
                        # Media index has an internal digest of the rewritten records.
                        value = rewrite(value, public_root, locale, release)
                        if relative == 'media-index.json':
                            value['sha256'] = hashlib.sha256(json.dumps(value['records'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                        project('projection/'+relative,locale+'/'+relative,value)
                    project('projection/release-index.json',locale+'/release-index.json',{'schemaVersion':1,'active':context,'projections':contexts})
                    shard_manifest = stage/locale/'database-shards/manifest.json'
                    if shard_manifest.exists():
                        value = read_json(shard_manifest)
                        for item in value['files']:
                            target = (shard_manifest.parent/item['path']).resolve()
                            if shard_manifest.parent.resolve() not in target.parents: raise ValueError('unsafe shard path')
                            item.update(sha256=file_hash(target),byteSize=target.stat().st_size)
                        value['totalBytes'] = sum(item['byteSize'] for item in value['files'])
                        project('projection/database-shards/manifest.json',locale+'/database-shards/manifest.json',value)
                    for name in ('live2d-catalog.json','immersive-scenes.json','auto-stage-skin.json'):
                        value = read_json(source_root/'supplemental-data'/name)
                        if name == 'immersive-scenes.json':
                            from tools.library_metadata import enrich_scenes
                            value = enrich_scenes(value, source_root/'public')
                        project('supplemental/'+name,locale+'/_supplemental/'+name,value)
                    project('supplemental/music-previews.json',locale+'/_supplemental/music-previews.json',{'contentReleaseId':release,'tracks':{}})
                    if recognition:
                        catalog = read_json(data/'catalog.json')
                        ids = {c['id'] for kind in ('memberCards','supportCards') for c in catalog.get(kind,[])}
                        if any(c['id'] not in ids for c in recognition[0]['cards']):
                            raise ValueError('recognition card is absent from catalog')
                        project('supplemental/card-recognition.json',locale+'/_supplemental/card-recognition.json',recognition[0])
                    project('supplemental/formal-scoring-rules.json',locale+'/_supplemental/formal-scoring-rules.json',rules)
                    if 'musicCharts' in read_json(data/'catalog.json'):
                        target=stage/locale/'_supplemental/song-rankings.json'
                        subprocess.run([os.environ.get('OURNOTES_NODE','node'),'--max-old-space-size=96',str(ROOT/'tools/content_derivatives.mjs'),
                            str(source_root),release,locale,str(target),str(ranking_cache),
                            str(stage/locale/'_supplemental/formal-scoring-rules.json')],check=True,cwd=ROOT)
                        records['files']['supplemental/song-rankings.json']=record(target)
                    for group in ('growth','system-banners','mission-rewards'):
                        name = 'public/'+group+'/manifest.json'
                        project(name,locale+'/_supplemental/'+group+'.json',read_json(stage/name))
                    for group in ('skills','items','growth','member-cards','support-cards'):
                        folder = stage/locale/'database-shards'/group
                        values = {'@projection-data/database-shards/'+group+'/'+p.name:read_json(p) for p in sorted(folder.glob('*.json'))}
                        target = stage/locale/'_groups'/(group+'.json'); write(target,values)
                        records['groups']['@projection-data/database-shards/'+group+'/*.json'] = record(target)
                    manifest['locales'][locale] = records
                write(stage/'manifest.json',manifest)
                verify_references(stage, public_root)
                write(stage/'.receipt.json',{'schemaVersion':SCHEMA,'files':inventory(stage),'candidateSha256':file_hash(candidate/'candidate.json')})
                stage.chmod(0o755)
                for path in stage.rglob('*'):
                    mode = 0o755 if path.is_dir() else 0o644
                    if path.stat().st_mode & 0o777 != mode: path.chmod(mode)
                stage.rename(final)
            finally:
                if stage.exists(): shutil.rmtree(stage)
        receipt = read_json(final/'.receipt.json')
        if receipt.get('candidateSha256') != file_hash(candidate/'candidate.json'): raise ValueError('content candidate binding mismatch')
        verify_tree(final,receipt['files'],exclude=('.receipt.json',))
        pointer = {'schemaVersion':SCHEMA,'contentReleaseId':release,'manifest':public_root+'manifest.json','sha256':file_hash(final/'manifest.json')}
        current = pointers/'current.json'
        if current.exists() and read_json(current) == pointer:
            return {'status':'unchanged','snapshot':str(final),'pointer':pointer}
        if current.exists():
            temporary = pointers/'.previous.next.json'; temporary.write_bytes(current.read_bytes()); os.replace(temporary,pointers/'previous.json')
        temporary = pointers/'.current.next.json'; write(temporary,pointer); os.replace(temporary,current)
        return {'status':'content_published','snapshot':str(final),'pointer':pointer}


def rollback_content(store, *, region='global'):
    store=Path(store).resolve()
    pointers=pointer_directory(store, region)
    with (store/'.publication.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        previous=read_json(pointers/'previous.json')
        match=re.fullmatch(r'/content/releases/([a-f0-9]{24})/manifest.json',previous.get('manifest',''))
        if previous.get('schemaVersion')!=SCHEMA or not match: raise ValueError('invalid rollback pointer')
        target=store/'releases'/match[1]
        if target.is_symlink() or file_hash(target/'manifest.json')!=previous['sha256']: raise ValueError('rollback manifest mismatch')
        if read_json(target/'manifest.json').get('region', 'global') != region: raise ValueError('rollback edition mismatch')
        verify_tree(target,read_json(target/'.receipt.json')['files'],exclude=('.receipt.json',))
        current=(pointers/'current.json').read_bytes()
        write(pointers/'.current.next.json',previous);os.replace(pointers/'.current.next.json',pointers/'current.json')
        (pointers/'.previous.next.json').write_bytes(current);os.replace(pointers/'.previous.next.json',pointers/'previous.json')
        return {'status':'content_rolled_back','pointer':previous}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path); parser.add_argument('--store',type=Path,required=True)
    parser.add_argument('--recognition-index',type=Path,help='Version-bound browser recognition index directory')
    parser.add_argument('--scoring-rules',type=Path,help='Version-bound rules for an existing sealed candidate')
    parser.add_argument('--rollback',action='store_true')
    parser.add_argument('--region',choices=('global','jp'),default='global',help='Edition to roll back')
    args = parser.parse_args()
    if bool(args.candidate)==args.rollback: parser.error('choose --candidate or --rollback')
    if args.rollback and (args.scoring_rules or args.recognition_index): parser.error('--scoring-rules requires --candidate')
    print(json.dumps(rollback_content(args.store,region=args.region) if args.rollback else publish_content(args.candidate,args.store,scoring_rules=args.scoring_rules,recognition_index=args.recognition_index),ensure_ascii=False,indent=2))
