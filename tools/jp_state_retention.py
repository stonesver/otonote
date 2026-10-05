"""Keep the successful JP run in an ephemeral runner; never delete R2 objects."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

from tools.global_remote_sync import file_hash, read_json
from tools.resource_pipeline.adapters.global_public import version_identity


def _inside(root: Path, path: Path) -> Path:
    root, path = Path(root).absolute(), Path(path).absolute()
    if path == root or root not in path.parents:
        raise ValueError('JP state path escapes root')
    if root.is_symlink() or any(part.is_symlink() for part in (path, *path.parents) if part == root or root in part.parents):
        raise ValueError('linked JP state path')
    if path.resolve() != path:
        raise ValueError('noncanonical JP state path')
    return path


def verified_run(root: Path, workspace: Path, state: dict) -> tuple[Path, Path]:
    """Bind retained inputs and source catalog to the last successful state."""
    workspace = _inside(root, workspace)
    run_id = state.get('runId')
    if (state.get('status') != 'built' or state.get('region') != 'jp'
            or not isinstance(run_id, str) or not re.fullmatch('[a-f0-9]{24}', run_id)):
        raise ValueError('JP successful run identity is absent')
    expected = hashlib.sha256(json.dumps({'source': state.get('versionIdentity'),
        'code': state.get('codeFingerprint')}, sort_keys=True).encode()).hexdigest()[:24]
    if run_id != expected:
        raise ValueError('JP run identity differs from source and code')
    folder = _inside(root, workspace/'runs'/run_id)
    plan = _inside(root, folder/'inputs/release-inputs.json')
    if file_hash(plan) != state.get('inputPlanSha256'):
        raise ValueError('JP retained input plan mismatch')
    entries = read_json(plan).get('environments', [])
    if len(entries) != 1 or entries[0].get('region') != 'jp':
        raise ValueError('JP retained plan edition mismatch')
    entry = entries[0]
    manifest = _inside(root, root/entry['manifest'])
    if folder/'inputs' not in manifest.parents or file_hash(manifest) != entry.get('manifestSha256'):
        raise ValueError('JP retained source manifest mismatch')
    catalog = _inside(root, folder/'snapshot/RemoteCatalog/catalog_main.bin')
    report = read_json(_inside(root, folder/'snapshot/report.json'))
    sha = file_hash(catalog)
    if (report.get('status') != 'verified_snapshot'
            or tuple(state.get('versionIdentity', [])) != version_identity(report['observation'])
            or report.get('catalogSha256') != sha
            or read_json(manifest).get('objects', {}).get('remoteCatalog', {}).get('sha256') != sha):
        raise ValueError('JP retained source catalog mismatch')
    return folder, catalog


def prune(root: Path, production: dict) -> dict:
    """Run after gate receipt recording and before checkpoint, in Actions only."""
    from tools.r2_production_gate import (_receipt_for_light, state_without_receipt,
        source_identity, trusted_input_inventory, verified_plan)
    root = Path(root).resolve(strict=True)
    workspace = _inside(root, root/'output/r2-jp/workspace')
    state_path = _inside(root, workspace/'state.json')
    before = state_path.read_bytes()
    state = json.loads(before)
    if production != state_without_receipt(state) or production.get('status') != 'built':
        raise ValueError('JP retention requires this successful production result')
    receipt = _receipt_for_light(state, 'jp')
    if receipt is None or receipt.get('publicPointer') != state.get('publication', {}).get('pointer'):
        raise ValueError('JP verified publication receipt is absent')
    expected_inputs = {'metadata': 'output/r2-jp/metadata.v39.dat',
                       'apkRoot': 'output/r2-jp/apks', 'unityVersion': 'output/r2-jp/unity-version.txt'}
    if (receipt['inputPaths'] != expected_inputs or
            state.get('codeFingerprint') != receipt['producerCodeSha256'] or
            source_identity(state.get('versionIdentity', [])) != receipt['sourceSha256'] or
            trusted_input_inventory(root, 'jp', receipt['inputPaths'], state) != receipt['trustedInputInventory']
            or not verified_plan(root, 'jp', state)):
        raise ValueError('JP retained production inputs differ from receipt')
    current, _catalog = verified_run(root, workspace, state)
    runs = _inside(root, workspace/'runs')
    obsolete = []
    for path in runs.iterdir():
        _inside(root, path)
        if not path.is_dir() or not re.fullmatch('[a-f0-9]{24}', path.name):
            raise ValueError('unexpected JP run path; retention aborted')
        if path != current:
            if any(child.is_symlink() for child in path.rglob('*')):
                raise ValueError('linked obsolete JP run; retention aborted')
            obsolete.append(path)
    if state_path.read_bytes() != before:
        raise ValueError('JP state changed during retention audit')
    for path in obsolete:
        _inside(root, path)
        shutil.rmtree(path)
    return {'status': 'pruned', 'region': 'jp', 'keptRunId': current.name,
            'removedRuns': len(obsolete)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--production-result', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prune(args.root, read_json(args.production_result)), sort_keys=True))


if __name__ == '__main__':
    main()
