"""Verified current catalog access with a reusable, on-demand bundle cache."""
from __future__ import annotations
import gc
import hashlib
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

from tools.global_remote_sync import acquire, file_hash, read_json, write_json, remote_path
from tools.resource_pipeline.catalog_adapter import CatalogAdapter


class CurrentResources:
    def __init__(self, snapshot, cache, metadata, apk, *, sources=(), max_download_bytes=2_000_000_000, decoder=None):
        self.snapshot, self.cache = Path(snapshot), Path(cache)
        self.report = read_json(self.snapshot / 'report.json')
        if self.report['status'] != 'verified_snapshot' or read_json(self.snapshot / 'status.json')['status'] != 'verified_snapshot':
            raise ValueError('current resources require a verified snapshot')
        catalog = self.snapshot / 'RemoteCatalog/catalog_main.bin'
        if file_hash(catalog) != self.report['catalogSha256']:
            raise ValueError('current catalog digest mismatch')
        self.catalog = CatalogAdapter().parse(catalog)
        self.locations = {}
        self.by_key = {}
        for loc in self.catalog.locations:
            self.by_key.setdefault(loc.primary_key, []).append(loc)
            self.locations.setdefault(loc.primary_key, loc)
        self.master = self.snapshot / 'master-json'
        self.metadata_path, self.apk = Path(metadata), Path(apk)
        from analysis.crypto.decrypt_global_formal_scores import METADATA_SHA256, MetadataV39, field_bytes, KEY_FIELD_USAGE, NONCE_SEED_FIELD_USAGE
        expected_metadata = decoder['metadataSha256'] if decoder else METADATA_SHA256
        if file_hash(self.metadata_path) != expected_metadata:
            raise ValueError('unsupported decoder metadata')
        if decoder and (decoder.get('signatureVerified') is not True or file_hash(self.apk) != decoder['apkSha256']):
            raise ValueError('decoder APK provenance mismatch')
        self.metadata = MetadataV39(self.metadata_path)
        if decoder:
            from tools.bundle_decoder import resolve_bundle_decoder
            self.key, self.seed, binding = resolve_bundle_decoder(
                self.metadata, decoder['clientVersion'], profile=decoder.get('bundleDecoderProfile'))
            if decoder.get('bundleDecoderBindingSha256') != binding:
                raise ValueError('bundle decoder binding changed since intake')
        else:
            # Historical offline mode already requires the exact pinned metadata.
            self.key = field_bytes(self.metadata, KEY_FIELD_USAGE, 16)
            self.seed = field_bytes(self.metadata, NONCE_SEED_FIELD_USAGE, 8)
        self.downloaded, self.budget = 0, max_download_bytes
        self.imports = {}
        self.used = {}
        self._environment = None
        self._environment_name = None
        for root in [self.snapshot, *map(Path, sources)]:
            self.index_source(root)

    def rows(self, name):
        return read_json(self.master / (name + '.json'))['_allData']

    def index_source(self, root):
        if (root / 'capture.json').is_file():
            report = read_json(root / 'capture.json')
            for row in report['files']:
                path = root / row.get('path', '')
                if path.suffix == '.bundle':
                    token = path.name.split('_')[0]
                    self.imports[token] = (path, row['sha256'])
        if (root / 'report.json').is_file():
            for row in read_json(root / 'report.json').get('files', []):
                path = Path(row.get('path', ''))
                if not path.is_absolute():
                    path = root / path
                if path.suffix == '.bundle':
                    self.imports[path.name] = (path, row['sha256'])
        # Supplemental acquisitions have per-file receipts.
        if root.is_dir():
            for receipt in root.glob('*.receipt.json'):
                row = read_json(receipt)
                name = receipt.name.removesuffix('.receipt.json')
                if not name.endswith('.bundle'): name += '.bundle'
                self.imports[name] = (root / name, row['sha256'])
            manifest = root / 'manifest.json'
            if manifest.is_file():
                for row in read_json(manifest).get('files', []):
                    if 'bundle' in row and 'path' in row and 'sha256' in row:
                        p = Path(row['path'])
                        if not p.is_absolute(): p = Path(__file__).resolve().parents[1] / p
                        self.imports[row['bundle']] = (p, row['sha256'])

    def locate(self, key, resource_type=None):
        rows = self.by_key.get(key, [])
        if resource_type: rows = [r for r in rows if r.resource_type == resource_type]
        unique = {(r.internal_id, r.dependencies, r.provider_id): r for r in rows}
        if len(unique) != 1: raise ValueError('missing or ambiguous current catalog entry: ' + key)
        return next(iter(unique.values()))

    def prefix(self, prefix):
        found = [loc for name, loc in self.locations.items() if name.startswith(prefix)
                 and re.fullmatch('[a-f0-9]{32}\\.bundle', name[len(prefix):])]
        if len(found) != 1: raise ValueError('no unique resource for ' + prefix)
        return found[0]

    def bundle_for(self, key):
        loc = self.locate(key)
        found = [self.locate(name) for name in loc.dependencies if name.endswith('.bundle')]
        if len(found) != 1: raise ValueError('no unique resource dependency for ' + key)
        return found[0]

    def get(self, loc):
        name = loc.primary_key
        if name.startswith('/') or '..' in Path(name).parts or not re.fullmatch(r'[a-zA-Z0-9_./-]+', name):
            raise ValueError('unsafe resource cache key')
        # Catalog keys can nearly exhaust NAME_MAX; leave room for receipts.
        cache_name = name if '/' not in name and len(name.encode()) <= 180 else hashlib.sha256((name + (self.report['catalogSha256'] if '/' in name else '')).encode()).hexdigest() + '.bundle'
        path = self.cache / 'bundles' / cache_name
        receipt = path.with_name(path.name + '.receipt.json')
        url = self.report['observation']['cdnRoot'] + remote_path(loc.internal_id)
        if receipt.exists() and path.exists():
            row = read_json(receipt)
            if (row['url'] == url and row['byteSize'] == loc.expected_size
                    and path.stat().st_size == loc.expected_size and file_hash(path) == row['sha256']):
                self.used[name] = row
                return path
            raise ValueError('cached resource integrity mismatch: ' + name)
        imported = self.imports.get(name) or self.imports.get(name[:-7].rsplit('_', 1)[-1])
        if imported and imported[0].is_file() and imported[0].stat().st_size == loc.expected_size:
            if file_hash(imported[0]) != imported[1]: raise ValueError('import resource digest mismatch')
            path.parent.mkdir(parents=True, exist_ok=True)
            # Never truncate a cache inode that may also belong to sealed inputs.
            with tempfile.TemporaryDirectory(prefix='.import-', dir=path.parent) as staging:
                temporary = Path(staging) / 'bundle'
                shutil.copyfile(imported[0], temporary)
                if temporary.stat().st_size != loc.expected_size or file_hash(temporary) != imported[1]:
                    raise ValueError('import resource copy integrity mismatch')
                row = {'url': url, 'sha256': imported[1], 'byteSize': loc.expected_size, 'origin': 'verified-local'}
                # As with downloads, a receipt may survive an interrupted rename;
                # the next lookup validates both bytes and receipt before reuse.
                write_json(receipt, row)
                temporary.replace(path)
        else:
            if self.downloaded + loc.expected_size > self.budget:
                raise ValueError('resource download budget exceeded; cache retained')
            row = acquire(url, path, loc.expected_size)
            self.downloaded += loc.expected_size
        self.used[name] = row
        return path

    def clear(self, name):
        from analysis.crypto.decrypt_global_formal_scores import decrypt_header
        raw = self.get(self.locate(name)).read_bytes()
        return raw if raw.startswith(b'UnityFS\0') else decrypt_header(raw, name, self.key, self.seed)

    def environment(self, name):
        from analysis.crypto.decrypt_global_formal_scores import UnityPy, decrypt_header
        if name != self._environment_name:
            self._environment = None
            gc.collect()
            if name in self.locations:
                raw = self.clear(name)
            else:
                with zipfile.ZipFile(self.apk) as archive:
                    matches = [p for p in archive.namelist() if Path(p).name == name]
                    if len(matches) != 1: raise ValueError('missing unique packaged bundle: ' + name)
                    packaged = matches
                    # Localized sprites share the packaged fixed UI atlas.
                    if name.startswith(('localization-assets-', 'ui_assets_embui_atlas_fixuispriteatlas_')):
                        atlases = [p for p in archive.namelist() if 'ui_assets_embui_atlas_fixuispriteatlas_' in p and p.endswith('.bundle')]
                        if len(atlases) != 1: raise ValueError('missing unique packaged UI atlas')
                        packaged = list(dict.fromkeys([*atlases, *matches]))
                    environment = UnityPy.Environment()
                    for member in packaged:
                        raw = archive.read(member)
                        if not raw.startswith(b'UnityFS\0'): raw = decrypt_header(raw, Path(member).name, self.key, self.seed)
                        environment.load_file(raw, name=Path(member).name)
                    self._environment = environment
                    self._environment_name = name
                    return environment
            self._environment = UnityPy.load(raw)
            self._environment_name = name
        return self._environment

    def texture(self, loc, container):
        env = self.environment(loc.primary_key)
        matches = [obj for path, obj in env.container.items() if path == container and obj.type.name == 'Texture2D']
        if len(matches) != 1: raise ValueError('missing unique image object: ' + container)
        obj = matches[0]
        return obj, obj.read()

    def image(self, reference):
        loc = self.locate(reference, 'UnityEngine.Texture2D')
        bundles = [self.locate(n) for n in loc.dependencies if n.endswith('.bundle')]
        if len(bundles) != 1: raise ValueError('ambiguous texture dependency: ' + reference)
        return self.texture(bundles[0], loc.internal_id)

    def save_receipts(self, path):
        write_json(path, {'catalogSha256': self.report['catalogSha256'], 'downloadedBytes': self.downloaded,
                          'resources': self.used})
