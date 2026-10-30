"""Load an optional pinned private Arena review into a normal content build."""
import argparse
import json
from pathlib import Path
import tempfile

from tools.r2_content import S3Bucket,SHA256
from tools.recompute_published_rankings import unpack_arena_review_bundle

LIMIT=16*1024**2


def prepare(root,expected,bucket,github_env):
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
    relative=review.relative_to(root).as_posix()
    with Path(github_env).open('a') as stream:
        stream.write('OURNOTES_ARENA_REVIEW_PATH='+relative+'\nOURNOTES_ARENA_REVIEW_SHA256='+sha+'\n')
    return dict(status='verified_private_arena_input',bundleSha256=expected)


def main():
    import os
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--bundle-sha256',required=True)
    p.add_argument('--github-env',type=Path,required=True);args=p.parse_args()
    try:
        bucket=S3Bucket.from_environment();bucket.bucket=os.environ['R2_PRIVATE_BUCKET']
        print(json.dumps(prepare(args.root,args.bundle_sha256,bucket,args.github_env)))
    except Exception as error:
        print(json.dumps(dict(status='failed',errorType=type(error).__name__)));return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
