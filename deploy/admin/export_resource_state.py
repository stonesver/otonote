"""Copy only bounded workflow status into the node's read-only status directory."""
import hashlib
import json
import os
from pathlib import Path

SOURCE = Path('/srv/ournotes-updater/app/output/global-update-workflow/latest-run.json')
TARGET = Path('/var/lib/ournotes-resource-state/latest-run.json')


def export():
    with SOURCE.open('rb') as stream:
        raw = stream.read(1024 * 1024 + 1)
        stamp = os.fstat(stream.fileno()).st_mtime
    if len(raw) > 1024 * 1024:
        raise ValueError('state exceeds its size limit')
    source = json.loads(raw)
    data = {'status': source.get('status', 'unknown'),
            'steps': [{'name': str(s.get('name', ''))[:80], 'status': str(s.get('status', ''))[:30]}
                      for s in source.get('steps', [])[:40] if isinstance(s, dict)]}
    workspace = SOURCE.parent
    data['inputsReady'] = (workspace/'manual-inputs.json').is_file()
    current = Path('/srv/ournotes-updater/content/current.json')
    pointer_bytes = current.read_bytes() if current.exists() else b''
    pointer = json.loads(pointer_bytes) if pointer_bytes else {}
    data['currentRelease'] = str(pointer.get('contentReleaseId', ''))[:200]
    staged = workspace/'manual-candidate.json'
    if staged.exists() and staged.stat().st_size < 1024*1024:
        candidate = json.loads(staged.read_text())
        data['candidate'] = {'id': str(candidate.get('id', ''))[:64],
                             'contentReleaseId': str(candidate.get('contentReleaseId', ''))[:200],
                             'stale': candidate.get('publicationBaseline') != (hashlib.sha256(pointer_bytes).hexdigest() if pointer_bytes else None)}
    if data['status'] not in ('running', 'passed', 'failed'):
        data['status'] = 'unknown'
    temporary = TARGET.with_suffix('.next')
    temporary.write_text(json.dumps(data, ensure_ascii=False))
    temporary.chmod(0o644)
    os.utime(str(temporary), (stamp, stamp))
    os.replace(str(temporary), str(TARGET))


if __name__ == '__main__':
    export()
