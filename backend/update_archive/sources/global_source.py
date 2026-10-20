"""Global manifests and on-demand originals, independent of website downloads."""
from __future__ import annotations
import hashlib
import json
from ..models import ArchiveError, identity, file_record


class GlobalSource:
    region = 'global'
    file_limit = 256 * 1024 ** 2
    control_allowance = 16 * 1024 ** 2

    def __init__(self, client, *, packages=None):
        self.client, self.packages = client, packages
        self.received_bytes = 0

    def read(self, url, limit):
        body = self.client.get(url, limit).body
        if len(body) > limit:
            raise ArchiveError('source_control_too_large')
        self.received_bytes += len(body)
        return body

    def decode_catalog(self, raw):
        return raw

    def remote_records(self, catalog, observation):
        from tools.global_remote_sync import remote_assets
        return [file_record({'source': 'remote_asset', 'key': r['key'], 'path': r['path'],
            'size': r['byteSize'], 'hash': r['catalogHash'], 'hashAlgorithm': r['catalogHashAlgorithm'],
            'provider': r['provider'], 'url': observation['cdnRoot'] + r['path']})
            for r in remote_assets(catalog)]

    def snapshot(self, previous=None):
        from tools.resource_pipeline.catalog_adapter import CatalogAdapter
        from tools.global_remote_sync import validate_manifest
        from tools.resource_pipeline.adapters.global_public import version_identity
        previous = previous or {}
        first = self.client.discover()
        rows, hashes = [], {}
        for source in ('remote_asset', 'master'):
            old = previous.get(self.region + ':' + source)
            keys = ('clientVersion', 'resourceVersion', 'catalogHash', 'cdnRoot') if source == 'remote_asset' else ('clientVersion', 'masterVersion', 'cdnRoot')
            if old and all(old['observation'].get(k) == first.get(k) for k in keys):
                rows.extend(old['files'])
                field = 'catalogSha256' if source == 'remote_asset' else 'masterManifestSha256'
                hashes.update({k: old['observation'][k] for k in (field,)
                               if k in old['observation']})
                continue
            if source == 'remote_asset':
                wire = self.read(first['catalogUrl'], 64_000_000)
                raw = self.decode_catalog(wire)
                hashes['catalogSha256'] = hashlib.sha256(wire).hexdigest()
                rows.extend(self.remote_records(CatalogAdapter().parse_bytes(raw), first))
            else:
                raw = self.read(first['masterManifestUrl'], 4_000_000)
                hashes['masterManifestSha256'] = hashlib.sha256(raw).hexdigest()
                for item in validate_manifest(json.loads(raw), first['masterVersion']):
                    rows.append(file_record({'source': 'master', 'key': item['name'],
                        'size': item['size'], 'sha256': item['hash'], 'hashAlgorithm': 'sha256',
                        'url': first['masterManifestUrl'].rsplit('/', 1)[0] + '/' + item['name']}))
        if version_identity(self.client.discover()) != version_identity(first):
            raise ArchiveError('source_changed_during_observation')
        sources = ['remote_asset', 'master']
        if self.packages:
            try:
                rows.extend(self.packages.inventory(first['clientVersion']))
                sources.append('client_entry')
            except (ArchiveError, ValueError, OSError):
                hashes['clientNotice'] = 'verified_client_material_required'
        self.current_inventory = {(r['source'], r['key']): r for r in rows}
        return {'region': self.region, 'files': rows, 'sources': sources, 'fileLimit': self.file_limit,
                'observation': {**first, **hashes}}

    def validate_historical(self, record):
        if record.get('sha256') or record['source'] == 'client_entry':
            return
        from ..diff import same_content
        current = self.current_inventory.get((record['source'], record['key']))
        if not current or not same_content(record, current) or current.get('url') != record.get('url'):
            raise ArchiveError('historical_identity_unverifiable')

    def fetch(self, record, target):
        self.validate_historical(record)
        from tools.global_remote_sync import acquire
        if record['source'] == 'client_entry':
            return self.packages.fetch(record, target)
        result = acquire(record['url'], target, record['size'], expected_sha=record.get('sha256'), expected_etag=record.get('etag'))
        self.received_bytes += target.stat().st_size
        return result
