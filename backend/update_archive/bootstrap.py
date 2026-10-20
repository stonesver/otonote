"""Read a finite selection from one immutable producer checkpoint.

Never restores the production workspace or writes a production pointer. Restored
files are independent copies under the archive runner's private temporary root.
"""
import hashlib
import json
from pathlib import Path
import re
from .models import ArchiveError, digest, region, safe_name


def restore_materials(client, bucket, selected_region, selection, target, *, max_bytes=512 * 1024 ** 2, preset=None):
    region(selected_region)
    if preset is not None and (preset != 'global-production-v1' or selected_region != 'global' or selection):
        raise ArchiveError('invalid_bootstrap_preset')
    if preset is None and (not isinstance(selection, dict) or not 1 <= len(selection) <= 64):
        raise ArchiveError('invalid_bootstrap_selection')
    def read(key, limit):
        item = client.get_object(Bucket=bucket, Key=key)
        try:
            raw = item['Body'].read(limit + 1)
        finally:
            item['Body'].close()
        if len(raw) > limit:
            raise ArchiveError('bootstrap_control_too_large')
        return raw
    pointer_raw = read('state/' + selected_region + '/current.json', 16384)
    pointer = json.loads(pointer_raw)
    sha = pointer.get('sha256', '')
    if (pointer.get('schemaVersion') != 1 or pointer.get('region') != selected_region
            or not re.fullmatch('[a-f0-9]{64}', sha)
            or pointer.get('manifest') != f'state/manifests/{selected_region}/{sha}.json'):
        raise ArchiveError('invalid_bootstrap_pointer')
    manifest_raw = read(pointer['manifest'], 128 * 1024 ** 2)
    manifest = json.loads(manifest_raw)
    if digest(manifest_raw) != sha or manifest.get('region') != selected_region or manifest.get('schemaVersion') not in (1, 2):
        raise ArchiveError('invalid_bootstrap_manifest')
    entries = {}
    for row in manifest['files']:
        name = safe_name(row['path'])
        if name in entries or not re.fullmatch('[a-f0-9]{64}', str(row.get('sha256', ''))) or type(row.get('size')) is not int or row['size'] < 0:
            raise ArchiveError('invalid_bootstrap_inventory')
        entries[name] = row
    cached = {}
    if preset:
        # The workflow's stable receipt binds the current client, not a guessed
        # newest directory or a path copied from an older hot-update snapshot.
        state_path = 'output/global-update-workflow/state.json'
        row = entries.get(state_path)
        if not row or row['size'] > 65536:
            raise ArchiveError('bootstrap_current_receipt_missing')
        raw = read('state/objects/' + row['sha256'], row['size'])
        if len(raw) != row['size'] or digest(raw) != row['sha256']:
            raise ArchiveError('bootstrap_digest_mismatch')
        proof = json.loads(raw)
        trusted = proof.get('r2ProductionReceipt', {}).get('trustedInputInventory', [])
        if not isinstance(trusted, list) or len(trusted) > 64:
            raise ArchiveError('invalid_bootstrap_current_receipt')
        selected = {}
        for role, suffix in (('metadata.dat', 'global-metadata.v39.dat'), ('profile.json', 'decoder.json')):
            matches = [r for r in trusted if isinstance(r, dict) and re.fullmatch(
                r'output/global-update-workflow/clients/[a-f0-9]{64}/' + re.escape(suffix), str(r.get('path', '')))]
            if len(matches) != 1 or entries.get(matches[0]['path']) != matches[0]:
                raise ArchiveError('bootstrap_current_binding_missing')
            selected['global/' + role] = matches[0]['path']
        if selected['global/metadata.dat'].rsplit('/', 1)[0] != selected['global/profile.json'].rsplit('/', 1)[0]:
            raise ArchiveError('bootstrap_current_binding_mismatch')
        selection = {'global/observation.json': state_path, **selected}
        cached[state_path] = raw
    target = Path(target).resolve()
    planned, total = [], len(pointer_raw) + len(manifest_raw)
    for local, original in selection.items():
        safe_name(local); safe_name(original)
        if original not in entries:
            raise ArchiveError('bootstrap_material_missing')
        row = entries[original]
        total += row['size']
        planned.append((local, row))
    if total > max_bytes:
        raise ArchiveError('bootstrap_budget_exceeded')
    for local, row in planned:
        path = target / local
        if any(p.is_symlink() for p in (path, *path.parents) if p == target or target in p.parents):
            raise ArchiveError('linked_bootstrap_path')
        path.parent.mkdir(parents=True, exist_ok=True)
        if row['path'] in cached:
            path.write_bytes(cached[row['path']])
            continue
        item = client.get_object(Bucket=bucket, Key='state/objects/' + row['sha256'])
        h, count = hashlib.sha256(), 0
        try:
            with path.open('xb') as out:
                for chunk in iter(lambda: item['Body'].read(1024 * 1024), b''):
                    count += len(chunk)
                    if count > row['size']:
                        raise ArchiveError('bootstrap_size_mismatch')
                    h.update(chunk); out.write(chunk)
        finally:
            item['Body'].close()
        if count != row['size'] or h.hexdigest() != row['sha256']:
            raise ArchiveError('bootstrap_digest_mismatch')
    return {'manifestSha256': sha, 'receivedBytes': total, 'files': list(selection)}
