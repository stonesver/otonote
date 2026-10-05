"""Upload a tiny immutable delivery fixture without promoting any public pointer."""
from __future__ import annotations
import argparse
import base64
import json
from pathlib import Path
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tools.r2_content import S3Bucket, canonical, digest, upload_release

GATEWAY = 'https://ournotes-content-gateway.haoyanl297.workers.dev'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mQAAAABJRU5ErkJggg==')


def prepare(root: Path):
    files = {
        'en/catalog.json': b'{}\n', 'zh-CN/catalog.json': b'{}\n',
        'public/live2d/delivery-probe/model3.json': canonical({'FileReferences': {'Textures': ['texture.png']}}),
        'public/live2d/delivery-probe/texture.png': PNG,
        'public/media/delivery-probe.bin': bytes(range(256)),
    }
    identifier = digest(canonical({'probeVersion': 1, 'files': {k: digest(v) for k, v in files.items()}}))[:24]
    prefix = '/content/releases/' + identifier + '/'
    manifest = {'schemaVersion': 1, 'region': 'global', 'channel': 'production',
                'contentReleaseId': 'delivery-probe-v1', 'root': prefix,
                'locales': {locale: {'files': {'projection/catalog.json': {
                    'path': locale + '/catalog.json', 'sha256': digest(files[locale + '/catalog.json']),
                    'bytes': len(files[locale + '/catalog.json'])}}, 'groups': {}} for locale in ('en', 'zh-CN')}}
    files['manifest.json'] = canonical(manifest)
    release = root / 'releases' / identifier
    release.mkdir(parents=True)
    for name, raw in files.items():
        path = release / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    (release / '.receipt.json').write_bytes(canonical({'schemaVersion': 1, 'files': {k: digest(v) for k, v in files.items()}}))
    (root / 'current.json').write_bytes(canonical({'schemaVersion': 1, 'contentReleaseId': 'delivery-probe-v1',
        'manifest': prefix + 'manifest.json', 'sha256': digest(files['manifest.json'])}))
    return identifier, files


def request(path, *, method='GET', headers=None):
    req = Request(GATEWAY + path, method=method,
                  headers={'User-Agent': 'otonote-delivery-probe/1.0', **(headers or {})})
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as response:
        return response.code, dict(response.headers.items()), response.read(1024 * 1024)
    with response:
        return response.status, dict(response.headers.items()), response.read(1024 * 1024)


def verify(identifier, files, fetch=request):
    prefix = '/content/releases/' + identifier + '/'
    checks = 0
    for name, expected in files.items():
        status, headers, data = fetch(prefix + name)
        headers = {k.lower(): v for k, v in headers.items()}
        if status != 200 or data != expected:
            raise ValueError('gateway fixture GET differs: ' + name + ' (HTTP ' + str(status) + ')')
        if headers.get('x-content-type-options') != 'nosniff' or 'immutable' not in headers.get('cache-control', ''):
            raise ValueError('gateway fixture lacks immutable delivery headers')
        if name.endswith('.json') and 'application/json' not in headers.get('content-type', ''):
            raise ValueError('gateway JSON MIME differs')
        if name.endswith('.png') and 'image/png' not in headers.get('content-type', ''):
            raise ValueError('gateway image MIME differs')
        checks += 1
    name = 'public/media/delivery-probe.bin'
    status, headers, data = fetch(prefix + name, method='HEAD')
    headers = {k.lower(): v for k, v in headers.items()}
    if status != 200 or data or headers.get('content-length') != '256':
        raise ValueError('gateway fixture HEAD differs')
    checks += 1
    status, headers, data = fetch(prefix + name, headers={'Range': 'bytes=8-31'})
    headers = {k.lower(): v for k, v in headers.items()}
    if status != 206 or data != files[name][8:32] or headers.get('content-range') != 'bytes 8-31/256':
        raise ValueError('gateway fixture range differs')
    checks += 1
    for path in (prefix + '.receipt.json', '/content/storage/' + identifier + '/descriptor.json',
                 '/content/blobs/' + digest(PNG)):
        if fetch(path)[0] != 404:
            raise ValueError('gateway exposes an internal control path')
        checks += 1
    if fetch(prefix + name, method='POST')[0] != 405:
        raise ValueError('gateway does not reject writes')
    return {'status': 'passed', 'releaseId': identifier, 'checks': checks + 1, 'publicPointerChanged': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix='r2-delivery-') as temporary:
        root = Path(temporary)
        identifier, files = prepare(root)
        report = {'releaseId': identifier, 'publicPointerChanged': False}
        try:
            report['upload'] = upload_release(S3Bucket.from_environment(4), root, 'global', workers=4, shared_media=True)
            report.update(verify(identifier, files))
        except Exception as error:
            report.update(status='failed', errorType=type(error).__name__)
            args.output.write_bytes(canonical(report))
            raise
        args.output.write_bytes(canonical(report))
        print(json.dumps(report))


if __name__ == '__main__':
    main()
