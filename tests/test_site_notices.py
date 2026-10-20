import copy
import json
import os
import tempfile
import stat
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.admin.app import create_admin
from backend.admin.config import load_config, validate_config
from backend.admin.node import create_node
from backend.admin.notices import Conflict, Notices, validate_notice


def notice(**changes):
    return {'kind': 'info', 'region': 'all', 'path': '/', 'title': '公告', 'body': '维护说明',
            'titleEn': '', 'bodyEn': '', 'href': '', 'startsAt': None, 'endsAt': None, **changes}


class NoticeStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Notices(self.tmp.name)
        self.identity = 'a' * 32

    def change(self, action, revision, **fields):
        return self.store.change('site', {'action': action, 'id': self.identity, 'expectedRevision': revision, **fields}, 'owner')

    def public(self):
        return json.loads((Path(self.tmp.name) / 'site/public.json').read_text())

    def test_drafts_publish_separately_and_withdraw_survives_restart(self):
        self.change('save', 0, notice=notice())
        self.assertFalse((Path(self.tmp.name) / 'site/public.json').exists())
        self.change('publish', 1)
        original = self.public()
        self.assertNotIn('updatedBy', json.dumps(original))
        self.change('save', 1, notice=notice(body='新的正文'))
        self.assertEqual(self.public(), original)
        rows = Notices(self.tmp.name).list('site')['notices']
        self.assertEqual(rows[0]['revision'], 2)
        self.assertEqual(rows[0]['published']['revision'], 1)
        with self.assertRaises(Conflict):
            self.change('withdraw', 2)
        self.change('withdraw', 1)
        self.assertEqual(self.public()['notices'], [])
        self.assertEqual(Notices(self.tmp.name).list('site')['notices'][0]['body'], '新的正文')

    def test_multiple_scopes_survive_save_publish_and_restart_without_touching_public_during_edit(self):
        value=notice()
        del value['path']
        value['paths']=['/recruitment/','/events/','/recruitment/']
        self.change('save',0,notice=value)
        self.change('publish',1)
        self.assertEqual(self.public()['notices'][0]['paths'],['/recruitment/','/events/'])
        original=self.public()
        self.change('save',1,notice={**value,'paths':['/music/']})
        self.assertEqual(self.public(),original)
        self.assertEqual(Notices(self.tmp.name).list('site')['notices'][0]['paths'],['/music/'])
        self.assertEqual(validate_notice({**value,'paths':['/events/','/']})['paths'],['/'])

    def test_legacy_single_path_draft_can_be_published_and_new_scopes_are_validated(self):
        self.change('save',0,notice=notice())
        path=Path(self.tmp.name)/'site/drafts.json'
        drafts=json.loads(path.read_text())
        drafts[self.identity].pop('paths')
        drafts[self.identity]['path']='/recruitment/'
        path.write_text(json.dumps(drafts))
        self.change('publish',1)
        self.assertEqual(self.public()['notices'][0]['paths'],['/recruitment/'])
        base=notice();base.pop('path')
        for paths in [[],None,'/events/',[''],['//evil/'],['/events?x/'],[['/events/']],['/events/']*33]:
            with self.subTest(paths=paths),self.assertRaises(ValueError):validate_notice({**base,'paths':paths})
        with self.assertRaises(ValueError):validate_notice({**base,'paths':['/events/'],'path':'/'})

    def test_unknown_save_retry_and_concurrent_edits(self):
        first = self.change('save', 0, notice=notice())
        self.assertEqual(self.change('save', 0, notice=notice()), first)
        with self.assertRaises(Conflict):
            self.change('save', 0, notice=notice(body='覆盖其他人的修改'))
        self.change('save', 1, notice=notice(body='新正文'))
        with self.assertRaises(Conflict):
            self.change('publish', 1)
        self.change('publish', 2)
        self.assertEqual(self.public()['notices'][0]['body'], '新正文')

    def test_failed_publish_keeps_previous_public_bytes_and_retry_is_safe(self):
        self.change('save', 0, notice=notice())
        self.change('publish', 1)
        path = Path(self.tmp.name) / 'site/public.json'
        previous = path.read_bytes()
        self.change('save', 1, notice=notice(body='新正文'))
        with patch('backend.admin.notices.os.replace', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                self.change('publish', 2)
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(list(path.parent.glob('.notice-*')), [])
        self.change('publish', 2)
        self.assertEqual(self.change('publish', 2)['notices'][0]['published']['revision'], 2)

    def test_publication_does_not_claim_success_when_directory_sync_fails(self):
        self.change('save',0,notice=notice())
        original=os.fsync
        def sync(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):raise OSError('directory sync failed')
            return original(descriptor)
        with patch('backend.admin.notices.os.fsync',side_effect=sync):
            with self.assertRaises(OSError):self.change('publish',1)
        # The replace may already have happened: reload, never assume rollback.
        self.assertEqual(self.store.list('site')['notices'][0]['published']['revision'],1)
        self.assertEqual(self.change('publish',1)['notices'][0]['published']['revision'],1)

    def test_cannot_delete_live_notice_but_can_reclaim_withdrawn_draft(self):
        self.change('save', 0, notice=notice())
        self.change('publish', 1)
        with self.assertRaises(Conflict):
            self.change('delete', 1)
        self.change('withdraw', 1)
        self.change('delete', 1)
        self.assertEqual(self.store.list('site'), {'notices': []})

    def test_validation_and_permissions_on_disk(self):
        for changed in [{'kind': []}, {'path': '//evil/'}, {'href': 'javascript:alert(1)'},
                        {'href': '/foo/?token=x'}, {'path': '/../'}, {'title': ''},
                        {'startsAt': float('nan')}, {'endsAt': True}, {'startsAt': 20, 'endsAt': 10}]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_notice(notice(**changed))
        self.change('save', 0, notice=notice())
        self.change('publish', 1)
        root = Path(self.tmp.name) / 'site'
        self.assertEqual((root / 'drafts.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / 'public.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(root.stat().st_mode & 0o777, 0o755)
        with self.assertRaises(ValueError):
            self.store.list('../private')


class NoticeHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = patch.dict(os.environ, {'NOTICE_READ': 'r'*40, 'NOTICE_WRITE': 'w'*40, 'NOTICE_PROXY': 'p'*40})
        env.start()
        self.addCleanup(env.stop)
        self.config = {'schemaVersion': 1, 'role': 'node', 'port': 18082, 'database': str(self.root/'jobs.sqlite'),
                       'readTokenEnv': 'NOTICE_READ', 'writeTokenEnv': 'NOTICE_WRITE', 'profiles': [],
                       'notices': {'directory': str(self.root/'notices'), 'sites': ['site'], 'publishUsers': ['owner']}}

    def test_node_tokens_actor_sites_and_invalid_requests(self):
        with TestClient(create_node(self.config)) as client:
            path = '/notices/site'
            read = {'Authorization': 'Bearer '+'r'*40}
            write = {'Authorization': 'Bearer '+'w'*40}
            content=notice();content.pop('path');content['paths']=['/recruitment/','/events/']
            payload = {'action': 'save', 'id': 'a'*32, 'expectedRevision': 0, 'notice': content, 'actor': 'owner'}
            self.assertEqual(client.get(path).status_code, 401)
            self.assertEqual(client.post(path, json=payload, headers=read).status_code, 401)
            self.assertEqual(client.post(path, json={**payload, 'actor': 'reader'}, headers=write).status_code, 403)
            self.assertEqual(client.post('/notices/other', json=payload, headers=write).status_code, 404)
            self.assertEqual(client.post(path, json={**payload, 'action': []}, headers=write).status_code, 400)
            self.assertEqual(client.post(path, json=payload, headers=write).status_code, 200)
            conflict = {**payload, 'notice': notice(body='stale')}
            self.assertEqual(client.post(path, json=conflict, headers=write).status_code, 409)
            self.assertEqual(client.get(path, headers=read).json()['notices'][0]['title'], '公告')
            self.assertEqual(client.get(path, headers=read).json()['notices'][0]['paths'], ['/recruitment/','/events/'])

    def test_maximum_unicode_notice_survives_loopback_ascii_encoding(self):
        with TestClient(create_node(self.config)) as client:
            payload = {'action': 'save', 'id': 'e'*32, 'expectedRevision': 0, 'actor': 'owner',
                       'notice': notice(title='😀'*120, titleEn='😀'*120, body='😀'*2000, bodyEn='😀'*2000)}
            response = client.post('/notices/site', content=json.dumps(payload).encode(),
                                   headers={'Authorization': 'Bearer '+'w'*40, 'Content-Type': 'application/json'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['notices'][0]['body'], payload['notice']['body'])

    def admin(self, mode='proxy'):
        return {'schemaVersion': 1, 'role': 'admin', 'port': 18080, 'origin': 'http://127.0.0.1:18080',
                'auth': {'mode': mode, 'users': ['owner', 'reader'], 'proxyTokenEnv': 'NOTICE_PROXY'},
                'sources': [{'id': 'stats', 'url': 'http://127.0.0.1:18081'}],
                'sites': [{'id': 'site', 'source': 'stats', 'nodes': ['node'], 'noticeNode': 'node'}],
                'nodes': [{'id': 'node', 'url': 'http://127.0.0.1:18082', 'readTokenEnv': 'NOTICE_READ',
                           'writeTokenEnv': 'NOTICE_WRITE', 'noticeUsers': ['owner']}]}

    def test_bff_checks_proxy_origin_and_actor_and_transports_only_fixed_path(self):
        calls = []
        def transport(node, path, payload=None, write=False):
            calls.append((path, payload, write))
            return {'notices': []}
        headers = {'x-admin-user': 'owner', 'x-admin-proxy': 'p'*40, 'Origin': 'http://127.0.0.1:18080', 'x-ournotes-request': '1'}
        with TestClient(create_admin(self.admin(), transport), base_url='http://127.0.0.1:18080') as client:
            self.assertEqual(client.post('/api/notices/site', json={}).status_code, 401)
            self.assertEqual(client.post('/api/notices/site', json={}, headers={**headers, 'Origin': 'https://evil.example'}).status_code, 403)
            self.assertEqual(client.post('/api/notices/site', json={}, headers={**headers, 'x-admin-user': 'reader'}).status_code, 403)
            self.assertEqual(client.post('/api/notices/site', json={'actor': 'other'}, headers=headers).status_code, 400)
            self.assertEqual(calls, [])
            self.assertEqual(client.get('/api/notices/site', headers=headers).json()['canWrite'], True)
            self.assertEqual(client.post('/api/notices/site', json={'action': 'publish'}, headers=headers).status_code, 200)
            self.assertEqual(calls[-1], ('/notices/site', {'action': 'publish', 'actor': 'owner'}, True))

    def test_preview_stays_read_only_and_config_paths_resolve(self):
        with TestClient(create_admin(self.admin('preview'), lambda *args: {'notices': []}), base_url='http://127.0.0.1:18080') as client:
            self.assertFalse(client.get('/api/notices/site').json()['canWrite'])
            self.assertEqual(client.post('/api/notices/site', json={}).status_code, 403)
        config = copy.deepcopy(self.config)
        config['notices']['directory'] = 'notices'
        path = self.root/'node.json'
        path.write_text(json.dumps(config))
        self.assertEqual(load_config(path)['notices']['directory'], str((self.root/'notices').resolve()))
        config['notices']['publishUsers'] = []
        with self.assertRaises(ValueError):
            validate_config(config)


if __name__ == '__main__':
    unittest.main()
