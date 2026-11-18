from copy import deepcopy
import json
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from backend.admin.app import create_admin
from backend.admin.publications import dispatch, publish_due


class AdminPublicationReviewTests(unittest.TestCase):
    def setUp(self):
        self.config = {'schemaVersion': 1, 'role': 'admin', 'port': 18080, 'origin': 'http://127.0.0.1:18080',
                       'auth': {'mode': 'proxy', 'proxyTokenEnv': 'ADMIN_TEST_PROXY', 'users': ['owner', 'reader']},
                       'publicationReview': {'repository': 'example/site', 'tokenEnv': 'ADMIN_TEST_GITHUB'},
                       'nodes': [{'id': 'content', 'url': 'http://127.0.0.1:18082', 'publishUsers': ['owner']}],
                       'sources': [], 'sites': []}
        self.headers = {'X-Admin-Proxy': 'p'*40, 'X-Admin-User': 'owner',
                        'Origin': self.config['origin'], 'X-OurNotes-Request': '1'}
        self.decision = {'region': 'global', 'publication': '123_1', 'revision': 2,
                         'action': 'publish', 'publishAt': None}
        self.state = {'profiles': [{'productionOwner': 'github-actions-r2', 'health': {
            'publicationReviews': {'status': 'ready', 'regions': {'global': {
                'publication': '123_1', 'revision': 2, 'status': 'pending'}}}}}]}
        self.send = Mock(return_value={'status': 'submitted'})
        self.secrets = patch.dict('os.environ', {'ADMIN_TEST_PROXY': 'p'*40, 'ADMIN_TEST_GITHUB': 'g'*40})
        self.secrets.start(); self.addCleanup(self.secrets.stop)

    def client(self, config=None):
        return TestClient(create_admin(config or self.config, transport=lambda *_: self.state,
                                       publication_dispatch=self.send), base_url=self.config['origin'])

    def test_existing_auth_and_exact_pending_revision_gate_dispatch(self):
        with self.client() as client:
            path = '/api/nodes/content/publication-review'
            self.assertEqual(client.post(path, json=self.decision).status_code, 401)
            self.assertEqual(client.post(path, json=self.decision, headers={**self.headers, 'X-Admin-User': 'reader'}).status_code, 403)
            self.assertEqual(client.post(path, json=self.decision, headers={**self.headers, 'Origin': 'https://other.invalid'}).status_code, 403)
            self.assertEqual(client.post(path, json={**self.decision, 'revision': 1}, headers=self.headers).status_code, 409)
            self.assertEqual(client.post(path, json={**self.decision, 'actor': 'owner'}, headers=self.headers).status_code, 400)
            self.send.assert_not_called()
            self.assertEqual(client.post(path, json=self.decision, headers=self.headers).json(), {'status': 'submitted'})
            self.send.assert_called_once_with(self.config['publicationReview'], self.decision)
            config = client.get('/api/config', headers=self.headers).json()
            self.assertTrue(config['publicationReview'])
            self.assertNotIn('tokenEnv', json.dumps(config))
            self.assertEqual(client.get('/assets/publication-review.mjs', headers=self.headers).status_code, 200)

    def test_preview_cannot_dispatch(self):
        config = deepcopy(self.config); config['auth'] = {'mode': 'preview'}
        with self.client(config) as client:
            self.assertEqual(client.post('/api/nodes/content/publication-review', json=self.decision,
                                         headers=self.headers).status_code, 403)
        self.send.assert_not_called()

    def test_dispatch_is_fixed_workflow_and_passes_only_decision_fields(self):
        response = Mock(status=204)
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        send = Mock(return_value=response)
        self.assertEqual(dispatch(self.config['publicationReview'], self.decision, send=send), {'status': 'submitted'})
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.github.com/repos/example/site/actions/workflows/retry-content-publication.yml/dispatches')
        self.assertEqual(json.loads(request.data), {'ref': 'main', 'inputs': {
            'region': 'global', 'publication': '123_1', 'mode': 'publish', 'revision': '2', 'publish_at': ''}})

    def test_timeout_is_not_reported_as_published_or_retried(self):
        self.send.side_effect = TimeoutError('private transport details')
        with self.client() as client:
            result = client.post('/api/nodes/content/publication-review', json=self.decision, headers=self.headers)
            self.assertEqual(result.status_code, 503)
            self.assertNotIn('private transport details', result.text)
            self.send.assert_called_once()

    def test_due_timer_uses_saved_time_and_revision_without_idle_dispatches(self):
        row = self.state['profiles'][0]['health']['publicationReviews']['regions']['global']
        row.update(status='scheduled', publishAt=200)
        attempts = {}
        tick = lambda now: publish_due(self.config, lambda *_: self.state, attempts, send=self.send, now=now)
        tick(199); self.send.assert_not_called()
        tick(200); tick(201); tick(799)
        self.send.assert_called_once_with(self.config['publicationReview'], self.decision)
        tick(800)
        self.send.assert_called_once()
        row.update(status='held', revision=3)
        tick(1400)
        self.send.assert_called_once()

    def test_due_timer_retries_unknown_transport_outcomes_after_ten_minutes(self):
        row = self.state['profiles'][0]['health']['publicationReviews']['regions']['global']
        row.update(status='scheduled', publishAt=200)
        self.send.side_effect = TimeoutError()
        attempts = {}
        with self.assertLogs('backend.admin.publications', level='WARNING'):
            for now in (200, 201, 799, 800):
                publish_due(self.config, lambda *_: self.state, attempts, send=self.send, now=now)
        self.assertEqual(self.send.call_count, 2)
