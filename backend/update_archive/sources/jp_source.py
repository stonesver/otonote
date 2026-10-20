from .global_source import GlobalSource
from ..models import file_record


class JpSource(GlobalSource):
    region = 'jp'
    file_limit = 256_000_000

    def decode_catalog(self, raw):
        from tools.resource_pipeline.adapters.jp_public import decode_catalog
        return decode_catalog(raw)

    def remote_records(self, catalog, observation):
        from tools.resource_pipeline.adapters.jp_public import asset_url
        from tools.jp_remote_sync import resource_identity
        rows = []
        for loc in catalog.locations:
            if not loc.internal_id.startswith('{Fwk.Resource.RemoteAssetDir}/'):
                continue
            proof = resource_identity(loc)
            rows.append(file_record({'source': 'remote_asset', 'key': loc.primary_key,
                'path': loc.internal_id, 'size': proof['size'], 'hash': proof['hash'],
                'hashAlgorithm': loc.expected_hash_algorithm, 'provider': loc.provider_id,
                'resourceType': loc.resource_type, 'url': asset_url(observation['resourceVersion'], loc.internal_id)}))
        return rows

    def fetch(self, record, target):
        self.validate_historical(record)
        if record['source'] == 'client_entry':
            return self.packages.fetch(record, target)
        from tools.jp_remote_sync import acquire
        result = acquire(self.client, record['url'], target, record['size'], expected_sha=record.get('sha256'),
                identity=record)
        self.received_bytes += target.stat().st_size
        return result
