"""External, opt-in configuration; no SDK/network access when disabled."""
import json
import os
from pathlib import Path
import re
from .models import ArchiveError, REGIONS
from .store import ArchiveRepository, LocalBucket, S3Bucket


def validate_config(raw):
    if not isinstance(raw, dict) or raw.get('schemaVersion') != 1:
        raise ArchiveError('invalid_archive_config')
    c = dict(raw)
    if type(c.get('enabled', False)) is not bool:
        raise ArchiveError('invalid_archive_enabled')
    c.setdefault('enabled', False)
    if not c['enabled']:
        return c
    storage = c.get('storage', {})
    if not isinstance(storage, dict) or storage.get('type') not in ('local', 's3'):
        raise ArchiveError('archive_storage_required')
    if storage['type'] == 'local' and not isinstance(storage.get('root'), str):
        raise ArchiveError('archive_local_root_required')
    if storage['type'] == 's3' and not isinstance(storage.get('bucket'), str):
        raise ArchiveError('archive_bucket_required')
    if not isinstance(c.get('sources', {}), dict):
        raise ArchiveError('invalid_archive_sources')
    for selected, source in c.get('sources', {}).items():
        if selected not in REGIONS or not isinstance(source, dict):
            raise ArchiveError('invalid_archive_sources')
        checkpoint = source.get('checkpoint')
        if checkpoint and (not isinstance(checkpoint, dict) or (storage['type'] == 's3' and checkpoint.get('bucket') == storage['bucket'])):
            raise ArchiveError('archive_source_bucket_must_be_separate')
    return c


def load_config(path):
    p = Path(path)
    if p.is_symlink() or p.stat().st_size > 65536:
        raise ArchiveError('archive_config_unsafe')
    return validate_config(json.loads(p.read_text()))


def s3_client(env_prefix='OURNOTES_ARCHIVE'):
    if not re.fullmatch('[A-Z][A-Z0-9_]{2,64}', env_prefix):
        raise ArchiveError('invalid_secret_reference')
    import boto3
    from botocore.config import Config
    endpoint = os.environ.get(env_prefix + '_ENDPOINT')
    from urllib.parse import urlsplit
    parsed = urlsplit(endpoint or '')
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ArchiveError('invalid_archive_endpoint')
    return boto3.client('s3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=os.environ[env_prefix + '_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ[env_prefix + '_SECRET_ACCESS_KEY'],
        config=Config(signature_version='s3v4', connect_timeout=10, read_timeout=30,
                      retries={'mode': 'standard', 'max_attempts': 2}, max_pool_connections=4,
                      s3={'addressing_style': 'path'}))


def repository(config, *, clock=None):
    c = validate_config(config)
    if not c['enabled']:
        return None
    storage = c['storage']
    bucket = LocalBucket(storage['root']) if storage['type'] == 'local' else S3Bucket(
        s3_client(storage.get('envPrefix', 'OURNOTES_ARCHIVE')), storage['bucket'])
    return ArchiveRepository(bucket, **({'clock': clock} if clock else {}))
