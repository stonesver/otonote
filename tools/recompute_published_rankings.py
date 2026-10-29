"""Recompute rankings in a pinned public snapshot without contacting game services.

Only shared-media releases are supported. Complete source inventory verification,
fresh media identity checks, immutable writes/readback and pointer CAS are required.
Unavailable reference rules can be repaired with explicitly digest-pinned inputs;
rules, skill coverage and rankings are published as one immutable snapshot.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
import mimetypes
from pathlib import Path
import re
import subprocess

from tools.r2_content import (S3Bucket, SHA256, SMALL_LIMIT, canonical, digest,
    pointer_key, check_public_path, _run_bounded, same_object, TransferProgress,
    _promote_verified_pointer)
from tools.r2_shared_media import (SharedMediaResolver, _control, _immutable,
    descriptor_key, blob_key, shard_name, LAYOUT)
from tools.materialize_r2_content import parse_pointer, parse_manifest, required_records

ROOT = Path(__file__).resolve().parents[1]


def verified_media(bucket, media):
    present = bucket.list_identities('content/blobs/')
    for record in media.values():
        if present.get(blob_key(record['sha256'])) != (record['bytes'], record['etag']):
            raise ValueError('previously verified media is missing or changed')


def download_source(bucket, region, expected, directory, workers):
    item = bucket.get(pointer_key(region))
    if item is None or digest(item[0]) != expected:
        raise ValueError('published pointer differs from expected baseline')
    pointer, identifier = parse_pointer(item[0], region)
    manifest_item = bucket.get(pointer['manifest'].lstrip('/'))
    if manifest_item is None:
        raise ValueError('published manifest is missing')
    manifest = parse_manifest(manifest_item[0], pointer, identifier, region)
    if manifest.get('channel') != 'production':
        raise ValueError('only published production content can be recomputed')
    resolver = SharedMediaResolver(_control(bucket), identifier, manifest_item[0])
    if resolver.descriptor is None:
        raise ValueError('ranking refresh requires verified shared-media layout')
    media = resolver.all_records()
    verified_media(bucket, media)
    prefix = manifest['root'].lstrip('/')
    listed = bucket.list_identities(prefix)
    if not listed or len(listed) + len(media) > 100_000 or sum(size for size, _ in listed.values()) > 8 * 1024**3:
        raise ValueError('source inventory exceeds bounds')
    directory.mkdir(parents=True, exist_ok=False)

    def download(entry):
        key, (size, etag) = entry
        name = key.removeprefix(prefix)
        check_public_path(name)
        if not key.startswith(prefix) or name.startswith('public/') or size > SMALL_LIMIT:
            raise ValueError('unexpected direct source object')
        value = bucket.get(key)
        if value is None or len(value[0]) != size or value[1] != etag:
            raise ValueError('source object changed during readback')
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value[0])
        return name, digest(value[0])

    files = dict(_run_bounded(sorted(listed.items()), download, workers,
                             progress=TransferProgress('download-public-snapshot')))
    inventory = {**files, **{name: row['sha256'] for name, row in media.items()}}
    if (files.get('manifest.json') != pointer['sha256'] or
            digest(canonical(inventory)) != resolver.descriptor['inventorySha256']):
        raise ValueError('source inventory does not match verified release')
    for name, (sha, size) in required_records(manifest).items():
        if files.get(name) != sha or (directory / name).stat().st_size != size:
            raise ValueError('source manifest record is incomplete or corrupt')
    return pointer, manifest, files, media


def calculate(source, output, model):
    subprocess.run(['node', str(ROOT/'tools/recompute_song_rankings.mjs'),
                    str(source), str(output), model], check=True, cwd=ROOT)


def validate_rankings(data, catalog, model):
    expected = {row['id'] for row in catalog['musicCharts']}
    if (not expected or len(expected) != len(catalog['musicCharts']) or data.get('unavailable') or
            data.get('sourceReleaseId') != catalog['release']['id'] or
            data.get('benchmark', {}).get('modelVersion') != model or
            not data.get('fingerprint') or not data.get('rulesFingerprint')):
        raise ValueError('recomputed ranking model or release mismatch')
    for mode in ('ordinary', 'gekisou'):
        rows = data.get(mode, [])
        if len(rows) != len(expected) or {row.get('id') for row in rows} != expected:
            raise ValueError('recomputed ranking coverage mismatch')
        for row in rows:
            score = row.get('expectedScore')
            if type(score) not in (int, float) or not math.isfinite(score) or score <= 0 or not row.get('chartFingerprint'):
                raise ValueError('recomputed ranking score is invalid')


def repair_reference_rules(source, manifest, path, expected):
    if not isinstance(expected, str) or not SHA256.fullmatch(expected):
        raise ValueError('rule repair requires a reviewed SHA-256')
    path = Path(path)
    if path.stat().st_size > SMALL_LIMIT:
        raise ValueError('rule repair exceeds bounds')
    raw = path.read_bytes()
    if digest(raw) != expected:
        raise ValueError('rule repair digest mismatch')
    rules = json.loads(raw)
    reference, native = rules.get('referenceProfile', {}), rules.get('native', {})
    if (rules.get('sourceReleaseId') != manifest['contentReleaseId']
            or rules.get('verificationStatus') != 'reference_compatible'
            or not isinstance(rules.get('tables'), dict)
            or reference.get('dataCompatibility') != 'supported_model'
            or reference.get('modelId') != 'ournotes-scoring-model-v1'
            or reference.get('currentGameplayVerified') is not False
            or not reference.get('sourceReleaseId')
            or reference['sourceReleaseId'] != native.get('sourceReleaseId')
            or not rules.get('nativeSha256')
            or rules['nativeSha256'] != native.get('nativeSha256')
            or rules['nativeSha256'] != reference.get('nativeSha256')):
        raise ValueError('rule repair is not a bound reference model')
    replacements = {}
    for locale in ('zh-CN', 'en'):
        record = manifest['locales'][locale]['files']['supplemental/formal-scoring-rules.json']
        old = json.loads((source/record['path']).read_bytes())
        if (old.get('verificationStatus') != 'unavailable'
                or old.get('sourceReleaseId') != manifest['contentReleaseId']):
            raise ValueError('rule repair requires unavailable rules for this release')
        replacements[record['path']] = canonical(rules)
    # Change only this private computation copy, after the full source inventory
    # has been verified. The published parent snapshot is never modified.
    for name, raw in replacements.items():
        (source/name).write_bytes(raw)
    return replacements


def reviewed_arena_projections(manifest,master_root,review_path,expected_sha256):
    """Compile pinned Arena tables for the exact already-published game release."""
    if not SHA256.fullmatch(expected_sha256):raise ValueError('invalid arena review digest')
    raw=Path(review_path).read_bytes()
    if len(raw)>SMALL_LIMIT or digest(raw)!=expected_sha256:raise ValueError('arena review digest mismatch')
    review=json.loads(raw)
    if (review.get('sourceReleaseId')!=manifest['contentReleaseId'] or review.get('region')!=manifest['region']
            or not review.get('masterVersion') or review['masterVersion']!=manifest.get('releaseRecord',{}).get('masterVersion')):
        raise ValueError('arena review does not match published Master')
    from tools.arena_content import build_arena_content,validate_arena_publication
    outputs={}
    for locale in manifest['locales']:
        value=build_arena_content(master_root,manifest['contentReleaseId'],manifest['region'],locale,review)
        validate_arena_publication(value,manifest['contentReleaseId'],manifest['region'])
        outputs[locale]=canonical(value)
    return outputs


def recompute(bucket, region, expected, work, *, model, source_run, workers=8,
              publish=False, compute=calculate, scoring_rules=None, expected_rules_sha256=None,
              arena_review=None,arena_master_root=None,expected_arena_review_sha256=None):
    if not SHA256.fullmatch(expected):
        raise ValueError('an explicit existing pointer digest is required')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', source_run):
        raise ValueError('invalid source run identity')
    work = Path(work)
    if work.exists():
        raise ValueError('recompute workspace must be new')
    work.mkdir(parents=True)
    source, output = work/'source', work/'computed'
    pointer, manifest, files, media = download_source(bucket, region, expected, source, workers)
    if (scoring_rules is None) != (expected_rules_sha256 is None):
        raise ValueError('rule repair needs both a file and its reviewed digest')
    replacements = (repair_reference_rules(source, manifest, scoring_rules, expected_rules_sha256)
                    if scoring_rules is not None else {})
    arena_inputs=(arena_review,arena_master_root,expected_arena_review_sha256)
    if any(v is not None for v in arena_inputs) and not all(v is not None for v in arena_inputs):raise ValueError('arena publication requires review, master root and digest')
    arena=reviewed_arena_projections(manifest,arena_master_root,arena_review,expected_arena_review_sha256) if arena_review is not None else {}
    arena_paths={}
    for locale,raw in arena.items():
        name=manifest['locales'][locale]['files'].get('projection/arena.json',{}).get('path',locale+'/arena.json')
        check_public_path(name);arena_paths[locale]=name;replacements[name]=raw
    compute(source, output, model)
    counts, coverage = {}, {}
    for locale in ('zh-CN', 'en'):
        records = manifest['locales'][locale]['files']
        catalog = json.loads((source/records['projection/catalog.json']['path']).read_bytes())
        if catalog.get('release', {}).get('id') != manifest['contentReleaseId']:
            raise ValueError('catalog does not match published release')
        data = json.loads((output/(locale + '.json')).read_bytes())
        validate_rankings(data, catalog, model)
        replacements[records['supplemental/song-rankings.json']['path']] = canonical(data)
        compatibility = json.loads((output/(locale+'-compatibility.json')).read_bytes())
        if (compatibility.get('sourceReleaseId') != catalog['release']['id']
                or compatibility.get('status') not in ('compatible','partial')
                or not isinstance(compatibility.get('issues'), list)
                or type(compatibility.get('checks')) is not int or compatibility['checks'] <= 0):
            raise ValueError('recomputed skill coverage is invalid')
        replacements[records['supplemental/scoring-compatibility.json']['path']] = canonical(compatibility)
        coverage[locale] = {'status':compatibility['status'],'issues':len(compatibility['issues'])}
        counts[locale] = {mode:len(data[mode]) for mode in ('ordinary', 'gekisou')}
    identifier = digest(canonical({'parent':pointer['sha256'], 'model':model,
                                  'rankings':{k:digest(v) for k,v in replacements.items()}}))[:24]
    old_root, new_root = manifest['root'], f'/content/releases/{identifier}/'
    target = work/'prepared'; target.mkdir()
    updated = deepcopy(manifest); updated['root'] = new_root
    new_files = {}
    for locale,name in arena_paths.items():updated['locales'][locale]['files']['projection/arena.json']={'path':name}
    for name in sorted(set(files)|set(replacements)):
        if name == 'manifest.json':
            continue
        raw = replacements[name] if name in replacements else (source/name).read_bytes()
        # Rebind URLs only; authored content, release identities and media stay intact.
        if name.endswith('.json'):
            raw = raw.replace(old_root.encode(), new_root.encode())
            json.loads(raw)
        path = target/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        new_files[name] = digest(raw)
    for sections in updated['locales'].values():
        for section in ('files', 'groups'):
            for record in sections[section].values():
                path = target/record['path']
                record.update(sha256=new_files[record['path']], bytes=path.stat().st_size)
    raw_manifest = canonical(updated)
    (target/'manifest.json').write_bytes(raw_manifest)
    new_files['manifest.json'] = digest(raw_manifest)
    new_pointer = {**pointer, 'manifest':new_root+'manifest.json', 'sha256':digest(raw_manifest)}
    # Library vectors are assembled by the renderer from the active edition pointers.
    new_pointer.pop('libraryPointers', None)
    report = {'region':region,'model':model,'counts':counts,'previousPointer':pointer,
              'nextPointer':new_pointer,'sourcePointerSha256':expected, 'scoringCoverage':coverage}
    if arena_review is not None:report['arenaReviewSha256']=expected_arena_review_sha256
    if scoring_rules is not None:
        report['scoringRepair'] = {'reviewedSha256':expected_rules_sha256,'coverage':coverage}
    (work/'verification.json').write_bytes(canonical(report))
    if not publish:
        return {**report, 'status':'verified_local'}
    # A moved pointer cancels the operation before any upload, and again before CAS.
    current = bucket.get(pointer_key(region))
    if current is None or digest(current[0]) != expected:
        raise ValueError('published pointer changed during recomputation')

    def upload(name):
        raw = (target/name).read_bytes()
        if digest(raw) != new_files[name]:
            raise ValueError('prepared data changed')
        key = new_root.lstrip('/') + name
        bucket.put_new(key, raw, content_type=mimetypes.guess_type(name)[0] or 'application/octet-stream',
                       cache_control='public, max-age=31536000, immutable', sha256=new_files[name])
        if not same_object(bucket, key, new_files[name], len(raw)):
            raise ValueError('immutable ranking snapshot failed readback')

    _run_bounded(sorted(name for name in new_files if name != 'manifest.json'), upload, workers,
                 progress=TransferProgress('upload-ranking-snapshot'))
    verified_media(bucket, media)
    inventory = {**new_files, **{name:row['sha256'] for name,row in media.items()}}
    descriptor = {'schemaVersion':1,'layout':LAYOUT,'releaseId':identifier,
                  'manifestSha256':digest(raw_manifest),'inventorySha256':digest(canonical(inventory)), 'shards':{}}
    shards = {}
    for name, row in media.items():
        shards.setdefault(shard_name(name), {})[name] = row
    prefix = descriptor_key(identifier).rsplit('/', 1)[0] + '/'
    for name, records in sorted(shards.items()):
        raw = canonical({'schemaVersion':1,'releaseId':identifier,'files':records})
        _immutable(bucket, prefix+name+'.json', raw)
        descriptor['shards'][name] = {'sha256':digest(raw),'bytes':len(raw)}
    _immutable(bucket, descriptor_key(identifier), canonical(descriptor))
    upload('manifest.json')
    resolver = SharedMediaResolver(_control(bucket), identifier, raw_manifest)
    if resolver.all_records() != media:
        raise ValueError('new media references differ from verified source')
    result = _promote_verified_pointer(bucket, canonical(new_pointer), region, expected, source_run=source_run)
    (work/'publication.json').write_bytes(canonical(result))
    return {**report, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', choices=('global','jp'), required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--source-run', required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--scoring-rules', type=Path)
    parser.add_argument('--expected-rules-sha256')
    parser.add_argument('--arena-review',type=Path)
    parser.add_argument('--arena-master-root',type=Path)
    parser.add_argument('--expected-arena-review-sha256')
    args = parser.parse_args()
    try:
        report = recompute(S3Bucket.from_environment(workers=8), args.region, args.expected_current,
                           args.work, model=args.model, source_run=args.source_run, publish=args.publish,
                           scoring_rules=args.scoring_rules, expected_rules_sha256=args.expected_rules_sha256,
                           arena_review=args.arena_review,arena_master_root=args.arena_master_root,expected_arena_review_sha256=args.expected_arena_review_sha256)
        print(json.dumps(report, ensure_ascii=False))
    except Exception as error:
        # Keep transport credentials and private endpoint details out of workflow output.
        print(json.dumps({'status':'failed','errorType':type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
