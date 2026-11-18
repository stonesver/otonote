"""Read only the hash-bound, already-published Arena configuration."""
import hashlib
import json
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def arena_master_version(data, server):
    if server not in data.get('serverScopes',[]):return None
    versions=data.get('sourceMasterVersions')
    return versions.get(server) if versions is not None else data.get('sourceMasterVersion')


def read_public_projection(origin, fetch_bytes=None):
    """Use the same immutable content/hash chain as the existing ranking capture."""
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('invalid_content_origin')
    def fetch(path, limit):
        if fetch_bytes:
            raw = fetch_bytes(path)
        else:
            with urlopen(Request(origin.rstrip('/') + path, headers={'User-Agent': 'OurNotes-Arena-Ranking/1.0'}), timeout=15) as response:
                raw = response.read(limit + 1)
        if not isinstance(raw, bytes) or len(raw) > limit:
            raise ValueError('invalid_arena_content_response')
        return raw
    import re
    pointer = json.loads(fetch('/content/current.json', 16_384))
    manifest_path = pointer.get('manifest', '')
    if not re.fullmatch(r'/content/releases/[a-f0-9]{24}/manifest\.json', manifest_path):
        raise ValueError('invalid_arena_content_manifest')
    raw = fetch(manifest_path, 4_000_000)
    if hashlib.sha256(raw).hexdigest() != pointer.get('sha256'):
        raise ValueError('arena_content_manifest_hash_mismatch')
    manifest = json.loads(raw)
    root = manifest_path.removesuffix('manifest.json')
    if (manifest.get('region') != 'global' or manifest.get('root') != root
            or manifest.get('contentReleaseId') != pointer.get('contentReleaseId')):
        raise ValueError('arena_content_identity_mismatch')
    record = manifest.get('locales', {}).get('zh-CN', {}).get('files', {}).get('projection/arena.json')
    if record is None:
        return None
    path = record.get('path', '')
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', path) or path.startswith('/') or '..' in path.split('/'):
        raise ValueError('invalid_arena_projection_path')
    raw = fetch(root + path, 4_000_000)
    if hashlib.sha256(raw).hexdigest() != record.get('sha256'):
        raise ValueError('arena_projection_hash_mismatch')
    data = json.loads(raw)
    if data.get('sourceReleaseId') != pointer['contentReleaseId'] or data.get('region') != 'global':
        raise ValueError('arena_content_identity_mismatch')
    return data, hashlib.sha256(raw).hexdigest()

