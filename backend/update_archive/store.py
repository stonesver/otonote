"""Bounded archive ledger and blob lifecycle, shared by both regions.

CAS protects short ledger changes; uploads, downloads and deletes never hold a
producer lock. Uncertain transfers remain charged until verified recovery.
"""
from __future__ import annotations
import contextlib
import copy
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid
import zlib

from .models import (ArchiveError, Conflict, CAPACITY, CONTROL_RESERVE, MAX_CONTROL, MAX_EXPANDED_CONTROL,
                     WINDOW, canonical, digest, identity, region, safe_name, timestamp)

PREFIX = 'update-archive/v1/'
LEDGER = 'control/ledger.json'
GONE = {'evicted_fifo', 'expired', 'cleaned_manual'}


def key_name(key):
    safe_name(key)
    if not (key == LEDGER or re.fullmatch(r'(global|jp)/objects/[a-f0-9]{64}-[a-f0-9]{32}', key)):
        raise ArchiveError('archive_key_not_allowed')
    return key


def file_digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


class LocalBucket:
    """Explicit local adapter, never selected implicitly by cloud configuration."""
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        key_name(key)
        p = self.root / key
        if any(x.is_symlink() for x in (p, *p.parents) if x == self.root or self.root in x.parents):
            raise ArchiveError('linked_archive_path')
        return p

    def get(self, key):
        p = self.path(key)
        if not p.exists():
            return None
        if p.stat().st_size > MAX_CONTROL:
            raise ArchiveError('control_too_large')
        raw = p.read_bytes()
        return raw, digest(raw)

    def replace(self, key, data, etag):
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        lock = self.root / '.archive.lock'
        if lock.is_symlink():
            raise ArchiveError('linked_archive_path')
        with lock.open('a+b') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            old = self.get(key)
            if (old[1] if old else None) != etag:
                raise Conflict('revision_conflict')
            with tempfile.NamedTemporaryFile(dir=p.parent, delete=False) as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
                temporary = out.name
            os.replace(temporary, p)

    def put_file(self, key, path):
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Digest-addressed immutable keys; atomic exclusive link avoids overwrite.
        with tempfile.NamedTemporaryFile(dir=p.parent, delete=False) as out:
            with Path(path).open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    out.write(chunk)
            temporary = Path(out.name)
        try:
            try:
                os.link(temporary, p)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)

    def open(self, key):
        return self.path(key).open('rb')

    def exists(self, key):
        return self.path(key).exists()

    def signature(self, key):
        path = self.path(key)
        return [path.stat().st_size, file_digest(path)]

    def delete(self, key):
        self.path(key).unlink(missing_ok=True)


class S3Bucket:
    """Archive-only object access. SDK import is optional and lazy."""
    def __init__(self, client, bucket):
        if not isinstance(bucket, str) or not bucket:
            raise ArchiveError('archive_bucket_required')
        self.client, self.bucket = client, bucket

    def name(self, key):
        return PREFIX + key_name(key)

    @staticmethod
    def code(error):
        return getattr(error, 'response', {}).get('Error', {}).get('Code')

    def get(self, key):
        try:
            item = self.client.get_object(Bucket=self.bucket, Key=self.name(key))
        except Exception as exc:
            if self.code(exc) in ('NoSuchKey', '404', 'NotFound'):
                return None
            raise ArchiveError('archive_read_failed') from None
        with contextlib.closing(item['Body']) as body:
            raw = body.read(MAX_CONTROL + 1)
        if len(raw) > MAX_CONTROL:
            raise ArchiveError('control_too_large')
        return raw, item['ETag']

    def replace(self, key, data, etag):
        condition = {'IfMatch': etag} if etag else {'IfNoneMatch': '*'}
        try:
            self.client.put_object(Bucket=self.bucket, Key=self.name(key), Body=data,
                                   ContentType='application/json', CacheControl='no-store', **condition)
        except Exception as exc:
            if self.code(exc) in ('PreconditionFailed', '412', 'ConditionalRequestConflict'):
                raise Conflict('revision_conflict') from None
            raise ArchiveError('archive_write_failed') from None

    def put_file(self, key, path):
        try:
            with Path(path).open('rb') as body:
                self.client.put_object(Bucket=self.bucket, Key=self.name(key), Body=body,
                                       ContentLength=Path(path).stat().st_size,
                                       ContentType='application/octet-stream', CacheControl='no-store',
                                       IfNoneMatch='*')
        except Exception as exc:
            if self.code(exc) not in ('PreconditionFailed', '412'):
                raise ArchiveError('archive_upload_failed') from None

    def open(self, key):
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self.name(key))['Body']
        except Exception:
            raise ArchiveError('archive_read_failed') from None

    def exists(self, key):
        try:
            self.client.head_object(Bucket=self.bucket, Key=self.name(key))
            return True
        except Exception as exc:
            if self.code(exc) in ('NoSuchKey', '404', 'NotFound'):
                return False
            raise ArchiveError('archive_head_failed') from None

    def signature(self, key):
        try:
            item = self.client.head_object(Bucket=self.bucket, Key=self.name(key))
            return [item['ContentLength'], item['ETag']]
        except Exception:
            raise ArchiveError('archive_head_failed') from None

    def delete(self, key):
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self.name(key))
        except Exception:
            raise ArchiveError('archive_delete_failed') from None


class ArchiveRepository:
    def __init__(self, bucket, *, capacity=CAPACITY, clock=time.time):
        if type(capacity) is not int or not CONTROL_RESERVE < capacity <= CAPACITY:
            raise ArchiveError('invalid_capacity')
        self.bucket, self.capacity, self.clock = bucket, capacity, clock

    def empty(self):
        return {'schemaVersion': 1, 'revision': 0, 'capacity': self.capacity, 'entries': {},
                'objects': {}, 'baselines': {}, 'batches': {}, 'checks': [], 'requests': {},
                'groups': {}, 'modes': {}, 'leases': {}, 'cleanup': {}}

    def state(self):
        item = self.bucket.get(LEDGER)
        raw = item[0] if item else None
        if raw and raw.startswith(b'\x1f\x8b'):
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                    raw = stream.read(MAX_EXPANDED_CONTROL + 1)
            except (OSError, EOFError, zlib.error):
                raise ArchiveError('invalid_compressed_control') from None
        if raw is not None and len(raw) > MAX_EXPANDED_CONTROL:
            raise ArchiveError('control_too_large')
        state = json.loads(raw) if raw is not None else self.empty()
        if state.get('schemaVersion') != 1 or state.get('capacity') != self.capacity:
            raise ArchiveError('archive_state_mismatch')
        return state, item[1] if item else None

    def mutate(self, fn, *, revision=None):
        for _ in range(32):
            state, etag = self.state()
            if revision is not None and state['revision'] != revision:
                raise Conflict('revision_conflict')
            result = fn(state)
            state['revision'] += 1
            raw = canonical(state)
            if len(raw) > MAX_EXPANDED_CONTROL:
                raise ArchiveError('control_too_large')
            # Full baselines repeat long asset paths; a real two-region initial
            # inventory is already ~20 MiB. Bound both decoded and stored bytes.
            if len(raw) >= 1024 * 1024:
                raw = gzip.compress(raw, compresslevel=1, mtime=0)
            if len(raw) > MAX_CONTROL:
                raise ArchiveError('control_too_large')
            if self.used(state) > self.capacity - CONTROL_RESERVE:
                raise ArchiveError('capacity_exceeded')
            try:
                self.bucket.replace(LEDGER, raw, etag)
                return result
            except Conflict:
                if revision is not None:
                    raise
        raise Conflict('archive_busy')

    @staticmethod
    def used(state):
        return sum(o['size'] for o in state['objects'].values())

    def summary(self, *, now=None):
        now = self.clock() if now is None else now
        state, _ = self.state()
        return {'status': 'ready', 'revision': state['revision'], 'capacityBytes': self.capacity,
                'storedBytes': self.used(state), 'controlReservedBytes': CONTROL_RESERVE,
                'usedBytes': self.used(state) + CONTROL_RESERVE, 'windowSeconds': WINDOW,
                'regions': {r: {'mode': state['modes'].get(r, 'auto'),
                    'storedBytes': sum(o['size'] for k, o in state['objects'].items() if k.startswith(r + '/')),
                    'pending': sum(e['region'] == r and e['status'] in ('pending', 'deferred_auto', 'waiting_manual', 'failed')
                                   and e['expiresAt'] > now for e in state['entries'].values())}
                    for r in ('global', 'jp')}, 'checks': state['checks'][-20:]}

    def entries(self, selected_region, *, now=None):
        region(selected_region)
        return sorted((self.visible(e, now) for e in self.state()[0]['entries'].values()
                       if e['region'] == selected_region), key=lambda e: (e['observedAt'], e['id']), reverse=True)

    def visible(self, entry, now=None):
        now = self.clock() if now is None else now
        result = copy.deepcopy(entry)
        if entry['expiresAt'] <= now and entry['status'] not in GONE:
            result['status'] = 'expired'
        return result

    def entry(self, entry_id, *, now=None):
        entry = self.state()[0]['entries'].get(entry_id)
        if entry is None:
            raise ArchiveError('entry_not_found')
        return self.visible(entry, now)

    def register(self, entry):
        def commit(s):
            if entry['id'] not in s['entries']:
                s['entries'][entry['id']] = entry
            return entry['id']
        return self.mutate(commit)

    def add(self, selected_region, name, data, *, observed_at, now, restore=False):
        region(selected_region); safe_name(name); timestamp(observed_at); timestamp(now)
        eid = identity([selected_region, name, observed_at])
        self.register({'id': eid, 'region': selected_region, 'key': name, 'source': 'remote_asset',
                       'observedAt': observed_at, 'expiresAt': observed_at + WINDOW,
                       'status': 'pending', 'size': len(data), 'objects': [], 'attempts': 0})
        if self.entry(eid, now=now)['status'] in GONE and not restore:
            return eid
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(data); stream.flush()
            self.save(eid, Path(stream.name), now=now, restore=restore)
        return eid

    def verify(self, key, expected_sha, size):
        h, count = hashlib.sha256(), 0
        with contextlib.closing(self.bucket.open(key)) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                count += len(chunk)
                if count > size:
                    raise ArchiveError('object_size_mismatch')
                h.update(chunk)
        if count != size or h.hexdigest() != expected_sha:
            raise ArchiveError('object_digest_mismatch')

    def make_space(self, size, *, now, exclude=(), evict=True):
        if size > self.capacity - CONTROL_RESERVE:
            raise ArchiveError('single_item_cannot_fit')
        for _ in range(10000):
            s, _ = self.state()
            if self.used(s) + size <= self.capacity - CONTROL_RESERVE:
                return
            leases = {v['entry'] for v in s['leases'].values() if v['until'] > now}
            candidates = sorted((e for e in s['entries'].values() if e['status'] == 'saved'
                                 and e['id'] not in leases and e['id'] not in exclude),
                                key=lambda e: (e['firstArchivedAt'], e['id']))
            if not candidates or not evict:
                raise ArchiveError('capacity_deferred')
            self.remove([candidates[0]['id']], reason='evicted_fifo', now=now)
        raise ArchiveError('cleanup_limit')

    def save(self, eid, path, *, now=None, restore=False, role='raw', evict=True):
        elapsed_start = time.monotonic()
        now = self.clock() if now is None else now
        path = Path(path)
        size, sha, token = path.stat().st_size, file_digest(path), uuid.uuid4().hex
        entry = self.entry(eid, now=now)
        if entry['expiresAt'] <= now:
            raise ArchiveError('entry_expired')
        if entry['status'] in GONE and not restore:
            raise Conflict('entry_changed')
        # A fresh generation never reuses a deleting key: a delayed remote delete
        # therefore cannot destroy a later restoration of identical bytes.
        current_objects = self.state()[0]['objects']
        key = next((k for k, o in current_objects.items() if k.startswith(entry['region'] + '/')
                    and o['sha256'] == sha and o['status'] == 'live'),
                   entry['region'] + '/objects/' + sha + '-' + token)
        existing = current_objects.get(key)
        if not existing:
            self.make_space(size, now=now, exclude=(eid,), evict=evict)

        def reserve(s):
            e = s['entries'][eid]
            if e['expiresAt'] <= now or (e['status'] in GONE and not restore):
                raise Conflict('entry_changed')
            obj = s['objects'].get(key)
            if obj and obj['status'] != 'live':
                raise Conflict('object_busy')
            if not obj:
                if self.used(s) + size > self.capacity - CONTROL_RESERVE:
                    raise Conflict('capacity_changed')
                s['objects'][key] = {'size': size, 'sha256': sha, 'status': 'reserved',
                                     'token': token, 'until': now + 1800, 'refs': [eid], 'role': role}
            elif eid not in obj['refs']:
                obj['refs'].append(eid)
            if key not in e['objects']:
                e['objects'].append(key)
            e['saveToken'] = token
            return bool(obj)
        reused = self.mutate(reserve)
        if not reused:
            self.bucket.put_file(key, path)
        if reused:
            obj = self.state()[0]['objects'][key]
            if obj.get('signature') != self.bucket.signature(key):
                raise ArchiveError('object_identity_changed')
        else:
            self.verify(key, sha, size)
        signature = self.bucket.signature(key)

        def finish(s):
            e, obj = s['entries'][eid], s['objects'].get(key)
            if (not obj or e.get('saveToken') != token or e['expiresAt'] <= now + time.monotonic() - elapsed_start
                    or (e['status'] in GONE and not restore)
                    or obj['status'] not in ('live', 'reserved')):
                raise Conflict('entry_changed')
            if obj['status'] == 'reserved' and obj['token'] != token:
                raise Conflict('object_changed')
            obj['status'] = 'live'
            obj['signature'] = signature
            if eid not in obj['refs']:
                obj['refs'].append(eid)
            if key not in e['objects']:
                e['objects'].append(key)
            if role == 'raw':
                if restore and entry['status'] in GONE:
                    e.pop('previews', None); e.pop('previewStatus', None); e.pop('decoderContext', None)
                e.update(status='saved', sha256=sha, objectKey=key, size=size)
                e.setdefault('firstArchivedAt', now)
            else:
                e.setdefault('previews', {})[role] = {'key': key, 'size': size, 'sha256': sha}
            return key
        return self.mutate(finish)

    def remove(self, ids, *, reason, now=None, cleanup_id=None, deadline=None):
        if reason not in GONE:
            raise ArchiveError('invalid_cleanup_reason')
        now = self.clock() if now is None else now
        token = uuid.uuid4().hex
        def mark(s):
            active = {v['entry'] for v in s['leases'].values() if v['until'] > now}
            keys = []
            for eid in ids:
                e = s['entries'].get(eid)
                if e is None or eid in active:
                    continue
                e['status'], e['cleanedAt'], e['cleanupReason'] = reason, now, reason
                e.pop('saveToken', None)
                for key in e['objects']:
                    obj = s['objects'].get(key)
                    if not obj:
                        continue
                    obj['refs'] = [r for r in obj['refs'] if r != eid]
                    if not obj['refs']:
                        if obj['status'] == 'reserved':
                            obj['deleteAfter'] = obj['until'] + 120
                        obj.update(status='deleting', token=token, cleanupId=cleanup_id)
                        if obj.get('deleteAfter', 0) <= now:
                            keys.append(key)
            return keys
        keys = self.mutate(mark)
        released = 0
        for key in keys:
            if deadline is not None and time.monotonic() >= deadline:
                break
            self.bucket.delete(key)
            if self.bucket.exists(key):
                raise ArchiveError('delete_unconfirmed')
            def finish(s):
                obj = s['objects'].get(key)
                if obj and obj['status'] == 'deleting' and obj['token'] == token and not obj['refs']:
                    size = obj['size']
                    if obj.get('cleanupId') in s['cleanup']:
                        s['cleanup'][obj['cleanupId']]['releasedBytes'] += size
                    del s['objects'][key]
                    return size
                return 0
            released += self.mutate(finish)
        return released

    def expire(self, *, now=None, deadline=None):
        now = self.clock() if now is None else now
        ids = [e['id'] for e in self.state()[0]['entries'].values()
               if e['expiresAt'] <= now and e['status'] not in GONE]
        return self.remove(ids, reason='expired', now=now, deadline=deadline) if ids else 0

    def recover(self, *, now=None, deadline=None):
        """Resume marked deletes; reclaim abandoned uploads only after quiescence.

        Runner hard deadline is 20 minutes, reservations live 30 minutes plus a
        two-minute transport grace. A new run never frees an active uploader's
        reservation merely because it has no committed references yet.
        """
        now = self.clock() if now is None else now
        for key, obj in self.state()[0]['objects'].items():
            if deadline is not None and time.monotonic() >= deadline:
                break
            if obj['status'] == 'deleting':
                if obj.get('deleteAfter', 0) > now:
                    continue
                self.bucket.delete(key)
                if self.bucket.exists(key):
                    continue
                def removed(s):
                    current = s['objects'].get(key)
                    if current == obj:
                        if obj.get('cleanupId') in s['cleanup']:
                            s['cleanup'][obj['cleanupId']]['releasedBytes'] += obj['size']
                        del s['objects'][key]
                self.mutate(removed)
            elif obj['status'] == 'reserved' and obj['until'] + 120 < now:
                # Verify before recovering, or remove uncertain bytes before releasing quota.
                valid = False
                if self.bucket.exists(key):
                    try:
                        self.verify(key, obj['sha256'], obj['size'])
                        valid = True
                        signature = self.bucket.signature(key)
                    except ArchiveError:
                        self.bucket.delete(key)
                        if self.bucket.exists(key):
                            continue
                def recovered(s):
                    current = s['objects'].get(key)
                    if current != obj:
                        return
                    refs = [eid for eid in obj['refs'] if eid in s['entries']
                            and s['entries'][eid]['status'] not in GONE
                            and s['entries'][eid]['expiresAt'] > now]
                    if valid and refs:
                        current.update(status='live', refs=refs, signature=signature)
                        for eid in refs:
                            e = s['entries'][eid]
                            if obj.get('role', 'raw') == 'raw':
                                e.update(status='saved', objectKey=key, sha256=obj['sha256'], size=obj['size'])
                                e.setdefault('firstArchivedAt', now)
                    elif not valid:
                        del s['objects'][key]
                        for eid in obj['refs']:
                            if eid in s['entries']:
                                e = s['entries'][eid]
                                e['objects'] = [x for x in e['objects'] if x != key]
                    else:
                        current.update(status='deleting', refs=[])
                self.mutate(recovered)

    def compact(self, *, now=None):
        now = self.clock() if now is None else now
        def shrink(s):
            s['leases'] = {k: v for k, v in s['leases'].items() if v['until'] > now}
            s['checks'] = s['checks'][-180:]
            s['entries'] = {k: e for k, e in s['entries'].items()
                            if e['expiresAt'] > now or e['status'] not in GONE
                            or any(k in s['objects'] for k in e['objects'])}
            s['batches'] = {k: b for k, b in s['batches'].items() if b.get('observedAt', now) + WINDOW > now}
            for field in ('requests', 'cleanup'):
                s[field] = {k: r for k, r in s[field].items()
                            if r.get('createdAt', now) + WINDOW > now or r['status'] in ('queued', 'running')}
        self.mutate(shrink)

    @contextlib.contextmanager
    def reading(self, eid, *, now=None):
        now = self.clock() if now is None else now
        token = uuid.uuid4().hex
        def lease(s):
            e = s['entries'].get(eid)
            if not e or e['status'] != 'saved' or e['expiresAt'] <= now:
                raise ArchiveError('entry_unavailable')
            obj = s['objects'].get(e['objectKey'])
            if not obj or obj['status'] != 'live':
                raise ArchiveError('entry_unavailable')
            s['leases'] = {k: v for k, v in s['leases'].items() if v['until'] > now}
            s['leases'][token] = {'entry': eid, 'until': now + 300}
            return copy.deepcopy(e)
        e = self.mutate(lease)
        try:
            yield e
        finally:
            self.mutate(lambda s: s['leases'].pop(token, None))

    def content(self, eid, *, now=None):
        with self.reading(eid, now=now) as e:
            with contextlib.closing(self.bucket.open(e['objectKey'])) as stream:
                raw = stream.read(e['size'] + 1)
            if len(raw) != e['size'] or digest(raw) != e['sha256']:
                raise ArchiveError('object_digest_mismatch')
            return raw
