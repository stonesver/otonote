"""Archive admission is separate from producer publication policy."""
import re
from .models import ArchiveError, CAPACITY, CONTROL_RESERVE

FILE_LIMIT = 256 * 1024 ** 2
UNIT_LIMIT = 512 * 1024 ** 2
TRANSFER_LIMIT = 2 * 1024 ** 3


def major_update(before, after):
    if before == after:
        return False
    a, b = re.fullmatch(r'(\d+)\.(\d+)(?:\.\d+)*', before or ''), re.fullmatch(r'(\d+)\.(\d+)(?:\.\d+)*', after or '')
    return not a or not b or a.groups() != b.groups()


def decisions(changes, *, mode='auto', old_client=None, new_client=None, hard_limit=FILE_LIMIT):
    if mode not in ('auto', 'record', 'manual'):
        raise ArchiveError('invalid_mode')
    output = {}
    units = {}
    for row in changes:
        key = (row['source'], row['key'])
        if not row['needsDownload']:
            output[key] = 'removed' if row['change'] == 'removed' else 'metadata_only'
        elif (mode == 'manual' or row['size'] > min(FILE_LIMIT, hard_limit)
              or row['source'] == 'client_entry' and major_update(old_client, new_client)):
            output[key] = 'waiting_manual'
        else:
            output[key] = 'deferred_auto' if mode == 'record' else 'pending'
            units.setdefault(row['source'], []).append(row)
    for rows in units.values():
        if sum(r['size'] for r in rows) > UNIT_LIMIT:
            for row in rows:
                output[(row['source'], row['key'])] = 'waiting_manual'
    return output
