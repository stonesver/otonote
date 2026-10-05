"""Build one fresh JP content candidate from an official version observation.

The verified 1.0.4 split APK and metadata are private inputs. Unknown client
versions stop before any content publication. R2 promotion is a separate step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from tools.global_remote_sync import file_hash, read_json, write_json
from tools.resource_pipeline.adapters.global_public import version_identity
from tools.jp_remote_sync import client_from_metadata, snapshot
from tools.jp_phone_inputs import build as build_inputs

ROOT = Path(__file__).resolve().parents[1]
# Include the whole production tool tree: JP intake, current_* extractors,
# candidate generation, publication, and their indirect Python/Node helpers.
# A commit SHA would also change for documentation-only commits, causing a new
# run directory and needless reacquisition of the same official CDN resources.
FINGERPRINT_ROOTS = {
    'tools': frozenset(('.py', '.js', '.mjs', '.cjs', '.json')),
    'analysis/crypto': frozenset(('.py', '.txt')),
    'packages/scoring': frozenset(('.js', '.mjs', '.cjs', '.json')),
    'config': frozenset(('.json', '.toml', '.yaml', '.yml')),
}
# publish-update-image.yml copies site/package*.json to the *root of its
# temporary Docker build context; there are no repository-root package files.
# Both Docker stages and their locked Python/Node inputs affect the producer.
FINGERPRINT_FILES = (
    '.dockerignore',
    '.github/workflows/publish-update-image.yml',
    'catalog/evidence/arena-client.json',
    'Dockerfile.worker',
    'requirements-worker.txt',
    'analysis/requirements.txt',
    'analysis/crypto/requirements.txt',
    'site/package.json',
    'site/package-lock.json',
    'deploy/Dockerfile.global-update',
)


def fingerprint():
    files = {}
    for dirname, suffixes in FINGERPRINT_ROOTS.items():
        directory = ROOT / dirname
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('JP producer source directory missing or linked: ' + dirname)
        for path in directory.rglob('*'):
            if path.suffix not in suffixes:
                continue
            if path.is_symlink() or not path.is_file():
                raise ValueError('JP producer source file missing or linked: ' + str(path.relative_to(ROOT)))
            files[path.relative_to(ROOT).as_posix()] = file_hash(path)
    for name in FINGERPRINT_FILES:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('JP producer toolchain file missing or linked: ' + name)
        files[name] = file_hash(path)
    return hashlib.sha256(json.dumps({'schemaVersion': 2, 'files': files},
                                     sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def run(*, metadata: Path, apk_root: Path, unity_version_file: Path,
        workspace: Path, content_store: Path, minimum_free_bytes=0):
    metadata, apk_root, unity_version_file, workspace, content_store = (
        Path(path).resolve() for path in (metadata, apk_root, unity_version_file, workspace, content_store))
    if (ROOT/'output').resolve() not in workspace.parents or workspace == content_store or workspace in content_store.parents or content_store in workspace.parents:
        raise ValueError('JP workspace must be isolated under output/')
    if any(path.is_symlink() for path in (metadata, apk_root, unity_version_file, workspace, content_store)):
        raise ValueError('linked JP input or output root')
    workspace.mkdir(parents=True, exist_ok=True)
    if minimum_free_bytes and shutil.disk_usage(workspace).free < minimum_free_bytes:
        raise ValueError('insufficient runner disk; JP current content preserved')
    client = client_from_metadata(metadata, authorize_builtin_credentials=True)
    observation = client.discover()
    source_id = version_identity(observation)
    code_id = fingerprint()
    state_path = workspace/'state.json'
    previous = read_json(state_path) if state_path.exists() else None
    if (previous and previous.get('status') == 'built' and (content_store/'jp/current.json').is_file() and
            tuple(previous.get('versionIdentity', ())) == source_id and previous.get('codeFingerprint') == code_id):
        return {'status':'unchanged','region':'jp','observation':{k:observation[k] for k in ('clientVersion','masterVersion','resourceVersion','catalogHash')},
                'publication':previous['publication']}
    run_id = hashlib.sha256(json.dumps({'source':source_id,'code':code_id},sort_keys=True).encode()).hexdigest()[:24]
    folder = workspace/'runs'/run_id
    folder.mkdir(parents=True, exist_ok=True)
    source = folder/'snapshot'
    if not source.exists(): snapshot(client, source)
    snap = read_json(source/'report.json')
    if (snap.get('status') != 'verified_snapshot' or
            version_identity(snap['observation']) != source_id):
        raise ValueError('JP cached snapshot does not match the official observation')
    inputs = folder/'inputs'
    if not inputs.exists():
        build_inputs(source, source/'master-json', metadata, apk_root, inputs,
                     remote=True, unity_version_file=unity_version_file)
    plan = inputs/'release-inputs.json'
    from tools.release_preflight import inspect_plan
    if inspect_plan(plan, require_production=True)['status'] != 'passed':
        raise ValueError('JP production input preflight failed')
    candidate = folder/'candidate'
    if not candidate.exists():
        subprocess.run([sys.executable, 'tools/release_candidates.py', '--plan', str(plan),
                        '--output', str(candidate), '--keep-failed'], cwd=ROOT, check=True)
    if read_json(candidate/'candidate.json').get('inputPlanSha256') != file_hash(plan):
        raise ValueError('JP candidate input plan mismatch')
    from tools.scoring_content import bind_scoring_rules
    from tools.content_publication import publish_content
    source_binding = read_json(plan)['environments'][0]
    rules = bind_scoring_rules(ROOT/source_binding['masterRoot'], source_binding['contentReleaseId'])
    rules_path = folder/'formal-scoring-rules.json'
    write_json(rules_path, rules)
    if version_identity(client.discover()) != source_id:
        raise ValueError('JP source changed before content publication')
    publication = publish_content(candidate, content_store, scoring_rules=rules_path)
    result = {'schemaVersion':1,'status':'built','region':'jp',
              'versionIdentity':list(source_id),'codeFingerprint':code_id,
              'runId':run_id,'inputPlanSha256':file_hash(plan),
              'publication':publication,
              'observation':{k:observation[k] for k in ('clientVersion','masterVersion','resourceVersion','catalogHash')}}
    write_json(state_path, result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--apk-root', type=Path, required=True)
    parser.add_argument('--unity-version-file', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--content-store', type=Path, required=True)
    parser.add_argument('--minimum-free-bytes', type=int, default=0)
    args = parser.parse_args(argv)
    try:
        result = run(metadata=args.metadata, apk_root=args.apk_root,
                     unity_version_file=args.unity_version_file, workspace=args.workspace,
                     content_store=args.content_store, minimum_free_bytes=args.minimum_free_bytes)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({'status':'blocked','region':'jp','error':str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
