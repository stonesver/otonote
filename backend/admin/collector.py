"""Public, write-only event ingress; authenticated aggregate reads stay private."""
import asyncio
import hashlib
import hmac
import ipaddress
import json
import re
import sqlite3
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .config import secret, validate_config
from .sampling import Sampler, ingest_log
from .store import Store

EVENTS = {'page_view', 'download_click', 'export_start', 'export_result'}
IDENTIFIER = re.compile(r'[a-zA-Z0-9_-]{16,80}\Z')


async def small_json(request, maximum=4096):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            raise HTTPException(413, 'request too large')
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise HTTPException(400, 'invalid JSON')
    if not isinstance(data, dict):
        raise HTTPException(400, 'object required')
    return data


def bearer(request, value):
    return hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + value)


def validate_event(event, site):
    allowed = {'v', 'site', 'id', 'type', 'path', 'resource', 'operation', 'result', 'visitor', 'referrer'}
    if any(not isinstance(v, str) for k, v in event.items() if k != 'v'):
        raise ValueError('event fields must be strings')
    if set(event) - allowed or type(event.get('v')) is not int or event.get('v') != 1 or event.get('site') != site['id'] or event.get('type') not in EVENTS:
        raise ValueError('unsupported event')
    for key in ('id', 'visitor', 'operation'):
        value = event.get(key)
        if (key == 'id' or value is not None) and (not isinstance(value, str) or not IDENTIFIER.fullmatch(value)):
            raise ValueError('invalid event identifier')
    path = event.get('path', '')
    if len(path) > 512 or (path not in site.get('paths', []) and not any(re.fullmatch(p, path) for p in site.get('pathPatterns', []))):
        raise ValueError('unknown page')
    if event['type'] != 'page_view':
        resource = event.get('resource', '')
        if len(resource) > 512 or (resource not in site.get('resources', []) and not any(re.fullmatch(p, resource) for p in site.get('resourcePatterns', []))):
            raise ValueError('unknown resource')
    elif any(k in event for k in ('resource', 'operation', 'result')):
        raise ValueError('invalid page event fields')
    if event['type'].startswith('export_') and not event.get('operation'):
        raise ValueError('export operation required')
    if event['type'] == 'export_result':
        if event.get('result') not in {'success', 'failed', 'cancelled'}:
            raise ValueError('invalid result')
    elif 'result' in event:
        raise ValueError('unexpected result')
    referrer = event.get('referrer', 'direct')
    if not isinstance(referrer, str) or not re.fullmatch(r'[a-zA-Z0-9.-]{1,253}', referrer):
        raise ValueError('invalid referrer')
    return event


class RateLimit:
    def __init__(self):
        self.entries = OrderedDict()

    def allow(self, key, now, rate, burst):
        tokens, previous = self.entries.pop(key, (burst, now))
        tokens = min(burst, tokens + max(0, now - previous) * rate)
        ok = tokens >= 1
        self.entries[key] = (tokens - 1 if ok else tokens, now)
        while len(self.entries) > 10000:
            self.entries.popitem(last=False)
        return ok


def create_collector(config, *, sampling=True, clock=time.time):
    c = validate_config(config, 'collector')
    store = Store(c['database'], c['maxDatabaseBytes'])
    read_key = secret(c['readTokenEnv'])
    sites = {s['id']: s for s in c['sites']}
    limiter = RateLimit()
    sampling_status = {'error': None}
    samplers = {s['id']: Sampler({**s, 'sampleSeconds': c['sampleSeconds']}) for s in c.get('loadSources', [])}
    for sid in sites:
        if store.state('started:' + sid) is None:
            store.set_state('started:' + sid, clock())
    store.set_state('collectorStart', clock())

    def tick():
        now = clock()
        for sid, sampler in samplers.items():
            store.add_load(sid, sampler.sample(now))
        for site in sites.values():
            ingest_log(store, site, now)
        store.set_state('lastSample', now)

    async def loop():
        rounds = 0
        while True:
            try:
                if rounds % 120 == 0:
                    await run_in_threadpool(store.prune)
                await run_in_threadpool(tick)
                sampling_status['error'] = None
            except (OSError, ValueError, OverflowError, sqlite3.Error):
                # Reporting a full/unavailable database must not require another write.
                sampling_status['error'] = {'at': clock(), 'code': 'sampling_unavailable'}
            rounds += 1
            await asyncio.sleep(c['sampleSeconds'])

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(loop()) if sampling else None
        yield
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store

    @app.middleware('http')
    async def boundary(request, call_next):
        # Only this path is suitable for a public Nginx location.
        if request.url.path != '/events' and not bearer(request, read_key):
            return JSONResponse({'error': 'unauthorized'}, status_code=401)
        try:
            response = await call_next(request)
        except OverflowError:
            response = JSONResponse({'error': 'storage_limit'}, status_code=507)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.post('/events')
    async def events(request: Request):
        now = clock()
        address = request.client.host if request.client else 'unknown'
        if c.get('trustedProxyTokenEnv'):
            if not hmac.compare_digest(request.headers.get('x-collector-proxy', ''), secret(c['trustedProxyTokenEnv'])):
                raise HTTPException(403, 'proxy authentication required')
            try:
                address = str(ipaddress.ip_address(request.headers.get('x-real-ip', '')))
            except ValueError:
                raise HTTPException(400, 'invalid proxy client address')
        rate_key = hashlib.sha256(address.encode()).digest()
        if not limiter.allow(rate_key, now, 1, 20):
            raise HTTPException(429, 'rate limit', headers={'Retry-After': '60'})
        event = await small_json(request)
        site = sites.get(event.get('site')) if isinstance(event.get('site'), str) else None
        if not site or request.headers.get('origin') not in site.get('origins', []):
            raise HTTPException(403, 'site origin not allowed')
        if not limiter.allow('site:' + site['id'], now, 50, 100):
            raise HTTPException(429, 'site rate limit')
        try:
            validate_event(event, site)
        except (ValueError, TypeError):
            raise HTTPException(400, 'event does not match the site catalog')
        await run_in_threadpool(store.add_event, event, site.get('timezone', 'Asia/Shanghai'), now)
        return Response(status_code=204)

    @app.get('/summary/{site_id}')
    def summary(site_id: str, window: str = 'today'):
        if site_id not in sites:
            raise HTTPException(404, 'unknown site')
        try:
            result = store.summary(sites[site_id], window, clock())
        except ValueError:
            raise HTTPException(400, 'invalid window')
        result['samplingError'] = sampling_status['error']
        return result

    @app.get('/loads')
    def loads(seconds: int = 3600, window: str = "", timezone: str = "Asia/Shanghai"):
        if timezone not in {s.get("timezone", "Asia/Shanghai") for s in sites.values()}:
            raise HTTPException(400, "invalid timezone")
        if window:
            from .store import window_bounds
            try:
                if window not in {"today", "yesterday"} and not window.startswith("date:"): raise ValueError()
                window_bounds(window, timezone, clock())
            except ValueError:
                raise HTTPException(400, "invalid window")
        if seconds not in {900, 3600, 86400}:
            raise HTTPException(400, 'invalid load window')
        return {'sources': [{**store.loads(s['id'], seconds, clock(), window=window or None, timezone=timezone), 'name': s.get('name', s['id'])}
                            for s in c.get('loadSources', [])]}

    @app.get('/growth/{site_id}')
    def growth(site_id: str):
        site = sites.get(site_id)
        if not site:
            raise HTTPException(404, 'unknown site')
        path = site.get('growthDiagnosticsFile')
        if not path:
            return {'status': 'unavailable', 'data': None}
        try:
            raw = Path(path).read_bytes()
            if len(raw) > 131072:
                raise ValueError('snapshot too large')
            data = json.loads(raw)
            generated = data.get('generatedAt')
            if data.get('schemaVersion') != 1 or not isinstance(generated, str):
                raise ValueError('invalid snapshot')
            from datetime import datetime
            age = clock() - datetime.fromisoformat(generated).timestamp()
            if not -30 <= age <= 300:
                raise ValueError('stale snapshot')
            if not isinstance(data.get('recentFailures'), list) or len(data['recentFailures']) > 50:
                raise ValueError('invalid failures')
            return {'status': 'ok', 'data': data}
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            return {'status': 'unavailable', 'data': None}

    @app.get('/health')
    def health():
        return {'status': 'degraded' if sampling_status['error'] else 'ok', 'time': clock(),
                'lastSample': store.state('lastSample'), 'samplingError': sampling_status['error']}
    return app
