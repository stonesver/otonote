"""Batch publication decisions. Game configuration dates never grant access.

Actions is the sole writer; every writer uses the existing per-region lock.
The dashboard sends decisions to Actions and observes this private state.
"""
import argparse
import json
import math
import time

from tools.r2_content import S3Bucket, RELEASE, SHA256, canonical, digest, pointer_key
from tools.materialize_r2_content import parse_pointer

POLICY_KEY = 'content/reviews/policy.json'
POLICY = {'schemaVersion': 1, 'enabled': True}
SCOPES = {'global': ['global-hmt', 'global-kr', 'global-en'], 'jp': ['jp']}


def enabled(bucket):
    item = bucket.get(POLICY_KEY)
    if item is None:
        return False
    if json.loads(item[0]) != POLICY:
        raise ValueError('invalid publication review policy')
    return True


def review_key(region):
    pointer_key(region)
    return f'content/reviews/{region}/current.json'


def access_key(identifier):
    if not RELEASE.fullmatch(identifier):
        raise ValueError('invalid release identity')
    return f'content/access/{identifier}.json'


def grant(bucket, pointer, region):
    identifier = pointer['manifest'].split('/')[3]
    value = canonical({'schemaVersion': 1, 'releaseId': identifier,
                       'region': region, 'manifestSha256': pointer['sha256']})
    key = access_key(identifier)
    bucket.put_new(key, value, content_type='application/json', cache_control='no-store', sha256=digest(value))
    if bucket.get(key)[0] != value:
        raise ValueError('public access identity mismatch')


def has_access(bucket, pointer, region):
    identifier = pointer['manifest'].split('/')[3]
    item = bucket.get(access_key(identifier))
    return item is not None and json.loads(item[0]) == {
        'schemaVersion': 1, 'releaseId': identifier, 'region': region, 'manifestSha256': pointer['sha256']}


def read(bucket, region):
    item = bucket.get(review_key(region))
    if item is None:
        return None, None
    if len(item[0]) > 256 * 1024:
        raise ValueError('oversized publication review')
    value = json.loads(item[0])
    if (value.get('schemaVersion') != 1 or value.get('region') != region
            or not RELEASE.fullmatch(value.get('releaseId', ''))
            or not SHA256.fullmatch(value.get('manifestSha256', ''))
            or type(value.get('revision')) is not int or value['revision'] < 1
            or value.get('status') not in {'pending', 'scheduled', 'held', 'published', 'stale'}):
        raise ValueError('invalid publication review')
    return value, item[1]


def save(bucket, region, value, etag):
    bucket.replace(review_key(region), canonical(value), etag,
                   content_type='application/json', cache_control='no-store')
    return value


def summary(bucket, release, manifest, previous):
    """A bounded private diff, never copied to public workflow summaries."""
    before = {}
    if previous:
        old = bucket.get(previous['manifest'].lstrip('/'))
        if old is None or digest(old[0]) != previous['sha256']:
            raise ValueError('previous manifest unavailable for review')
        before = json.loads(old[0])
    def records(value):
        return value.get('locales', {}).get('zh-CN', {}).get('files', {})
    old_records, new_records = records(before), records(manifest)
    changed = [name for name, spec in new_records.items()
               if spec.get('sha256') != old_records.get(name, {}).get('sha256')]
    result = {'changedProjectionCount': len(changed), 'changedProjections': changed[:50], 'entities': []}
    name = 'projection/catalog.json'
    spec = new_records.get(name)
    if not spec:
        return result
    current = json.loads((release / spec['path']).read_bytes())
    old_catalog = {}
    if name in old_records:
        spec = old_records[name]
        old = bucket.get(before['root'].lstrip('/') + spec['path'])
        if old is None or digest(old[0]) != spec['sha256']:
            raise ValueError('previous catalog unavailable for review')
        old_catalog = json.loads(old[0])
    for kind in ('bands', 'characters', 'memberCards', 'supportCards', 'musicTracks'):
        old_rows = {str(row['id']): row for row in old_catalog.get(kind, [])}
        added = [row for row in current.get(kind, []) if str(row['id']) not in old_rows]
        result['entities'].append({'kind': kind, 'added': len(added),
            'names': [str(row.get('displayName') or row.get('title') or row.get('name') or row['id'])[:160]
                      for row in added[:20]]})
    return result


def register(bucket, region, publication, release, raw, manifest):
    if not enabled(bucket):
        return
    pointer, identifier = parse_pointer(raw, region)
    old, etag = read(bucket, region)
    if old and old['releaseId'] == identifier and old['manifestSha256'] == pointer['sha256'] and old['status'] != 'stale':
        return old  # A repeated production run must not reset a hold or scheduled decision.
    current = bucket.get(pointer_key(region))
    previous = json.loads(current[0]) if current else None
    value = {'schemaVersion': 1, 'region': region, 'serverScopes': SCOPES[region],
             'publication': publication, 'releaseId': identifier, 'manifestSha256': pointer['sha256'],
             'contentReleaseId': pointer['contentReleaseId'], 'revision': (old['revision'] if old else 0) + 1,
             'status': 'published' if has_access(bucket, pointer, region) else 'pending',
             'publishAt': None, 'updatedAt': time.time(),
             'summary': summary(bucket, release, manifest, previous)}
    return save(bucket, region, value, etag)


def authorize(bucket, pointer, region, *, now=None, write=False):
    """Used at the common final promotion boundary, including recovery paths."""
    if not enabled(bucket) or has_access(bucket, pointer, region):
        return True
    value, _ = read(bucket, region)
    epoch = time.time() if now is None else now
    allowed = (value is not None and value['releaseId'] == pointer['manifest'].split('/')[3]
               and value['manifestSha256'] == pointer['sha256'] and value['status'] == 'scheduled'
               and type(value.get('publishAt')) in (int, float) and value['publishAt'] <= epoch)
    if allowed and write:
        grant(bucket, pointer, region)
    return allowed


def pending_matches(bucket, region, pointer, current_sha):
    """Reuse an unchanged prepared batch while its original public baseline holds."""
    if not enabled(bucket):
        return False
    value, _ = read(bucket, region)
    if (not value or value['status'] not in {'pending', 'scheduled', 'held'}
            or value['releaseId'] != pointer['manifest'].split('/')[3]
            or value['manifestSha256'] != pointer['sha256']):
        return False
    from tools.r2_publication import publication_key
    item = bucket.get(publication_key(region, value['publication']))
    if item is None:
        return False
    record = json.loads(item[0])
    return record['expectedCurrent'] == current_sha and json.loads(record['pointer']) == pointer


def decide(bucket, region, publication, revision, action, publish_at=None, *, now=None):
    if not enabled(bucket):
        raise ValueError('publication review is not enabled')
    value, etag = read(bucket, region)
    if value is None or value['publication'] != publication or value['revision'] != revision:
        raise ValueError('publication review changed; reload before deciding')
    if value['status'] in {'published', 'stale'}:
        raise ValueError('publication is no longer pending')
    epoch = time.time() if now is None else now
    if action == 'publish':
        publish_at = epoch
    elif action == 'schedule':
        if type(publish_at) not in (int, float) or not math.isfinite(publish_at) or not epoch < publish_at <= 253402300799:
            raise ValueError('a future confirmed publication time is required')
    elif action == 'hold':
        publish_at = None
    else:
        raise ValueError('unknown publication decision')
    value.update(status='held' if action == 'hold' else 'scheduled', publishAt=publish_at,
                 revision=revision + 1, updatedAt=epoch)
    return save(bucket, region, value, etag)


def process(bucket, region, *, source_run):
    if not enabled(bucket):
        return {'status': 'disabled'}
    value, etag = read(bucket, region)
    epoch = time.time()
    if not value or value['status'] != 'scheduled' or value['publishAt'] > epoch:
        return {'status': value['status'] if value else 'empty'}
    from tools.r2_publication import retry, publication_key
    saved = bucket.get(publication_key(region, value['publication']))
    if saved is None:
        raise ValueError('saved publication missing')
    record = json.loads(saved[0])
    raw = record['pointer'].encode()
    pointer, identifier = parse_pointer(raw, region)
    if identifier != value['releaseId'] or pointer['sha256'] != value['manifestSha256']:
        raise ValueError('review no longer matches saved publication')
    current = bucket.get(pointer_key(region))
    if (digest(current[0]) if current else 'none') != record['expectedCurrent'] and (current is None or current[0] != raw):
        value.update(status='stale', revision=value['revision'] + 1, updatedAt=epoch)
        save(bucket, region, value, etag)
        return {'status': 'stale'}
    result = retry(bucket, region, value['publication'], source_run=source_run, publish=True)
    if result['status'] in {'published', 'unchanged'}:
        value.update(status='published', revision=value['revision'] + 1, updatedAt=epoch)
        save(bucket, region, value, etag)
    return result


def bootstrap(bucket):
    """Explicit migration: admit only current/previous snapshots, then enable review."""
    if enabled(bucket):
        return {'status': 'enabled'}
    from tools.materialize_r2_content import parse_manifest
    for region in SCOPES:
        for key in (pointer_key(region), 'content/previous.json' if region == 'global' else 'content/jp/previous.json'):
            item = bucket.get(key)
            if item is None:
                continue
            pointer, identifier = parse_pointer(item[0], region)
            manifest = bucket.get(pointer['manifest'].lstrip('/'))
            if manifest is None:
                raise ValueError('existing manifest missing')
            parse_manifest(manifest[0], pointer, identifier, region)
            grant(bucket, pointer, region)
    body = canonical(POLICY)
    bucket.put_new(POLICY_KEY, body, content_type='application/json', cache_control='no-store', sha256=digest(body))
    if not enabled(bucket):
        raise ValueError('review activation failed')
    return {'status': 'enabled'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('bootstrap', 'process', 'publish', 'schedule', 'hold'))
    parser.add_argument('--region', choices=tuple(SCOPES))
    parser.add_argument('--publication')
    parser.add_argument('--revision', type=int)
    parser.add_argument('--publish-at', type=float)
    parser.add_argument('--source-run', default='review')
    args = parser.parse_args(argv)
    try:
        bucket = S3Bucket.from_environment(8)
        if args.action == 'bootstrap':
            result = bootstrap(bucket)
        else:
            if args.region is None:
                parser.error('region is required')
            if args.action != 'process':
                decide(bucket, args.region, args.publication, args.revision, args.action, args.publish_at)
            result = process(bucket, args.region, source_run=args.source_run)
        # Private names and diffs must never appear in a public Actions log.
        print(json.dumps({'status': result['status']}))
    except Exception as error:
        raise SystemExit('Publication review failed: ' + type(error).__name__) from None


if __name__ == '__main__':
    main()
