"""Authenticated archive views and queued mutations; never unpack in HTTP."""
import contextlib
import asyncio
import copy
import difflib
import hashlib
import io
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import quote
import zipfile

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from .collector import small_json
from backend.update_archive.models import ArchiveError, Conflict, REGIONS
from backend.update_archive import requests as commands


class ArchiveAdmission:
    """Bound ledger memory across concurrent views and file responses."""
    def __init__(self, app):
        self.app = app
        self.slot = asyncio.Semaphore(1)
        self.media = asyncio.Semaphore(4)

    async def __call__(self, scope, receive, send):
        if scope.get('type') == 'http' and scope.get('path', '').startswith('/api/archive/'):
            if scope['path'].startswith('/api/archive/previews/'):
                async with self.media:
                    await self.slot.acquire()
                    admitted = True
                    async def media_send(message):
                        nonlocal admitted
                        # Snapshot preparation is memory heavy; the immutable
                        # media stream is bounded and needn't hold up metadata.
                        if message['type'] == 'http.response.start' and admitted:
                            self.slot.release(); admitted = False
                        await send(message)
                    try:
                        return await self.app(scope, receive, media_send)
                    finally:
                        if admitted:self.slot.release()
            async with self.slot:
                return await self.app(scope, receive, send)
        return await self.app(scope, receive, send)


def install(app, config, *, repo=None, preview=False):
    app.add_middleware(ArchiveAdmission)
    router = APIRouter(prefix='/api/archive')
    config = config if isinstance(config, dict) else {'schemaVersion': 1, 'enabled': False}
    cached = [repo]
    def repository():
        if cached[0] is not None:
            return cached[0]
        if not config or not config.get('enabled', False):
            raise HTTPException(503, 'archive_disabled')
        try:
            from backend.update_archive.config import repository as create
            cached[0] = create(config)
        except Exception:
            raise HTTPException(503, 'archive_unavailable') from None
        return cached[0]

    def protected(fn):
        def call(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Conflict as e:
                raise HTTPException(409, str(e)) from None
            except ArchiveError as e:
                raise HTTPException(400, str(e)) from None
            except (OSError, KeyError, ValueError):
                raise HTTPException(503, 'archive_unavailable') from None
        return call

    def public_entry(e):
        row = {k: copy.deepcopy(e[k]) for k in ('id', 'region', 'batch', 'source', 'key', 'change',
            'size', 'observedAt', 'expiresAt', 'firstArchivedAt', 'status', 'sha256', 'attempts',
            'previewStatus', 'previewError', 'previewVersion', 'previewWarningCount', 'cleanupReason', 'cleanedAt', 'error') if k in e}
        file = e.get('file', {})
        row['upstream'] = {k: file[k] for k in ('hash', 'hashAlgorithm', 'sha256', 'path', 'package', 'resourceType') if k in file}
        if e.get('upstreamEtag'):
            row['upstream']['etag'] = e['upstreamEtag']
        row['previews'] = [{'id': k, **{f: v for f, v in p.items() if f not in ('key',)}}
                           for k, p in e.get('previews', {}).items() if k.startswith('preview_')]
        return row

    @router.get('/summary')
    def summary():
        if cached[0] is None and (not config or not config.get('enabled', False)):
            return {'status': 'disabled', 'writable': False}
        data = protected(lambda: repository().summary())()
        data['writable'] = not preview
        return data

    @router.get('/entries')
    def entries(region: str = 'global', offset: int = 0, limit: int = 50, batch: str = '',
                status: str = '', source: str = '', query: str = '', group: str = ''):
        if region not in REGIONS or offset < 0 or not 1 <= limit <= 100 or len(query) > 200:
            raise HTTPException(400, 'invalid_filter')
        rows = protected(lambda: repository().entries(region))()
        groups = repository().state()[0]['batches'] if group else {}
        rows = [e for e in rows if (not group or groups.get(e.get('batch'), {}).get('group') == group)
                and (not batch or e.get('batch') == batch)
                and (not status or e['status'] == status) and (not source or e['source'] == source)
                and query.lower() in e['key'].lower()]
        return {'entries': [public_entry(e) for e in rows[offset:offset + limit]],
                'total': len(rows), 'nextOffset': offset + limit if offset + limit < len(rows) else None}

    @router.get('/batches')
    def batches(region: str = 'global', offset: int = 0, limit: int = 50):
        if region not in REGIONS or offset < 0 or not 1 <= limit <= 100:
            raise HTTPException(400, 'invalid_filter')
        s = protected(lambda: repository().state()[0])()
        rows = sorted((b for b in s['batches'].values() if b['region'] == region),
                      key=lambda b: b['observedAt'], reverse=True)
        return {'batches': rows[offset:offset + limit], 'total': len(rows), 'groups': list(s['groups'].values())}

    @router.get('/entries/{eid}')
    def detail(eid: str):
        return protected(lambda: public_entry(repository().entry(eid)))()

    @router.get('/requests')
    def requests():
        s = protected(lambda: repository().state()[0])()
        return {'requests': sorted(s['requests'].values(), key=lambda r: r['createdAt'], reverse=True)[:100],
                'cleanup': sorted(s['cleanup'].values(), key=lambda r: r['createdAt'], reverse=True)[:100]}

    @router.post('/requests')
    async def submit(request: Request):
        data = await small_json(request, maximum=65536)
        return await run_in_threadpool(protected(lambda: commands.queue_save(repository(), data.get('entries'), actor=request.state.actor,
            key=data.get('key'), now=time.time(), max_bytes=data.get('maxBytes'))))

    @router.post('/requests/{rid}/cancel')
    def cancel(rid: str, request: Request):
        return protected(lambda: commands.cancel_request(repository(), rid, actor=request.state.actor))()

    @router.post('/cleanup/plans')
    async def plan(request: Request):
        data = await small_json(request, maximum=65536)
        def prepare():
            ids = data.get('entries')
            if data.get('scope') in ('region', 'all', 'batch', 'group'):
                s = repository().state()[0]
                chosen_region = data.get('region')
                if chosen_region not in REGIONS and data.get('scope') != 'all':
                    raise HTTPException(400, 'invalid_region')
                batch_ids = {k for k, b in s['batches'].items() if b.get('group') == data.get('group')}
                ids = [e['id'] for e in s['entries'].values() if e['expiresAt'] > time.time()
                       and e['status'] not in ('expired', 'cleaned_manual', 'evicted_fifo')
                       and (data['scope'] == 'all' or e['region'] == chosen_region)
                       and (data['scope'] != 'batch' or e.get('batch') == data.get('batch'))
                       and (data['scope'] != 'group' or e.get('batch') in batch_ids)]
                del s
            return commands.cleanup_plan(repository(), ids, actor=request.state.actor, now=time.time(), limit=100000)
        return await run_in_threadpool(protected(prepare))

    @router.post('/cleanup/{pid}/confirm')
    async def confirm(pid: str, request: Request):
        data = await small_json(request, maximum=65536)
        return await run_in_threadpool(protected(lambda: commands.confirm_cleanup(repository(), pid, data.get('digest'),
                         actor=request.state.actor, now=time.time())))

    @router.post('/mode')
    async def mode(request: Request):
        data = await small_json(request, maximum=65536)
        if data.get('region') not in REGIONS or data.get('mode') not in ('auto', 'record', 'manual'):
            raise HTTPException(400, 'invalid_mode')
        if type(data.get('revision')) is not int:
            raise HTTPException(400, 'revision_required')
        await run_in_threadpool(protected(lambda: repository().mutate(lambda s: s['modes'].update({data['region']: data['mode']}),
                                             revision=data['revision'])))
        return {'status': 'updated'}

    @router.post('/groups')
    async def group(request: Request):
        data = await small_json(request, maximum=65536)
        if data.get('region') not in REGIONS or not isinstance(data.get('name'), str) or not 1 <= len(data['name']) <= 100:
            raise HTTPException(400, 'invalid_group')
        from backend.update_archive.models import identity
        if type(data.get('revision')) is not int or (data.get('id') is not None and not re.fullmatch('[a-f0-9]{64}', str(data['id']))):
            raise HTTPException(400, 'invalid_group_revision_or_id')
        gid = data.get('id') or identity([data['region'], data['name'], time.time()])
        def update(s):
            if len(s['groups']) >= 100 and gid not in s['groups']:
                raise ArchiveError('group_limit')
            if data.get('active', True):
                for g in s['groups'].values():
                    if g['region'] == data['region']:
                        g['active'] = False
            s['groups'][gid] = {'id': gid, 'region': data['region'], 'name': data['name'], 'active': bool(data.get('active', True))}
        await run_in_threadpool(protected(lambda: repository().mutate(update, revision=data.get('revision'))))
        return {'id': gid}

    @router.post('/batches/{bid}/group')
    async def regroup(bid: str, request: Request):
        data = await small_json(request, maximum=65536)
        if type(data.get('revision')) is not int or (data.get('group') is not None and not re.fullmatch('[a-f0-9]{64}', str(data['group']))):
            raise HTTPException(400, 'invalid_group_revision_or_id')
        def move(s):
            b = s['batches'][bid]
            g = s['groups'].get(data.get('group'))
            if g and g['region'] != b['region']:
                raise ArchiveError('cross_region_group')
            if data.get('group') is not None and not g:
                raise ArchiveError('group_not_found')
            b['group'] = data.get('group')
        await run_in_threadpool(protected(lambda: repository().mutate(move, revision=data.get('revision'))))
        return {'status': 'updated'}

    def preview_snapshot(eid, pid):
        r = repository(); s, _ = r.state()
        e = s['entries'].get(eid)
        if not e or e['status'] != 'saved' or e['expiresAt'] <= time.time():
            raise HTTPException(410, 'archive_content_unavailable')
        if not re.fullmatch(r'preview_[a-f0-9]{16}', pid) or pid not in e.get('previews', {}):
            raise HTTPException(404, 'preview_not_found')
        item = e['previews'][pid]; obj = s['objects'].get(item['key'])
        if not obj or obj['status'] != 'live':
            raise HTTPException(410, 'archive_content_unavailable')
        # A bounded immutable preview is read as a committed snapshot. Unlike
        # original downloads, viewing it never writes a lease to the big ledger.
        return r, copy.deepcopy(e), copy.deepcopy(item), copy.deepcopy(obj['signature'])

    def serve(eid, request, preview_id=None):
        r = protected(repository)()
        snapshot = protected(lambda: preview_snapshot(eid, preview_id))() if preview_id else None
        cm = contextlib.nullcontext(snapshot[1]) if snapshot else r.reading(eid)
        entered = False
        try:
            e = cm.__enter__()
            entered = True
            item = e
            key = e['objectKey']
            mime = 'application/octet-stream'
            if preview_id is not None:
                if not re.fullmatch(r'preview_[a-f0-9]{16}', preview_id) or preview_id not in e.get('previews', {}):
                    raise ArchiveError('preview_not_found')
                item = e['previews'][preview_id]
                key = item['key']
                mime = item.get('mime', 'application/octet-stream')
            obj = r.state()[0]['objects'].get(key) if not snapshot else None
            signature = snapshot[3] if snapshot else obj.get('signature') if obj and obj['status'] == 'live' else None
            if signature is None or signature != r.bucket.signature(key):
                raise ArchiveError('object_identity_changed')
            size, start, end = item['size'], 0, item['size'] - 1
            status = 200
            headers = {'Accept-Ranges': 'bytes', 'Content-Disposition':
                ("attachment; filename*=UTF-8''" + quote(Path(e['key']).name)) if preview_id is None else 'inline'}
            value = request.headers.get('range')
            if value:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
                if not match or not any(match.groups()):
                    raise HTTPException(416, headers={'Content-Range': f'bytes */{size}'})
                if match[1]:
                    start, end = int(match[1]), int(match[2]) if match[2] else size - 1
                else:
                    start = max(0, size - int(match[2]))
                end = min(end, size - 1)
                if start > end or start >= size:
                    raise HTTPException(416, headers={'Content-Range': f'bytes */{size}'})
                status = 206
                headers['Content-Range'] = f'bytes {start}-{end}/{size}'
            headers['Content-Length'] = str(max(0, end - start + 1))
            if request.method == 'HEAD':
                cm.__exit__(None, None, None)
                return Response(status_code=status, headers=headers, media_type=mime)
            body = r.bucket.open(key)
        except Exception as error:
            if entered:
                cm.__exit__(None, None, None)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(410, 'archive_content_unavailable') from None
        def chunks():
            deadline = time.monotonic() + 290
            try:
                skip, remaining = start, max(0, end - start + 1)
                while skip:
                    part = body.read(min(skip, 1024 * 1024))
                    if not part:
                        raise ArchiveError('object_size_mismatch')
                    skip -= len(part)
                while remaining:
                    if time.monotonic() > deadline:
                        raise ArchiveError('read_lease_expired')
                    part = body.read(min(remaining, 1024 * 1024))
                    if not part:
                        raise ArchiveError('object_size_mismatch')
                    remaining -= len(part)
                    yield part
            finally:
                body.close(); cm.__exit__(None, None, None)
        return StreamingResponse(chunks(), status_code=status, headers=headers, media_type=mime)

    @router.api_route('/files/{eid}', methods=['GET', 'HEAD'])
    def raw(eid: str, request: Request):
        return serve(eid, request)

    @router.api_route('/previews/{eid}/{pid}', methods=['GET', 'HEAD'])
    def preview_file(eid: str, pid: str, request: Request):
        return serve(eid, request, pid)

    @router.get('/text/{eid}/{pid}')
    def text(eid: str, pid: str):
        return protected(lambda: text_value(eid, pid))()

    def text_value(eid, pid):
        r, _, item, _ = preview_snapshot(eid, pid)
        if item.get('mime') not in ('text/plain', 'application/json') or item['size'] > 1024 * 1024:
            raise HTTPException(400)
        with contextlib.closing(r.bucket.open(item['key'])) as stream:
            raw = stream.read(item['size'] + 1)
        from backend.update_archive.models import digest
        if len(raw) != item['size'] or digest(raw) != item['sha256']:
            raise ArchiveError('object_digest_mismatch')
        return {'text': raw.decode('utf-8'), 'truncated': item.get('truncated', False)}

    @router.get('/diff/{before}/{before_pid}/{after}/{after_pid}')
    def text_diff(before: str, before_pid: str, after: str, after_pid: str):
        a = protected(lambda: text_value(before, before_pid))()
        b = protected(lambda: text_value(after, after_pid))()
        before_lines, after_lines = a['text'].splitlines(), b['text'].splitlines()
        lines = difflib.unified_diff(before_lines[:2000], after_lines[:2000],
                                     fromfile='before', tofile='after', lineterm='')
        return {'diff': '\n'.join(list(__import__('itertools').islice(lines, 10000)))[:512 * 1024],
                'truncated': a['truncated'] or b['truncated'] or len(before_lines) > 2000 or len(after_lines) > 2000}

    @router.post('/export')
    async def export(request: Request):
        data = await small_json(request, maximum=65536)
        spool = await run_in_threadpool(prepare_export, data)
        def export_bytes():
            try:
                yield from iter(lambda: spool.read(1024 * 1024), b'')
            finally:
                spool.close()
        return StreamingResponse(export_bytes(), media_type='application/zip',
                                 headers={'Content-Disposition': 'attachment; filename="archive.zip"'})

    def prepare_export(data):
        r = repository(); state, _ = r.state()
        ids = protected(lambda: commands.selected_entries(state, data.get('entries'), time.time()))()
        if sum(state['entries'][i]['size'] for i in ids) > 128 * 1024 ** 2:
            raise HTTPException(400, 'export_split_required')
        del state
        # Private temporary spool is removed after delivery; no permanent ZIP cache.
        spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        try:
            manifest = []
            deadline = time.monotonic() + 290
            with zipfile.ZipFile(spool, 'w', compression=zipfile.ZIP_STORED) as out:
                for eid in ids:
                    with r.reading(eid) as e:
                        path = eid + '/' + Path(e['key']).name
                        h, count = hashlib.sha256(), 0
                        with contextlib.closing(r.bucket.open(e['objectKey'])) as stream, out.open(path, 'w') as target:
                            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                                count += len(chunk)
                                if count > e['size'] or time.monotonic() >= deadline:
                                    raise ArchiveError('export_budget_exceeded')
                                h.update(chunk); target.write(chunk)
                        if count != e['size'] or h.hexdigest() != e['sha256']:
                            raise ArchiveError('object_digest_mismatch')
                        manifest.append({'id': eid, 'path': path, 'sourceName': e['key'], 'sha256': e['sha256']})
                from backend.update_archive.models import canonical
                out.writestr('manifest.json', canonical(manifest))
            spool.seek(0)
        except Exception:
            spool.close()
            raise HTTPException(410, 'export_content_unavailable') from None
        return spool

    app.include_router(router)
