"""Resume publication of checkpointed, verified content without running production."""
import argparse
import json
import re
from pathlib import Path

from tools.r2_content import (S3Bucket, SHA256, SMALL_LIMIT, canonical, digest,
    sealed_release, check_public_path, same_object, pointer_key, _run_bounded,
    _promote_verified_pointer, worker_count)
from tools.materialize_r2_content import parse_pointer, parse_manifest, required_records
from tools.r2_shared_media import verify_inventory


def publication_key(region, publication):
    pointer_key(region)
    if not re.fullmatch(r'[1-9][0-9]*_[1-9][0-9]*', publication):
        raise ValueError('publication must be an Actions run ID and attempt')
    return f'content/publications/{region}/{publication}.json'


def record(bucket, store, region, publication, expected_current):
    """Called after upload verification and successful private checkpoint."""
    release, raw, manifest, files = sealed_release(store, region)
    inventory = {name: {'sha256': sha, 'bytes': (release / name).stat().st_size}
                 for name, sha in files.items()}
    return record_prepared(bucket, region, publication, expected_current, release, raw, manifest, inventory)


def record_prepared(bucket, region, publication, expected_current, release, raw, manifest, inventory):
    """Save the verified inventory for both production and public-data recomputation."""
    key = publication_key(region, publication)
    if expected_current != 'none' and not SHA256.fullmatch(expected_current):
        raise ValueError('invalid publication baseline')
    body = canonical({'schemaVersion': 1, 'region': region, 'publication': publication,
                      'expectedCurrent': expected_current, 'pointer': raw.decode(), 'files': inventory})
    if len(body) > SMALL_LIMIT:
        raise ValueError('publication inventory exceeds control object limit')
    bucket.put_new(key, body, content_type='application/json', cache_control='no-store', sha256=digest(body))
    saved = bucket.get(key)
    if saved is None or saved[0] != body:
        raise ValueError('publication record differs from sealed content')
    from tools.publication_review import register
    register(bucket, region, publication, release, raw, manifest)
    return {'status': 'recorded', 'publication': publication, 'releaseId': manifest['root'].split('/')[3]}


def retry(bucket, region, publication, *, source_run, workers=8, publish=False):
    worker_count(workers)
    item = bucket.get(publication_key(region, publication))
    if item is None:
        raise ValueError('checkpointed publication record is missing')
    value = json.loads(item[0])
    if (value.get('schemaVersion') != 1 or value.get('region') != region
            or value.get('publication') != publication):
        raise ValueError('publication identity mismatch')
    raw = value['pointer'].encode()
    pointer, identifier = parse_pointer(raw, region)
    manifest_item = bucket.get(pointer['manifest'].lstrip('/'))
    if manifest_item is None:
        raise ValueError('publication manifest is missing')
    manifest = parse_manifest(manifest_item[0], pointer, identifier, region)
    if manifest.get('channel') != 'production':
        raise ValueError('publication is not production content')
    inventory = value['files']
    if not isinstance(inventory, dict) or not 0 < len(inventory) <= 100_000:
        raise ValueError('invalid publication inventory')
    for name, spec in inventory.items():
        check_public_path(name)
        if (not isinstance(spec, dict) or not SHA256.fullmatch(spec.get('sha256', ''))
                or type(spec.get('bytes')) is not int or spec['bytes'] < 0):
            raise ValueError('invalid publication file identity')
    if inventory.get('manifest.json') != {'sha256': pointer['sha256'], 'bytes': len(manifest_item[0])}:
        raise ValueError('publication manifest inventory mismatch')
    for name, (sha, size) in required_records(manifest).items():
        if inventory.get(name) != {'sha256': sha, 'bytes': size}:
            raise ValueError('publication omits a required record')
    current = bucket.get(pointer_key(region))
    actual = digest(current[0]) if current else 'none'
    expected = value['expectedCurrent']
    # A lost acknowledgement can leave this exact artifact already active.
    if actual != expected and (current is None or current[0] != raw):
        raise ValueError('public content changed since this publication was prepared')
    if not verify_inventory(bucket, manifest_item[0], inventory, workers):
        def verify(entry):
            name, spec = entry
            if not same_object(bucket, manifest['root'].lstrip('/') + name, spec['sha256'], spec['bytes']):
                raise ValueError('publication object is missing or changed')
        _run_bounded(inventory.items(), verify, workers)
    result = _promote_verified_pointer(bucket, raw, region, actual, source_run=source_run, dry_run=not publish)
    # Confirm the write even when the transport lost a previous acknowledgement.
    if publish and result['status'] in {'published', 'unchanged'}:
        after = bucket.get(pointer_key(region))
        if after is None or after[0] != raw:
            raise ValueError('published pointer readback differs')
    return {**result, 'publication': publication}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('record', 'verify', 'promote'))
    parser.add_argument('--region', required=True, choices=('global', 'jp'))
    parser.add_argument('--publication', required=True)
    parser.add_argument('--store', type=Path)
    parser.add_argument('--expected-current')
    parser.add_argument('--source-run')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args(argv)
    try:
        bucket = S3Bucket.from_environment(args.workers)
        if args.action == 'record':
            if args.store is None or args.expected_current is None:
                parser.error('record requires --store and --expected-current')
            result = record(bucket, args.store, args.region, args.publication, args.expected_current)
        else:
            if not args.source_run:
                parser.error('verify/promote requires --source-run')
            result = retry(bucket, args.region, args.publication, source_run=args.source_run,
                           workers=args.workers, publish=args.action == 'promote')
        print(json.dumps(result))
    except Exception as error:
        raise SystemExit('Publication recovery failed: ' + type(error).__name__) from None


if __name__ == '__main__':
    main()
