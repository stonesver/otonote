"""Export local R2 materialization and HTML delivery status for the private UI.

This host-side probe uses no R2 or GitHub credentials. It reports the local
materializer's verified identities, not the latest remote production result.
Keep this file compatible with the server's /usr/bin/python3 (Python 3.6).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


RELEASE = re.compile(r'/content/releases/([a-f0-9]{24})/manifest\.json\Z')
PAIR = re.compile(r'([a-f0-9]{24})-([a-f0-9]{24})\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
WORKFLOW_URL = 'https://github.com/stonesver/otonote/actions/workflows/content-r2.yml'
CONTENT_ROOT = Path('/srv/ournotes-r2-prerender-content')
RENDERED_ROOT = Path('/srv/ournotes-rendered')
TARGET = Path('/var/lib/ournotes-resource-state/latest-run.json')


def _regular_bytes(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('missing or unsafe delivery record')
    with path.open('rb') as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError('delivery record exceeds limit')
    return data


def _json(path, limit):
    value = json.loads(_regular_bytes(path, limit))
    if not isinstance(value, dict):
        raise ValueError('invalid delivery record')
    return value


def _pointer(content, region):
    path = content / ('current.json' if region == 'global' else 'jp/current.json')
    raw = _regular_bytes(path, 4096)
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('schemaVersion') != 1:
        raise ValueError('invalid local content pointer')
    manifest_path = value.get('manifest')
    match = RELEASE.fullmatch(manifest_path) if isinstance(manifest_path, str) else None
    checksum = value.get('sha256')
    release_id = value.get('contentReleaseId')
    if (not match or not isinstance(checksum, str) or not SHA256.fullmatch(checksum)
            or not isinstance(release_id, str) or len(release_id) > 200):
        raise ValueError('invalid local content pointer')
    return raw, value, match.group(1)


def _region(content, rendered, region, pointers):
    raw, pointer, release_id = pointers[region]
    release = content / 'releases' / release_id
    if release.is_symlink() or not release.is_dir():
        raise ValueError('missing local materialized release')
    manifest_raw = _regular_bytes(release / 'manifest.json', 4 * 1024 * 1024)
    if hashlib.sha256(manifest_raw).hexdigest() != pointer['sha256']:
        raise ValueError('local manifest differs from pointer')
    manifest = json.loads(manifest_raw)
    if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1
            or manifest.get('region', 'global') != region
            or manifest.get('root') != '/content/releases/' + release_id + '/'
            or manifest.get('contentReleaseId') != pointer['contentReleaseId']):
        raise ValueError('local manifest identity differs from pointer')
    receipt = _json(release / '.r2-materialization-receipt.json', 32 * 1024 * 1024)
    if (receipt.get('schemaVersion') != 1 or receipt.get('region') != region
            or receipt.get('releaseId') != release_id
            or receipt.get('pointerSha256') != hashlib.sha256(raw).hexdigest()
            or receipt.get('manifestSha256') != pointer['sha256']):
        raise ValueError('local materialization receipt differs from pointer')
    recorded = receipt.get('objects')
    if (not isinstance(recorded, dict) or
            recorded.get('manifest.json') != {'sha256': pointer['sha256'], 'bytes': len(manifest_raw)}):
        raise ValueError('local materialization receipt lacks manifest identity')

    name = 'current' if region == 'global' else 'current-jp'
    link = rendered / name
    if not link.is_symlink():
        raise ValueError('rendered current link is absent')
    target = os.readlink(str(link))
    if not target.startswith('releases/') or not PAIR.fullmatch(target[len('releases/'):]):
        raise ValueError('unsafe rendered current link')
    pair = target[len('releases/'):]
    final = rendered / target
    if final.is_symlink() or not final.is_dir():
        raise ValueError('rendered release is absent')
    complete = _json(final / 'complete.json', 256 * 1024)
    render_pointer = complete.get('pointer')
    other = 'jp' if region == 'global' else 'global'
    if (complete.get('schemaVersion') != 1 or complete.get('region') != region
            or complete.get('pair') != pair or complete.get('codeId') != pair[:24]
            or not isinstance(render_pointer, dict)
            or any(render_pointer.get(key) != value for key, value in pointer.items())
            or render_pointer.get('libraryPointers') != {other: pointers[other][1]}):
        raise ValueError('rendered HTML differs from local materialized pointer')
    return {'contentReleaseId': pointer['contentReleaseId'], 'releaseId': release_id,
            'manifestSha256': pointer['sha256'], 'renderPair': pair}


def collect(content=CONTENT_ROOT, rendered=RENDERED_ROOT):
    content, rendered = Path(content), Path(rendered)
    if content.is_symlink() or rendered.is_symlink():
        raise ValueError('linked delivery root')
    pointers = {region: _pointer(content, region) for region in ('global', 'jp')}
    regions = {region: _region(content, rendered, region, pointers)
               for region in ('global', 'jp')}
    # A materializer or HTML promotion may race the read. Never report a
    # mixed pair if either pointer or rendered link changed meanwhile.
    for region in ('global', 'jp'):
        current = content / ('current.json' if region == 'global' else 'jp/current.json')
        if _regular_bytes(current, 4096) != pointers[region][0]:
            raise ValueError('local pointer changed during status export')
        name = 'current' if region == 'global' else 'current-jp'
        if os.readlink(str(rendered / name)) != 'releases/' + regions[region]['renderPair']:
            raise ValueError('rendered current changed during status export')
    return regions


def export(content=CONTENT_ROOT, rendered=RENDERED_ROOT, target=TARGET):
    result = {'schemaVersion': 2, 'productionOwner': 'github-actions-r2',
              'status': 'unavailable', 'delivery': {'status': 'unavailable', 'regions': {}}}
    ready = False
    try:
        result['delivery'] = {'status': 'ready', 'regions': collect(content, rendered)}
        result['status'] = 'passed'
        ready = True
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass  # Replace any prior success with unavailable; do not leak paths.
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.r2-delivery-', dir=str(target.parent))
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(result, output, sort_keys=True, separators=(',', ':'))
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, str(target))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return ready


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--content', type=Path, default=CONTENT_ROOT)
    parser.add_argument('--rendered', type=Path, default=RENDERED_ROOT)
    parser.add_argument('--target', type=Path, default=TARGET)
    args = parser.parse_args()
    raise SystemExit(0 if export(args.content, args.rendered, args.target) else 1)


if __name__ == '__main__':
    main()
