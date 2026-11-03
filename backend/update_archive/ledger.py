"""Immutable, bounded ledger pages published through one conditional root write.

The root registers uploads before bytes leave the process. Concurrent writers
may share immutable pages, but only a matching logical revision can publish.
Retired generations remain readable for an hour; collection never deletes a
page referenced by a root or an unexpired writer reservation.
"""
import copy
import contextlib
import gzip
import io
import json
import time
import threading
import uuid
import zlib
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

from .models import ArchiveError, Conflict, CONTROL_RESERVE, MAX_CONTROL, canonical, digest

ROOT = 'control/ledger.json'
FIELDS = ('entries', 'objects', 'baselines', 'batches', 'requests', 'groups',
          'modes', 'leases', 'cleanup', 'runs', '_baselineFiles')
TARGET = 1024 * 1024
MAX_PAGE = 16 * 1024 * 1024
GRACE = 3600
WRITER_LIFETIME = 1800
WRITER_WAIT_SECONDS = 300
CACHE_BYTES = 32 * 1024 * 1024


def partition(key):
    return format(int(digest(key.encode()), 16), '0256b')


def unpack(raw, limit):
    if raw.startswith(b'\x1f\x8b'):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                raw = stream.read(limit + 1)
        except (OSError, EOFError, zlib.error):
            raise ArchiveError('invalid_compressed_control') from None
    if len(raw) > limit:
        raise ArchiveError('control_too_large')
    return json.loads(raw)


def pack(value):
    return gzip.compress(canonical(value), compresslevel=1, mtime=0)


def book(header):
    return copy.deepcopy(header.get('_storage', {'maps': {}, 'blobs': {}, 'writers': {}}))


def referenced(storage, now):
    keys = {page['key'] for pages in storage['maps'].values() for page in pages}
    for writer in storage['writers'].values():
        if writer['until'] > now:
            keys.update(writer['keys'])
    return keys


def reserve_bytes(storage):
    # Root working room and every registered generation, including failed uploads.
    return max(CONTROL_RESERVE, MAX_CONTROL + sum(p['size'] for p in storage['blobs'].values()))


class ControlCapacity(ArchiveError):
    def __init__(self, required):
        super().__init__('capacity_exceeded')
        self.required = required


class Ledger:
    def __init__(self, bucket, *, clock=time.time):
        self.bucket, self.clock = bucket, clock
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.cache_lock = threading.RLock()
        self.local = threading.local()

    def release_writer(self, token):
        for _ in range(32):
            item = self.bucket.get(ROOT)
            if not item:
                return
            header = unpack(item[0], 128 * 1024 * 1024)
            storage = book(header)
            if token not in storage['writers']:
                return
            storage['writers'].pop(token)
            header['_storage'] = storage
            try:
                self.write_root(header, item[1])
                return
            except Conflict:
                continue
        raise Conflict('archive_busy')

    @contextlib.contextmanager
    def admission(self, *, empty, force=False):
        """Fair, leased admission before loading the logical mutation snapshot.

        A large region update must not restart every time another region writes
        one small entry. Readers keep using the last published root throughout.
        Upload registrations remain separate from logical history and billing.
        """
        if getattr(self.local, 'token', None):
            yield
            return
        token, registered = uuid.uuid4().hex, False
        deadline = time.monotonic() + WRITER_WAIT_SECONDS
        try:
            for _ in range(32):
                item = self.bucket.get(ROOT)
                header = unpack(item[0], 128 * 1024 * 1024) if item else empty()
                if not force and header.get('schemaVersion') != 3 and '_storage' not in header:
                    yield
                    return
                if header.get('schemaVersion') not in (1, 2, 3) or header.get('capacity') != empty()['capacity']:
                    raise ArchiveError('archive_state_mismatch')
                storage, now = book(header), self.clock()
                storage['writers'] = {k: v for k, v in storage['writers'].items() if v['until'] > now}
                order = max([storage.get('nextWriter', 0)] + [v.get('order', 0) for v in storage['writers'].values()]) + 1
                storage['nextWriter'] = order
                storage['writers'][token] = {'keys': [], 'until': now + WRITER_LIFETIME,
                                             'admission': True, 'order': order}
                header['_storage'] = storage
                try:
                    self.write_root(header, item[1] if item else None)
                    registered = True
                    break
                except Conflict:
                    continue
            if not registered:
                raise Conflict('archive_busy')
            delay = .05
            while True:
                item = self.bucket.get(ROOT)
                storage = book(unpack(item[0], 128 * 1024 * 1024))
                now = self.clock()
                waiting = sorted((v['order'], key) for key, v in storage['writers'].items()
                                 if v.get('admission') and v['until'] > now)
                own = storage['writers'].get(token)
                if not own or own['until'] <= now:
                    raise Conflict('ledger_writer_expired')
                if waiting and waiting[0][1] == token:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ArchiveError('ledger_writer_busy')
                time.sleep(min(delay, remaining))
                delay = min(2, delay * 2)
            self.local.token = token
            try:
                yield
            finally:
                self.local.token = None
        finally:
            if registered:
                self.release_writer(token)

    def cached(self, key, raw=None):
        with self.cache_lock:
            return self._cached(key, raw)

    def _cached(self, key, raw=None):
        if raw is None:
            raw = self.cache.pop(key, None)
            if raw is None:
                return None
            self.cache_bytes -= len(raw)
        old = self.cache.pop(key, None)
        if old is not None:
            self.cache_bytes -= len(old)
        if len(raw) <= CACHE_BYTES:
            self.cache[key] = raw
            self.cache_bytes += len(raw)
        while self.cache_bytes > CACHE_BYTES:
            _, removed = self.cache.popitem(last=False)
            self.cache_bytes -= len(removed)
        return raw

    def page(self, descriptor):
        key = descriptor['key']
        raw = self.cached(key)
        if raw is None:
            item = self.bucket.get(key)
            if item is None:
                raise ArchiveError('ledger_page_missing')
            raw = item[0]
        if len(raw) != descriptor['size'] or digest(raw) != descriptor['sha256']:
            raise ArchiveError('ledger_page_digest_mismatch')
        value = unpack(raw, MAX_PAGE)
        if not isinstance(value, dict) or len(value) != descriptor['count']:
            raise ArchiveError('invalid_ledger_page')
        self.cached(key, raw)
        return value

    def load(self, header):
        storage = header['_storage']
        if set(storage['maps']) != set(FIELDS):
            raise ArchiveError('invalid_ledger_index')
        state = {k: v for k, v in header.items() if k not in ('_storage', '_controlStorageBytes')}
        deadline = time.monotonic() + 300
        def read(page):
            if time.monotonic() > deadline:
                raise ArchiveError('ledger_snapshot_expired')
            return self.page(page)
        for field, pages in storage['maps'].items():
            rows = {}
            for page in pages:
                registered = storage['blobs'].get(page['key'], {})
                if (registered.get('deleting') or registered.get('sha256') != page['sha256']
                        or registered.get('size') != page['size']):
                    raise ArchiveError('invalid_ledger_index')
            with ThreadPoolExecutor(max_workers=4) as pool:
                for page, value in zip(pages, pool.map(read, pages)):
                    if time.monotonic() > deadline:
                        raise ArchiveError('ledger_snapshot_expired')
                    if any(k in rows or not partition(k).startswith(page['prefix']) for k in value):
                        raise ArchiveError('invalid_ledger_partition')
                    rows.update(value)
            state[field] = rows
        files = state.pop('_baselineFiles')
        for baseline in state['baselines'].values():
            count = baseline.pop('_fileCount', None)
            if count is not None:
                if type(count) is not int or not 0 <= count <= len(files):
                    raise ArchiveError('invalid_ledger_baseline')
                baseline['files'] = [None] * count
        for item in files.values():
            baseline = state['baselines'].get(item['baseline'], {})
            rows, index = baseline.get('files', []), item['index']
            if type(index) is not int or not 0 <= index < len(rows) or rows[index] is not None:
                raise ArchiveError('invalid_ledger_baseline')
            rows[index] = item['file']
        if any(row is None for baseline in state['baselines'].values() for row in baseline.get('files', [])):
            raise ArchiveError('invalid_ledger_baseline')
        state['schemaVersion'] = 2  # Existing logical interface, independent of wire layout.
        state['_controlStorageBytes'] = reserve_bytes(storage)
        return state

    def plan(self, state, storage):
        # A whole source baseline is not one indivisible record. Keep the exact
        # original order while paging its inventory independently of its header.
        state = dict(state)
        baselines, files = {}, {}
        for key, baseline in state.get('baselines', {}).items():
            value = dict(baseline)
            if 'files' in value:
                rows = value.pop('files')
                value['_fileCount'] = len(rows)
                for index, row in enumerate(rows):
                    files[digest(canonical([key, index]))] = {'baseline': key, 'index': index, 'file': row}
            baselines[key] = value
        state.update(baselines=baselines, _baselineFiles=files)
        existing = {p['sha256']: (key, p) for key, p in storage['blobs'].items() if not p.get('deleting')}
        maps, uploads = {}, {}
        def split(rows, prefix):
            raw = canonical(rows)
            if len(raw) > TARGET and len(rows) > 1:
                if len(prefix) >= 256:
                    raise ArchiveError('invalid_ledger_partition')
                groups = {}
                for key, value in rows.items():
                    part = partition(key)[:len(prefix) + 1]
                    groups.setdefault(part, {})[key] = value
                return [page for part, group in sorted(groups.items()) for page in split(group, part)]
            if len(raw) > MAX_PAGE:
                raise ArchiveError('ledger_record_too_large')
            raw = gzip.compress(raw, compresslevel=1, mtime=0)
            sha = digest(raw)
            key = existing.get(sha, (f'control/shards/{sha}-{uuid.uuid4().hex}.json.gz',))[0]
            descriptor = {'key': key, 'sha256': sha, 'size': len(raw), 'count': len(rows), 'prefix': prefix}
            uploads[key] = raw
            return [descriptor]
        for field in FIELDS:
            maps[field] = split(state.get(field, {}), '') if state.get(field) else []
        return maps, uploads

    def write_root(self, header, etag):
        raw = pack(header)
        if len(raw) > MAX_CONTROL:
            raise ArchiveError('control_too_large')
        self.bucket.replace(ROOT, raw, etag)

    def commit(self, state, header, etag, capacity):
        now, token = self.clock(), getattr(self.local, 'token', None)
        storage = book(header)
        writer = storage['writers'].get(token)
        if not writer or writer['until'] <= now:
            raise Conflict('ledger_writer_expired')
        maps, uploads = self.plan(state, storage)
        for pages in maps.values():
            for page in pages:
                storage['blobs'].setdefault(page['key'], {
                    'size': page['size'], 'sha256': page['sha256'], 'retiredAt': now})
        required = reserve_bytes(storage)
        if sum(o['size'] for o in state['objects'].values()) + required > capacity:
            raise ControlCapacity(required)
        writer['keys'] = list(uploads)
        reserved = dict(header, _storage=storage)
        # Even a legacy root first records its complete staged-page inventory.
        self.write_root(reserved, etag)
        def upload(item):
            key, raw = item
            if self.clock() >= writer['until']:
                raise Conflict('ledger_writer_expired')
            if self.cached(key) is None:
                try:
                    self.bucket.replace(key, raw, None)
                except Conflict:
                    pass  # A concurrent writer may already have uploaded it.
                item = self.bucket.get(key)
                if item is None or item[0] != raw:
                    raise ArchiveError('ledger_page_readback_failed')
                self.cached(key, raw)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(upload, uploads.items()))
        # Reservations by other writers may change the ETag without changing
        # logical data. A committed logical revision always forces a retry.
        for _ in range(32):
            item = self.bucket.get(ROOT)
            current = unpack(item[0], 128 * 1024 * 1024)
            if current['revision'] != header['revision']:
                raise Conflict('revision_conflict')
            current_book = book(current)
            if token not in current_book['writers'] or self.clock() >= current_book['writers'][token]['until']:
                raise Conflict('ledger_writer_expired')
            current_book['writers'][token]['keys'] = []
            old_refs = referenced(current_book, self.clock())
            current_book['maps'] = maps
            new_refs = referenced(current_book, self.clock())
            for key in old_refs - new_refs:
                current_book['blobs'][key]['retiredAt'] = self.clock()
            candidate = {k: v for k, v in state.items() if k not in FIELDS and k not in ('_storage', '_controlStorageBytes')}
            candidate.update(schemaVersion=3, _storage=current_book)
            try:
                self.write_root(candidate, item[1])
                return
            except Conflict:
                continue
        raise Conflict('archive_busy')

    def collect(self, *, deadline=None):
        """Retire physical generations, never logical history or active uploads."""
        item = self.bucket.get(ROOT)
        if not item:
            return False
        header = unpack(item[0], 128 * 1024 * 1024)
        if header.get('schemaVersion') != 3:
            return False
        storage, now = book(header), self.clock()
        storage['writers'] = {k: v for k, v in storage['writers'].items() if v['until'] > now}
        keep = referenced(storage, now)
        doomed = [key for key, p in storage['blobs'].items()
                  if key not in keep and p['retiredAt'] + GRACE <= now]
        if not doomed:
            return False
        for key in doomed:
            storage['blobs'][key]['deleting'] = True
        header['_storage'] = storage
        try:
            self.write_root(header, item[1])
        except Conflict:
            return False  # A fresh root won; reconsider reachability next time.
        deleted = []
        for key in doomed:
            if deadline is not None and time.monotonic() >= deadline:
                break
            self.bucket.delete(key)
            if self.bucket.exists(key):
                raise ArchiveError('ledger_delete_unconfirmed')
            deleted.append(key)
        if not deleted:
            return False
        for _ in range(32):
            item = self.bucket.get(ROOT)
            current = unpack(item[0], 128 * 1024 * 1024)
            storage = book(current)
            for key in deleted:
                if storage['blobs'].get(key, {}).get('deleting'):
                    storage['blobs'].pop(key)
            current['_storage'] = storage
            try:
                self.write_root(current, item[1])
                return True
            except Conflict:
                continue
        return False  # Deletes remain registered and charged until a later CAS.
