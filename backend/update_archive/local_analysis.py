"""Offline full object inventory and bounded previews; runs in a child process."""
import argparse
import json
from pathlib import Path

from .models import ArchiveError, canonical, digest
from .store import file_digest


def inventory(raw, name, context):
    with raw.open('rb') as stream:
        header = stream.read(8)
    if Path(name).suffix != '.bundle' and not header.startswith(b'UnityFS'):
        return {'complete': True, 'kind': 'file', 'objects': [
            {'name': name, 'type': 'file', 'sha256': file_digest(raw)}]}
    import UnityPy
    payload = raw.read_bytes()
    if not payload.startswith(b'UnityFS'):
        if not context or not context.get('metadata'):
            raise ArchiveError('decoder_context_missing')
        from analysis.crypto.inspect_il2cpp import MetadataV39
        from tools.bundle_decoder import resolve_bundle_decoder
        from analysis.crypto.decrypt_global_formal_scores import decrypt_header
        metadata = MetadataV39(Path(context['metadata']))
        key, seed, _ = resolve_bundle_decoder(metadata, context['clientVersion'], profile=context.get('profile'))
        payload = decrypt_header(payload, name, key, seed)
    env = UnityPy.load(payload)
    rows, complete = [], True
    for obj in env.objects:
        row = {'type': obj.type.name, 'pathId': str(obj.path_id)}
        try:
            row['sha256'] = digest(obj.get_raw_data())
            # Names are matching hints, pathId is diagnostic only across builds.
            try:
                row['name'] = str(getattr(obj.read(), 'm_Name', ''))
            except Exception:
                row['name'] = ''
        except Exception:
            row['error'] = 'object_read_failed'; complete = False
        rows.append(row)
    return {'complete': complete, 'kind': 'bundle', 'objects': rows}


def compare(before, after):
    if not before.get('complete') or not after.get('complete'):
        return {'complete': False, 'error': 'incomplete_inventory'}
    def named(report):
        grouped = {}
        for row in report['objects']:
            key = (row.get('type'), row.get('name'))
            if key[1]:
                grouped.setdefault(key, []).append(row)
        return {k: v[0] for k, v in grouped.items() if len(v) == 1}, set(grouped)
    (old, old_names), (new, new_names) = named(before), named(after)
    old_hashes = {r.get('sha256') for r in before['objects']}
    new_hashes = {r.get('sha256') for r in after['objects']}
    removed = [v for k, v in old.items() if k not in new_names and v['sha256'] not in new_hashes]
    added = [v for k, v in new.items() if k not in old_names and v['sha256'] not in old_hashes]
    modified = [{'before': old[k], 'after': new[k]} for k in old.keys() & new.keys()
                if old[k]['sha256'] != new[k]['sha256']]
    return {'complete': True, 'removedCandidates': removed, 'addedCandidates': added,
            'modifiedCandidates': modified,
            'unmatchedBefore': len(before['objects']) - len(old),
            'unmatchedAfter': len(after['objects']) - len(new),
            'note': '对象名称只用于匹配候选；重命名、同名对象或跨包移动需核对原件。'}


def main():
    p = argparse.ArgumentParser()
    for name in ('input', 'output', 'name', 'context'):
        p.add_argument('--' + name, required=True)
    args = p.parse_args(); raw, output = Path(args.input), Path(args.output)
    context = json.loads(Path(args.context).read_bytes())
    report = {'previews': []}
    try:
        index = inventory(raw, args.name, context)
    except Exception as exc:
        index = {'complete': False, 'objects': [], 'error':
                 str(exc) if isinstance(exc, ArchiveError) else 'inventory_failed'}
    report['inventoryComplete'] = index['complete']
    # Preview limits never bound the independent inventory or raw retention.
    from .previews import convert
    try:
        report['previews'] = convert(raw, output, args.name, context=context)
    except Exception as exc:
        report['previewError'] = str(exc) if isinstance(exc, ArchiveError) else 'preview_failed'
    (output / 'inventory.json').write_bytes(canonical(index))
    (output / 'report.json').write_bytes(canonical(report))


if __name__ == '__main__':
    main()
