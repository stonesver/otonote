"""Select a verified Global working set without deleting local or remote files."""
from __future__ import annotations

import json
from pathlib import Path
import re

from tools.r2_state import _inside, safe_relative
from tools.resource_pipeline.adapters.global_public import version_identity


RUN = re.compile(r'[0-9.]+-[a-f0-9]{8}-[a-f0-9]{8}-complete-v[0-9]+-[a-f0-9]{8}(?:-d[a-f0-9]{12})?\Z')


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def excluded_runs(root: Path, config_path: Path, production: dict) -> list[str]:
    """Exclude only managed sync generations not referenced by this success.

    Rollback uses the previous immutable R2 manifest. Initial inputs, all trusted
    client material and conversion caches remain selected by the caller's original
    allowlist. Unknown directories, links or incomplete evidence fail closed.
    """
    from tools.r2_production_gate import (_receipt_for_light, read_json, state_path,
        state_without_receipt, trusted_input_inventory, verified_plan, state_plan)
    config_path = _inside(root, str(Path(config_path).relative_to(root)))
    config = read_json(config_path)
    workspace = _inside(root, safe_relative(config['workspace']))
    state_file = state_path(root, 'global')
    if workspace/'state.json' != state_file or config.get('completeContent') is not True:
        raise ValueError('unsupported Global working set configuration')
    state_bytes = state_file.read_bytes()
    state = json.loads(state_bytes)
    if production != state_without_receipt(state) or production.get('status') != 'content_published':
        raise ValueError('Global working set requires this successful production')
    receipt = _receipt_for_light(state, 'global')
    if (receipt is None or receipt['inputPaths'].get('config') != str(config_path.relative_to(root))
            or receipt['publicPointer'] != state.get('publication', {}).get('pointer')
            or trusted_input_inventory(root, 'global', receipt['inputPaths'], state) != receipt['trustedInputInventory']
            or not verified_plan(root, 'global', state)):
        raise ValueError('Global working set verification failed')
    plan = state_plan(root, 'global', state)
    sync = _inside(root, str((workspace/'sync-complete').relative_to(root)))
    sync_file = _inside(root, str((sync/'state.json').relative_to(root)))
    sync_bytes = sync_file.read_bytes()
    sync_state = json.loads(sync_bytes)
    if (sync_state.get('inputPlan') != str(plan)
            or version_identity(sync_state.get('observation', {})) != version_identity(state.get('observation', {}))
            or sync_state.get('pipelineVersion') != 3):
        raise ValueError('Global sync state differs from successful production')

    generations = []
    for path in sorted(sync.iterdir()):
        _inside(root, str(path.relative_to(root)))
        if path.is_dir():
            if not RUN.fullmatch(path.name):
                raise ValueError('unknown Global sync generation')
            # Do not silently exclude paths that the unfiltered inventory rejects.
            if any(item.is_symlink() for item in path.rglob('*')):
                raise ValueError('symlink in Global sync generation')
            generations.append(path)
    kept = set()
    documents = [state, sync_state, read_json(plan)]
    visited = {plan}
    prefix = str(sync.relative_to(root)) + '/'
    while documents:
        for raw in strings(documents.pop()):
            relative = raw.removeprefix(str(root) + '/')
            if not relative.startswith(prefix):
                continue
            path = _inside(root, safe_relative(relative))
            generation = sync / path.relative_to(sync).parts[0]
            if generation not in generations:
                if path == sync_file:
                    continue
                raise ValueError('missing Global input generation reference')
            if not path.exists():
                raise ValueError('missing Global input reference')
            kept.add(generation)
            # Follow control documents, including references to reused old inputs.
            if path.is_file() and path.suffix == '.json' and path not in visited:
                if len(visited) >= 10000 or path.stat().st_size > 16 * 1024 * 1024:
                    raise ValueError('Global reference audit exceeds budget')
                visited.add(path)
                documents.append(json.loads(path.read_bytes()))
    if not kept or state_file.read_bytes() != state_bytes or sync_file.read_bytes() != sync_bytes:
        raise ValueError('Global working set changed during audit')
    return [str(path.relative_to(root)) for path in generations if path not in kept]
