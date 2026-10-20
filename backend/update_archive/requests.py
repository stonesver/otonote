"""Frozen, idempotent workbench requests; no immediate official downloads."""
import copy
import uuid
import time
from .models import ArchiveError, Conflict, WINDOW, identity, region
from .store import GONE


def selected_entries(state, ids, now, *, limit=500):
    if not isinstance(ids, list) or not ids or len(ids) > limit or any(not isinstance(i, str) for i in ids):
        raise ArchiveError('invalid_selection')
    ids = sorted(set(ids))
    if any(i not in state['entries'] or state['entries'][i]['expiresAt'] <= now for i in ids):
        raise ArchiveError('selection_unavailable')
    return ids


def queue_save(repo, ids, *, actor, key, now, max_bytes):
    if not isinstance(key, str) or not 1 <= len(key) <= 128 or type(max_bytes) is not int or not 0 < max_bytes <= 2 * 1024 ** 3:
        raise ArchiveError('invalid_request')
    request_id = identity(['save', actor, key])
    def add(s):
        selection = selected_entries(s, ids, now)
        old = s['requests'].get(request_id)
        if old:
            if old['entries'] != selection or old['maxBytes'] != max_bytes:
                raise Conflict('idempotency_conflict')
            return copy.deepcopy(old)
        r = {'id': request_id, 'entries': selection, 'maxBytes': max_bytes, 'spentBytes': 0,
             'createdAt': now, 'actor': actor, 'status': 'queued'}
        s['requests'][request_id] = r
        return copy.deepcopy(r)
    return repo.mutate(add)


def cleanup_plan(repo, ids, *, actor, now, limit=500):
    plan_id = uuid.uuid4().hex
    def plan(s):
        selection = selected_entries(s, ids, now, limit=limit)
        keys = {k for eid in selection for k in s['entries'][eid]['objects']}
        freed = sum(s['objects'][k]['size'] for k in keys if k in s['objects']
                    and set(s['objects'][k]['refs']) <= set(selection))
        r = {'id': plan_id, 'entries': selection, 'actor': actor, 'createdAt': now,
             'status': 'proposed', 'estimatedBytes': freed, 'releasedBytes': 0}
        r['digest'] = identity(r)
        s['cleanup'][plan_id] = r
        return copy.deepcopy(r)
    return repo.mutate(plan)


def confirm_cleanup(repo, plan_id, digest, *, actor, now):
    def confirm(s):
        p = s['cleanup'].get(plan_id)
        if not p or p['actor'] != actor or p['digest'] != digest:
            raise Conflict('cleanup_plan_changed')
        if p['status'] in ('queued', 'running', 'complete', 'partial'):
            return copy.deepcopy(p)
        if p['status'] != 'proposed' or now > p['createdAt'] + 600:
            raise Conflict('cleanup_plan_expired')
        p['status'] = 'queued'
        return copy.deepcopy(p)
    return repo.mutate(confirm)


def approved_entries(repo, selected_region, *, now):
    s, _ = repo.state()
    result = {}
    for r in sorted(s['requests'].values(), key=lambda r: r['createdAt']):
        if r['status'] not in ('queued', 'running', 'partial'):
            continue
        for eid in r['entries']:
            e = s['entries'].get(eid)
            if e and e['region'] == selected_region and e['expiresAt'] > now:
                if e['size'] * 2 + r.get('spentBytes', 0) <= r['maxBytes']:
                    result.setdefault(eid, r['id'])
    return result


def finish_requests(repo, selected_region, *, now):
    def finish(s):
        for r in s['requests'].values():
            if r['status'] not in ('queued', 'running', 'partial'):
                continue
            entries = [s['entries'].get(eid) for eid in r['entries']]
            if all(e and e['status'] == 'saved' and e['expiresAt'] > now for e in entries):
                r['status'] = 'complete'
            elif all(not e or e['expiresAt'] <= now for e in entries):
                r['status'] = 'expired'
            elif any(e and e['status'] == 'saved' for e in entries):
                r['status'] = 'partial'
    repo.mutate(finish)


def charge_request(repo, request_id, estimated_bytes):
    def charge(s):
        r = s['requests'][request_id]
        if r['status'] not in ('queued', 'running', 'partial'):
            raise Conflict('request_cancelled')
        if r['spentBytes'] + estimated_bytes > r['maxBytes']:
            raise ArchiveError('request_budget_exceeded')
        r['spentBytes'] += estimated_bytes
        r['status'] = 'running'
    repo.mutate(charge)


def cancel_request(repo, request_id, *, actor):
    def cancel(s):
        r = s['requests'].get(request_id)
        if not r or r['actor'] != actor:
            raise ArchiveError('request_not_found')
        if r['status'] not in ('complete', 'expired'):
            r['status'] = 'cancelled'
        return copy.deepcopy(r)
    return repo.mutate(cancel)


def process_cleanups(repo, *, now, deadline=None):
    for p in list(repo.state()[0]['cleanup'].values()):
        if deadline is not None and time.monotonic() >= deadline:
            break
        if p['status'] not in ('queued', 'running', 'partial'):
            continue
        def start(s):
            if s['cleanup'][p['id']]['status'] in ('queued', 'partial'):
                s['cleanup'][p['id']]['status'] = 'running'
            chosen = set(p['entries'])
            for r in s['requests'].values():
                if r['status'] in ('queued', 'running', 'partial') and chosen.intersection(r['entries']):
                    r['status'] = 'cancelled'
        repo.mutate(start)
        try:
            repo.remove(p['entries'], reason='cleaned_manual', now=now, cleanup_id=p['id'], deadline=deadline)
            def finished(s):
                chosen = set(p['entries'])
                complete = (all(eid not in s['entries'] or s['entries'][eid]['status'] in GONE for eid in chosen)
                            and not any(o.get('cleanupId') == p['id'] or (o['status'] in ('reserved', 'deleting')
                                and any(k in s['entries'].get(eid, {}).get('objects', []) for eid in chosen))
                                for k, o in s['objects'].items()))
                s['cleanup'][p['id']]['status'] = 'complete' if complete else 'partial'
            repo.mutate(finished)
        except (ArchiveError, OSError):
            repo.mutate(lambda s: s['cleanup'][p['id']].update(status='partial', error='cleanup_failed'))
