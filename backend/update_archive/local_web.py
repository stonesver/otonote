"""Loopback-only local history viewer; remote resources are never fetched here."""
import difflib
import json
from pathlib import Path
import secrets

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from .models import ArchiveError
from .local_analysis import compare
from .history import content_entry


def create_app(library, port=18087):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    token = secrets.token_hex(32)
    origin = f'http://127.0.0.1:{port}'

    @app.middleware('http')
    async def local_only(request: Request, call_next):
        if request.headers.get('host') != f'127.0.0.1:{port}':
            return JSONResponse({'error': 'invalid_host'}, status_code=403)
        if request.headers.get('origin') not in (None, origin):
            return JSONResponse({'error': 'invalid_origin'}, status_code=403)
        if request.url.path.startswith('/api/') and request.cookies.get('archive-local') != token:
            return JSONResponse({'error': 'local_session_required'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'"
        return response

    @app.exception_handler(ArchiveError)
    async def error(request, exc):
        return JSONResponse({'error': str(exc)}, status_code=400)

    static = Path(__file__).with_name('local_static')

    @app.get('/')
    def index():
        response = HTMLResponse((static / 'index.html').read_text())
        response.set_cookie('archive-local', token, httponly=True, samesite='strict')
        return response

    @app.get('/app.js')
    def script():
        return FileResponse(static / 'app.js', media_type='text/javascript')

    @app.get('/app.css')
    def css():
        return FileResponse(static / 'app.css', media_type='text/css')

    @app.get('/api/entries')
    def entries(query: str = '', region: str = '', removed: bool = False, offset: int = 0,
                local: bool = True):
        if offset < 0:
            raise HTTPException(400)
        snapshot = library.entries()
        rows = sorted(snapshot.values(), key=lambda e: (e['observedAt'], e['id']), reverse=True)
        reports, jobs = library.analysis_records()
        availability = {}
        matches = []
        summary = dict(saved=0, complete=0, pending=0, running=0, partial=0, failed=0)
        counted = set()
        for entry in rows:
            original = content_entry(snapshot, entry)
            sha = original.get('sha256') if original else None
            if sha not in availability:
                availability[sha] = library.has(sha)
            oid = original['id'] if original else entry['id']
            report, job = reports.get(oid), jobs.get(oid)
            status = library.analysis_status(report, job) if availability[sha] else 'unavailable'
            if availability[sha] and oid not in counted:
                counted.add(oid)
                summary['saved'] += 1
                summary[status] += 1
            if ((not local or availability[sha]) and (not region or entry['region'] == region)
                    and query.lower() in entry['key'].lower() and (not removed or entry.get('change') == 'removed')):
                thumbnail = next((p['path'] for p in (report or {}).get('previews', [])
                                  if p['mime'].startswith('image/')), None)
                matches.append({**entry, 'localAvailable': availability[sha], 'analysisStatus': status,
                                'thumbnail': thumbnail})
        with library.connect() as db:
            last_sync = db.execute("SELECT value FROM settings WHERE key='lastSync'").fetchone()
        summary['lastSync'] = float(last_sync[0]) if last_sync else None
        return {'entries': matches[offset:offset + 100], 'total': len(matches), 'summary': summary}

    @app.get('/api/entries/{eid}')
    def detail(eid: str):
        return library.detail(eid)

    @app.post('/api/entries/{eid}/analyze')
    async def analyze(eid: str, request: Request):
        if request.headers.get('x-archive-local') != '1':
            raise HTTPException(403)
        return await run_in_threadpool(library.analyze, eid)

    @app.get('/api/entries/{eid}/raw')
    def raw(eid: str):
        d = library.detail(eid)
        if not d['localAvailable']:
            raise HTTPException(404, 'historical_original_missing')
        return FileResponse(library.object_path(d['original']['sha256']),
                            filename=Path(d['entry']['key']).name, media_type='application/octet-stream')

    def analysis_file(eid, name):
        report = library.preview_report(eid)
        if not report or Path(name).name != name:
            raise HTTPException(404)
        allowed = {p['path']: p for p in report['previews']}
        if name not in allowed:
            raise HTTPException(404)
        path = library.root / 'analysis' / report['directory'] / name
        return path, allowed[name]

    @app.get('/api/entries/{eid}/preview/{name}')
    def preview(eid: str, name: str):
        path, row = analysis_file(eid, name)
        mime = row['mime']
        if mime not in ('image/webp', 'audio/ogg', 'audio/wav', 'text/plain', 'application/json'):
            raise HTTPException(400)
        return FileResponse(path, media_type=mime)

    @app.get('/api/compare/{before}/{after}')
    def comparison(before: str, after: str):
        reports = [library.detail(eid) for eid in (before, after)]
        a, b = [d['entry'] for d in reports]
        if (a['region'], a['source'], a['key']) != (b['region'], b['source'], b['key']):
            raise ArchiveError('unrelated_versions')
        indexes = []
        for detail in reports:
            report = detail['analysis']
            if not report:
                raise ArchiveError('analysis_required')
            indexes.append(json.loads((library.root / 'analysis' / report['directory'] / 'inventory.json').read_bytes()))
        result = compare(*indexes)
        texts = []
        for detail in reports:
            row = next((p for p in detail['analysis']['previews']
                        if p['mime'] in ('text/plain', 'application/json') and p['path'] != 'objects.json'), None)
            if not row:
                break
            path = library.root / 'analysis' / detail['analysis']['directory'] / row['path']
            texts.append((path.read_text(), row.get('truncated', False)))
        if len(texts) == 2:
            import itertools
            lines = difflib.unified_diff(texts[0][0].splitlines(), texts[1][0].splitlines(),
                                        fromfile='before', tofile='after', lineterm='')
            limited = list(itertools.islice(lines, 10001))
            result['textDiff'] = '\n'.join(limited[:10000])[:512 * 1024]
            result['textTruncated'] = any(t[1] for t in texts) or len(limited) > 10000 or len('\n'.join(limited)) > 512 * 1024
        return result

    return app


def serve(library, port):
    import uvicorn
    uvicorn.run(create_app(library, port), host='127.0.0.1', port=port)
