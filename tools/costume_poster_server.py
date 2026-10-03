"""Loopback-only offline image producer; never included in public website routes.

Requires local Node dependencies, Pillow, a content store and separately supplied Core.
Open the printed loopback URL and click Generate. The result is a sealed poster input.
"""
import argparse
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit

from tools.costume_posters import read_posters

ROOT = Path(__file__).resolve().parents[1]


def handler(costumes, models, content, core, output, bundle, port):
    token = secrets.token_hex(24)
    selected = {m['id']:m for m in models['models'] if m['state'] == 'available'}
    if costumes['contentReleaseId'] != models['releaseId']:
        raise ValueError('costume/model release mismatch')
    jobs = {}
    for row in costumes['costumes']:
        matches = [selected[v['modelId']] for v in row['models'] if v['state'] == 'available'
                   and v['modelId'] in selected and selected[v['modelId']]['modelPath'] == v['modelPath']]
        if not matches:
            continue
        model = min(matches, key=lambda m:m['bytes'])
        if str(model['characterId']) != str(row['characterMasterId']):
            raise ValueError('costume/model character mismatch')
        jobs[row['masterId']] = {k:model[k] for k in ['modelPath','sourceSha256','characterId','root']}
        jobs[row['masterId']]['groupId'] = row['masterId']
    if output.exists():
        raise ValueError('output already exists; choose a new poster directory')
    stage = output.with_name('.' + output.name + '.working')
    stage.mkdir(parents=True, exist_ok=True)
    saved = read_posters(stage)
    for key, row in saved.items():
        if key not in jobs or any(row[k] != jobs[key][k] for k in ['modelPath','sourceSha256','characterId']):
            raise ValueError('poster staging belongs to different models')
    origin = f'http://127.0.0.1:{port}'
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Host') != f'127.0.0.1:{port}':
                self.send_error(403); return
            path = urlsplit(self.path).path
            if path == '/jobs':
                self.respond(json.dumps({'token':token,'rows':[v for k,v in jobs.items() if k not in saved]}).encode(), 'application/json'); return
            if path == '/':
                self.respond(b'<!doctype html><meta charset="utf-8"><title>Costume image producer</title><style>body{font:16px sans-serif}#stage{width:600px;height:800px}canvas{width:100%;height:100%}</style><button>Generate full-body images</button><p role="status">Ready</p><div id="stage"><canvas></canvas></div><script type="module" src="/renderer.js"></script>', 'text/html'); return
            super().do_GET()

        def translate_path(self, path):
            path = urlsplit(path).path
            if path == '/core.js': return str(core)
            if path == '/renderer.js': return str(bundle)
            if path.startswith('/content/'):
                target = (content / path[len('/content/'):]).resolve()
                if content in target.parents and not any(p.startswith('.') for p in Path(path).parts): return str(target)
            return str(stage / '.missing')

        def respond(self, body, kind):
            self.send_response(200); self.send_header('Content-Type', kind)
            self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(body)))
            self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            if (self.headers.get('Host') != f'127.0.0.1:{port}' or self.headers.get('Origin') != origin
                    or self.headers.get('X-Poster-Token') != token): self.send_error(403); return
            path = urlsplit(self.path).path
            try:
                identifier = int(path.removeprefix('/result/'))
                if path != f'/result/{identifier}' or identifier not in jobs or identifier in saved: raise ValueError()
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8_000_000 or self.headers.get('Transfer-Encoding'): raise ValueError()
                from PIL import Image
                image = Image.open(io.BytesIO(self.rfile.read(length)))
                if image.format != 'PNG' or not (100 <= image.width <= 1600 and 100 <= image.height <= 2000): raise ValueError()
                image = image.convert('RGBA')
                if image.getbbox() is None: raise ValueError('empty image')
                image.thumbnail((600, 800))
                buf = io.BytesIO(); image.save(buf, 'WEBP', quality=90, method=6)
                data = buf.getvalue(); sha = hashlib.sha256(data).hexdigest(); name = f'{identifier}-{sha}.webp'
                (stage / name).write_bytes(data)
                saved[identifier] = {k:v for k,v in jobs[identifier].items() if k != 'root'}
                saved[identifier].update(file=name,sha256=sha,width=image.width,height=image.height)
                manifest = stage / 'manifest.json'
                temporary = stage / '.manifest.json'
                temporary.write_text(json.dumps({'schemaVersion':1,'posters':list(saved.values())},ensure_ascii=False))
                temporary.replace(manifest)
                if len(saved) == len(jobs): stage.rename(output)
                self.respond(b'{}','application/json')
            except (ValueError, OSError): self.send_error(400)
    return Handler


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['costumes','models','content','core','output']: p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--port',type=int,default=4420)
    args=p.parse_args(); output=args.output.resolve()
    if ROOT/'output' not in output.parents: raise ValueError('use a directory under output/')
    bundle=output.with_suffix('.renderer.js'); bundle.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['node',str(ROOT/'site/node_modules/esbuild/bin/esbuild'),str(ROOT/'tools/render_costume_posters.mjs'),
                    '--bundle','--format=esm','--platform=browser','--target=es2022','--outfile='+str(bundle)],check=True)
    cls=handler(json.loads(args.costumes.read_text()),json.loads(args.models.read_text()),args.content.resolve(),args.core.resolve(),output,bundle,args.port)
    print(f'Open http://127.0.0.1:{args.port}/ to produce images; output: {output}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),cls).serve_forever()


if __name__ == '__main__': main()
