"""Generate HTML from sealed code/content; historical retention is external."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def read_inputs(code_root, content, region="global"):
    if region not in ("global", "jp"): raise ValueError("Unsupported region")
    code = (code_root / 'current').resolve(strict=True)
    if code.parent != (code_root / 'releases').resolve():
        raise ValueError('Code release outside store')
    metadata = json.loads((code / 'code-release.json').read_text())
    identity = metadata['codeId']
    if not re.fullmatch('[a-f0-9]{24}', identity) or code.name != identity:
        raise ValueError('Invalid code identity')
    if hashlib.sha256(json.dumps(metadata['files'],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()[:24] != identity:
        raise ValueError('Invalid code inventory identity')
    pointer_bytes = (content / ('current.json' if region == 'global' else 'jp/current.json')).read_bytes()
    pointer = json.loads(pointer_bytes)
    match = re.fullmatch('/content/releases/([a-f0-9]{24})/manifest.json', pointer['manifest'])
    if not match or pointer.get('schemaVersion') != 1:
        raise ValueError('Invalid content pointer')
    manifest = (content / 'releases' / match[1] / 'manifest.json').read_bytes()
    if hashlib.sha256(manifest).hexdigest() != pointer['sha256']:
        raise ValueError('Invalid content manifest')
    content_manifest = json.loads(manifest)
    manifest_region = content_manifest.get('region') or ('global' if content_manifest.get('contentReleaseId','').startswith('global-') else None)
    if manifest_region != region: raise ValueError('Content region mismatch')
    other = 'jp' if region == 'global' else 'global'
    other_path = content / ('jp/current.json' if other == 'jp' else 'current.json')
    snapshot_id = match[1]
    if other_path.is_file():
        try:
            counterpart = json.loads(other_path.read_bytes())
            other_match = re.fullmatch('/content/releases/([a-f0-9]{24})/manifest.json', counterpart.get('manifest', ''))
            if not other_match or counterpart.get('schemaVersion') != 1: raise ValueError('Invalid library pointer')
            raw = (content / 'releases' / other_match[1] / 'manifest.json').read_bytes()
            other_manifest = json.loads(raw)
            if hashlib.sha256(raw).hexdigest() != counterpart.get('sha256') or (other_manifest.get('region') or other_manifest.get('contentReleaseId','').split('-')[0]) != other:
                raise ValueError('Invalid library manifest')
        except (OSError, ValueError, TypeError, AttributeError):
            # Retain a usable native edition if the optional library fails.
            counterpart = None
        pointer['libraryPointers'] = {other: counterpart}
        vector = json.dumps(pointer['libraryPointers'], ensure_ascii=False, separators=(',', ':'))
        snapshot_id = hashlib.sha256((snapshot_id + vector).encode()).hexdigest()[:24]
        pointer_bytes = json.dumps(pointer, ensure_ascii=False, separators=(',', ':')).encode()
    return code, metadata, pointer_bytes, identity + '-' + snapshot_id


def switch(root, name, target):
    temporary = root / ('.' + name + '.next')
    if temporary.is_symlink(): temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, root / name)


def publish(code_root, content, output, runner=subprocess.run, region="global"):
    if region not in ("global", "jp"): raise ValueError("Unsupported region")
    suffix = "" if region == "global" else "-jp"
    code_root, content, output = map(lambda p: Path(p).resolve(), (code_root, content, output))
    if output == code_root or output == content or code_root in output.parents or content in output.parents:
        raise ValueError('Derived output overlaps immutable stores')
    output.mkdir(parents=True, exist_ok=True)
    with (output / '.render.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        code, metadata, pointer_bytes, pair = read_inputs(code_root, content, region)
        current = output / ('current' + suffix)
        pending_file = output / ('.pending' + suffix + '.json')
        if current.exists() and not current.is_symlink(): raise ValueError('Rendered current must be a symlink')
        target = 'releases/' + pair
        if current.is_symlink() and os.readlink(current) == target:
            pending_file.unlink(missing_ok=True)
            return {'status':'unchanged', 'pair':pair}
        # Keep the previous internally consistent view during a normal refresh.
        # The HTML pins its own code/content, so it never mixes with new data.
        # A persistently failed refresh eventually falls back to the fresh client.
        if current.is_symlink():
            serving = os.readlink(current)
            switch(output, 'previous' + suffix, serving)
            pending = json.loads(pending_file.read_text()) if pending_file.exists() else {}
            if pending.get('serving') != serving:
                pending = {'serving':serving, 'changedAt':time.time()}
            pending['target'] = target
            temporary = output / ('.pending' + suffix + '.next')
            temporary.write_text(json.dumps(pending))
            os.replace(temporary, pending_file)
            if time.time() - pending['changedAt'] > 600: current.unlink()
        renderer = code / 'compiled/prerender/render.mjs'
        if not renderer.is_file():
            if current.is_symlink(): current.unlink()
            return {'status':'client_fallback', 'reason':'code_has_no_renderer'}
        for name, expected in metadata['files'].items():
            path = code / 'compiled' / name
            if not path.resolve().is_relative_to(code / 'compiled') or path.is_symlink(): raise ValueError('Unsafe code path')
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise ValueError('Invalid compiled file')
        releases = output / 'releases'
        releases.mkdir(exist_ok=True)
        final = releases / pair
        if final.is_symlink(): raise ValueError('Linked rendered release')
        if not final.exists() or not (final / region).is_dir():
            stage = Path(tempfile.mkdtemp(prefix='.render-', dir=releases))
            try:
                (stage / 'pointer.json').write_bytes(pointer_bytes)
                # Measured English rendering needs more than 384 MiB; keep
                # native/Python headroom within the 1 GiB R2 container limit.
                for locale in ('zh-CN','en'):
                    runner(['node', '--max-old-space-size=512', str(renderer), str(code), str(content), str(stage), locale, str(stage/'pointer.json'), region], check=True, timeout=1200)
                    report = json.loads((stage / ('report-' + region + '-' + locale + '.json')).read_text())
                    if report['codeId'] != metadata['codeId'] or report['pointer'] != json.loads(pointer_bytes) or report.get('region') != region or report.get('locale') != locale: raise ValueError('Mismatched render result')
                    for route in ('', 'characters', 'cards/members', 'cards/supports', 'music', 'database/items', 'database/skills', 'tools/live2d'):
                        html = (stage / region / locale / route / 'index.html').read_text()
                        if 'data-prerendered="true"' not in html or '<main' not in html: raise ValueError('Missing required rendered content')
                (stage / 'complete.json').write_text(json.dumps({'schemaVersion':1,'pair':pair,'codeId':metadata['codeId'],'region':region,'pointer':json.loads(pointer_bytes)}))
                stage.chmod(0o755)
                if final.exists():
                    # Restore a retired HTML view without removing payloads
                    # that an already-open browser may still be requesting.
                    saved = json.loads((final / 'complete.json').read_text())
                    if saved.get('pair') != pair or saved.get('pointer') != json.loads(pointer_bytes): raise ValueError('Invalid retired view')
                    (stage / region).rename(final / region)
                    if (stage / 'payloads').exists():
                        (final / 'payloads').mkdir(exist_ok=True)
                        for payload in (stage / 'payloads').iterdir():
                            destination = final / 'payloads' / payload.name
                            if destination.exists():
                                if destination.read_bytes() != payload.read_bytes(): raise ValueError('Immutable payload changed')
                            else: payload.rename(destination)
                    for path in stage.iterdir():
                        if path.is_file(): os.replace(path, final / path.name)
                    os.utime(final, None)
                else:
                    stage.rename(final)
            finally:
                if stage.exists(): shutil.rmtree(stage)
        complete = json.loads((final / 'complete.json').read_text())
        if complete.get('pair') != pair or complete.get('pointer') != json.loads(pointer_bytes): raise ValueError('Invalid rendered release')
        fresh = read_inputs(code_root, content, region)
        if fresh[3] != pair or fresh[2] != pointer_bytes:
            return {'status':'superseded', 'pair':pair}
        switch(output, 'current' + suffix, target)
        pending_file.unlink(missing_ok=True)
        # Historical HTML and open-tab payloads belong to independent audited
        # maintenance. Publication changes pointers, never deletes other releases.
        return {'status':'published', 'pair':pair,
                'retention':{'status':'deferred_to_operations'}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code-root', required=True)
    parser.add_argument('--content', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--region', choices=('all','global','jp'), default='all')
    args = parser.parse_args()
    failed = False
    for region in (('global','jp') if args.region == 'all' else (args.region,)):
        if region == 'jp' and args.region == 'all' and not (Path(args.content)/'jp/current.json').exists():
            continue
        try:
            print(json.dumps({'region':region, **publish(args.code_root, args.content, args.output, region=region)}), flush=True)
        except Exception as error:
            # Attempt the other region even when one generation fails.
            print(json.dumps({'region':region, 'status':'failed', 'error':str(error)}), flush=True)
            failed = True
    raise SystemExit(1 if failed else 0)
