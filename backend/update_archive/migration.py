"""Explicit ledger migration after all consumers have installed schema-3 readers."""
import argparse
import json
import signal
from pathlib import Path

from .config import load_config, repository
from .ledger import book, unpack
from .models import ArchiveError, MAX_EXPANDED_CONTROL
from .store import LEDGER


def migrate(repo, backup):
    item = repo.bucket.get(LEDGER)
    if not item:
        raise ArchiveError('archive_ledger_required')
    header = unpack(item[0], MAX_EXPANDED_CONTROL)
    destination = Path(backup)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    path = destination / LEDGER
    path.parent.mkdir()
    path.write_bytes(item[0])
    if header['schemaVersion'] == 3:
        for pages in book(header)['maps'].values():
            for page in pages:
                repo.ledger.page(page)  # Verify before saving a rollback copy.
                raw = repo.bucket.get(page['key'])
                if not raw:
                    raise ArchiveError('ledger_page_missing')
                path = destination / page['key']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw[0])
    before = repo.state()[0]
    repo.migrate()
    after = repo.state()[0]
    for field in ('entries', 'batches', 'groups'):
        if not set(before[field]) <= set(after[field]):
            raise ArchiveError('ledger_history_verification_failed')
    root = repo.bucket.get(LEDGER)
    return {'status': 'migrated', 'schemaVersion': 3, 'entries': len(after['entries']),
            'batches': len(after['batches']), 'rootBytes': len(root[0]),
            'pages': sum(len(v) for v in book(unpack(root[0], MAX_EXPANDED_CONTROL))['maps'].values())}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup')
    args = parser.parse_args(argv)
    if args.apply and not args.backup:
        parser.error('--apply requires an external --backup directory')
    repo = repository(load_config(args.config))
    if repo is None:
        raise ArchiveError('archive_disabled')
    if args.apply:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
        signal.alarm(1200)
        try:
            result = migrate(repo, args.backup)
        finally:
            signal.alarm(0)
    else:
        item = repo.bucket.get(LEDGER)
        header = unpack(item[0], MAX_EXPANDED_CONTROL) if item else repo.empty()
        state = repo.state()[0]
        maps, _ = repo.ledger.plan(state, book(header))
        result = {'status': 'checked', 'schemaVersion': header['schemaVersion'],
                  'entries': len(state['entries']), 'pages': sum(map(len, maps.values()))}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
