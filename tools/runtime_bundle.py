"""Deterministic immutable updater/renderer source bundles; configuration stays external.

The separately supplied base image must pin installed Python/Node/system dependencies
by digest. This bundle never copies a workspace, credentials, state or node_modules.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from tools.release_candidate import canonical, digest, inspect_source, check_source_files


def permitted(name):
    path=Path(name)
    if '..' in path.parts or path.is_absolute() or any(part in {'vendor','.deps','node_modules','__pycache__'} for part in path.parts): return False
    if name == 'tools/resource_pipeline/VerifyApk.java':return True
    if name.startswith('tools/'):
        return path.suffix in {'.py','.mjs'} or name.endswith('-requirements.txt')
    if name.startswith('analysis/'):
        return path.suffix == '.py' or path.name == 'requirements.txt'
    if name.startswith('backend/'):
        return path.suffix == '.py'
    if name.startswith('packages/scoring/'):
        return path.suffix in {'.mjs','.json'}
    return name in {'site/package.json','site/package-lock.json','config/site-product.json',
                    'catalog/evidence/arena-client.json'}


def build(root, output, revision='HEAD'):
    root, output=Path(root).resolve(),Path(output).resolve()
    if output.exists():raise ValueError('runtime destination already exists')
    source=inspect_source(root,revision)
    files={name:value for name,value in source['files'].items() if permitted(name)}
    required={'tools/global_update.py','tools/publish_prerender.py','tools/code_publication.py',
              'tools/runtime_bundle.py','tools/release_candidate.py','tools/repository_hygiene.py',
              'site/package-lock.json','packages/scoring/data/formal-scoring-rules.json',
              'analysis/crypto/decrypt_master.py','analysis/crypto/decrypt_global_formal_scores.py',
              'backend/contracts.py','tools/resource_pipeline/VerifyApk.java',
              'catalog/evidence/arena-client.json'}
    if not required.issubset(files):raise ValueError('runtime source contract incomplete')
    try:
        output.mkdir(parents=True)
        for name in files:
            target=output/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,target)
        check_source_files(output,{'files':files})
        manifest={'schemaVersion':1,'sourceCommit':source['commit'],'sourceFingerprint':source['fingerprint'],
                  'lockSha256':source['lockSha256'],'files':files,'contract':{
                      'program':'read-only tools/analysis/backend/packages subtrees and reviewed catalog evidence under the existing program root',
                      'configuration':'external read-only config overlay under the existing program root',
                      'state':'single state-root mount preserving existing program/output/content paths',
                      'sameMountRequired':['output','content'],
                      'preserveExistingAbsolutePaths':True,
                      'automaticStateMigration':False,
                      'verifyBeforeMounts':True, 'baseImage':'operator-provided digest-pinned image',
                      'entrypoints':['tools.global_update','tools.publish_prerender','tools.code_publication'],
                      'legacyWebsiteBuild':False}}
        (output/'runtime.json').write_bytes(canonical(manifest))
        expected=digest((output/'runtime.json').read_bytes())
        verify(output,expected)
        return {'runtimeSha256':expected,'sourceCommit':source['commit'],'files':len(files)}
    except Exception:
        shutil.rmtree(output);raise


def verify(root, expected_sha256):
    root=Path(root).resolve()
    if not re.fullmatch('[a-f0-9]{64}',expected_sha256):raise ValueError('invalid expected runtime digest')
    raw=(root/'runtime.json').read_bytes()
    if digest(raw)!=expected_sha256:raise ValueError('runtime manifest digest mismatch')
    manifest=json.loads(raw)
    if manifest.get('schemaVersion')!=1:raise ValueError('unsupported runtime manifest')
    files=manifest['files']
    from tools.repository_hygiene import classify_path, scan_bytes
    actual={}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():raise ValueError('linked runtime path')
        if not path.is_file():continue
        name=path.relative_to(root).as_posix()
        if name=='runtime.json':continue
        if not permitted(name) or classify_path(name):raise ValueError('configuration or unsupported file in runtime bundle')
        data=path.read_bytes()
        if scan_bytes(name,data):raise ValueError('runtime source hygiene rejected a file')
        actual[name]=digest(data)
    if actual!=files:raise ValueError('runtime source inventory mismatch')
    return {'runtimeSha256':expected_sha256,'sourceCommit':manifest['sourceCommit'],'files':len(files)}


def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build');b.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);b.add_argument('--output',type=Path,required=True);b.add_argument('--revision',default='HEAD')
    v=sub.add_parser('verify');v.add_argument('--root',type=Path,required=True);v.add_argument('--expected-sha256',required=True)
    a=p.parse_args()
    try:print(json.dumps(build(a.root,a.output,a.revision) if a.command=='build' else verify(a.root,a.expected_sha256)))
    except (OSError,ValueError,KeyError,TypeError) as e:
        print(json.dumps({'error':str(e) if isinstance(e,ValueError) and not isinstance(e,json.JSONDecodeError) else type(e).__name__}),file=sys.stderr);return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
