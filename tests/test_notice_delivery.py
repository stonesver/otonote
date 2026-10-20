"""Exercise the real BFF HTTP transport, node application and public file route."""
import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import uvicorn
from fastapi.testclient import TestClient

from backend.admin.app import create_admin
from backend.admin.node import create_node
from tools.preview_independent_site import handler


class NoticeDeliveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        environment = patch.dict(os.environ, {
            'DELIVERY_READ': 'r'*40, 'DELIVERY_WRITE': 'w'*40, 'DELIVERY_PROXY': 'p'*40})
        environment.start()
        self.addCleanup(environment.stop)
        connection = socket.socket()
        connection.bind(('127.0.0.1', 0))
        self.addCleanup(connection.close)
        node_port = connection.getsockname()[1]
        config = {'schemaVersion': 1, 'role': 'node', 'port': node_port,
                  'database': str(root/'jobs.sqlite'), 'profiles': [],
                  'readTokenEnv': 'DELIVERY_READ', 'writeTokenEnv': 'DELIVERY_WRITE',
                  'notices': {'directory': str(root/'notices'), 'sites': ['site'],
                              'publishUsers': ['owner']}}
        node = uvicorn.Server(uvicorn.Config(create_node(config), log_level='error'))
        thread = threading.Thread(target=node.run, kwargs={'sockets': [connection]}, daemon=True)
        thread.start()
        def stop_node():
            node.should_exit = True
            thread.join(timeout=5)
        self.addCleanup(stop_node)
        deadline = time.monotonic()+5
        while not node.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(node.started, 'node failed to start')
        admin = {'schemaVersion': 1, 'role': 'admin', 'port': 18080,
                 'origin': 'http://127.0.0.1:18080',
                 'auth': {'mode': 'proxy', 'users': ['owner'], 'proxyTokenEnv': 'DELIVERY_PROXY'},
                 'sources': [{'id': 'stats', 'url': 'http://127.0.0.1:18081'}],
                 'sites': [{'id': 'site', 'source': 'stats', 'nodes': ['node'], 'noticeNode': 'node'}],
                 'nodes': [{'id': 'node', 'url': f'http://127.0.0.1:{node_port}',
                            'readTokenEnv': 'DELIVERY_READ', 'writeTokenEnv': 'DELIVERY_WRITE',
                            'noticeUsers': ['owner']}]}
        # No transport override: urllib makes authenticated HTTP calls to uvicorn.
        self.admin = self.enterContext(TestClient(create_admin(admin), base_url=admin['origin']))
        self.headers = {'x-admin-user': 'owner', 'x-admin-proxy': 'p'*40,
                        'Origin': admin['origin'], 'X-OurNotes-Request': '1'}
        self.public_file = root/'notices/site/public.json'
        (root/'code').mkdir()
        (root/'code/code-release.json').write_text(json.dumps({'codeId': 'a'*24}))
        self.web = ThreadingHTTPServer(('127.0.0.1', 0),
                                      handler(root/'code', root/'content', notices=self.public_file))
        web_thread = threading.Thread(target=self.web.serve_forever, daemon=True)
        web_thread.start()
        self.addCleanup(web_thread.join)
        self.addCleanup(self.web.server_close)
        self.addCleanup(self.web.shutdown)

    def change(self, action, revision, **fields):
        return self.admin.post('/api/notices/site', headers=self.headers, json={
            'id': 'a'*32, 'action': action, 'expectedRevision': revision, **fields})

    def public(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.web.server_port, timeout=3)
        try:
            connection.request('GET', '/site-notices.json')
            response = connection.getresponse()
            return response.status, response.getheader('Cache-Control'), response.read()
        finally:
            connection.close()

    def test_save_publish_edit_republish_withdraw_reaches_public_http(self):
        value = {'kind': 'info', 'region': 'all', 'paths': ['/recruitment/', '/events/'],
                 'title': '联动验收', 'body': '首次发布', 'titleEn': '', 'bodyEn': '',
                 'href': '/updates/', 'startsAt': None, 'endsAt': None}
        self.assertEqual(self.change('save', 0, notice=value).status_code, 200)
        self.assertEqual(self.public()[0], 503)
        self.assertEqual(self.change('publish', 1).status_code, 200)
        status, cache, original = self.public()
        self.assertEqual(status, 200)
        self.assertIn('no-store', cache)
        self.assertEqual(json.loads(original)['notices'][0]['paths'], value['paths'])
        self.assertNotIn('updatedBy', original.decode())
        self.assertEqual(self.change('save', 1, notice={**value, 'body': '再次发布'}).status_code, 200)
        self.assertEqual(self.public()[2], original, 'saving a draft must not change the website')
        self.assertEqual(self.change('publish', 1).status_code, 409)
        self.assertEqual(self.change('publish', 2).status_code, 200)
        self.assertEqual(json.loads(self.public()[2])['notices'][0]['body'], '再次发布')
        rows = self.admin.get('/api/notices/site', headers=self.headers).json()
        self.assertTrue(rows['canWrite'])
        self.assertEqual(rows['notices'][0]['published']['revision'], 2)
        self.assertEqual(self.change('withdraw', 2).status_code, 200)
        self.assertEqual(json.loads(self.public()[2])['notices'], [])
