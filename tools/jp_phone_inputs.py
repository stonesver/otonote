"""Build isolated JP inputs from a pinned, read-only Android capture.

No account files or raw inputs are published. Reuses the common compiler APIs;
resources come from this capture, its APK, or a byte-verified identical catalog cache.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
from urllib.parse import urlsplit, unquote

from tools.current_resources import CurrentResources
from tools.global_remote_sync import read_json, write_json, file_hash
from tools.resource_pipeline.catalog_adapter import CatalogAdapter
from tools.resource_pipeline.golden import CURRENT_SITE_MASTER_TABLES, _master_aggregate, _master_row_count
from tools.release_preflight import check_environment

ROOT = Path(__file__).resolve().parents[1]
JP_METADATA_SHA256 = '7a1b2ab310706f9301edc1cbf7d1b4785ecb764b75a1807f6d3bf3b5b7834bcf'


def extract_taxonomy(resources, output):
    from tools.build_site_catalog import CARD_TAXONOMY_NAMES
    from tools.card_taxonomy import build_card_taxonomy
    atlases = [n for n in resources.packaged if n.startswith('ui_assets_embui_atlas_fixuispriteatlas_')]
    if len(atlases) != 1: raise ValueError('missing unique JP UI atlas')
    records = []
    for name in [atlases[0], 'localization-assets-japanese(ja)_assets_all.bundle']:
        env = resources.environment(name)
        for obj in env.objects:
            if obj.type.name != 'Sprite': continue
            data = obj.read(); key = data.m_Name.lower()
            if key not in CARD_TAXONOMY_NAMES or (key == 'icon_awakened') != name.startswith('localization-'): continue
            image = data.image
            target = output/'png'/('jp-ui-'+key+'.png'); target.parent.mkdir(parents=True, exist_ok=True)
            if any(r['name'].lower() == key for r in records): raise ValueError('duplicate JP taxonomy sprite: '+key)
            image.save(target, 'PNG')
            records.append({'type':'Sprite','name':data.m_Name,'bundle':name,'path_id':obj.path_id,
                'container_path':'','exported_file':str(target.relative_to(output)),
                'width':image.width,'height':image.height,'sha256':file_hash(target)})
    # Fail closed if this APK no longer supplies the site's full taxonomy.
    build_card_taxonomy([{**r,'source_file':r['exported_file']} for r in records],
                        {r['exported_file']:str(r['path_id']) for r in records})
    write_json(output/'manifest.json', {'assets':records})
    return len(records)


class PhoneResources(CurrentResources):
    def __init__(self, capture, master, metadata, apk, cache):
        from analysis.crypto.decrypt_global_formal_scores import MetadataV39, field_bytes
        self.snapshot, self.master, self.metadata_path, self.apk, self.cache = map(Path, (capture, master, metadata, apk, cache))
        if file_hash(self.metadata_path) != JP_METADATA_SHA256:
            raise ValueError('JP 1.0.4 metadata changed; review field references before decoding')
        self.metadata = MetadataV39(self.metadata_path)
        self.key = field_bytes(self.metadata, 0x8000020B, 16)
        self.seed = field_bytes(self.metadata, 0x80000213, 8)
        catalog = self.snapshot / 'RemoteCatalog/catalog_main.bin'
        self.catalog = CatalogAdapter().parse(catalog)
        self.report = {'catalogSha256': file_hash(catalog), 'observation': {'resourceVersion': 'jp-phone-20260930'}}
        self.locations, self.by_key = {}, defaultdict(list)
        for loc in self.catalog.locations:
            self.locations.setdefault(loc.primary_key, loc)
            self.by_key[loc.primary_key].append(loc)
        self.encrypted = {p.name.split('_')[0]: p for p in (self.snapshot/'EncryptedBundles').glob('*.bundle')}
        self.cached = defaultdict(list)
        for p in (self.snapshot/'Addressables').rglob('*'):
            if p.is_file() and p.name != '__info':
                self.cached[p.parent.name].append(p)
        self.used, self.downloaded = {}, 0
        self.shared = {}
        self._environment = self._environment_name = None
        self.prior_supplemental = self.cache / 'empty-prior'
        self.prior_supplemental.mkdir(parents=True, exist_ok=True)
        self.prior_catalog = catalog
        self.packaged = {}
        with zipfile.ZipFile(self.apk) as archive:
            for name in archive.namelist():
                if name.endswith('.bundle'): self.packaged[Path(name).name] = name

    def reuse_local(self, catalog, caches):
        """Reuse bytes only when both catalogs bind the exact same resource.

        Never imports the other edition's Master, labels, or generated JSON.
        Receipt SHA-256 is rechecked on access; no network fallback is allowed.
        """
        prior = CatalogAdapter().parse(Path(catalog))
        compatible = set()
        for old in prior.locations:
            current = self.locations.get(old.primary_key)
            if current and current.expected_hash and current.expected_size and (
                current.expected_hash, current.expected_size, current.provider_id, current.resource_type
            ) == (old.expected_hash, old.expected_size, old.provider_id, old.resource_type):
                compatible.add(old.primary_key)
        for cache in caches:
            for receipt in Path(cache).resolve().rglob('*.receipt.json'):
                row = read_json(receipt)
                name = unquote(urlsplit(row.get('url','')).path).split('/asset/Android/',1)[-1]
                if name not in compatible: continue
                path = receipt.with_name(receipt.name.removesuffix('.receipt.json'))
                if not path.is_file() or path.stat().st_size != self.locations[name].expected_size: continue
                self.shared.setdefault(name, (path, row['sha256'], prior.catalog_hash))

    def get(self, loc):
        name = loc.primary_key
        token = name.removesuffix('.bundle').rsplit('_', 1)[-1]
        candidates = ([self.encrypted[token]] if token in self.encrypted else []) + self.cached.get(loc.expected_hash, [])
        # CRI's filesystem cache uses the content token in the catalog name,
        # while Unity's __data cache uses the AssetBundleRequestOptions hash.
        candidates += self.cached.get(token, [])
        candidates = list(dict.fromkeys(candidates))
        candidates = [p for p in candidates if p.stat().st_size == loc.expected_size]
        if len(candidates) == 1:
            path = candidates[0]
        elif name in self.packaged:
            path = self.cache / 'packaged' / name
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(self.apk) as archive: path.write_bytes(archive.read(self.packaged[name]))
            if path.stat().st_size != loc.expected_size: raise ValueError('packaged resource size mismatch: ' + name)
        elif name in self.shared:
            path, sha, catalog = self.shared[name]
            if file_hash(path) != sha: raise ValueError('shared local resource digest mismatch: ' + name)
            self.used[name] = {'sha256': sha, 'byteSize': path.stat().st_size, 'origin': 'identical-catalog-local-cache',
                               'path': str(path), 'sourceCatalogSha256': catalog, 'expectedHash': loc.expected_hash}
            return path
        else:
            raise ValueError('JP capture missing unique resource: ' + name)
        self.used[name] = {'sha256': file_hash(path), 'byteSize': path.stat().st_size, 'origin': 'jp-installed-client', 'path': str(path)}
        return path


def build(capture, master, metadata, apk_root, output, reuse_catalog=None, reuse_cache=(), prepare_only=()):
    from tools.current_content_inputs import extract_images, extract_scores, extract_stories, extract_audio
    from tools.current_bgm_inputs import extract_bgm
    from tools.current_content_media import gallery, mission_images, live2d, immersive, auto_stage, costume_icons
    from tools.current_growth_inputs import growth
    capture, master, metadata, apk_root, output = map(lambda p: Path(p).resolve(), (capture, master, metadata, apk_root, output))
    if ROOT/'output' not in output.parents or output.exists(): raise ValueError('use a new directory under output/')
    report = read_json(master/'master-decrypt-report.json')
    if report['failures']: raise ValueError('Master decryption is incomplete')
    for row in report['results']:
        if file_hash(capture/'Master'/Path(row['source']).name) != row['encrypted_sha256'] or file_hash(master/Path(row['output']).name) != row['json_sha256']:
            raise ValueError('Master decryption binding mismatch')
    stage = output.with_name('.' + output.name + '.working')
    stage.mkdir(parents=True, exist_ok=True)
    resources = PhoneResources(capture, master, metadata, apk_root/'split_UnityDataAssetPack.apk', stage/'.cache')
    if reuse_catalog: resources.reuse_local(reuse_catalog, reuse_cache)
    fingerprint = {'catalog': resources.report['catalogSha256'], 'master': file_hash(master/'master-decrypt-report.json'),
        'apks': {p.name:file_hash(p) for p in apk_root.glob('*.apk')}, 'metadata': file_hash(metadata)}
    if (stage/'.source.json').exists() and read_json(stage/'.source.json') != fingerprint: raise ValueError('source changed during JP intake')
    write_json(stage/'.source.json', fingerprint)
    release = 'jp-prod-20260930-v1-0-4-10053-' + hashlib.sha256(json.dumps(fingerprint,sort_keys=True).encode()).hexdigest()[:12]
    source = {'id':'jp-production','region':'jp','channel':'production','contentReleaseId':release}
    counts = {}
    def module(name, folder, operation, extra=()):
        if prepare_only and name not in prepare_only: return
        marker = stage/('.'+name+'.complete.json')
        def artifacts():
            files={str(p.relative_to(folder)):file_hash(p) for p in folder.rglob('*') if p.is_file() and p.name != '.DS_Store'}
            files.update({'@'+str(p.relative_to(stage)):file_hash(p) for p in extra})
            return files
        if marker.exists():
            saved=read_json(marker)
            actual=artifacts()
            expected={n:sha for n,sha in saved['files'].items() if Path(n).name != '.DS_Store'}
            if actual != expected: raise ValueError('changed completed JP module: '+name)
            resources.used.update(saved.get('sources',{}))
            counts[name]=saved['count']; print('Reused '+name, flush=True); return
        print('Extracting '+name, flush=True)
        count=operation()
        write_json(marker,{'count':count,'files':artifacts(),'sources':resources.used})
        counts[name]=count
    def masters():
        (stage/'master').mkdir(exist_ok=True)
        for p in master.glob('Master*.json'): shutil.copyfile(p,stage/'master'/p.name)
        return len(list((stage/'master').glob('*.json')))
    module('master',stage/'master',masters)
    empty=stage/'.empty-assets.json';write_json(empty,{'assets':[]})
    module('images',stage/'assets',lambda:extract_images(resources,{'assetManifest':str(empty),'extractedRoot':str(stage)},stage/'assets',same_apk=False))
    module('taxonomy',stage/'taxonomy',lambda:extract_taxonomy(resources,stage/'taxonomy'))
    module('scores',stage/'scores',lambda:extract_scores(resources,source,stage/'scores'))
    supplemental=stage/'supplemental';public=supplemental/'public';data=supplemental/'data'
    module('gallery',public/'gallery',lambda:gallery(resources,public/'gallery'))
    module('costumes', public / 'costumes', lambda: costume_icons(resources, public / 'costumes'))
    module('growth',public/'growth',lambda:growth(resources,public/'growth'))
    module('missions',supplemental/'missions',lambda:mission_images(resources,supplemental/'missions'))
    for group in ('system-banners','mission-rewards'):
        if (stage/'.missions.complete.json').exists():
            shutil.copytree(supplemental/'missions'/group,public/group,dirs_exist_ok=True)
    module('stage',public/'auto-stage',lambda:auto_stage(resources,public,data),(data/'auto-stage-skin.json',))
    module('scenes',public/'immersive',lambda:immersive(resources,release,public,data),(data/'immersive-scenes.json',))
    module('stories',stage/'stories',lambda:extract_stories(resources,source,stage/'stories'))
    module('models',public/'live2d',lambda:live2d(resources,release,stage/'stories',public,data),(data/'live2d-catalog.json',))
    module('audio',stage/'audio',lambda:extract_audio(resources,source,{},stage/'audio'))
    module('bgm',stage/'bgm',lambda:extract_bgm(resources,source,{},stage/'bgm'))
    if prepare_only: return {'status':'partial_preparation','modules':counts}
    assets=stage/'combined-assets.json'
    combined=[]
    for group in ('assets','taxonomy'):
        combined.extend({**r,'exported_file':group+'/'+r['exported_file']} for r in read_json(stage/group/'manifest.json')['assets'])
    write_json(assets, {'assets':combined})
    records=[{'logicalName':p.name,'sha256':file_hash(p)} for p in sorted((stage/'master').glob('*.json'))]
    manifest={'schemaVersion':1,'identity':{k:source[k] for k in ('region','channel','contentReleaseId')},
        'client':{'packageName':'com.bushiroad.sirius','versionName':'1.0.4','versionCode':10053,'unityVersion':(capture/'il2cpp/unity.ver').read_text().strip()},
        'master':{'aggregateSha256':_master_aggregate(records)},
        'objects':{'assetManifest':{'sha256':file_hash(assets),'byteSize':assets.stat().st_size},'remoteCatalog':{'sha256':resources.report['catalogSha256']}},
        'statistics':{'masterTableCount':len(records),'criticalTableRows':{n:_master_row_count(read_json(stage/'master'/(n+'.json')),n) for n in CURRENT_SITE_MASTER_TABLES}},
        'provenance':{'source':'adb-installed-client','capture':str(capture.relative_to(ROOT)),**fingerprint}}
    write_json(stage/'content-release.json',manifest)
    def final(name): return str((output/name).relative_to(ROOT))
    source.update(manifest=final('content-release.json'),manifestSha256=file_hash(stage/'content-release.json'),masterRoot=final('master'),assetManifest=final('combined-assets.json'),extractedRoot=str(output.relative_to(ROOT)))
    for field,name,key in [('scoreInputs','scores/index.json','index'),('storyInputs','stories/index.json','index'),('musicAudioInputs','audio/cri-media-report.json','report'),('bgmAudioInputs','bgm/bgm-audio-report.json','report')]:
        source[field]={key:final(name),'sha256':file_hash(stage/name)}
    files={str(p.relative_to(supplemental)):file_hash(p) for group in (public,data) for p in sorted(group.rglob('*')) if p.is_file() and p.name != '.DS_Store'}
    write_json(supplemental/'manifest.json',{'schemaVersion':1,'contentReleaseId':release,'catalogSha256':resources.report['catalogSha256'],'files':files})
    source['supplementalInputs']={'root':final('supplemental'),'sha256':file_hash(supplemental/'manifest.json')}
    resources.save_receipts(stage/'resource-receipts.json')
    write_json(stage/'release-inputs.json',{'schemaVersion':1,'environments':[source]})
    write_json(stage/'intake-report.json',{'contentReleaseId':release,'modules':counts,'source':fingerprint})
    stage.rename(output)
    if check_environment(source,ROOT)['status'] != 'passed': raise ValueError('JP final input preflight failed')
    return read_json(output/'intake-report.json')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('capture','master','metadata','apk-root','output'): parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--reuse-catalog',type=Path)
    parser.add_argument('--reuse-cache',type=Path,action='append',default=[])
    parser.add_argument('--prepare-only',action='append',default=[],choices=['master','images','taxonomy','scores','gallery','growth','missions','stage','scenes','stories','models','audio','bgm'])
    args=parser.parse_args()
    print(json.dumps(build(args.capture,args.master,args.metadata,args.apk_root,args.output,args.reuse_catalog,args.reuse_cache,args.prepare_only),ensure_ascii=False,indent=2))
