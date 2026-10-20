"""Synthetic local workbench fixture; never reads official or cloud resources."""
import argparse
import hashlib
from pathlib import Path
import tempfile
import time

from backend.admin.app import create_admin
from .models import canonical
from .store import ArchiveRepository, LocalBucket
from .worker import run_once
from .previews import generate


def create_demo(root, port=18086, *, writable=False):
    class Synthetic:
        region = 'global'
        files = []
        def snapshot(self, previous=None):
            return {'region': self.region, 'files': self.files, 'sources': ['remote_asset'],
                    'observation': {'clientVersion': '1.0.1'}}
        def fetch(self, row, target):
            target.write_bytes(payloads[row['key']])
    repo = ArchiveRepository(LocalBucket(root))
    now = time.time(); source = Synthetic(); run_once(repo, source)
    from PIL import Image
    import io
    out = io.BytesIO(); Image.new('RGB', (360, 220), '#64877b').save(out, format='PNG')
    payloads = {'cards/sample.png': out.getvalue(),
                'data/preview.json': canonical({'activity': '本地合成活动', 'nextVersion': '1.1.0'}),
                'scripts/sample.lua': b'-- local synthetic sample\nreturn { enabled = true }\n',
                'audio/sample.wav': b''}
    import wave
    out = io.BytesIO()
    with wave.open(out, 'wb') as audio:
        audio.setparams((1, 2, 8000, 8000, 'NONE', 'not compressed')); audio.writeframes(b'\0\0' * 8000)
    payloads['audio/sample.wav'] = out.getvalue()
    source.files = [{'source': 'remote_asset', 'key': k, 'size': len(v),
                     'sha256': hashlib.sha256(v).hexdigest()} for k, v in payloads.items()]
    run_once(repo, source, previewer=generate)
    # An oversized logical update supplies a manual-selection example without allocating bytes.
    source.files += [{'source': 'remote_asset', 'key': 'large/future.bundle',
                      'size': 300 * 1024 ** 2, 'hash': 'synthetic-future'}]
    run_once(repo, source)
    config = {'schemaVersion': 1, 'role': 'admin', 'port': port,
              'origin': f'http://127.0.0.1:{port}', 'auth': {'mode': 'preview'}, 'sites': []}
    if writable:
        import os
        # Token is generated for this process only and never printed or persisted.
        import secrets
        token = secrets.token_hex(32)
        os.environ['OURNOTES_ARCHIVE_DEMO_TOKEN'] = token
        config['auth'] = {'mode': 'proxy', 'proxyTokenEnv': 'OURNOTES_ARCHIVE_DEMO_TOKEN', 'users': ['local-demo']}
        app = create_admin(config, archive_repo=repo)
        from starlette.datastructures import MutableHeaders
        class LoopbackDemo:
            async def __call__(self, scope, receive, send):
                if scope['type'] == 'http':
                    headers = MutableHeaders(scope=scope)
                    headers['x-admin-proxy'] = token; headers['x-admin-user'] = 'local-demo'
                await app(scope, receive, send)
        return LoopbackDemo()
    return create_admin(config, archive_repo=repo)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=18086)
    parser.add_argument('--writable', action='store_true', help='Synthetic temporary data only')
    args = parser.parse_args()
    import uvicorn
    with tempfile.TemporaryDirectory(prefix='otonote-archive-demo-') as root:
        uvicorn.run(create_demo(root, args.port, writable=args.writable), host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
