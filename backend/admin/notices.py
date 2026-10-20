"""Drafts and independently published, public-only notices on a resource node."""
import fcntl
import json
import math
import os
import re
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


class Conflict(ValueError):
    pass

NOTICE_FIELDS = {'kind', 'region', 'title', 'body', 'titleEn', 'bodyEn', 'href', 'startsAt', 'endsAt'}


def validate_notice(value):
    if not isinstance(value, dict) or set(value) not in (NOTICE_FIELDS | {'paths'}, NOTICE_FIELDS | {'path'}):
        raise ValueError('invalid notice fields')
    for key, maximum in [('kind', 20), ('region', 20), ('title', 120),
                         ('body', 2000), ('titleEn', 120), ('bodyEn', 2000), ('href', 300)]:
        if not isinstance(value[key], str) or len(value[key]) > maximum or '\x00' in value[key]:
            raise ValueError('invalid notice text')
    if (value['kind'] not in {'info', 'maintenance', 'incident'} or value['region'] not in {'all', 'global', 'jp'}
            or not value['title'].strip() or not value['body'].strip()):
        raise ValueError('invalid notice type or content')
    # Logical paths only, never an origin, query, fragment or encoded path.
    paths = value['paths'] if 'paths' in value else [value['path']]
    if not isinstance(paths, list) or not 1 <= len(paths) <= 32 or any(
            not isinstance(path, str) or len(path) > 200 or not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)*', path)
            for path in paths):
        raise ValueError('invalid notice paths')
    if value['href'] and not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)*', value['href']):
        raise ValueError('invalid logical path')
    for key in ('startsAt', 'endsAt'):
        stamp = value[key]
        if stamp is not None and (type(stamp) not in (int, float) or not math.isfinite(stamp) or not 0 <= stamp <= 253402300799):
            raise ValueError('invalid notice time')
    if value['endsAt'] is not None and value['startsAt'] is not None and value['endsAt'] <= value['startsAt']:
        raise ValueError('notice must end after it starts')
    result = {key: value[key] for key in NOTICE_FIELDS}
    result['paths'] = ['/'] if '/' in paths else list(dict.fromkeys(paths))
    return result


def atomic_json(path, value, mode):
    descriptor, temporary = tempfile.mkstemp(prefix='.notice-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        # Persist the new directory entry before acknowledging publication.
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Notices:
    """Public file is publication truth; draft saves never change it."""
    def __init__(self, directory):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root.chmod(0o755)

    @contextmanager
    def locked(self, site):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', site):
            raise ValueError('invalid site')
        root = self.root / site
        root.mkdir(exist_ok=True)
        root.chmod(0o755)
        with (root / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield root

    @staticmethod
    def read(root, name, default):
        path = root / name
        if not path.exists():
            return default
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('notice storage too large')
        return json.loads(path.read_text())

    def list(self, site):
        with self.locked(site) as root:
            return self._list(root)

    def _list(self, root):
        drafts = self.read(root, 'drafts.json', {})
        public = self.read(root, 'public.json', {'schemaVersion': 1, 'notices': []})
        published = {row['id']: {key: row[key] for key in ('revision', 'startsAt', 'endsAt')} for row in public['notices']}
        return {'notices': [{**row, 'published': published.get(key)} for key, row in drafts.items()]}

    def change(self, site, payload, actor):
        if (not isinstance(payload, dict) or not isinstance(payload.get('action'), str)
                or payload['action'] not in {'save', 'publish', 'withdraw', 'delete'}):
            raise ValueError('invalid notice action')
        action = payload['action']
        expected = {'action', 'id', 'expectedRevision'} | ({'notice'} if action == 'save' else set())
        if (set(payload) != expected or not isinstance(payload['id'], str)
                or not re.fullmatch('[a-f0-9]{32}', payload['id'])
                or type(payload['expectedRevision']) is not int or payload['expectedRevision'] < 0):
            raise ValueError('invalid notice identity')
        identity = payload['id']
        with self.locked(site) as root:
            drafts = self.read(root, 'drafts.json', {})
            public = self.read(root, 'public.json', {'schemaVersion': 1, 'notices': []})
            draft = drafts.get(identity)
            published = next((n for n in public['notices'] if n['id'] == identity), None)
            content = validate_notice(payload['notice']) if action == 'save' else None
            if (action == 'save' and draft and draft['revision'] == payload['expectedRevision'] + 1
                    and draft['updatedBy'] == actor and all(draft.get(k) == v for k, v in content.items())):
                return self._list(root)
            baseline = published if action == 'withdraw' else draft
            if payload['expectedRevision'] != (baseline['revision'] if baseline else 0):
                raise Conflict('notice changed; reload before editing')
            if action == 'save':
                if draft and all(draft.get(k) == v for k, v in content.items()):
                    return self._list(root)
                if not draft and len(drafts) >= 32:
                    raise ValueError('notice limit reached')
                drafts[identity] = {**content, 'id': identity, 'revision': payload['expectedRevision'] + 1,
                                    'updatedAt': time.time(), 'updatedBy': actor}
                atomic_json(root / 'drafts.json', drafts, 0o600)
            elif action == 'delete':
                if published:
                    raise Conflict('withdraw the public notice before deleting its draft')
                drafts.pop(identity, None)
                atomic_json(root / 'drafts.json', drafts, 0o600)
            else:
                if not draft:
                    raise ValueError('save a draft before publishing')
                notices = [row for row in public['notices'] if row['id'] != identity]
                if action == 'publish':
                    notices.append({**validate_notice({key: draft[key] for key in
                        NOTICE_FIELDS | ({'paths'} if 'paths' in draft else {'path'})}),
                                    'id': identity, 'revision': draft['revision']})
                atomic_json(root / 'public.json', {'schemaVersion': 1, 'notices': notices}, 0o644)
            return self._list(root)


def register_notices(app, config):
    """Node auth middleware protects these routes with existing read/write keys."""
    from fastapi import HTTPException, Request
    from .collector import small_json
    settings = config.get('notices')
    if not settings:
        return
    store = Notices(settings['directory'])

    def allowed(site):
        if site not in settings['sites']:
            raise HTTPException(404, 'unknown notice site')

    @app.get('/notices/{site}')
    def list_notices(site: str):
        allowed(site)
        try:
            return store.list(site)
        except (OSError, ValueError):
            raise HTTPException(503, 'notice storage unavailable')

    @app.post('/notices/{site}')
    async def change_notice(site: str, request: Request):
        allowed(site)
        data = await small_json(request, 65536)
        actor = data.pop('actor', None)
        if actor not in settings['publishUsers']:
            raise HTTPException(403, 'notice publication not allowed')
        try:
            return store.change(site, data, actor)
        except Conflict:
            raise HTTPException(409, 'notice revision conflict')
        except ValueError:
            raise HTTPException(400, 'invalid notice')
        except OSError:
            raise HTTPException(503, 'notice write failed; reload to check result')
