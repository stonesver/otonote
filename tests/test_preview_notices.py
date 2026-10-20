"""Public preview routes follow served completed HTML rather than remote pointers."""
import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from tools.preview_independent_site import handler


class PreviewNoticeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.code = self.root/'code'
        self.code.mkdir()
        (self.code/'code-release.json').write_text(json.dumps({'codeId':'a'*24}))
        self.content = self.root/'content'
        self.content.mkdir()
        self.render = self.root/'render'
        self.render.mkdir()
        self.public = self.root/'public.json'
        self.completion = {'schemaVersion':1, 'region':'global', 'codeId':'a'*24,
                           'pair':'a'*24+'-'+'b'*24, 'pointer':{'schemaVersion':1,
                           'manifest':'/content/releases/'+'b'*24+'/manifest.json', 'sha256':'c'*64}}
        (self.render/'complete.json').write_text(json.dumps(self.completion))
        self.server = ThreadingHTTPServer(('127.0.0.1',0), handler(self.code,self.content,self.render,notices=self.public))
        thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self,path):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        try:
            connection.request('GET',path)
            response=connection.getresponse()
            return response.status, response.getheader('Cache-Control'), response.read()
        finally:
            connection.close()

    def test_public_notices_are_read_fresh_without_exposing_drafts(self):
        self.public.write_text(json.dumps({'schemaVersion':1,'notices':[]}))
        status, cache, _ = self.get('/site-notices.json')
        self.assertEqual(status,200)
        self.assertIn('no-store',cache)
        self.public.write_text(json.dumps({'schemaVersion':1,'notices':[{'title':'changed'}]}))
        self.assertEqual(json.loads(self.get('/site-notices.json')[2])['notices'][0]['title'],'changed')
        self.assertEqual(self.get('/drafts.json')[0],404)
        self.public.unlink()
        self.assertEqual(self.get('/site-notices.json')[0],503)

    def test_update_status_uses_completed_served_view_not_latest_content(self):
        status,_,body=self.get('/site-status/global.json')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body),self.completion)
        (self.content/'current.json').write_text('{"manifest":"new-remote-content"}')
        self.assertEqual(json.loads(self.get('/site-status/global.json')[2]),self.completion)
        self.assertEqual(self.get('/site-status/jp.json')[0],503)
        self.completion['codeId']='d'*24
        (self.render/'complete.json').write_text(json.dumps(self.completion))
        self.assertEqual(self.get('/site-status/global.json')[0],503)
