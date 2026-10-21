"""Retain version-matched decoder inputs without running a parser in the cloud."""
import tempfile
from pathlib import Path
from .models import ArchiveError, canonical


def capture_context(repo, eid, context, *, now, budget):
    state, _ = repo.state()
    entry = state['entries'][eid]
    expected = state['batches'].get(entry.get('batch'), {}).get('observation', {}).get('clientVersion')
    metadata = context.get('metadata')
    if entry.get('decoderContext'):
        return 0
    if not metadata or context.get('clientVersion') != expected:
        return 0
    path = Path(metadata)
    try:
        size = path.stat().st_size if path.is_file() else None
    except OSError:
        return 0
    if size is None or size > 32 * 1024 ** 2:
        return 0
    profile = canonical({k: context.get(k) for k in ('clientVersion', 'profile', 'region')})
    cost = 2 * (size + len(profile))
    if cost > budget:
        return 0
    try:
        with tempfile.TemporaryDirectory(prefix='archive-context-') as folder:
            target = Path(folder) / 'profile.json'
            target.write_bytes(profile)
            repo.save_previews(eid, [{'role': 'context_metadata', 'path': path},
                                    {'role': 'context_profile', 'path': target}], now=now)
    except (ArchiveError, OSError):
        repo.mutate(lambda s: s['entries'][eid].update(contextStatus='unavailable'))
    return cost
