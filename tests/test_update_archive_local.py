import errno
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.update_archive.models import ArchiveError, CONTROL_RESERVE, canonical, digest
from backend.update_archive.store import ArchiveRepository, LocalBucket, LEDGER
from backend.update_archive.worker import run_once
from backend.update_archive.local import Library


class Source:
    region = 'global'
    payload = None
    def snapshot(self, previous=None):
        files = [] if self.payload is None else [{'source': 'remote_asset', 'key': 'note.txt',
            'size': len(self.payload), 'sha256': digest(self.payload)}]
        return {'region': self.region, 'sources': ['remote_asset'], 'files': files,
                'observation': {'clientVersion': '1.0.1'}}
    def fetch(self, row, target):
        target.write_bytes(self.payload)


class LocalHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = ArchiveRepository(LocalBucket(self.root / 'cloud'), capacity=CONTROL_RESERVE + 8)
        self.local = Library(self.root / 'local')
        self.source = Source()
        run_once(self.repo, self.source, clock=lambda: 100)

    def observe(self, payload, now):
        self.source.payload = payload
        result = run_once(self.repo, self.source, clock=lambda: now)
        self.assertNotEqual(result['status'], 'failed', result)
        return self.repo.entries('global')[0]

    def test_offline_a_b_removed_then_fifo_keeps_local_history_and_pre_removal_bytes(self):
        a = self.observe(b'old', 101)
        b = self.observe(b'new', 102)
        removed = self.observe(None, 103)
        self.assertEqual(removed['previousEntryId'], b['id'])
        self.assertEqual(b['previousEntryId'], a['id'])
        # No writes, leases, or receipt requirements during local reception.
        with patch.object(self.repo, 'mutate', side_effect=AssertionError('read-only sync')):
            self.assertEqual(self.local.sync(self.repo)['received'], 2)
        self.repo.add('jp', 'pressure', b'12345678', observed_at=104, now=104)
        self.repo.compact(now=10**12)
        self.local.sync(self.repo)
        detail = self.local.detail(removed['id'])
        self.assertTrue(detail['localAvailable'])
        self.assertEqual(self.local.object_path(detail['original']['sha256']).read_bytes(), b'new')
        self.assertEqual(len(detail['versions']), 3)
        self.assertEqual(self.repo.entry(b['id'])['status'], 'evicted_fifo')
        self.assertEqual(self.local.sync(self.repo)['received'], 0)

    def test_missing_original_after_fifo_remains_an_explicit_history_gap(self):
        old = self.observe(b'old', 101)
        removed = self.observe(None, 102)
        self.repo.add('jp', 'pressure', b'12345678', observed_at=103, now=103)
        self.local.sync(self.repo)
        d = self.local.detail(removed['id'])
        self.assertFalse(d['localAvailable'])
        self.assertEqual(d['original']['id'], old['id'])
        with self.assertRaisesRegex(ArchiveError, 'historical_original_missing'):
            self.local.analyze(removed['id'])

    def test_uncaptured_modified_version_never_falls_back_to_older_local_bytes(self):
        a = self.observe(b'old', 101)
        self.local.sync(self.repo)
        self.source.payload = b'new'
        run_once(self.repo, self.source, clock=lambda: 102, mode='manual')
        b = self.repo.entries('global')[0]
        removed = self.observe(None, 103)
        self.local.sync(self.repo)
        self.assertTrue(self.local.detail(a['id'])['localAvailable'])
        self.assertFalse(self.local.detail(b['id'])['localAvailable'])
        self.assertFalse(self.local.detail(removed['id'])['localAvailable'])

    def test_fifo_evicts_every_alias_of_oldest_object_even_if_new_alias_is_recent(self):
        a = self.repo.add('global', 'a', b'old', now=101, observed_at=101)
        b = self.repo.add('jp', 'b', b'new', now=102, observed_at=102)
        c = self.repo.add('global', 'c', b'old', now=103, observed_at=103)
        self.repo.add('jp', 'd', b'12345', now=104, observed_at=104)
        self.assertEqual(self.repo.entry(a)['status'], 'evicted_fifo')
        self.assertEqual(self.repo.entry(c)['status'], 'evicted_fifo')
        self.assertEqual(self.repo.entry(b)['status'], 'saved')

    def test_resume_checks_digest_and_never_acknowledges_corrupt_content(self):
        entry = self.observe(b'abcdef', 101)
        state, _ = self.repo.state(); obj = state['objects'][entry['objectKey']]
        from backend.update_archive.models import identity
        partial = self.local.root / 'partial' / identity([entry['objectKey'], obj['sha256'], obj['size']])
        partial.write_bytes(b'abc')
        with patch.object(self.repo.bucket, 'open_at', wraps=self.repo.bucket.open_at) as opener:
            self.local.sync(self.repo)
            self.assertEqual(opener.call_args.args[1], 3)
        self.assertTrue(self.local.has(entry['sha256']))
        other = Library(self.root / 'other')
        self.repo.bucket.path(entry['objectKey']).write_bytes(b'xxxxxx')
        self.assertEqual(other.sync(self.repo)['unavailable'], 1)
        self.assertFalse(other.has(entry['sha256']))

    def test_disk_full_stops_without_deleting_local_history_or_claiming_receipt(self):
        self.observe(b'abc', 101)
        with patch.object(self.local, 'receive', side_effect=OSError(errno.ENOSPC, 'disk full')):
            with self.assertRaisesRegex(ArchiveError, 'local_disk_full'):
                self.local.sync(self.repo)
        self.assertEqual(len(self.local.entries()), 1)

    def test_version_one_upgrade_keeps_deleted_status_and_does_not_expire_live_bytes(self):
        entry = self.observe(b'abc', 101)
        state, etag = self.repo.state()
        state['schemaVersion'] = 1
        state['entries'][entry['id']]['expiresAt'] = 1
        for obj in state['objects'].values():
            obj.pop('storedAt', None)
        self.repo.bucket.replace(LEDGER, canonical(state), etag)
        self.assertEqual(self.repo.content(entry['id'], now=10**12), b'abc')
        self.repo.compact(now=10**12)
        self.assertEqual(self.repo.state()[0]['schemaVersion'], 2)

    def test_local_analysis_removed_view_and_loopback_security(self):
        from fastapi.testclient import TestClient
        from backend.update_archive.local_web import create_app
        a = self.observe(b'old', 101)
        b = self.observe(b'new', 102)
        removed = self.observe(None, 103)
        self.local.sync(self.repo)
        self.local.analyze(a['id'])
        self.local.analyze(removed['id'])
        with TestClient(create_app(self.local), base_url='http://127.0.0.1:18087') as client:
            self.assertEqual(client.get('/api/entries').status_code, 403)
            self.assertEqual(client.get('/').status_code, 200)
            self.assertEqual(client.get('/api/entries/'+removed['id']+'/raw').content, b'new')
            diff = client.get('/api/compare/'+a['id']+'/'+b['id']).json()
            self.assertIn('-old', diff['textDiff']); self.assertIn('+new', diff['textDiff'])
            self.assertEqual(client.get('/api/entries', headers={'Host': 'evil.example'}).status_code, 403)
            self.assertEqual(client.post('/api/entries/'+a['id']+'/analyze').status_code, 403)

    def test_incomplete_object_index_cannot_report_removals(self):
        from backend.update_archive.local_analysis import compare
        result = compare({'complete': True, 'objects': []}, {'complete': False, 'objects': []})
        self.assertFalse(result['complete'])
        self.assertNotIn('removedCandidates', result)

    def test_sync_automatically_analyzes_and_reuses_completed_removal_result(self):
        old = self.observe(b'old', 101)
        removed = self.observe(None, 102)
        result = self.local.sync_and_analyze(self.repo)
        self.assertEqual(result['analysis']['complete'], 1)
        report = self.local.detail(removed['id'])['analysis']
        self.assertTrue(report['inventoryComplete'])
        self.assertEqual(report['entryId'], old['id'])
        with patch.object(self.local, 'entries', side_effect=AssertionError('no full index for thumbnails')):
            self.assertEqual(self.local.preview_report(removed['id']), report)
        with patch.object(self.local, '_analyze_original', side_effect=AssertionError('already complete')):
            self.assertEqual(self.local.sync_and_analyze(self.repo)['analysis']['complete'], 0)
        self.assertEqual(self.local.detail(old['id'])['analysis']['directory'], report['directory'])

    def test_auto_analysis_isolates_failures_and_retries_after_cooldown(self):
        old = self.observe(b'old', 101)
        new = self.observe(b'new', 102)
        self.local.sync(self.repo)
        real = self.local._analyze_original
        def analyze(entry):
            if entry['id'] == old['id']:
                raise ArchiveError('local_analysis_timeout')
            return real(entry)
        with patch.object(self.local, '_analyze_original', side_effect=analyze):
            result = self.local.analyze_pending()
        self.assertEqual((result['failed'], result['complete']), (1, 1))
        with patch.object(self.local, '_analyze_original', side_effect=AssertionError('cooldown')):
            self.assertEqual(self.local.analyze_pending()['failed'], 0)
        jobs = self.local.analysis_records()[1]
        self.local.save_analysis_job(old['id'], {**jobs[old['id']], 'retryAt': 0})
        self.assertEqual(self.local.analyze_pending()['complete'], 1)
        self.assertEqual(self.local.detail(new['id'])['analysisJob']['status'], 'complete')

    def test_partial_analysis_retries_when_decoder_material_arrives(self):
        entry = self.observe(b'old', 101)
        self.local.sync(self.repo)
        entry['previews'] = {'context_metadata': {'sha256': digest(b'meta')}}
        with self.local.connect() as db:
            db.execute('UPDATE entries SET body=? WHERE id=?', (json.dumps(entry), entry['id']))
        partial = {'inventoryComplete': False, 'previews': [], 'previewError': 'decoder_context_missing'}
        with patch.object(self.local, '_analyze_original', return_value=partial) as analyze:
            self.assertEqual(self.local.analyze_pending()['partial'], 1)
            self.local.analyze_pending()
            self.assertEqual(analyze.call_count, 1)
            sha = digest(b'meta'); self.local.object_path(sha).write_bytes(b'meta')
            with self.local.connect() as db:
                db.execute('INSERT INTO objects VALUES (?,?,?)', (sha, 4, 103))
            self.local.analyze_pending()
            self.assertEqual(analyze.call_count, 2)

    def test_auto_analysis_defers_budget_and_busy_writer_then_recovers_interrupted_job(self):
        entry = self.observe(b'old', 101)
        self.local.sync(self.repo)
        self.assertEqual(self.local.analyze_pending(max_seconds=0)['deferred'], 1)
        with self.local.writing():
            self.assertEqual(self.local.analyze_pending()['deferred'], 1)
        self.local.save_analysis_job(entry['id'], {'status': 'running',
                                    'signature': self.local.analysis_signature(entry)})
        self.assertEqual(self.local.analyze_pending()['complete'], 1)

    def test_local_list_filters_by_retained_bytes_including_removal_aliases(self):
        from fastapi.testclient import TestClient
        from backend.update_archive.local_web import create_app
        a = self.observe(b'old', 101)
        removed = self.observe(None, 102)
        self.local.sync(self.repo)
        self.source.payload = b'new'
        run_once(self.repo, self.source, clock=lambda: 103, mode='manual')
        missing = self.repo.entries('global')[0]
        self.repo.add('jp', 'pressure', b'12345678', observed_at=104, now=104)
        self.local.sync(self.repo)
        with TestClient(create_app(self.local), base_url='http://127.0.0.1:18087') as client:
            client.get('/')
            rows = client.get('/api/entries?region=global').json()
            self.assertEqual({e['id'] for e in rows['entries']}, {a['id'], removed['id']})
            self.assertTrue(all(e['localAvailable'] for e in rows['entries']))
            self.assertEqual(client.get('/api/entries?region=global&removed=true').json()['total'], 1)
            all_rows = client.get('/api/entries?local=false&region=global').json()
            self.assertEqual(all_rows['total'], 3)
            self.assertFalse(next(e for e in all_rows['entries'] if e['id'] == missing['id'])['localAvailable'])
            self.assertEqual(client.get('/api/entries?query=absent').json()['total'], 0)
            self.assertEqual(client.get('/api/entries?region=global&offset=1').json()['total'], 2)
            self.local.object_path(a['sha256']).unlink()
            self.assertEqual(client.get('/api/entries?region=global').json()['total'], 0)

    def test_context_is_captured_without_cloud_preview_and_retries_after_budget_deferral(self):
        repo = ArchiveRepository(LocalBucket(self.root / 'context-cloud'))
        source = Source()
        material = self.root / 'metadata.dat'; material.write_bytes(b'context')
        source.context = {'metadata': str(material), 'clientVersion': '1.0.1',
                          'region': 'global', 'profile': {'synthetic': True}}
        run_once(repo, source, clock=lambda: 100)
        source.payload = b'new'
        run_once(repo, source, clock=lambda: 101, max_bytes=6)
        entry = repo.entries('global')[0]
        self.assertEqual(entry['status'], 'saved')
        self.assertNotIn('decoderContext', entry)
        run_once(repo, source, clock=lambda: 102)
        entry = repo.entry(entry['id'])
        self.assertTrue(entry['decoderContext'])
        self.assertFalse(any(k.startswith('preview_') for k in entry['previews']))
        local = Library(self.root / 'context-local')
        local.sync(repo)
        self.assertTrue(local.has(entry['previews']['context_metadata']['sha256']))

    def test_oversized_object_does_not_destroy_existing_fifo_content(self):
        entry = self.observe(b'old', 101)
        with self.assertRaisesRegex(ArchiveError, 'single_item_cannot_fit'):
            self.repo.add('jp', 'huge', b'0123456789', now=102, observed_at=102)
        self.assertEqual(self.repo.content(entry['id']), b'old')

    def test_legacy_baseline_becomes_selectable_without_upstream_change(self):
        state = self.repo.empty(); state['schemaVersion'] = 1
        state['baselines']['global:remote_asset'] = {'id': 'baseline', 'observedAt': 100,
            'observation': {'clientVersion': '1.0.1'},
            'files': [{'source': 'remote_asset', 'key': 'unchanged', 'size': 3, 'sha256': digest(b'old')}]}
        _, etag = self.repo.state()
        self.repo.bucket.replace(LEDGER, canonical(state), etag)
        entry = self.repo.entries('global')[0]
        self.assertTrue(entry['baseline'])
        self.assertEqual(entry['status'], 'waiting_manual')
        self.assertEqual(self.repo.state()[0]['batches'][entry['batch']]['observation']['clientVersion'], '1.0.1')

    def test_duplicate_object_names_are_not_treated_as_confirmed_removals(self):
        from backend.update_archive.local_analysis import compare
        a = {'type': 'TextAsset', 'name': 'same', 'sha256': digest(b'a')}
        b = {**a, 'sha256': digest(b'b')}
        result = compare({'complete': True, 'objects': [a]}, {'complete': True, 'objects': [b, b]})
        self.assertEqual(result['removedCandidates'], [])
        self.assertEqual(result['unmatchedAfter'], 2)

    def test_repeated_version_transition_is_not_deduplicated_as_an_old_event(self):
        self.observe(b'old', 101)
        self.observe(b'new', 102)
        self.observe(b'old', 103)
        self.observe(b'new', 104)
        self.assertEqual(len(self.repo.entries('global')), 4)

    def test_sync_orders_oldest_objects_before_newer_ones(self):
        a = self.observe(b'old', 101); b = self.observe(b'new', 102)
        received = []
        receive = self.local.receive
        def record(bucket, key, obj):
            received.append(obj['sha256'])
            return receive(bucket, key, obj)
        with patch.object(self.local, 'receive', side_effect=record):
            self.local.sync(self.repo)
        self.assertEqual(received, [a['sha256'], b['sha256']])
