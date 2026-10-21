"""Private, unlimited local history. Cloud access is GET-only, never a retention lease."""
from __future__ import annotations
import argparse
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

from .models import ArchiveError, canonical, identity
from .store import file_digest
from .history import content_entry


class Library:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ('objects', 'partial', 'analysis'):
            (self.root / name).mkdir(exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS objects(sha TEXT PRIMARY KEY, size INTEGER NOT NULL, received REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS analysis(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS analysis_jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.root / 'history.sqlite3', timeout=30)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextlib.contextmanager
    def writing(self):
        with (self.root / '.sync.lock').open('a+b') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ArchiveError('local_library_busy') from None
            yield

    def object_path(self, sha):
        if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha):
            raise ArchiveError('invalid_local_digest')
        return self.root / 'objects' / sha

    def entries(self):
        with self.connect() as db:
            return {row[0]: json.loads(row[1]) for row in db.execute('SELECT id, body FROM entries')}

    def has(self, sha):
        if not sha:
            return False
        with self.connect() as db:
            row = db.execute('SELECT size FROM objects WHERE sha=?', (sha,)).fetchone()
        path = self.object_path(sha)
        return bool(row and path.is_file() and path.stat().st_size == row[0])

    def receive(self, bucket, key, obj):
        """Resume only the same immutable object; acknowledge after hash + fsync."""
        sha, size = obj['sha256'], obj['size']
        target = self.object_path(sha)
        if self.has(sha) and file_digest(target) == sha:
            return False
        partial = self.root / 'partial' / identity([key, sha, size])
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > size:
            partial.unlink(); offset = 0
        if offset < size or not partial.exists():
            with contextlib.closing(bucket.open_at(key, offset)) as source, partial.open('ab') as out:
                count = offset
                while chunk := source.read(min(1024 * 1024, size - count + 1)):
                    count += len(chunk)
                    if count > size:
                        raise ArchiveError('object_size_mismatch')
                    out.write(chunk)
                out.flush(); os.fsync(out.fileno())
            if count != size:
                raise ArchiveError('object_size_mismatch')
        if file_digest(partial) != sha:
            partial.unlink()
            raise ArchiveError('object_digest_mismatch')
        os.replace(partial, target)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO objects VALUES (?,?,?)', (sha, size, time.time()))
        return True

    def sync(self, repo):
        with self.writing():
            state, _ = repo.state()
            result = {'received': 0, 'reused': 0, 'unavailable': 0, 'errors': []}
            # Merge, never mirror-delete: local history survives all cloud pruning.
            with self.connect() as db:
                for table in ('entries', 'batches', 'groups'):
                    for key, body in state[table].items():
                        old = db.execute(f'SELECT body FROM {table} WHERE id=?', (key,)).fetchone()
                        if old and table == 'entries':
                            body = {**json.loads(old[0]), **body}
                        db.execute(f'INSERT OR REPLACE INTO {table} VALUES (?,?)',
                                   (key, json.dumps(body)))
                db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',
                           ('lastSync', str(time.time())))
            # Follow actual raw-object FIFO, with decoder inputs immediately before
            # their raw object. No cloud writes, receipts, or read leases.
            pending, seen = [], set()
            raws = sorted(((k, o) for k, o in state['objects'].items()
                           if o['status'] == 'live' and o.get('role', 'raw') == 'raw'),
                          key=lambda item: (item[1]['storedAt'], item[0]))
            for key, obj in raws:
                for eid in obj['refs']:
                    for role, item in state['entries'].get(eid, {}).get('previews', {}).items():
                        if role.startswith('context_'):
                            context_obj = state['objects'].get(item['key'])
                            if context_obj and context_obj['status'] == 'live':
                                pending.append((item['key'], context_obj))
                pending.append((key, obj))
            for key, obj in pending:
                if key in seen:
                    continue
                seen.add(key)
                try:
                    result['received' if self.receive(repo.bucket, key, obj) else 'reused'] += 1
                except (ArchiveError, OSError) as exc:
                    if isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, errno.EDQUOT):
                        raise ArchiveError('local_disk_full') from None
                    result['unavailable'] += 1
                    result['errors'].append({'sha256': obj['sha256'], 'error':
                        str(exc) if isinstance(exc, ArchiveError) else 'local_or_remote_io_failed'})
            return result

    def detail(self, eid):
        entries = self.entries()
        entry = entries.get(eid)
        if not entry:
            raise ArchiveError('entry_not_found')
        original = content_entry(entries, entry)
        with self.connect() as db:
            row = db.execute('SELECT body FROM analysis WHERE id=?',
                             (original['id'] if original else eid,)).fetchone()
        versions = sorted((e for e in entries.values() if
                           (e['region'], e['source'], e['key']) ==
                           (entry['region'], entry['source'], entry['key'])),
                          key=lambda e: (e['observedAt'], e['id']), reverse=True)
        return {'entry': entry, 'original': original,
                'localAvailable': bool(original and self.has(original.get('sha256'))),
                'versions': versions, 'analysis': json.loads(row[0]) if row else None,
                'analysisJob': self.analysis_records()[1].get(original['id'] if original else eid)}

    def analysis_records(self):
        with self.connect() as db:
            reports = {r[0]: json.loads(r[1]) for r in db.execute('SELECT id, body FROM analysis')}
            jobs = {r[0]: json.loads(r[1]) for r in db.execute('SELECT id, body FROM analysis_jobs')}
        return reports, jobs

    def preview_report(self, eid):
        # Thumbnail requests read only their version chain, not the entire index.
        chain, current = {}, eid
        with self.connect() as db:
            while current and current not in chain:
                row = db.execute('SELECT body FROM entries WHERE id=?', (current,)).fetchone()
                if not row:
                    break
                entry = json.loads(row[0]); chain[current] = entry
                if entry.get('sha256') or entry.get('change') not in ('removed', 'metadata_changed'):
                    break
                current = entry.get('previousEntryId')
            if eid not in chain:
                raise ArchiveError('entry_not_found')
            original = content_entry(chain, chain[eid])
            row = db.execute('SELECT body FROM analysis WHERE id=?',
                             (original['id'] if original else eid,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def analysis_status(report, job):
        if job:
            return job['status']
        if report:
            return 'complete' if report.get('inventoryComplete') and not report.get('previewError') else 'partial'
        return 'pending'

    def analysis_signature(self, entry):
        materials = entry.get('previews', {})
        return identity([entry.get('sha256'), [(role, item.get('sha256'), self.has(item.get('sha256')))
                         for role, item in sorted(materials.items()) if role.startswith('context_')]])

    def save_analysis_job(self, eid, body):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO analysis_jobs VALUES (?,?)', (eid, json.dumps(body)))

    def analysis_due(self, entry, report, job, now):
        if not job:
            return not report or self.analysis_status(report, None) != 'complete'
        if job.get('signature') != self.analysis_signature(entry):
            return True
        # A running record with no writer lock means its process was interrupted.
        return job['status'] == 'running' or (job['status'] == 'failed' and now >= job.get('retryAt', 0))

    def analyze_pending(self, max_seconds=600):
        deadline = time.monotonic() + max_seconds
        result = {'complete': 0, 'partial': 0, 'failed': 0, 'deferred': 0, 'errors': []}
        reports, jobs = self.analysis_records()
        # One snapshot, one candidate per version; removal aliases share its result.
        candidates = [e for e in self.entries().values() if e.get('sha256') and self.has(e['sha256'])
                      and self.analysis_due(e, reports.get(e['id']), jobs.get(e['id']), time.time())]
        candidates.sort(key=lambda e: (e['observedAt'], e['id']))
        for i, entry in enumerate(candidates):
            if time.monotonic() >= deadline:
                result['deferred'] = len(candidates) - i
                break
            try:
                report = self.analyze(entry['id'], only_pending=True)
                if report is not None:
                    result[self.analysis_status(report, None)] += 1
            except ArchiveError as exc:
                if str(exc) in ('local_library_busy', 'local_disk_full'):
                    result['deferred'] = len(candidates) - i
                    result['errors'].append({'error': str(exc)})
                    break
                result['failed'] += 1
                result['errors'].append({'entryId': entry['id'], 'error': str(exc)})
        return result

    def sync_and_analyze(self, repo):
        result = self.sync(repo)
        result['analysis'] = self.analyze_pending()
        return result

    def analyze(self, eid, *, only_pending=False):
        with self.writing():
            detail = self.detail(eid)
            entry = detail['original']
            if not entry or not detail['localAvailable']:
                raise ArchiveError('historical_original_missing')
            reports, jobs = self.analysis_records()
            if only_pending and not self.analysis_due(entry, reports.get(entry['id']), jobs.get(entry['id']), time.time()):
                return None
            job = {'status': 'running', 'signature': self.analysis_signature(entry), 'updatedAt': time.time()}
            self.save_analysis_job(entry['id'], job)
            try:
                report = self._analyze_original(entry)
            except Exception as exc:
                error = str(exc) if isinstance(exc, ArchiveError) else 'local_analysis_failed'
                if isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, errno.EDQUOT):
                    error = 'local_disk_full'
                self.save_analysis_job(entry['id'], {**job, 'status': 'failed', 'error': error,
                                       'updatedAt': time.time(), 'retryAt': time.time() + 3600})
                raise ArchiveError(error) from None
            self.save_analysis_job(entry['id'], {**job, 'status': self.analysis_status(report, None),
                                   'updatedAt': time.time()})
            return report

    def _analyze_original(self, entry):
        raw = self.object_path(entry['sha256'])
        if file_digest(raw) != entry['sha256']:
            raise ArchiveError('local_original_corrupt')
        context = None
        materials = entry.get('previews', {})
        meta, profile = materials.get('context_metadata'), materials.get('context_profile')
        if meta and profile and self.has(meta['sha256']) and self.has(profile['sha256']):
            if any(file_digest(self.object_path(item['sha256'])) != item['sha256']
                   for item in (meta, profile)):
                raise ArchiveError('local_context_corrupt')
            context = json.loads(self.object_path(profile['sha256']).read_bytes())
            context['metadata'] = str(self.object_path(meta['sha256']))
        # Each completed analysis is immutable. Parser failure cannot erase a
        # previous useful result; raw bytes are never rewritten by analysis.
        with tempfile.TemporaryDirectory(dir=self.root / 'analysis', prefix='work-') as folder:
            work = Path(folder); output = work / 'output'; output.mkdir()
            config = work / 'context.json'; config.write_bytes(canonical(context))
            command = [sys.executable, '-m', 'backend.update_archive.local_analysis',
                       '--input', str(raw), '--output', str(output), '--name', entry['key'],
                       '--context', str(config)]
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'TMPDIR',
                   'OURNOTES_CRI_KEY', 'OURNOTES_MASTER_SALT_HEX', 'OURNOTES_MASTER_KEY_HEX',
                   'OURNOTES_MASTER_IV_HEX', 'PYTHONPYCACHEPREFIX')}
            try:
                done = subprocess.run(command, env=env, capture_output=True, timeout=300)
                if done.returncode:
                    raise ArchiveError('local_analysis_failed')
                report = json.loads((output / 'report.json').read_bytes())
                generation = identity([entry['id'], time.time_ns()])
                os.replace(output, self.root / 'analysis' / generation)
                report.update(directory=generation, entryId=entry['id'])
                with self.connect() as db:
                    db.execute('INSERT OR REPLACE INTO analysis VALUES (?,?)',
                               (entry['id'], json.dumps(report)))
                return report
            except subprocess.TimeoutExpired:
                raise ArchiveError('local_analysis_timeout') from None


def main():
    parser = argparse.ArgumentParser(description='本地更新历史库：R2 只读同步、永久留存和分析')
    parser.add_argument('--root', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    sync = sub.add_parser('sync'); sync.add_argument('--config', required=True)
    analyze = sub.add_parser('analyze'); analyze.add_argument('--entry', required=True)
    serve = sub.add_parser('serve'); serve.add_argument('--port', type=int, default=18087)
    args = parser.parse_args(); library = Library(args.root)
    if args.command == 'sync':
        from .config import load_config, repository
        repo = repository(load_config(args.config))
        if repo is None:
            raise ArchiveError('archive_disabled')
        result = library.sync_and_analyze(repo)
    elif args.command == 'analyze':
        result = library.analyze(args.entry)
    else:
        from .local_web import serve
        serve(library, args.port)
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
