"""Atomically publish public Arena ranking observations without changing event boards."""
import json
import os
import tempfile
from pathlib import Path

from backend.arena_rankings import observation_path, validate_observation


def publish_observations(observations, root, server):
    if not isinstance(observations, list) or not 1 <= len(observations) <= 10:
        raise ValueError('invalid_arena_ranking_observations')
    checked, seen = [], set()
    # A malformed response must not replace any previous successful observation.
    for row in observations:
        if not isinstance(row, dict):
            raise ValueError('invalid_arena_ranking_observation')
        value = validate_observation(row, server, row.get('seasonId'), row.get('bandId'))
        target = observation_path(root, server, value['seasonId'], value['bandId'])
        if target in seen:
            raise ValueError('duplicate_arena_ranking_scope')
        seen.add(target)
        checked.append((target, value))
    paths = []
    for target, value in checked:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        # Capture may use a private umask. Only these public observations are readable.
        for directory in (target.parent, target.parent.parent, target.parent.parent.parent):
            os.chmod(directory, 0o755)
        fd, temporary = tempfile.mkstemp(prefix='.arena-', dir=target.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o644)
                json.dump(value, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        paths.append(target)
    return paths
