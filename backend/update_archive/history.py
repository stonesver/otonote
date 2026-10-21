"""Stable version links, independent of physical object retention."""
from .diff import same_content
from .models import identity


def prior_entry(entries, region, source, key, previous):
    if not previous:
        return None
    candidates = [e for e in entries.values()
                  if e['region'] == region and e['source'] == source and e['key'] == key
                  and e.get('change') != 'removed'
                  and same_content(e.get('file', {}), previous)]
    return max(candidates, key=lambda e: (e['observedAt'], e['id']))['id'] if candidates else None


def upgrade(state):
    """Read v1 without resurrecting already deleted objects; next CAS writes v2."""
    legacy = state['schemaVersion'] == 1
    state['schemaVersion'] = 2
    for entry in state['entries'].values():
        entry.pop('expiresAt', None)
    if legacy:
        ordered = sorted(state['entries'].values(), key=lambda e: (e['observedAt'], e['id']))
        seen = {}
        for entry in ordered:
            key = (entry['region'], entry['source'], entry['key'])
            versions = seen.setdefault(key, {})
            if 'previousEntryId' not in entry:
                entry['previousEntryId'] = prior_entry(versions, *key, entry.get('file', {}).get('previous'))
            versions[entry['id']] = entry
        # Existing installations already have a baseline. Make its uncaptured
        # files selectable without waiting for the next upstream change.
        for key, baseline in state['baselines'].items():
            if ':' not in key or 'files' not in baseline:
                continue
            region, source = key.split(':', 1)
            bid = identity(['legacy-baseline', key, baseline['id']])
            ids = []
            for row in baseline['files']:
                if prior_entry(seen.get((region, source, row['key']), {}), region, source, row['key'], row):
                    continue
                eid = identity([bid, row['key']])
                state['entries'][eid] = {'id': eid, 'batch': bid, 'region': region, 'source': source,
                    'key': row['key'], 'file': row, 'size': row['size'], 'change': 'baseline',
                    'baseline': True, 'observedAt': baseline.get('observedAt', 0),
                    'status': 'waiting_manual', 'objects': [], 'attempts': 0, 'previousEntryId': None}
                ids.append(eid)
            if ids:
                state['batches'][bid] = {'id': bid, 'region': region, 'source': source,
                    'sourceId': baseline['id'], 'previousSourceId': None,
                    'observedAt': baseline.get('observedAt', 0), 'observation': baseline.get('observation', {}),
                    'entries': ids, 'group': None}
    for obj in state['objects'].values():
        obj.setdefault('storedAt', min((state['entries'][eid].get('firstArchivedAt',
                                      state['entries'][eid]['observedAt'])
                                      for eid in obj['refs'] if eid in state['entries']), default=0))


def content_entry(entries, entry):
    """Resolve the pre-removal version, following metadata-only aliases."""
    seen = set()
    while entry and entry['id'] not in seen:
        seen.add(entry['id'])
        if entry.get('sha256'):
            return entry
        if entry.get('change') not in ('removed', 'metadata_changed'):
            # An uncaptured modified version must never borrow older bytes.
            return None
        entry = entries.get(entry.get('previousEntryId'))
    return None
