"""Archive and retire old HTML; preserve live views and every open-tab payload.

Python 3.6+ host tool. All paths are explicit; no production configuration.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import time

from tools.operations import AuditError, PAIR, digest, identity, render_lock, root_path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def protected_views(root):
    protected = set()
    pointers = {}
    for name in ('current', 'current-jp', 'previous', 'previous-jp'):
        path = root/name
        if not path.is_symlink():
            if name.startswith('current') or path.exists():
                raise AuditError('invalid_render_pointer')
            pointers[name] = None
            continue
        target = os.readlink(str(path))
        if not target.startswith('releases/') or not PAIR.fullmatch(target[9:]):
            raise AuditError('unsafe_render_pointer')
        destination = root/target
        if destination.is_symlink() or not destination.is_dir():
            raise AuditError('missing_protected_view')
        pointers[name] = target
        protected.add(target[9:])
    for name in ('.pending.json', '.pending-jp.json'):
        path = root/name
        if path.is_symlink():
            raise AuditError('linked_pending_view')
        if path.exists():
            value = json.loads(path.read_text())
            for key in ('serving', 'target'):
                target = value.get(key)
                if not isinstance(target, str) or not target.startswith('releases/') or not PAIR.fullmatch(target[9:]):
                    raise AuditError('unsafe_pending_view')
                protected.add(target[9:])
            pointers[name] = digest(path)
    return protected, pointers


def make_plan(root, cutoff, max_views=8):
    if type(cutoff) is not int or cutoff < 0 or cutoff > time.time() - 86400:
        raise AuditError('retention_requires_at_least_one_day')
    if type(max_views) is not int or not 1 <= max_views <= 100:
        raise AuditError('invalid_retention_batch_size')
    releases = root/'releases'
    if releases.is_symlink() or not releases.is_dir():
        raise AuditError('invalid_releases_directory')
    protected, pointers = protected_views(root)
    files, views, skipped = [], [], 0
    for release in sorted(releases.iterdir()):
        if not PAIR.fullmatch(release.name):
            skipped += 1
            continue
        if release.is_symlink() or not release.is_dir():
            raise AuditError('linked_or_invalid_release')
        if release.name in protected or release.stat().st_mtime > cutoff:
            continue
        receipt = release/'complete.json'
        if receipt.is_symlink() or not receipt.is_file():
            raise AuditError('missing_release_receipt')
        complete = json.loads(receipt.read_text())
        if (not isinstance(complete, dict) or complete.get('pair') != release.name
                or complete.get('codeId') != release.name[:24]):
            raise AuditError('release_identity_mismatch')
        for region in ('global', 'jp'):
            folder = release/region
            if folder.is_symlink():
                raise AuditError('linked_html_directory')
            if not folder.exists():
                continue
            if not folder.is_dir() or complete.get('region', region) != region:
                raise AuditError('invalid_html_region')
            if len(views) >= max_views:
                continue
            views.append({'path': folder.relative_to(root).as_posix(), 'receiptSha256': digest(receipt),
                          'mtimeNs': release.stat().st_mtime_ns})
            for path in sorted(folder.rglob('*')):
                mode = path.lstat()
                if stat.S_ISDIR(mode.st_mode):
                    continue
                if not stat.S_ISREG(mode.st_mode) or path.suffix != '.html':
                    raise AuditError('unexpected_html_tree_entry')
                files.append({'path': path.relative_to(root).as_posix(), 'sha256': digest(path),
                    'size': mode.st_size, 'inode': mode.st_ino, 'device': mode.st_dev,
                    'links': mode.st_nlink, 'allocated': mode.st_blocks * 512,
                    'mtimeNs': mode.st_mtime_ns})
    # Count physical bytes only when every hardlink is in the removal set.
    inodes = {}
    for row in files:
        inodes.setdefault((row['device'], row['inode']), []).append(row)
    reclaim = sum(rows[0]['allocated'] for rows in inodes.values() if len(rows) == rows[0]['links'])
    value = {'schemaVersion': 1, 'operation': 'archive-retire-render-html', 'cutoff': cutoff, 'maxViews': max_views,
             'pointers': pointers, 'views': views, 'files': files, 'skippedUnknown': skipped,
             'estimatedReclaimBytes': reclaim}
    return dict(value, planId=identity(value))


def plan(root, cutoff, max_views=8):
    root = root_path(root)
    with render_lock(root):
        return make_plan(root, cutoff, max_views)


def archive_path(root, path):
    path = Path(path).absolute()
    if path.is_symlink() or path.resolve() != path or root == path or root in path.parents:
        raise AuditError('archive_must_be_external_and_unlinked')
    return path


def verify_archive(path, expected):
    wanted = {row['path']: row for row in expected['files']}
    seen = set()
    with tarfile.open(str(path), 'r:gz') as archive:
        for member in archive:
            if not member.isfile() or member.name in seen:
                raise AuditError('invalid_retention_archive')
            seen.add(member.name)
            stream = archive.extractfile(member)
            if member.name == '.retention-plan.json':
                if member.size != len(canonical(expected)) or stream.read() != canonical(expected):
                    raise AuditError('archive_plan_mismatch')
            else:
                row = wanted.get(member.name)
                if row is None or member.size != row['size']:
                    raise AuditError('unexpected_archive_member')
                sha = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    sha.update(block)
                if sha.hexdigest() != row['sha256']:
                    raise AuditError('archive_content_mismatch')
    if seen != set(wanted) | {'.retention-plan.json'}:
        raise AuditError('incomplete_retention_archive')


def archive_html(root, expected, destination):
    root = root_path(root)
    destination = archive_path(root, destination)
    with render_lock(root):
        if expected != make_plan(root, expected['cutoff'], expected['maxViews']):
            raise AuditError('plan_changed_reaudit_required')
        space = os.statvfs(str(destination.parent))
        limit = min(512 * 1024 * 1024, space.f_bavail * space.f_frsize - 2 * 1024**3)
        if limit <= 0:
            raise AuditError('insufficient_archive_headroom')
        fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'wb') as output:
                class BoundedWriter:
                    def write(self, data):
                        if output.tell() + len(data) > limit:
                            raise AuditError('archive_budget_exceeded')
                        return output.write(data)
                with tarfile.open(fileobj=BoundedWriter(), mode='w:gz', dereference=True) as archive:
                    data = canonical(expected)
                    member = tarfile.TarInfo('.retention-plan.json'); member.size = len(data); member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))
                    for row in expected['files']:
                        archive.add(str(root/row['path']), arcname=row['path'], recursive=False)
            verify_archive(destination, expected)
        except BaseException:
            destination.unlink()
            raise
    return {'status': 'archived', 'planId': expected['planId'], 'archiveSha256': digest(destination),
            'archiveBytes': destination.stat().st_size}


def apply(root, expected, archive):
    root = root_path(root)
    archive = archive_path(root, archive)
    with render_lock(root):
        if expected != make_plan(root, expected['cutoff'], expected['maxViews']):
            raise AuditError('plan_changed_reaudit_required')
        verify_archive(archive, expected)
        before = os.statvfs(str(root))
        for row in expected['files']:
            (root/row['path']).unlink()
        for view in expected['views']:
            folder = root/view['path']
            for path in sorted(folder.rglob('*'), key=lambda item: len(item.parts), reverse=True):
                path.rmdir()
            folder.rmdir()
        after = os.statvfs(str(root))
    return {'status': 'retired', 'planId': expected['planId'], 'retiredViews': len(expected['views']),
            'freeBytesBefore': before.f_bavail * before.f_frsize,
            'freeBytesAfter': after.f_bavail * after.f_frsize,
            'preserved': 'current_previous_pending_and_all_payloads'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'archive', 'apply'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--minimum-age-days', type=int, default=7)
    parser.add_argument('--max-views', type=int, default=8)
    args = parser.parse_args()
    try:
        if args.action == 'plan':
            if args.minimum_age_days < 1:
                raise AuditError('retention_requires_at_least_one_day')
            result = plan(args.root, int(time.time()) - args.minimum_age_days * 86400, args.max_views)
            fd = os.open(str(args.plan), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(result, stream, sort_keys=True)
            print(json.dumps({key: value for key, value in result.items() if key not in ('files', 'views', 'pointers')}, sort_keys=True))
        else:
            if args.archive is None:
                parser.error('--archive required')
            expected = json.loads(args.plan.read_text())
            operation = archive_html if args.action == 'archive' else apply
            print(json.dumps(operation(args.root, expected, args.archive), sort_keys=True))
    except AuditError as error:
        print(json.dumps({'status': 'blocked', 'reason': str(error)}))
        return 2
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError):
        print(json.dumps({'status': 'blocked', 'reason': 'retention_validation_failed'}))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
