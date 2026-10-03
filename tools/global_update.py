"""Repeatable Global update workflow: doctor, check, run, status and bundle."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
from importlib.machinery import PathFinder
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from uuid import uuid4

from tools.global_remote_sync import file_hash, read_json, write_json, update
from tools.resource_pipeline.adapters.global_public import (
    GlobalPublicClient, discover_package, utc_now, version_identity,
)

ROOT = Path(__file__).resolve().parents[1]
CHART_PROJECTION_SOURCES = (
    'tools/release_candidates.py', 'tools/costume_catalog.py', 'tools/costume_posters.py', 'tools/formal_chart_projection.py',
    'tools/project_formal_charts.mjs', 'packages/scoring/scoring-rules/formal-chart.mjs',
    'packages/scoring/scoring-rules/formal-time.mjs', 'packages/scoring/scoring-rules/model-version.mjs',
)


def chart_projection_fingerprint():
    """A sealed candidate must be rebuilt when chart reconstruction changes."""
    files = {name: file_hash(ROOT/name) for name in CHART_PROJECTION_SOURCES}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def load_config(path: Path) -> dict:
    config = read_json(path)
    if config.get('schemaVersion') != 1:
        raise ValueError('unsupported workflow configuration')
    for key in ('workspace', 'baseline', 'inputPlan', 'initialObservation', 'initialPackage'):
        value = Path(config[key])
        if value.is_absolute() or '..' in value.parts:
            raise ValueError(f'{key} must be repository-relative')
        config[key] = (ROOT / value).resolve()
        if ROOT not in config[key].parents:
            raise ValueError(f'{key} escapes repository')
    if (ROOT / 'output').resolve() not in config['workspace'].parents:
        raise ValueError('workspace must be under output/')
    # Never allow journal writes over configured inputs.
    for key in ('baseline', 'inputPlan', 'initialObservation', 'initialPackage'):
        if config['workspace'] == config[key] or config['workspace'] in config[key].parents or config[key] in config['workspace'].parents:
            raise ValueError('workflow workspace overlaps configured inputs')
    return config


@contextmanager
def locked(workspace: Path):
    workspace.mkdir(parents=True, exist_ok=True)
    with (workspace / 'workflow.lock').open('a+') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('another workflow is running') from None
        yield


class Journal:
    def __init__(self, workspace: Path, command: str):
        self.directory = workspace / 'runs' / (utc_now().replace(':', '-') + '-' + uuid4().hex[:8])
        self.directory.mkdir(parents=True)
        self.workspace = workspace
        self.report = {'schemaVersion': 1, 'command': command, 'status': 'running',
                       'startedAt': utc_now(), 'steps': [], 'publicationReady': False}
        self.save()

    def save(self):
        write_json(self.directory / 'report.json', self.report)
        write_json(self.workspace / 'latest-run.json', {**self.report, 'runDirectory': str(self.directory)})

    def step(self, name, operation):
        row = {'name': name, 'status': 'running', 'startedAt': utc_now()}
        self.report['steps'].append(row)
        self.save()
        print(f'[{name}] 开始', file=sys.stderr, flush=True)
        try:
            result = operation()
        except BaseException as exc:
            row.update(status='failed', error=f'{type(exc).__name__}: {exc}', finishedAt=utc_now())
            self.report.update(status='failed', failedStep=name, error=row['error'], finishedAt=utc_now())
            self.save()
            raise
        row.update(status='passed', finishedAt=utc_now())
        self.save()
        return result

    def finish(self, result):
        self.report.update(status='passed', finishedAt=utc_now(), result=result)
        self.save()
        return result

    def command(self, name, args):
        log = self.directory / f'{name}.log'
        def execute():
            print(f'日志：{log}', file=sys.stderr, flush=True)
            with log.open('w') as stream:
                subprocess.run(args, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True)
        self.step(name, execute)


def doctor(config, *, build=False):
    checks = {}
    def command(name, args, predicate=lambda text: True, codes=(0,)):
        try:
            p = subprocess.run(args, capture_output=True, text=True, timeout=20)
            checks[name] = p.returncode in codes and predicate(p.stdout + p.stderr)
        except (OSError, subprocess.TimeoutExpired):
            checks[name] = False
    command('curl_http2', ['curl', '--version'], lambda text: 'HTTP2' in text)
    for key in ('baseline', 'inputPlan', 'initialObservation'):
        checks[key] = config[key].exists()
    if build:
        # Node also computes content-derived ranking tables; Astro/npm are only
        # needed by the legacy full-website build mode.
        command('node_22.20+', ['node', '--version'], lambda text: tuple(map(int, text.strip().lstrip('v').split('.'))) >= (22,20,0))
        if not config.get('contentPublication'):
            command('npm', ['npm', '--version'])
            checks['site_dependencies'] = (ROOT / 'site/node_modules/astro/package.json').is_file()
        command('ffmpeg', ['ffmpeg', '-version'])
        for module in ('UnityPy', 'PIL', 'py3rijndael', 'elftools'):
            checks['python_' + module] = (importlib.util.find_spec(module) is not None or
                PathFinder.find_spec(module, [str(ROOT / 'analysis/.deps'), str(ROOT / 'analysis/vendor')]) is not None)
        if config.get('intakePackages'):
            command('java', ['java', '-version'])
            command('javac', ['javac', '-version'])
            checks['apksig'] = (ROOT / config['apksigJar']).is_file()
            command('vgmstream', ['vgmstream-cli', '-h'], lambda text: 'vgmstream' in text.lower(), codes=(0, 1))
        else:
            from tools.build_remote_global_inputs import APK, METADATA
            checks['decoder_apk'] = APK.is_file()
            checks['decoder_metadata'] = METADATA.is_file()
    result = {'status': 'passed' if all(checks.values()) else 'failed', 'checks': checks}
    if result['status'] != 'passed':
        raise ValueError('dependency check failed: ' + ', '.join(k for k, v in checks.items() if not v))
    return result


def observation_check(config, client):
    workspace = config['workspace']
    state = workspace / 'state.json'
    previous = read_json(state)['observation'] if state.exists() else read_json(config['initialObservation'])
    observation = client.discover()
    return {'observation': observation, 'resourceChanged': version_identity(previous) != version_identity(observation),
            'changes': [k for k in ('clientVersion', 'cdnRoot', 'masterVersion', 'resourceVersion', 'catalogHash')
                        if previous.get(k) != observation.get(k)]}


def package_check(config, client):
    path = config['workspace'] / 'last-package.json'
    previous_path = path if path.exists() else config['initialPackage']
    previous = read_json(previous_path) if previous_path.exists() else None
    package = discover_package(client)
    changed = None if previous is None else any(previous.get(k) != package.get(k) for k in ('url', 'byteSize', 'etag'))
    # This is the last successful observation, not proof of APK verification.
    write_json(path, package)
    return {'package': package, 'packageChanged': changed}


def tree_hashes(site: Path):
    if site.is_symlink() or not site.is_dir():
        raise ValueError('site must be a real directory')
    result = {}
    for path in sorted(site.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'linked site entry: {path}')
        if path.is_file():
            result[path.relative_to(site).as_posix()] = file_hash(path)
        elif not path.is_dir():
            raise ValueError(f'unsupported site entry: {path}')
    return result


def validate_site(site: Path):
    from tools.verify_site_product import verify
    from tools.private_content_guard import verify_no_private_content
    metadata = read_json(site / 'site-candidate.json')
    if metadata.get('historicalReplay') is not False or metadata.get('validation', {}).get('status') != 'passed':
        raise ValueError('site is not a verified current candidate')
    validation = verify(site)
    if validation['status'] != 'passed':
        raise ValueError(f"site reference check failed: {validation['failures'][:5]}")
    verify_no_private_content(site)
    return {'validation': validation, 'limitations': metadata.get('limitations', []),
            'projections': metadata['projections'], 'publicationReady': False}


def bundle(site: Path, destination: Path):
    """Seal first, then archive only the inspected static files; never follow links."""
    # Check symlinks before validators read files.
    files = tree_hashes(site)
    receipt_path = destination / 'bundle.json'
    if receipt_path.exists():
        previous = read_json(receipt_path)
        if previous['files'] != files:
            raise ValueError('site changed since sealing; use a new build/output directory')
        archive = destination / 'website.tar.gz'
        if archive.is_file() and file_hash(archive) == previous['archiveSha256']:
            return previous
    report = validate_site(site)
    destination.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.website-', suffix='.tar.gz', dir=destination)
    os.close(descriptor)
    temporary = Path(temporary)
    archive = destination / 'website.tar.gz'
    manifest = {'schemaVersion': 1, 'site': str(site.resolve()), 'files': files, **report}
    try:
        # The manifest is local metadata, not placed among the public website files.
        with tempfile.TemporaryDirectory(prefix='ournotes-bundle-') as tmp:
            manifest_path = Path(tmp) / 'bundle-manifest.json'
            write_json(manifest_path, manifest)
            with tarfile.open(temporary, 'w:gz', compresslevel=1, dereference=False) as tar:
                tar.add(manifest_path, arcname='bundle-manifest.json', recursive=False)
                for name, sha in files.items():
                    path = site / name
                    if path.is_symlink() or file_hash(path) != sha:
                        raise ValueError('site changed during packaging')
                    tar.add(path, arcname='site/' + name, recursive=False)
        if tree_hashes(site) != files:
            raise ValueError('site changed during packaging')
        temporary.replace(archive)
        result = {**manifest, 'archive': str(archive.resolve()), 'archiveSha256': file_hash(archive),
                  'archiveBytes': archive.stat().st_size, 'createdAt': utc_now()}
        write_json(receipt_path, result)
        (destination / 'website.tar.gz.sha256').write_text(result['archiveSha256'] + '  website.tar.gz\n')
        return result
    finally:
        temporary.unlink(missing_ok=True)


def seal_directory(site, destination):
    """Server publication consumes files directly; avoid a duplicate large archive."""
    files = tree_hashes(site)
    receipt_path = destination / 'bundle.json'
    if receipt_path.exists():
        prior = read_json(receipt_path)
        if prior['files'] != files:
            raise ValueError('site changed since sealing')
        return prior
    report = validate_site(site)
    import hashlib
    identity = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    receipt = {'schemaVersion': 1, 'site': str(site), 'files': files, **report,
               'archive': None, 'archiveSha256': None, 'artifactSha256': identity}
    write_json(receipt_path, receipt)
    return receipt


def run_update(config, journal, client, *, rebuild=False):
    if config.get('publication') and config.get('contentPublication'):
        raise ValueError('choose content publication or full website publication')
    workspace = config['workspace']
    minimum = config.get('minimumFreeBytes', 0)
    if minimum and shutil.disk_usage(workspace).free < minimum:
        raise ValueError('insufficient free disk space; current website preserved')
    journal.step('dependencies', lambda: doctor(config, build=True))
    package = journal.step('official-package', lambda: package_check(config, client))
    decoder = None
    if config.get('intakePackages'):
        from tools.current_client import intake
        decoder = journal.step('verify-client', lambda: intake(package['package'], workspace / 'clients', ROOT / config['apksigJar']))
        client = GlobalPublicClient(decoder['clientVersion'])
    # Its state commits only verified inputs. Website success is tracked separately.
    complete = config.get('completeContent', False)
    synced = journal.step('sync-inputs', lambda: update(client, workspace / ('sync-complete' if complete else 'sync'),
        config['baseline'], config['inputPlan'], False, complete_content=complete, decoder=decoder))
    plan = Path(synced.get('inputPlan') or synced['candidate'])
    from tools.release_preflight import inspect_plan
    def preflight():
        result = inspect_plan(plan, require_production=True)
        if result['status'] != 'passed':
            raise ValueError('candidate input preflight failed')
        return result
    journal.step('input-preflight', preflight)
    plan_sha = file_hash(plan)
    projection_fingerprint = chart_projection_fingerprint() if config.get('contentPublication') else None
    state_path = workspace / 'state.json'
    previous = read_json(state_path) if state_path.exists() else None
    if (previous and previous['inputPlanSha256'] == plan_sha and not rebuild
            and (projection_fingerprint is None or previous.get('chartProjectionFingerprint') == projection_fingerprint)):
        build = Path(previous['buildDirectory'])
    else:
        suffix = '-' + uuid4().hex[:8] if rebuild else ''
        projection_suffix = '-' + projection_fingerprint[:12] if projection_fingerprint else ''
        build = workspace / 'builds' / (plan_sha[:20] + projection_suffix + suffix)
    candidate, site = build / 'candidate', build / 'site'
    write_json(build / 'workflow-input.json', {'inputPlan': str(plan),
        **({'chartProjectionFingerprint': projection_fingerprint} if projection_fingerprint else {})})
    if config.get('contentPublication'):
        from tools.content_publication import publish_content
        if not candidate.exists():
            journal.command('compile-data', [sys.executable, 'tools/release_candidates.py', '--plan', str(plan),
                                            '--output', str(candidate), '--keep-failed'])
        def publish_data():
            if read_json(candidate / 'candidate.json')['inputPlanSha256'] != plan_sha:
                raise ValueError('cached candidate input plan mismatch')
            # Rebind even when a sealed candidate is reused: older candidates
            # predate scoring artifacts and must not undo a repaired publication.
            from tools.scoring_content import bind_scoring_rules
            sources = read_json(plan)['environments']
            if len(sources) != 1: raise ValueError('scoring content requires one bound source')
            source = sources[0]
            rules = bind_scoring_rules(ROOT/source['masterRoot'], source['contentReleaseId'])
            if (file_hash(plan) != plan_sha or inspect_plan(plan, require_production=True)['status'] != 'passed'
                    or chart_projection_fingerprint() != projection_fingerprint):
                raise ValueError('scoring inputs changed during binding')
            rules_path = build/'formal-scoring-rules.json'
            write_json(rules_path, rules)
            options = {}
            if config['contentPublication'].get('cardRecognition', False):
                from tools.card_recognition import prepare_candidate_index
                options['recognition_index'] = prepare_candidate_index(candidate, build/'card-recognition')
            return publish_content(candidate, config['contentPublication']['root'], scoring_rules=rules_path, **options)
        published = journal.step('publish-content', publish_data)
        result = {'schemaVersion': 1, 'status': published['status'], 'publication': published,
                  'observation': synced['observation'], 'inputPlan': str(plan), 'inputPlanSha256': plan_sha,
                  'buildDirectory': str(build), 'candidate': str(candidate), 'publicationReady': False,
                  'chartProjectionFingerprint': projection_fingerprint,
                  'limitations': ['formal_gameplay_not_verified'], **package}
        from tools.update_retention import history
        result['retainedBuilds'] = history(previous, result)
        # A successful publication does not authorize removing older content or
        # inputs. Independent maintenance must first audit all serving/render refs.
        result['retention'] = {'status': 'deferred_to_operations'}
        write_json(build/'content-publication.json',published)
        journal.step('save-success', lambda: write_json(state_path, result))
        return result
    if not site.exists():
        if not candidate.exists():
            journal.command('compile-data', [sys.executable, 'tools/release_candidates.py', '--plan', str(plan),
                                            '--output', str(candidate), '--keep-failed'])
        def check_candidate():
            if read_json(candidate / 'candidate.json')['inputPlanSha256'] != plan_sha:
                raise ValueError('cached candidate input plan mismatch')
        journal.step('candidate-binding', check_candidate)
        journal.command('build-site', [sys.executable, 'tools/release_site.py', '--candidate', str(candidate), '--output', str(site)])
    seal = bundle if config.get('createArchive', True) else seal_directory
    receipt = journal.step('verify-and-bundle', lambda: seal(site, build / 'package'))
    artifact = receipt.get('artifactSha256') or receipt['archiveSha256']
    result = {'schemaVersion': 1, 'status': 'unchanged' if previous and (previous.get('artifactSha256') or previous.get('archiveSha256')) == artifact else 'candidate_built',
              'observation': synced['observation'], 'inputPlan': str(plan), 'inputPlanSha256': plan_sha,
              'buildDirectory': str(build), 'site': str(site), 'archive': receipt['archive'],
              'archiveSha256': receipt['archiveSha256'], 'artifactSha256': artifact, 'publicationReady': False,
              'limitations': receipt['limitations'], **package}
    if config.get('publication'):
        from tools.server_publication import publish
        publication = config['publication']
        result['publication'] = journal.step('publish', lambda: publish(site, build / 'package/bundle.json',
            Path(publication['root']), publication['domain']))
    if config.get('publication'):
        from tools.update_retention import history, cleanup
        result['retainedBuilds'] = history(previous, result)
    journal.step('save-success', lambda: write_json(state_path, result))
    if config.get('publication'):
        journal.step('retention', lambda: cleanup(workspace, config['publication']['root'], result['retainedBuilds']))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('doctor', 'check', 'run', 'status', 'bundle', 'fetch', 'build', 'publish'), nargs='?', default='run')
    parser.add_argument('--config', type=Path, default=ROOT / 'config/global-update.json')
    parser.add_argument('--candidate-id', help='exact verified candidate digest (publish only)')
    parser.add_argument('--rebuild', action='store_true', help='new site build even when game resources are unchanged')
    parser.add_argument('--site', type=Path, help='existing verified site to package (bundle only)')
    parser.add_argument('--output', type=Path, help='package directory under output/ (bundle only)')
    args = parser.parse_args(argv)
    journal = None
    try:
        if (args.command == 'publish') != bool(args.candidate_id):
            raise ValueError('--candidate-id is required only for publish')
        if args.rebuild and args.command != 'run':
            raise ValueError('--rebuild requires run')
        if args.command != 'bundle' and (args.site or args.output):
            raise ValueError('--site and --output require bundle')
        config = load_config(args.config)
        workspace = config['workspace']
        if args.command == 'status':
            result = {name: read_json(workspace / name) if (workspace / name).exists() else None
                      for name in ('state.json', 'latest-run.json')}
        else:
            with locked(workspace):
                journal = Journal(workspace, args.command)
                if args.command in {'fetch', 'build', 'publish'}:
                    from tools.admin_resource_workflow import execute
                    result = execute(config, journal, args.command, args.candidate_id)
                elif args.command == 'doctor':
                    result = journal.step('dependencies', lambda: doctor(config, build=True))
                elif args.command == 'bundle':
                    if not args.site or not args.output:
                        raise ValueError('bundle requires --site and --output')
                    site, destination = args.site.absolute(), args.output.resolve()
                    if (ROOT / 'output').resolve() not in destination.parents or site.resolve() == destination or site.resolve() in destination.parents or destination in site.resolve().parents:
                        raise ValueError('package output must be under output/ and separate from site')
                    result = journal.step('verify-and-bundle', lambda: bundle(site, destination))
                    result = {k: v for k, v in result.items() if k != 'files'}
                else:
                    client = GlobalPublicClient(config['clientVersion'])
                    if args.command == 'check':
                        journal.step('dependencies', lambda: doctor(config))
                        result = journal.step('resource-version', lambda: observation_check(config, client))
                        result.update(journal.step('official-package', lambda: package_check(config, client)))
                        write_json(workspace / 'last-check.json', result)
                    else:
                        result = run_update(config, journal, client, rebuild=args.rebuild)
                journal.finish(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        if journal:
            journal.report.update(status='failed', error=f'{type(exc).__name__}: {exc}', finishedAt=utc_now())
            journal.save()
        print(f'更新流程失败：{exc}', file=sys.stderr)
        return 130 if isinstance(exc, KeyboardInterrupt) else 75 if str(exc) == 'another workflow is running' else 1


if __name__ == '__main__':
    raise SystemExit(main())
