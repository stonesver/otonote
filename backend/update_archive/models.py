"""Canonical, bounded archive identities. No credentials or disk paths in views."""
from __future__ import annotations
import hashlib
import json
import math
import re
from pathlib import PurePosixPath

CAPACITY = 2 * 1024 ** 3
CONTROL_RESERVE = 64 * 1024 ** 2
WINDOW = 10 * 86400
MAX_CONTROL = 24 * 1024 ** 2
REGIONS = ('global', 'jp')


class ArchiveError(ValueError):
    """A safe fixed reason code suitable for the private workbench."""


class Conflict(ArchiveError):
    pass


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'),
                       allow_nan=False) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def identity(value):
    return digest(canonical(value))


def region(value):
    if value not in REGIONS:
        raise ArchiveError('invalid_region')
    return value


def safe_name(value):
    if (not isinstance(value, str) or not value or len(value.encode()) > 2048
            or any(ord(c) < 32 for c in value) or '\\' in value
            or value.startswith('/') or any(p in ('', '.', '..') for p in value.split('/'))):
        raise ArchiveError('invalid_relative_name')
    return value


def timestamp(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ArchiveError('invalid_timestamp')
    return value


def file_record(value):
    if not isinstance(value, dict) or value.get('source') not in ('remote_asset', 'master', 'client_entry'):
        raise ArchiveError('invalid_source')
    safe_name(value.get('key'))
    if type(value.get('size')) is not int or value['size'] < 0:
        raise ArchiveError('invalid_size')
    if value.get('sha256') is not None and not re.fullmatch('[a-f0-9]{64}', str(value['sha256'])):
        raise ArchiveError('invalid_digest')
    allowed = ('source', 'key', 'size', 'hash', 'hashAlgorithm', 'sha256', 'url', 'provider',
               'resourceType', 'dependencies', 'path', 'package', 'etag')
    result = {k: value[k] for k in allowed if k in value}
    if len(canonical(result)) > 16384:
        raise ArchiveError('record_too_large')
    return result
