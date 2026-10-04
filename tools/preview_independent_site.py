"""Read-only loopback preview of independently built code and content stores."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import http.client
import os
import re


def handler(code, content, rendered=None, growth_upstream=None):
    upstream = urlsplit(growth_upstream) if growth_upstream else None
    if upstream and (upstream.scheme != 'http' or upstream.hostname != '127.0.0.1'
                     or not upstream.port or upstream.path or upstream.query
                     or upstream.fragment or upstream.username or upstream.password):
        raise ValueError('growth_upstream_must_be_loopback_http')
    code, content = Path(code).resolve(), Path(content).resolve()
    identity = json.loads((code/'code-release.json').read_text())['codeId']
    rendered = Path(rendered).absolute() if rendered else None
    class Preview(SimpleHTTPRequestHandler):
        def send_head(self):
            # Browsers need byte ranges to seek local audio before the entire
            # file is buffered. SimpleHTTPRequestHandler only serves full files.
            self.byte_range = None
            path = self.translate_path(self.path)
            if not Path(path).is_file():
                return super().send_head()
            try:
                source = open(path, 'rb')
            except OSError:
                self.send_error(404, 'File not found')
                return None
            size = os.fstat(source.fileno()).st_size
            requested = self.headers.get('Range', '')
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            # Unsupported/multipart ranges and conditional ranges fall back to
            # the complete representation, as permitted by HTTP.
            if match and any(match.groups()) and not self.headers.get('If-Range'):
                first, last = match.groups()
                start = int(first) if first else max(0, size - int(last))
                end = min(size - 1, int(last)) if first and last else size - 1
                if start >= size or start > end:
                    source.close()
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return None
                self.byte_range = (start, end)
                source.seek(start)
            self.send_response(206 if self.byte_range else 200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Accept-Ranges', 'bytes')
            if self.byte_range:
                start, end = self.byte_range
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Content-Length', str(end - start + 1))
            else:
                self.send_header('Content-Length', str(size))
            self.end_headers()
            return source

        def copyfile(self, source, outputfile):
            if self.byte_range is None:
                return super().copyfile(source, outputfile)
            remaining = self.byte_range[1] - self.byte_range[0] + 1
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)

        def growth_response(self, status, value):
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def proxy_growth(self):
            path = self.path.rstrip('/')
            allowed = {'GET': {'/api/growth-export/capabilities'},
                       'POST': {'/api/growth-export/read', '/api/growth-export/gacha-history'}}
            if path not in allowed.get(self.command, set()):
                self.growth_response(404, {'error': 'not_found'}); return
            if not upstream:
                self.growth_response(503, {'error': 'login_service_unavailable'}); return
            body = None
            if self.command == 'POST':
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
                    self.growth_response(400, {'error': 'invalid_request'}); return
                length = int(lengths[0])
                if length > 8192:
                    self.growth_response(413, {'error': 'request_too_large'}); return
                self.connection.settimeout(10)
                try:
                    body = self.rfile.read(length)
                except (OSError, TimeoutError):
                    self.growth_response(408, {'error': 'request_timeout'}); return
            # Preserve browser provenance: the gateway owns Origin/Host/nonce validation.
            headers = {key: self.headers[key] for key in
                       ('Host', 'Origin', 'Sec-Fetch-Site', 'Content-Type', 'X-Growth-Nonce')
                       if key in self.headers}
            connection = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=145)
            try:
                connection.request(self.command, path, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read(2_000_001)
                if len(payload) > 2_000_000:
                    raise ValueError('response_too_large')
                self.send_response(response.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.send_header('Cache-Control', 'no-store')
                if response.getheader('Retry-After'):
                    self.send_header('Retry-After', response.getheader('Retry-After'))
                self.end_headers()
                self.wfile.write(payload)
            except (OSError, http.client.HTTPException, ValueError):
                self.growth_response(502, {'error': 'login_service_unavailable'})
            finally:
                body = None
                connection.close()

        def do_GET(self):
            if self.path.startswith('/api/growth-export/'):
                self.proxy_growth()
            else:
                super().do_GET()

        def do_POST(self):
            self.proxy_growth()

        def log_message(self, format, *args):
            if not self.path.startswith('/api/growth-export/'):
                super().log_message(format, *args)

        def translate_path(self, path):
            path = unquote(urlsplit(path).path)
            render_root = rendered.resolve() if rendered else None
            if path.startswith('/content/'):
                root, name = content, path[len('/content/'):]
                if name == 'global/current.json': name = 'current.json'
            elif path.startswith('/rendered/releases/') and render_root:
                parts = path.split('/', 4)
                root, name = render_root, parts[4] if len(parts) == 5 else '.missing'
            elif path.startswith('/app/releases/'+identity+'/'):
                root, name = code/'compiled',path[len('/app/releases/'+identity+'/'):]
            elif path.startswith(('/global/zh-CN/','/global/en/','/jp/zh-CN/','/jp/en/')):
                name = path.split('/',3)[3]
                if name.startswith(('vendor/','brand/','images/')) or name == 'favicon.svg': root = code/'compiled'
                elif render_root and (render_root/path.lstrip('/')/'index.html').is_file(): root,name = render_root,path.lstrip('/')+'/index.html'
                elif '.' not in name.rsplit('/',1)[-1]: root,name = code,'index.html'
                else: root,name = code,'.missing'
            elif path == '/': root,name=code,'index.html'
            else: root,name=code,'.missing'
            target=(root/name).resolve()
            if root not in target.parents or any(p.startswith('.') for p in Path(name).parts): return str(code/'.missing')
            return str(target)
        def end_headers(self):
            self.send_header('Cache-Control','no-store')
            super().end_headers()
        def list_directory(self, path):
            self.send_error(404); return None
    return Preview


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code',type=Path,required=True);parser.add_argument('--content',type=Path,required=True)
    parser.add_argument('--port',type=int,default=4321)
    parser.add_argument('--rendered',type=Path)
    parser.add_argument('--growth-upstream', help='Optional loopback gateway, e.g. http://127.0.0.1:18765')
    args=parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1',args.port),handler(args.code,args.content,args.rendered,args.growth_upstream)).serve_forever()
