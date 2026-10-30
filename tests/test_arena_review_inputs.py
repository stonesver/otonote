import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.arena_content import read_arena_review,build_arena_content
from tools.arena_review_inputs import prepare,LIMIT
from tools.r2_content import canonical,digest
from tools import r2_production_gate as gate
from tools import global_update


class ArenaReviewInputTests(unittest.TestCase):
    def test_pinned_private_input_reaches_normal_build_and_other_release_stays_unknown(self):
        image=b'RIFF'+bytes(4)+b'WEBP'+b'test'
        review=dict(schemaVersion=1,region='global',sourceReleaseId='test',masterVersion='a'*32,
                    tables={},serverScopes=['global-hmt'],rankIcons=[dict(tier=1,path='rank-icons/rank-1.webp',sha256=digest(image))])
        raw=canonical(dict(review=review,files={'rank-icons/rank-1.webp':base64.b64encode(image).decode()}))
        class Client:
            def get_object(self,**kwargs):
                self.request=kwargs
                return dict(ContentLength=len(raw),Body=io.BytesIO(raw))
        client=Client();bucket=SimpleNamespace(client=client,bucket='private-example')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);env=root/'github-env'
            prepare(root,digest(raw),bucket,env)
            binding=dict(line.split('=',1) for line in env.read_text().splitlines())
            with patch.dict(os.environ,binding):
                selected=read_arena_review(dict(region='global',contentReleaseId='test'),root)
                value=build_arena_content(root,'test','global',review=selected)
                self.assertTrue(value['rankIcons'][0]['image'].startswith('data:image/webp;base64,'))
                self.assertNotIn(str(root),json.dumps(value))
                self.assertIsNone(read_arena_review(dict(region='global',contentReleaseId='next-master'),root))
            self.assertEqual(client.request['Key'],'state/objects/'+digest(raw))
            with self.assertRaises(ValueError):prepare(root,'0'*64,bucket,env)

    def test_review_digest_changes_the_production_gate_and_oversized_input_is_not_read(self):
        with patch('tools.jp_update.fingerprint',return_value='a'*64):
            with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'b'*64}):first=gate.code_fingerprints(gate.ROOT)
            with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'c'*64}):second=gate.code_fingerprints(gate.ROOT)
            self.assertEqual(first[0],second[0]);self.assertNotEqual(first[1],second[1])
        with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'b'*64}):first=global_update.chart_projection_fingerprint()
        with patch.dict(os.environ,{'OURNOTES_ARENA_REVIEW_BUNDLE_SHA256':'c'*64}):second=global_update.chart_projection_fingerprint()
        self.assertNotEqual(first,second,'review changes must not reuse an older sealed candidate')
        class Body:
            def read(self,*args):raise AssertionError('oversized input must not be read')
            def close(self):pass
        client=SimpleNamespace(get_object=lambda **kwargs:dict(ContentLength=LIMIT+1,Body=Body()))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):prepare(Path(folder),'a'*64,SimpleNamespace(client=client,bucket='private-example'),Path(folder)/'env')
