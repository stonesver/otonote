"""Offline audit and lossless deduplication of immutable render/code/content assets.

No production defaults. Actual paths/configuration stay outside version control.
Deduplication preserves every URL, byte and release; it never removes releases.
Compatible with Python 3.6+ for maintenance hosts; no third-party dependencies.
"""
import argparse
import array
import collections
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


PAIR = re.compile(r'^[a-f0-9]{24}-[a-f0-9]{24}$')
PAYLOAD = re.compile(r'^([a-f0-9]{64})\.json$')
CODE = re.compile(r'^[a-f0-9]{24}$')
SHA256 = re.compile(r'^[a-f0-9]{64}$')


class AuditError(ValueError):
    """Fixed error codes only: never embed private paths or file contents."""


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def attribute_identity(path):
    """Include ACL/security labels without exposing their values in reports."""
    if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
        if sys.platform == 'darwin':
            try:
                names = subprocess.check_output(['/usr/bin/xattr', str(path)], stderr=subprocess.DEVNULL).decode().splitlines()
                return identity([(name, hashlib.sha256(subprocess.check_output(
                    ['/usr/bin/xattr', '-px', name, str(path)], stderr=subprocess.DEVNULL)).hexdigest()) for name in sorted(names)])
            except (OSError, ValueError, subprocess.CalledProcessError):
                raise AuditError('extended_attribute_check_failed')
        raise AuditError('extended_attribute_check_unavailable')
    try:
        attrs = [(name, hashlib.sha256(os.getxattr(str(path), name)).hexdigest())
                 for name in sorted(os.listxattr(str(path)))]
    except OSError as error:
        if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
            return identity([])
        raise AuditError('extended_attribute_check_failed')
    return identity(attrs)


def root_path(value):
    path = Path(value).absolute()
    if path.is_symlink() or not path.is_dir():
        raise AuditError('invalid_store_root')
    return path.resolve()


def safe_file(root, relative):
    parts = Path(relative).parts
    if len(parts) != 4 or parts[0] != 'releases' or not PAIR.fullmatch(parts[1]) or parts[2] != 'payloads' or not PAYLOAD.fullmatch(parts[3]):
        raise AuditError('invalid_payload_path')
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise AuditError('linked_payload_path')
    if not path.is_file():
        raise AuditError('missing_payload')
    return path


@contextlib.contextmanager
def store_lock(root, name, busy):
    path = root / name
    if path.is_symlink():
        raise AuditError('linked_lock')
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AuditError(busy)
        yield
    finally:
        os.close(fd)


@contextlib.contextmanager
def render_lock(root):
    # Live R2 promotion and legacy publication use different locks. Maintenance
    # must exclude both publishers without stopping either service.
    with store_lock(root, '.r2-prerender.lock', 'render_in_progress'):
        with store_lock(root, '.render.lock', 'render_in_progress'):
            yield


def code_lock(root):
    return store_lock(root, '.publication.lock', 'code_publication_in_progress')


def file_record(root, path, expected):
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise AuditError('nonregular_asset')
    return {'path':path.relative_to(root).as_posix(), 'sha256':expected,
            'device':metadata.st_dev, 'inode':metadata.st_ino, 'size':metadata.st_size,
            'mtimeNs':metadata.st_mtime_ns, 'mode':stat.S_IMODE(metadata.st_mode),
            'uid':metadata.st_uid, 'gid':metadata.st_gid, 'links':metadata.st_nlink,
            'attributes':attribute_identity(path), 'flags':getattr(metadata, 'st_flags', 0),
            'allocated':metadata.st_blocks * 512}


def inventory(root):
    releases = root / 'releases'
    if releases.is_symlink() or not releases.is_dir():
        raise AuditError('invalid_releases_directory')
    files = []
    skipped = 0
    for release in sorted(releases.iterdir()):
        if not PAIR.fullmatch(release.name):
            skipped += 1
            continue
        if release.is_symlink():
            raise AuditError('linked_release')
        marker = release / 'complete.json'
        if marker.is_symlink() or not marker.is_file():
            raise AuditError('missing_release_receipt')
        try:
            receipt = json.loads(marker.read_text())
        except (ValueError, OSError):
            raise AuditError('invalid_release_receipt')
        if not isinstance(receipt, dict):
            raise AuditError('invalid_release_receipt')
        if receipt.get('pair') != release.name or receipt.get('codeId') != release.name[:24]:
            raise AuditError('release_identity_mismatch')
        payloads = release / 'payloads'
        if payloads.is_symlink():
            raise AuditError('linked_payload_directory')
        if not payloads.exists():
            continue
        for path in sorted(payloads.iterdir()):
            match = PAYLOAD.fullmatch(path.name)
            if not match:
                skipped += 1
                continue
            relative = path.relative_to(root).as_posix()
            path = safe_file(root, relative)
            if digest(path) != match.group(1):
                raise AuditError('payload_digest_mismatch')
            files.append(file_record(root, path, match.group(1)))
    return files, skipped


def safe_code_file(root, relative):
    if not isinstance(relative, str) or '\\' in relative or '\x00' in relative:
        raise AuditError('invalid_code_asset_path')
    parts = relative.split('/')
    if len(parts) < 4 or parts[0] != 'releases' or not CODE.fullmatch(parts[1]) or parts[2] != 'compiled' or any(part in ('', '.', '..') for part in parts):
        raise AuditError('invalid_code_asset_path')
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise AuditError('linked_code_asset_path')
    if not path.is_file():
        raise AuditError('missing_code_asset')
    return path


def read_code_receipt(path):
    if path.is_symlink() or not path.is_file():
        raise AuditError('invalid_code_receipt')
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise AuditError('invalid_code_receipt')
            result[key] = value
        return result
    try:
        value = json.loads(path.read_text(), object_pairs_hook=unique_object)
    except (OSError, ValueError, UnicodeError):
        raise AuditError('invalid_code_receipt')
    if not isinstance(value, dict):
        raise AuditError('invalid_code_receipt')
    return value


def normalize_excluded_code_ids(values):
    if not isinstance(values, (list, tuple, set, frozenset)) or any(
        not isinstance(value, str) or not CODE.fullmatch(value) for value in values
    ):
        raise AuditError('invalid_excluded_code_id')
    return tuple(sorted(set(values)))


def code_inventory(root, exclude_code_ids=()):
    excluded = normalize_excluded_code_ids(exclude_code_ids)
    releases = root / 'releases'
    if releases.is_symlink() or not releases.is_dir():
        raise AuditError('invalid_releases_directory')
    files, preserved, skipped = [], [], 0
    for release in sorted(releases.iterdir()):
        # An explicit exclusion is an untouched version, not a relaxed receipt
        # check. Do not stat, traverse, read or select any path in that version.
        if release.name in excluded:
            continue
        if not CODE.fullmatch(release.name):
            skipped += 1
            continue
        if release.is_symlink() or not release.is_dir():
            raise AuditError('invalid_code_release')
        marker = release / 'code-release.json'
        metadata = read_code_receipt(marker)
        declared = metadata.get('files')
        if metadata.get('schemaVersion') != 1 or metadata.get('contentSchemaVersion') != 1 or not isinstance(declared, dict) or not declared:
            raise AuditError('invalid_code_contract')
        # Match verify_code/build_web_client: insertion order of the serialized
        # manifest inventory is part of the existing codeId contract.
        calculated = hashlib.sha256(json.dumps(declared, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:24]
        if metadata.get('codeId') != release.name or calculated != release.name:
            raise AuditError('code_identity_mismatch')
        compiled = release / 'compiled'
        if compiled.is_symlink() or not compiled.is_dir():
            raise AuditError('invalid_compiled_directory')
        actual = set()
        for directory, dirs, names in os.walk(str(compiled), followlinks=False):
            for name in dirs + names:
                path = Path(directory) / name
                if path.is_symlink():
                    raise AuditError('linked_code_asset_path')
                if name in names:
                    if name == '.DS_Store':
                        skipped += 1
                    else:
                        actual.add(path.relative_to(compiled).as_posix())
        if actual != set(declared):
            raise AuditError('code_inventory_mismatch')
        for name, expected in declared.items():
            if not isinstance(expected, str) or not SHA256.fullmatch(expected):
                raise AuditError('invalid_code_asset_digest')
            path = safe_code_file(root, 'releases/' + release.name + '/compiled/' + name)
            if not stat.S_ISREG(path.stat().st_mode):
                raise AuditError('nonregular_asset')
            if digest(path) != expected:
                raise AuditError('code_asset_digest_mismatch')
            if path.name in ('index.html', 'code-release.json', 'verification.json', 'entry-shell.json'):
                preserved.append({'path':path.relative_to(root).as_posix(), 'sha256':expected})
            else:
                files.append(file_record(root, path, expected))
        shell_path = release / 'index.html'
        if shell_path.is_symlink() or not shell_path.is_file():
            raise AuditError('invalid_code_shell')
        try:
            shell = shell_path.read_text()
        except (OSError, UnicodeError):
            raise AuditError('invalid_code_shell')
        boot = re.search(r'src="/app/releases/' + release.name + r'/(boot-[A-Z0-9]+\.js)"', shell)
        if not boot or boot.group(1) not in declared:
            raise AuditError('invalid_code_shell')
        if 'entry-shell.json' in declared:
            entry = read_code_receipt(compiled / 'entry-shell.json')
            if entry.get('sha256') != hashlib.sha256(shell.replace(release.name, '__CODE_ID__').encode()).hexdigest():
                raise AuditError('code_shell_digest_mismatch')
        for path in (marker, shell_path, release / 'verification.json'):
            if path.is_symlink():
                raise AuditError('linked_code_receipt')
            if path.name != 'verification.json' or path.exists():
                if not path.is_file():
                    raise AuditError('invalid_code_receipt')
                preserved.append({'path':path.relative_to(root).as_posix(), 'sha256':digest(path)})
    return files, skipped, preserved


def deduplication_plan(files, skipped, *, operation='deduplicate-render-payloads', preserved=None):
    groups = collections.defaultdict(list)
    for item in files:
        # Do not change ownership, permissions or filesystem of any file.
        key = (item['sha256'], item['device'], item['mode'], item['uid'], item['gid'], item['attributes'], item['flags'])
        groups[key].append(item)
    actions = []
    reclaim = 0
    for members in groups.values():
        canonical = members[0]
        old_inodes = collections.defaultdict(list)
        for item in members[1:]:
            if item['inode'] == canonical['inode']:
                continue
            actions.append({'source':canonical['path'], 'target':item['path'], 'sha256':item['sha256']})
            old_inodes[item['inode']].append(item)
        for items in old_inodes.values():
            if len(items) == items[0]['links']:
                reclaim += items[0]['allocated']
    body = {'schemaVersion':1, 'operation':operation,
            'inventoryDigest':identity(files if preserved is None else {'assets':files, 'preserved':preserved}), 'actions':actions,
            'payloadFiles' if preserved is None else 'assetFiles':len(files), 'skippedUnknown':skipped,
            'estimatedReclaimBytes':reclaim}
    return dict(body, planId=identity(body))


def content_lock(root):
    # Exactly the lock used by publish_content and rollback_content.
    return store_lock(root, '.publication.lock', 'content_publication_in_progress')


def filesystem_flags(path):
    """Linux stat has no st_flags: query the filesystem instead of assuming zero."""
    if sys.platform.startswith('linux'):
        flags = array.array('L', [0])
        try:
            with path.open('rb') as stream:
                fcntl.ioctl(stream.fileno(), 0x80006601 | (flags.itemsize << 16), flags, True)
        except OSError:
            raise AuditError('content_filesystem_flags_unavailable')
        return int(flags[0])
    metadata = path.stat()
    if not hasattr(metadata, 'st_flags'):
        raise AuditError('content_filesystem_flags_unavailable')
    return metadata.st_flags


def content_signature(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns,
            metadata.st_ctime_ns, metadata.st_uid, metadata.st_gid,
            metadata.st_mode, metadata.st_nlink)


def content_relative(value):
    if (not isinstance(value, str) or not value or '\\' in value or
            any(ord(char) < 32 for char in value) or
            any(part in ('', '.', '..') for part in value.split('/'))):
        raise AuditError('invalid_content_path')
    return value


def safe_content_file(root, relative):
    parts = content_relative(relative).split('/')
    if len(parts) < 3 or parts[0] != 'releases' or not CODE.fullmatch(parts[1]):
        raise AuditError('invalid_content_asset_path')
    if parts[-1] in ('.receipt.json', 'manifest.json', 'current.json', 'previous.json'):
        raise AuditError('protected_content_asset')
    return content_checked_file(root, relative)


def content_checked_file(root, relative):
    path = root
    for part in content_relative(relative).split('/'):
        path = path / part
        if path.is_symlink():
            raise AuditError('linked_content_path')
    if not stat.S_ISREG(path.lstat().st_mode):
        raise AuditError('nonregular_content_asset')
    return path


def content_json(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise AuditError('duplicate_content_json_key')
            result[key] = value
        return result
    try:
        value = json.loads(path.read_text(), object_pairs_hook=unique_object)
    except (OSError, ValueError, UnicodeError):
        raise AuditError('invalid_content_json')
    if not isinstance(value, dict):
        raise AuditError('invalid_content_json')
    return value


def content_inventory(root):
    """Verify sealed snapshots without requiring historical candidate/source trees.

    Snapshot IDs cannot be regenerated from the receipt alone: their historical
    inputs include publisher code. Instead bind directory ID to manifest.root,
    every receipt entry to actual bytes, and regional pointers to that manifest.
    """
    releases = root / 'releases'
    if releases.is_symlink() or not releases.is_dir():
        raise AuditError('invalid_content_releases')
    files, preserved, cache, checked, directories, manifests = [], [], {}, {}, {}, {}

    def record(path):
        relative = path.relative_to(root).as_posix()
        path = content_checked_file(root, relative)
        before = content_signature(path.lstat())
        key = before[:2]
        if key not in cache:
            item = file_record(root, path, digest(path))
            item['flags'] = filesystem_flags(path)
            item['ctimeNs'] = before[4]
            if content_signature(path.lstat()) != before:
                raise AuditError('content_changed_during_audit')
            cache[key] = (before, item)
        elif cache[key][0] != before:
            raise AuditError('content_changed_during_audit')
        checked[relative] = before
        return dict(cache[key][1], path=relative)

    names = sorted(path.name for path in releases.iterdir())
    if any(not CODE.fullmatch(name) for name in names):
        raise AuditError('unexpected_content_release')
    for name in names:
        release = releases / name
        if release.is_symlink() or not release.is_dir():
            raise AuditError('invalid_content_release')
        marker = content_checked_file(root, 'releases/' + name + '/.receipt.json')
        receipt_record = record(marker)
        receipt = content_json(marker)
        expected = receipt.get('files')
        candidate = receipt.get('candidateSha256')
        if (receipt.get('schemaVersion') != 1 or not isinstance(expected, dict) or not expected or
                not isinstance(candidate, str) or not SHA256.fullmatch(candidate)):
            raise AuditError('invalid_content_receipt')
        for relative, sha in expected.items():
            content_relative(relative)
            if relative == '.receipt.json' or not isinstance(sha, str) or not SHA256.fullmatch(sha):
                raise AuditError('invalid_content_receipt')
        found = {}
        for directory, dirs, entries in os.walk(str(release), followlinks=False):
            folder = Path(directory)
            metadata = folder.stat()
            directories[folder] = (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_ctime_ns)
            for entry in sorted(dirs + entries):
                path = folder / entry
                if path.is_symlink():
                    raise AuditError('linked_content_path')
                if entry in dirs:
                    continue
                relative = path.relative_to(release).as_posix()
                item = record(path)
                if relative == '.receipt.json':
                    continue
                if expected.get(relative) != item['sha256']:
                    raise AuditError('content_inventory_or_digest_mismatch')
                found[relative] = item
                if path.name in ('.receipt.json', 'manifest.json', 'current.json', 'previous.json'):
                    preserved.append(item)
                else:
                    files.append(item)
        if set(found) != set(expected):
            raise AuditError('content_inventory_mismatch')
        preserved.append(receipt_record)
        manifest_path = content_checked_file(root, 'releases/' + name + '/manifest.json')
        manifest = content_json(manifest_path)
        locales = manifest.get('locales')
        release_id = manifest.get('contentReleaseId')
        if (manifest.get('schemaVersion') != 1 or manifest.get('root') != '/content/releases/' + name + '/' or
                manifest.get('region') not in ('global', 'jp') or manifest.get('channel') != 'production' or
                not isinstance(release_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', release_id) or
                not isinstance(locales, dict) or set(locales) != {'en', 'zh-CN'}):
            raise AuditError('invalid_content_manifest')
        for locale, groups in locales.items():
            if not isinstance(groups, dict):
                raise AuditError('invalid_content_locale')
            for group in ('files', 'groups'):
                if not isinstance(groups.get(group), dict):
                    raise AuditError('invalid_content_locale')
                for entry in groups[group].values():
                    if not isinstance(entry, dict):
                        raise AuditError('invalid_content_record')
                    relative = content_relative(entry.get('path'))
                    item = found.get(relative)
                    if (not relative.startswith(locale + '/') or not item or entry.get('sha256') != item['sha256'] or
                            type(entry.get('bytes')) is not int or entry['bytes'] != item['size']):
                        raise AuditError('content_manifest_binding_mismatch')
        manifests[name] = (manifest, found['manifest.json']['sha256'])
    pointer_names = ('current.json', 'previous.json', 'jp/current.json', 'jp/previous.json')
    if (root / 'jp').is_symlink():
        raise AuditError('linked_content_pointer_directory')
    absent = []
    for relative in pointer_names:
        path = root / relative
        if path.is_symlink():
            raise AuditError('linked_content_pointer')
        if not path.exists():
            absent.append(relative)
            continue
        item = record(path)
        pointer = content_json(path)
        target = pointer.get('manifest')
        match = re.fullmatch(r'/content/releases/([a-f0-9]{24})/manifest.json', target) if isinstance(target, str) else None
        if pointer.get('schemaVersion') != 1 or not match or match.group(1) not in manifests:
            raise AuditError('invalid_content_pointer')
        manifest, sha = manifests[match.group(1)]
        region = 'jp' if relative.startswith('jp/') else 'global'
        if (pointer.get('sha256') != sha or manifest['region'] != region or
                pointer.get('contentReleaseId') != manifest['contentReleaseId']):
            raise AuditError('content_pointer_binding_mismatch')
        preserved.append(item)
    # Detect uncooperative writers as well as publication under the shared lock.
    for relative, before in checked.items():
        if content_signature(content_checked_file(root, relative).lstat()) != before:
            raise AuditError('content_changed_during_audit')
    for folder, before in directories.items():
        metadata = folder.stat()
        if folder.is_symlink() or before != (metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_ctime_ns):
            raise AuditError('content_changed_during_audit')
    if names != sorted(path.name for path in releases.iterdir()) or any(os.path.lexists(str(root / name)) for name in absent):
        raise AuditError('content_changed_during_audit')
    return sorted(files, key=lambda item: item['path']), sorted(preserved, key=lambda item: item['path'])


def content_action_state(item):
    # Link creation/removal changes ctime and nlink during our own apply.
    return {key:value for key,value in item.items() if key not in ('path', 'ctimeNs', 'links', 'allocated')}


def make_content_plan(root):
    files, preserved = content_inventory(root)
    protected_inodes = {(item['device'], item['inode']) for item in preserved}
    groups = collections.defaultdict(lambda: collections.defaultdict(list))
    for item in files:
        if (item['device'], item['inode']) in protected_inodes:
            continue
        key = tuple(item[field] for field in ('sha256', 'size', 'device', 'mode', 'uid', 'gid', 'attributes', 'flags'))
        groups[key][item['inode']].append(item)
    selected, states = [], {item['path']:item for item in files}
    for inodes in groups.values():
        members = sorted(inodes.values(), key=lambda items: items[0]['path'])
        if len(members) < 2:
            continue
        flags = members[0][0]['flags']
        # Immutable/append-only files cannot be safely replaced or hardlinked.
        blocked_flags = (0x10 | 0x20) if sys.platform.startswith('linux') else (0x2 | 0x4 | 0x20000 | 0x40000)
        if flags & blocked_flags:
            continue
        external = [items for items in members if len(items) < items[0]['links']]
        if any(len(items) > items[0]['links'] for items in members):
            raise AuditError('invalid_content_link_count')
        keeper = external[0] if external else min(members, key=lambda items: (items[0]['allocated'], items[0]['path']))
        targets = [items for items in members if items is not keeper and len(items) == items[0]['links'] and items[0]['allocated'] > 0]
        if targets:
            selected.extend(keeper)
            for items in targets:
                selected.extend(items)
    plan = deduplication_plan(selected, 0, operation='deduplicate-content-assets', preserved=preserved)
    plan['inventoryDigest'] = identity({'assets':files, 'preserved':preserved})
    plan['assetFiles'] = len(files)
    replaced = collections.Counter()
    for action in plan['actions']:
        action['sourceState'] = content_action_state(states[action['source']])
        action['targetState'] = content_action_state(states[action['target']])
        target = states[action['target']]
        inode = (target['device'], target['inode'])
        action['targetLinksRemaining'] = target['links'] - replaced[inode]
        replaced[inode] += 1
    plan['planId'] = identity({key:value for key,value in plan.items() if key != 'planId'})
    return plan


def plan_content_deduplication(value):
    root = root_path(value)
    with content_lock(root):
        return make_content_plan(root)


def validate_content_action(root, action, source, target):
    for path, key in ((source, 'sourceState'), (target, 'targetState')):
        item = file_record(root, path, action['sha256'])
        item['flags'] = filesystem_flags(path)
        if content_action_state(item) != action[key]:
            raise AuditError('content_metadata_changed_during_apply')
        if key == 'targetState' and item['links'] != action['targetLinksRemaining']:
            raise AuditError('content_links_changed_during_apply')


def apply_content_deduplication(value, expected):
    return apply_plan(value, expected, content_lock, make_content_plan, safe_content_file,
                      validate_content_action)


def make_plan(root):
    files, skipped = inventory(root)
    return deduplication_plan(files, skipped)


def make_code_plan(root, exclude_code_ids=()):
    excluded = normalize_excluded_code_ids(exclude_code_ids)
    files, skipped, preserved = code_inventory(root, excluded)
    plan = deduplication_plan(files, skipped, operation='deduplicate-code-assets', preserved=preserved)
    # Empty exclusions preserve the exact legacy plan shape and digest.
    if excluded:
        body = {key:value for key,value in plan.items() if key != 'planId'}
        body['excludedCodeIds'] = list(excluded)
        plan = dict(body, planId=identity(body))
    return plan


def plan_deduplication(value):
    root = root_path(value)
    with render_lock(root):
        return make_plan(root)


def apply_deduplication(value, expected):
    return apply_plan(value, expected, render_lock, make_plan, safe_file)


def plan_code_deduplication(value, exclude_code_ids=()):
    excluded = normalize_excluded_code_ids(exclude_code_ids)
    root = root_path(value)
    with code_lock(root):
        return make_code_plan(root, excluded)


def apply_code_deduplication(value, expected, exclude_code_ids=()):
    excluded = normalize_excluded_code_ids(exclude_code_ids)
    if not isinstance(expected, dict):
        raise AuditError('invalid_deduplication_plan')
    if normalize_excluded_code_ids(expected.get('excludedCodeIds', ())) != excluded:
        raise AuditError('plan_changed_reaudit_required')
    return apply_plan(value, expected, code_lock,
                      lambda root: make_code_plan(root, excluded), safe_code_file)


def apply_plan(value, expected, lock, planner, resolve_file, validate_action=None):
    root = root_path(value)
    with lock(root):
        current = planner(root)
        if expected != current:
            raise AuditError('plan_changed_reaudit_required')
        before = os.statvfs(str(root))
        changed = 0
        for action in current['actions']:
            source = resolve_file(root, action['source'])
            target = resolve_file(root, action['target'])
            # Both were hashed under the publication lock; ensure the selected
            # canonical file still satisfies its content-addressed identity.
            if digest(source) != action['sha256'] or digest(target) != action['sha256']:
                raise AuditError('payload_changed_during_apply')
            if validate_action is not None:
                validate_action(root, action, source, target)
            temporary = target.parent / ('.dedupe-' + uuid.uuid4().hex)
            try:
                os.link(str(source), str(temporary))
                os.replace(str(temporary), str(target))
                changed += 1
            finally:
                if temporary.exists():
                    temporary.unlink()
        after = os.statvfs(str(root))
        return {'status':'complete', 'planId':current['planId'], 'linkedFiles':changed,
                'freeBytesBefore':before.f_bavail * before.f_frsize,
                'freeBytesAfter':after.f_bavail * after.f_frsize,
                'preserved':'all_release_paths_and_bytes'}


def task_status(report, last_success=None):
    """Public operational summary from private reports; never echo raw errors."""
    error = str(report.get('error', ''))
    if 'insufficient free disk' in error:
        reason = 'disk_capacity_blocked'
    elif error == 'game_rpc_unknown':
        reason = 'upstream_rpc_unknown'
    elif report.get('status') == 'failed':
        reason = 'task_failed'
    else:
        reason = None
    return {'status':report.get('status') if report.get('status') in ('failed','complete','passed','running','unchanged') else 'unknown',
            'reason':reason, 'paused':bool(report.get('paused',False)),
            'hasLastSuccess':bool(last_success)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    for command in ('dedupe-plan', 'dedupe-apply'):
        child = sub.add_parser(command)
        roots = child.add_mutually_exclusive_group(required=True)
        roots.add_argument('--rendered-root')
        roots.add_argument('--code-root')
        roots.add_argument('--content-root')
        child.add_argument('--plan', required=True, type=Path)
        child.add_argument('--exclude-code-id', action='append', default=[],
                           help='leave this 24-hex code version untouched; repeat on both plan and apply')
    args = parser.parse_args(argv)
    try:
        if getattr(args, 'exclude_code_id', None) and not args.code_root:
            raise AuditError('code_exclusions_require_code_root')
        if args.command == 'dedupe-plan':
            result = (plan_content_deduplication(args.content_root) if args.content_root else
                      plan_code_deduplication(args.code_root, args.exclude_code_id) if args.code_root else
                      plan_deduplication(args.rendered_root))
            fd = os.open(str(args.plan), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(result, stream, sort_keys=True, indent=2)
            print(json.dumps({k:v for k,v in result.items() if k != 'actions'}))
        elif args.command == 'dedupe-apply':
            expected = json.loads(args.plan.read_text())
            print(json.dumps(apply_content_deduplication(args.content_root, expected) if args.content_root else
                             apply_code_deduplication(args.code_root, expected, args.exclude_code_id) if args.code_root else
                             apply_deduplication(args.rendered_root, expected)))
        else:
            parser.error('command required')
    except AuditError as error:
        print(json.dumps({'status':'blocked','reason':str(error)}), file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'status':'blocked','reason':'invalid_input_or_io_failure'}), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
