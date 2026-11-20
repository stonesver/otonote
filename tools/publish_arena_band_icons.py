"""Publish only the reviewed five Arena badges, without changing content pointers."""
import base64
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from tools.publication_review import grant
from tools.r2_content import S3Bucket
from tools.release_candidate import canonical


def publish(bucket, payload, inventory):
    manifest = canonical({'schemaVersion': 1, 'kind': 'arena-band-icons', 'files': inventory['files']})
    manifest_sha = hashlib.sha256(manifest).hexdigest()
    identifier = inventory['releaseId']
    if manifest_sha[:24] != identifier:
        raise ValueError('badge release identity mismatch')
    prefix = f'content/releases/{identifier}/'
    expected = {**inventory['files'], 'manifest.json': manifest_sha}
    if payload is not None:
        if set(payload) != set(inventory['files']):
            raise ValueError('badge inventory differs from reviewed source')
        files = {name: base64.b64decode(encoded, validate=True) for name, encoded in payload.items()}
        files['manifest.json'] = manifest
        if any(hashlib.sha256(raw).hexdigest() != expected[name] for name, raw in files.items()):
            raise ValueError('badge bytes differ from reviewed source')
        for name, raw in files.items():
            bucket.put_new(prefix + name, raw, content_type='image/png' if name.endswith('.png') else 'application/json',
                           cache_control='public, max-age=31536000, immutable', sha256=expected[name])
    # Permission covers a release prefix. Verify its complete direct-object inventory before granting it.
    if set(bucket.list_identities(prefix)) != {prefix + name for name in expected}:
        raise ValueError('remote badge inventory differs from reviewed source')
    if bucket.get(f'content/storage/{identifier}/descriptor.json') is not None:
        raise ValueError('unexpected shared media layout for badge release')
    for name, sha in expected.items():
        result = bucket.get(prefix + name)
        if result is None or hashlib.sha256(result[0]).hexdigest() != sha:
            raise ValueError('badge readback differs from reviewed source')
    grant(bucket, {'manifest': '/' + prefix + 'manifest.json', 'sha256': manifest_sha}, 'global')
    return {'releaseId': inventory['releaseId'], 'verifiedObjects': len(expected)}


def verify_public(origin, inventory):
    for name, sha in inventory['files'].items():
        url = f"{origin}/content/releases/{inventory['releaseId']}/{name}"
        request = Request(url, headers={'User-Agent': 'OurNotes-Release-Verification/1.0'})
        with urlopen(request, timeout=30) as response:
            if (response.status != 200 or response.geturl() != url or response.headers.get_content_type() != 'image/png'
                    or hashlib.sha256(response.read()).hexdigest() != sha):
                raise ValueError(f'public badge verification failed: {name}')
    return len(inventory['files'])


if __name__ == '__main__':
    inventory = json.loads((Path(__file__).resolve().parents[1] / 'site/src/lib/arena-band-icons.json').read_text())
    origin = os.environ['CONTENT_ORIGIN'].rstrip('/')
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('configure the production HTTPS origin in CONTENT_ORIGIN')
    encoded = os.environ.get('BAND_ICON_BYTES')
    result = publish(S3Bucket.from_environment(), json.loads(encoded) if encoded else None, inventory)
    result['verifiedPublicUrls'] = verify_public(origin, inventory)
    print(json.dumps(result))
