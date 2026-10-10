"""Build and test an official candidate from an isolated, clean Git commit.

The receipt is evidence of commands executed by this runner, not a signature.
Deployment pins its SHA-256 obtained from the trusted CI run / local review.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
# These gates require only checked-in fixtures, never a downloaded game snapshot.
GATES = {
    'python-delivery': ['python', '-m', 'unittest', 'tests.test_code_publication', 'tests.test_release_candidate', 'tests.test_runtime_bundle', 'tests.test_repository_hygiene', 'tests.test_costumes', 'tests.test_content_publication', 'tests.test_global_remote_sync'],
    'browser-content-contract': ['node', '--test', 'site/tests/independent-content.test.mjs', 'site/tests/tool-startup.test.mjs', 'site/tests/navigation-initial-state.test.mjs', 'site/tests/costumes.test.mjs', 'site/tests/card-recognition.test.mjs', 'site/tests/card-recognition-engine.test.mjs', 'site/tests/account-growth-403.test.mjs'],
    'shared-scoring': ['node', '--test', 'site/tests/scoring-engine.test.mjs', 'site/tests/formal-chart.test.mjs', 'site/tests/formal-native-state.test.mjs', 'site/tests/formal-note-core.test.mjs', 'site/tests/formal-score-replay.test.mjs', 'site/tests/formation-optimizer-worker.test.mjs', 'site/tests/shared-scoring-package.test.mjs', 'site/tests/band-item-totals.test.mjs'],
    'performance-planning': ['node', '--test', 'site/tests/performance-scenarios.test.mjs', 'site/tests/gekisou-life-reduction.test.mjs', 'site/tests/gekisou-skill-composition.test.mjs', 'site/tests/scoring-candidate-coverage.test.mjs', 'site/tests/scoring-content-compatibility.test.mjs', 'site/tests/inventory-optimizer-error.test.mjs', 'site/tests/growth-scenarios.test.mjs', 'site/tests/team-planning-integration.test.mjs', 'site/tests/team-planning-directions.test.mjs', 'site/tests/team-planning-scenario.test.mjs', 'site/tests/team-planning-localization.test.mjs', 'site/tests/manual-growth-input.test.mjs'],
    'shared-team-workspace': ['node', '--test', 'site/tests/team-workspace-store.test.mjs', 'site/tests/team-workspace-compatibility.test.mjs', 'site/tests/shared-team-context.test.mjs', 'site/tests/shared-team-selected-growth.test.mjs', 'site/tests/team-card-view.test.mjs', 'site/tests/team-card-filters.test.mjs', 'site/tests/team-card-picker-ui.test.mjs', 'site/tests/workspace-dismiss.test.mjs', 'site/tests/shared-inventory-panel.test.mjs', 'site/tests/personal-growth-store.test.mjs'],
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True)
    if result.returncode: raise ValueError('Git source inspection failed')
    return result.stdout


def inspect_source(root, revision):
    root = Path(root).resolve()
    commit = git(root, 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}').decode().strip()
    if git(root, 'rev-parse', 'HEAD').decode().strip() != commit:
        raise ValueError('requested commit is not the current checkout')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=all').strip():
        raise ValueError('official candidates require a clean checkout; export/review a baseline first')
    from tools.repository_hygiene import classify_path, scan_bytes
    files = {}
    for entry in git(root, 'ls-tree', '-r', '-z', commit).split(b'\0'):
        if not entry: continue
        info, encoded_name = entry.split(b'\t', 1)
        mode, kind, object_id = info.decode().split()
        name = encoded_name.decode()
        if kind != 'blob' or mode not in ('100644','100755'): raise ValueError('unsupported committed source entry')
        path = root / name
        if path.is_symlink() or not path.is_file(): raise ValueError('unsupported source entry')
        data = path.read_bytes()
        blob = b'blob ' + str(len(data)).encode() + b'\0' + data
        object_digest = hashlib.sha1(blob).hexdigest() if len(object_id)==40 else hashlib.sha256(blob).hexdigest()
        if object_digest != object_id: raise ValueError('source bytes do not match the requested commit')
        if classify_path(name) or scan_bytes(name, data):
            raise ValueError('source hygiene gate rejected a tracked file; run repository_hygiene privately')
        files[name] = digest(data)
    if 'site/package-lock.json' not in files: raise ValueError('missing dependency lock')
    return {'commit': commit, 'tree': git(root, 'rev-parse', 'HEAD^{tree}').decode().strip(),
            'dirty': False, 'files': dict(sorted(files.items())), 'fingerprint': digest(canonical(files)),
            'lockSha256': files['site/package-lock.json']}


def check_source_files(root, source):
    for name, expected in source['files'].items():
        path = Path(root) / name
        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected:
            raise ValueError('source changed during candidate verification')


def command_record(label, command, cwd, env):
    actual = [sys.executable if item == 'python' and index == 0 else item for index, item in enumerate(command)]
    result = subprocess.run(actual, cwd=cwd, env=env, capture_output=True)
    if result.returncode:
        # Test output may include fixture data / private environment values.
        raise ValueError('candidate command failed: ' + label + '; rerun the named gate locally for details')
    return {'gate': label, 'command': command, 'exitCode': result.returncode,
            'stdoutSha256': digest(result.stdout), 'stderrSha256': digest(result.stderr)}


def validate_receipt(source, metadata, receipt, expected_sha256=None):
    raw = (Path(source) / 'verification.json').read_bytes()
    if expected_sha256 and digest(raw) != expected_sha256: raise ValueError('verification receipt digest mismatch')
    provenance = metadata.get('provenance', {})
    if provenance.get('kind') != 'verified-commit' or provenance.get('source', {}).get('dirty') is not False:
        raise ValueError('preview artifact is not an official candidate')
    origin = provenance['source']
    import re
    if not re.fullmatch('[a-f0-9]{40,64}', origin.get('commit', '')) or not re.fullmatch('[a-f0-9]{40,64}', origin.get('tree', '')):
        raise ValueError('invalid source identity')
    if digest(canonical(origin.get('files', {}))) != origin.get('fingerprint'):
        raise ValueError('source fingerprint mismatch')
    if origin.get('lockSha256') != origin.get('files', {}).get('site/package-lock.json'):
        raise ValueError('dependency lock fingerprint mismatch')
    if json.loads((Path(source)/'compiled/build-source.json').read_bytes()) != {'fingerprint':origin['fingerprint'],'commit':origin['commit'],'verificationRun':provenance.get('verificationRun')}:
        raise ValueError('compiled source identity mismatch')
    if receipt.get('schemaVersion') != 1 or receipt.get('sourceFingerprint') != origin['fingerprint']:
        raise ValueError('verification source mismatch')
    if receipt.get('artifact') != {'codeId': metadata['codeId'], 'manifestSha256': digest((Path(source)/'code-release.json').read_bytes()), 'shellSha256': digest((Path(source)/'index.html').read_bytes())}:
        raise ValueError('verification artifact mismatch')
    records = receipt.get('commands', [])
    expected_commands = {'dependencies': ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                         **GATES, 'build': ['node', 'tools/build_web_client.mjs', 'output/candidate']}
    if len(records) != len(expected_commands): raise ValueError('missing verification gates')
    if {record.get('gate') for record in records} != set(expected_commands): raise ValueError('missing verification gates')
    for record in records:
        if record.get('command') != expected_commands[record['gate']] or record.get('exitCode') != 0:
            raise ValueError('invalid verification execution record')
        if any(not re.fullmatch('[a-f0-9]{64}', record.get(key, '')) for key in ('stdoutSha256', 'stderrSha256')):
            raise ValueError('missing command output fingerprints')


def build_candidate(root, destination, revision='HEAD'):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    if destination.exists(): raise ValueError('candidate destination must not exist')
    source = inspect_source(root, revision)
    with tempfile.TemporaryDirectory(prefix='ournotes-candidate-') as temp:
        isolated = Path(temp) / 'source'; isolated.mkdir()
        for name in source['files']:
            target = isolated / name; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root/name, target)
        check_source_files(isolated, source)
        home = Path(temp)/'home'; home.mkdir()
        env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8', 'CI': '1',
               'ASTRO_TELEMETRY_DISABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1',
               'OURNOTES_SOURCE_FINGERPRINT': source['fingerprint'], 'OURNOTES_SOURCE_COMMIT': source['commit'], 'OURNOTES_VERIFICATION_RUN': uuid.uuid4().hex}
        toolchain = {}
        for executable in ('node', 'npm'):
            result = subprocess.run([executable, '--version'], env=env, capture_output=True, check=True)
            toolchain[executable] = result.stdout.decode().strip()
        toolchain['python'] = sys.version.split()[0]
        records = [command_record('dependencies', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], isolated/'site', env)]
        for label, command in GATES.items(): records.append(command_record(label, command, isolated, env))
        records.append(command_record('build', ['node', 'tools/build_web_client.mjs', 'output/candidate'], isolated, env))
        check_source_files(isolated, source)
        # Detect concurrent local edits, even though they cannot affect the isolated build.
        if inspect_source(root, revision) != source: raise ValueError('checkout changed during verification')
        output = isolated/'output/candidate'
        metadata = json.loads((output/'code-release.json').read_bytes())
        metadata['provenance'] = {'kind': 'verified-commit', 'source': source, 'toolchain': toolchain, 'verificationRun':env['OURNOTES_VERIFICATION_RUN']}
        (output/'code-release.json').write_bytes(canonical(metadata))
        receipt = {'schemaVersion': 1, 'sourceFingerprint': source['fingerprint'], 'commands': records,
                   'artifact': {'codeId': metadata['codeId'], 'manifestSha256': digest((output/'code-release.json').read_bytes()),
                                'shellSha256': digest((output/'index.html').read_bytes())}}
        (output/'verification.json').write_bytes(canonical(receipt))
        from tools.code_publication import verify_code
        receipt_sha = digest((output/'verification.json').read_bytes())
        verify_code(output, require_verified=True, expected_receipt_sha256=receipt_sha)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(output, destination)
    return {'codeId': metadata['codeId'], 'commit': source['commit'], 'verificationSha256': receipt_sha}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=ROOT); p.add_argument('--revision', default='HEAD')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    try: print(json.dumps(build_candidate(args.root, args.output, args.revision)))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Candidate rejected: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr); return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
