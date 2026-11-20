"""Load an optional pinned private Arena review into a normal content build."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import tempfile

from tools.arena_content import GLOBAL_REVIEW_RELEASE, SERVERS, build_arena_content
from tools.growth_login import GameClient, BOOTSTRAP, LOGIN_SERVICE, string
from tools.ranking_regions import fetch_manifest, server_cdn
from tools.r2_content import S3Bucket,SHA256,canonical,digest
from tools.recompute_published_rankings import unpack_arena_review_bundle

LIMIT=16*1024**2


class ReviewRenewalRequired(ValueError):
    def __init__(self, reason):
        super().__init__('arena review renewal required: ' + reason)


def renew_unchanged_review(path):
    """Rebind a private copy only after all reviewed regional tables match.

    The client digest and published IDs stay fixed. The ordinary compiler still
    checks that digest against its actual client and hashes its decoded tables.
    """
    value = json.loads(path.read_bytes())
    identity = GLOBAL_REVIEW_RELEASE.fullmatch(str(value.get('sourceReleaseId', '')))
    scopes = SERVERS['global']
    bindings = value.get('serverMasters', {})
    if (value.get('region') != 'global' or not identity
            or identity[1] != value.get('masterVersion') or not value.get('tables')
            or set(value.get('serverScopes', [])) != scopes or set(bindings) != scopes
            or bindings['global-hmt'].get('version') != identity[1]):
        raise ReviewRenewalRequired('complete Global regional bindings are required')
    # Verify the pinned bundle's decoded files and full regional hash coverage.
    build_arena_content(path.parent, value['sourceReleaseId'], 'global', review=value)
    versions, cdns = {}, {}
    names = tuple(name + '.bin' for name in value['tables'])
    try:
        for server in sorted(scopes):
            game = GameClient(server_id=server)
            host = game.discover()
            versions[server] = string(game._public_rpc(host, 'app.masterdata.MasterdataService/Version'), 1)
            if not re.fullmatch('[a-f0-9]{32}', versions[server]):
                raise ReviewRenewalRequired('invalid observed Master version')
            cdns[server] = server_cdn(game._public_rpc(BOOTSTRAP, LOGIN_SERVICE + 'GetServerList'), server)
        if all(versions[s] == bindings[s]['version'] for s in scopes):
            return value, 'unchanged'
        reference = None
        for server in sorted(scopes):
            previous = fetch_manifest(cdns[server], bindings[server]['version'], tables=names)
            current = (previous if versions[server] == bindings[server]['version'] else
                       fetch_manifest(cdns[server], versions[server], tables=names))
            if previous != current or (reference is not None and current != reference):
                raise ReviewRenewalRequired('reviewed tables changed in ' + server)
            reference = current
    except ReviewRenewalRequired:
        raise
    except Exception:
        raise ReviewRenewalRequired('regional Master verification failed') from None
    # Only the Master component changes; retaining the APK suffix is essential.
    release = value['sourceReleaseId']
    renewed = dict(value,
        sourceReleaseId=release[:identity.start(1)] + versions['global-hmt'] + release[identity.end(1):],
        masterVersion=versions['global-hmt'],
        serverMasters={s: dict(bindings[s], version=versions[s]) for s in sorted(scopes)},
        observedAt=datetime.now(timezone.utc).isoformat())
    return renewed, 'renewed'


def prepare(root,expected,bucket,github_env,*,renew_unchanged=False):
    root=Path(root).resolve(strict=True)
    if not SHA256.fullmatch(expected):raise ValueError('invalid Arena review bundle digest')
    response=bucket.client.get_object(Bucket=bucket.bucket,Key='state/objects/'+expected)
    body=response['Body']
    try:
        if response.get('ContentLength',0)>LIMIT:raise ValueError('Arena input exceeds bounds')
        raw=body.read(LIMIT+1)
    finally:body.close()
    parent=root/'output';parent.mkdir(exist_ok=True)
    # A fresh, private input directory never overwrites restored sources or checkpoints.
    stage=Path(tempfile.mkdtemp(prefix='arena-review-',dir=parent))
    review,sha=unpack_arena_review_bundle(raw,expected,stage/'input')
    renewal = 'not_requested'
    if renew_unchanged:
        value, renewal = renew_unchanged_review(review)
        if renewal == 'renewed':
            review_raw = canonical(value)
            review.write_bytes(review_raw)
            sha = digest(review_raw)
    relative=review.relative_to(root).as_posix()
    with Path(github_env).open('a') as stream:
        stream.write('OURNOTES_ARENA_REVIEW_PATH='+relative+'\nOURNOTES_ARENA_REVIEW_SHA256='+sha+'\n')
    return dict(status='verified_private_arena_input',bundleSha256=expected,renewal=renewal)


def main():
    import os
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--bundle-sha256',required=True)
    p.add_argument('--github-env',type=Path,required=True)
    p.add_argument('--renew-unchanged',action='store_true',help='verify and rebind identical Global regional tables')
    args=p.parse_args()
    try:
        bucket=S3Bucket.from_environment();bucket.bucket=os.environ['R2_PRIVATE_BUCKET']
        print(json.dumps(prepare(args.root,args.bundle_sha256,bucket,args.github_env,
                                 renew_unchanged=args.renew_unchanged)))
    except Exception as error:
        result=dict(status='failed',errorType=type(error).__name__)
        if isinstance(error,ReviewRenewalRequired):result['reason']=str(error)
        print(json.dumps(result));return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
