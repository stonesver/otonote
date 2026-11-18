"""Publish only the reviewed five Arena badges, without changing content pointers."""
import base64
import hashlib
import json
import os
from pathlib import Path

from tools.r2_content import S3Bucket
from tools.release_candidate import canonical


def publish(bucket, payload, inventory):
    if set(payload) != set(inventory['files']):
        raise ValueError('badge inventory differs from reviewed source')
    files = {}
    for name, expected in inventory['files'].items():
        raw = base64.b64decode(payload[name], validate=True)
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('badge bytes differ from reviewed source')
        files[name] = raw
    manifest = canonical({'schemaVersion': 1, 'kind': 'arena-band-icons', 'files': inventory['files']})
    if hashlib.sha256(manifest).hexdigest()[:24] != inventory['releaseId']:
        raise ValueError('badge release identity mismatch')
    files['manifest.json'] = manifest
    for name, raw in files.items():
        key = 'content/releases/' + inventory['releaseId'] + '/' + name
        sha = hashlib.sha256(raw).hexdigest()
        bucket.put_new(key, raw, content_type='image/png' if name.endswith('.png') else 'application/json',
                       cache_control='public, max-age=31536000, immutable', sha256=sha)
        result = bucket.get(key)
        if result is None or hashlib.sha256(result[0]).hexdigest() != sha:
            raise ValueError('badge readback differs from reviewed source')
    return {'releaseId': inventory['releaseId'], 'verifiedObjects': len(files)}


if __name__ == '__main__':
    inventory = json.loads((Path(__file__).resolve().parents[1] / 'site/src/lib/arena-band-icons.json').read_text())
    print(json.dumps(publish(S3Bucket.from_environment(), json.loads(os.environ['BAND_ICON_BYTES']), inventory)))
