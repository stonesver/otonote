import os
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.admin.app import create_admin
from backend.update_archive.store import ArchiveRepository, LocalBucket


class AdminArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.repo = ArchiveRepository(LocalBucket(self.tmp.name))
        self.config = {'schemaVersion': 1, 'role': 'admin', 'port': 18080,
                       'origin': 'http://127.0.0.1:18080', 'auth': {'mode': 'preview'}, 'sites': []}

    def test_existing_admin_starts_without_archive_configuration_and_sdk(self):
        with TestClient(create_admin(self.config), base_url=self.config['origin']) as client:
            self.assertEqual(client.get('/api/archive/summary').json()['status'], 'disabled')
            self.assertEqual(client.get('/api/config').status_code, 200)

    def test_authenticated_preview_reads_archives_but_cannot_queue_cleanup(self):
        import time
        now = time.time()
        eid = self.repo.add('global', 'note.txt', b'hello', observed_at=now, now=now)
        with TestClient(create_admin(self.config, archive_repo=self.repo), base_url=self.config['origin']) as client:
            self.assertEqual(client.get('/api/archive/summary').json()['storedBytes'], 5)
            response = client.get('/api/archive/files/' + eid, headers={'Range': 'bytes=1-3'})
            self.assertEqual((response.status_code, response.content), (206, b'ell'))
            self.assertEqual(client.post('/api/archive/cleanup/plans', json={'entries': [eid]}).status_code, 403)

    def writer(self):
        self.config['auth'] = {'mode': 'proxy', 'proxyTokenEnv': 'OURNOTES_TEST_ARCHIVE_TOKEN', 'users': ['owner']}
        import secrets
        self.token = secrets.token_hex(24)
        self.env = patch.dict(os.environ, {'OURNOTES_TEST_ARCHIVE_TOKEN': self.token})
        self.env.start(); self.addCleanup(self.env.stop)
        return TestClient(create_admin(self.config, archive_repo=self.repo), base_url=self.config['origin'],
                          headers={'x-admin-proxy': self.token, 'x-admin-user': 'owner',
                                   'Origin': self.config['origin'], 'X-OurNotes-Request': '1'})

    def test_authenticated_manual_cleanup_queues_then_worker_executes(self):
        import time
        from backend.update_archive.requests import process_cleanups
        now = time.time()
        eid = self.repo.add('jp', 'sample.txt', b'hello', observed_at=now, now=now)
        with self.writer() as client:
            p = client.post('/api/archive/cleanup/plans', json={'scope': 'all'}).json()
            self.assertEqual(p['estimatedBytes'], 5)
            self.assertEqual(self.repo.content(eid), b'hello')
            self.assertEqual(client.post('/api/archive/cleanup/'+p['id']+'/confirm', json={'digest': 'wrong'}).status_code, 409)
            self.assertEqual(client.post('/api/archive/cleanup/'+p['id']+'/confirm', json={'digest': p['digest']}).status_code, 200)
            process_cleanups(self.repo, now=now+1)
            self.assertEqual(client.get('/api/archive/files/'+eid).status_code, 410)
            self.assertEqual(client.get('/api/archive/requests').json()['cleanup'][0]['releasedBytes'], 5)

    def test_all_archive_paths_reuse_authentication_and_mutation_origin_check(self):
        with self.writer() as client:
            for path in ('summary', 'entries', 'requests', 'files/'+'a'*64):
                self.assertEqual(client.get('/api/archive/'+path, headers={'x-admin-proxy':'wrong'}).status_code, 401)
            self.assertEqual(client.post('/api/archive/mode', headers={'Origin': 'https://wrong.example'},
                                         json={'region':'global','mode':'record','revision':0}).status_code, 403)

    def test_invalid_range_and_head_are_bounded_and_release_read_leases(self):
        import time
        now = time.time(); eid = self.repo.add('global', 'a', b'hello', observed_at=now, now=now)
        with self.writer() as client:
            url = '/api/archive/files/'+eid
            self.assertEqual(client.head(url).headers['content-length'], '5')
            self.assertEqual(client.get(url, headers={'Range':'bytes=-2'}).content, b'lo')
            for value in ('bytes=9-10', 'bytes=3-1', 'bytes=1-2,3-4', 'nonsense'):
                self.assertEqual(client.get(url, headers={'Range':value}).status_code, 416)
            self.assertEqual(self.repo.state()[0]['leases'], {})

    def test_text_is_data_and_unsafe_raw_is_always_attachment(self):
        import time
        from pathlib import Path
        from backend.update_archive.previews import generate
        now = time.time(); eid = self.repo.add('global', 'sample.js', b'<script>alert(1)</script>', observed_at=now, now=now)
        generate(self.repo, self.repo.entry(eid))
        pid = next(k for k in self.repo.entry(eid)['previews'] if k.startswith('preview_'))
        with self.writer() as client:
            r = client.get('/api/archive/files/'+eid)
            self.assertIn('attachment', r.headers['content-disposition'])
            self.assertEqual(client.get('/api/archive/text/'+eid+'/'+pid).json()['text'], '<script>alert(1)</script>')
            self.assertEqual(client.get('/api/archive/diff/'+eid+'/'+pid+'/'+eid+'/'+pid).json()['diff'], '')

    def test_broken_archive_configuration_does_not_break_old_modules(self):
        for bad in (None, [], {'schemaVersion':1,'enabled':True,'storage':None}):
            self.config['archive'] = bad
            with TestClient(create_admin(self.config), base_url=self.config['origin'], raise_server_exceptions=False) as client:
                self.assertEqual(client.get('/api/config').status_code, 200)
                self.assertEqual(client.get('/assets/admin.mjs').status_code, 200)
                self.assertIn(client.get('/api/archive/summary').status_code, (200,503))
