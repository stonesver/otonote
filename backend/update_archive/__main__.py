"""Opt-in, one-shot archive command. Never invokes website production."""
import argparse
import contextlib
import json
import signal

from .config import load_config, repository
from .models import ArchiveError
from .worker import run_once


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--config')
    parser.add_argument('--region', required=True, choices=('global', 'jp'))
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config) if args.config else {'schemaVersion': 1, 'enabled': False}
        if not config['enabled']:
            print(json.dumps({'region': args.region, 'status': 'disabled'}))
            return 0
        # Hard process lifetime also bounds late writes during abandoned-upload recovery.
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
        signal.alarm(1200)
        from .runtime import PreparedSource
        from .previews import generate, bind_context
        repo = repository(config)
        with contextlib.ExitStack() as stack:
            adapter = PreparedSource(config, args.region, stack)
            def preview(repository, entry, *, clock, max_output_bytes):
                bind_context(repository, entry, getattr(adapter, 'context', {}), clock=clock)
                generate(repository, entry, clock=clock, max_output_bytes=max_output_bytes)
            result = run_once(repo, adapter, previewer=preview)
        print(json.dumps(result, sort_keys=True))
        return 1 if result['status'] == 'failed' else 0
    except (ArchiveError, OSError, ValueError, KeyError, TypeError, RuntimeError):
        print(json.dumps({'region': args.region, 'status': 'failed', 'error': 'archive_configuration_or_source_failed'}))
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
