"""Read-only, pinned Global package input checks before catalog generation.

This checks baseline manifests, Master bytes and the extraction manifest. It does
not attest package signatures, extracted asset bytes, gameplay or remote access.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.resource_pipeline.golden import (
    CURRENT_SITE_MASTER_TABLES, GoldenError, _master_aggregate, _master_row_count,
)


class PreflightError(ValueError):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def read_object(path: Path) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise PreflightError(f'expected JSON object: {path.name}')
    return value


def load_plan(path: Path) -> list[dict]:
    payload = read_object(path)
    if payload.get('schemaVersion') != 1:
        raise PreflightError('unsupported input plan schema')
    entries = payload.get('environments')
    if not isinstance(entries, list) or not entries:
        raise PreflightError('input plan requires environments')
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise PreflightError('environment must be an object')
        region, channel = entry.get('region'), entry.get('channel')
        if region not in {'global', 'jp'} or channel not in {'staging', 'production'}:
            raise PreflightError('unsupported region/channel')
        name = f'{region}-{channel}'
        if entry.get('id') != name or name in seen:
            raise PreflightError('duplicate or inconsistent environment id')
        seen.add(name)
        for field in ('manifest', 'masterRoot', 'assetManifest', 'contentReleaseId', 'manifestSha256'):
            value = entry.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise PreflightError(f'{name}: invalid {field}')
        if entry.get('manifestSha256') and not re.fullmatch('[a-f0-9]{64}', entry['manifestSha256']):
            raise PreflightError(f'{name}: invalid manifestSha256')
    return entries


def check_environment(entry: dict, root: Path = ROOT) -> dict:
    report = {'environment': entry['id'], 'status': 'passed', 'checks': [], 'tableRows': {}}

    def check(name, status, detail):
        report['checks'].append({'name': name, 'status': status, 'detail': detail})

    fields = ('manifest', 'manifestSha256', 'contentReleaseId', 'masterRoot', 'assetManifest')
    absent = [field for field in fields if not entry.get(field)]
    if absent:
        check('input_binding', 'external_gate', 'not configured: ' + ', '.join(absent))
    else:
        manifest = root / entry['manifest']
        master = root / entry['masterRoot']
        assets = root / entry['assetManifest']
        missing = [name for name, path, directory in [('manifest', manifest, False), ('masterRoot', master, True), ('assetManifest', assets, False)] if not (path.is_dir() if directory else path.is_file())]
        if missing:
            check('input_files', 'external_gate', 'not present: ' + ', '.join(missing))
        else:
            try:
                baseline = read_object(manifest)
                actual_digest = digest(manifest)
                check('manifest_pin', 'passed' if actual_digest == entry['manifestSha256'] else 'failed', actual_digest)
                identity = baseline.get('identity', {})
                expected = {key: entry[key] for key in ('region', 'channel', 'contentReleaseId')}
                identity_ok = baseline.get('schemaVersion') == 1 and isinstance(identity, dict) and all(identity.get(k) == v for k, v in expected.items())
                check('release_identity', 'passed' if identity_ok else 'failed', expected)
                # Do not parse a different release's inputs after pin/identity failure.
                if actual_digest == entry['manifestSha256'] and identity_ok:
                    records = []
                    for path in sorted(master.glob('*.json')):
                        value = json.loads(path.read_text(encoding='utf-8'))
                        report['tableRows'][path.stem] = _master_row_count(value, path.stem)
                        records.append({'logicalName': path.name, 'sha256': digest(path)})
                    actual_master = _master_aggregate(records)
                    check('master_digest', 'passed' if actual_master == baseline.get('master', {}).get('aggregateSha256') else 'failed', actual_master)
                    missing_tables = sorted(set(CURRENT_SITE_MASTER_TABLES) - report['tableRows'].keys())
                    check('required_tables', 'failed' if missing_tables else 'passed', missing_tables)
                    actual_assets = digest(assets)
                    expected_assets = baseline.get('objects', {}).get('assetManifest', {})
                    matches = actual_assets == expected_assets.get('sha256') and assets.stat().st_size == expected_assets.get('byteSize')
                    check('asset_manifest_digest', 'passed' if matches else 'failed', actual_assets)
                    critical = baseline.get('statistics', {}).get('criticalTableRows', {})
                    mismatch = [key for key, count in critical.items() if report['tableRows'].get(key) != count]
                    check('baseline_counts', 'failed' if mismatch else 'passed', mismatch)
            except (OSError, ValueError, TypeError, AttributeError, GoldenError) as exc:
                check('input_parse', 'failed', str(exc))
    statuses = {check['status'] for check in report['checks']}
    if entry.get('arenaReview') and not ({'failed', 'external_gate'} & statuses):
        from tools.arena_content import read_arena_review
        try:
            read_arena_review(entry, root)
            check('arena_review', 'passed', 'review identity and bytes verified')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            check('arena_review', 'failed', str(exc))
        statuses = {check['status'] for check in report['checks']}
    if entry.get('musicAudioInputs') and not ({'failed', 'external_gate'} & statuses):
        from tools.music_audio_inputs import read_music_audio_inputs
        try:
            read_music_audio_inputs(entry, root)
            check('music_audio_inputs', 'passed', 'release identity and decoded audio bytes verified')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            check('music_audio_inputs', 'failed', str(exc))
        statuses = {check['status'] for check in report['checks']}
    if entry.get('bgmAudioInputs') and not ({'failed', 'external_gate'} & statuses):
        from tools.bgm_catalog import read_bgm_inputs
        try:
            read_bgm_inputs(entry, root)
            check('bgm_audio_inputs', 'passed', 'BGM release identity and decoded audio bytes verified')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            check('bgm_audio_inputs', 'failed', str(exc))
        statuses = {check['status'] for check in report['checks']}
    report['status'] = 'failed' if 'failed' in statuses else 'external_gate' if 'external_gate' in statuses else 'passed'
    return report


def inspect_plan(path: Path, *, root: Path = ROOT, environments: list[str] | None = None, require_production: bool = False) -> dict:
    entries = load_plan(path)
    selected = set(environments or [entry['id'] for entry in entries])
    unknown = selected - {entry['id'] for entry in entries}
    if unknown:
        raise PreflightError('unknown environments: ' + ', '.join(sorted(unknown)))
    if require_production:
        if any(entry['channel'] != 'production' for entry in entries if entry['id'] in selected):
            raise PreflightError('production readiness requires production inputs')
    results = [check_environment(entry, root) for entry in entries if entry['id'] in selected]
    statuses = {result['status'] for result in results}
    return {'schemaVersion': 1, 'status': 'failed' if 'failed' in statuses else 'external_gate' if 'external_gate' in statuses else 'passed',
            'environments': results, 'scope': 'offline_input_integrity', 'publicationReady': False,
            'remainingGates': ['package_provenance', 'extracted_asset_integrity', 'schema_and_mapping_diff', 'projection_and_browser', 'gameplay_rules', 'remote_observations']}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=ROOT / 'config/release-inputs.json')
    parser.add_argument('--environment', action='append')
    parser.add_argument('--require-production', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        report = inspect_plan(args.plan, environments=args.environment, require_production=args.require_production)
    except (OSError, ValueError) as exc:
        report = {'status': 'failed', 'error': str(exc)}
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        # The caller owns this report path; never allow replacing a protected input.
        resolved = args.output.resolve()
        protected = [args.plan.resolve(), ROOT / 'catalog', ROOT / 'phone_dump', ROOT / 'input', ROOT / 'data', ROOT / 'site']
        if any(resolved == path or path in resolved.parents for path in protected):
            parser.error('report output must be outside protected inputs/site')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding='utf-8')
    print(rendered)
    return {'passed': 0, 'failed': 1, 'external_gate': 2}[report['status']]


if __name__ == '__main__':
    raise SystemExit(main())
