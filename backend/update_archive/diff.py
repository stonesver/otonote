"""Compare complete per-source inventories without guessing renamed entities."""
from .models import ArchiveError, file_record


def inventory(rows):
    result = {}
    for raw in rows:
        row = file_record(raw)
        key = (row['source'], row['key'])
        if key in result and result[key] != row:
            raise ArchiveError('conflicting_inventory')
        result[key] = row
    return result


def same_content(a, b):
    # Missing hashes never prove content identity, even with equal sizes.
    token_a, token_b = a.get('sha256') or a.get('hash'), b.get('sha256') or b.get('hash')
    return bool(token_a and token_b and token_a == token_b and a['size'] == b['size']
                and a.get('hashAlgorithm') == b.get('hashAlgorithm'))


def compare(current, previous):
    new, old = inventory(current), inventory(previous)
    changes = []
    for key in sorted(new.keys() | old.keys()):
        a, b = new.get(key), old.get(key)
        if a == b:
            continue
        change = 'removed' if a is None else 'added' if b is None else (
            'metadata_changed' if same_content(a, b) else 'modified')
        changes.append({**(a or b), 'change': change, 'previous': b,
                        'needsDownload': change in ('added', 'modified')})
    return changes
