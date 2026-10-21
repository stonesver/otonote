import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CliTests(unittest.TestCase):
    def test_disabled_entry_does_not_require_credentials_or_make_storage(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            config.write_text(json.dumps({'schemaVersion': 1, 'enabled': False}))
            result = subprocess.run([sys.executable, '-m', 'backend.update_archive', '--config', str(config),
                                     '--region', 'global'], capture_output=True, text=True,
                                    env={'PATH': os.environ['PATH']})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'disabled')

    def test_enabled_local_entry_runs_the_same_automatic_worker_without_cloud(self):
        import contextlib
        import hashlib
        import io
        from unittest.mock import patch
        from backend.update_archive.__main__ import main
        from tests.test_update_archive_worker import Source
        from backend.update_archive.store import ArchiveRepository, LocalBucket
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);config=root/'config.json'
            config.write_text(json.dumps({'schemaVersion':1,'enabled':True,
                'storage':{'type':'local','root':str(root/'store')}}))
            source=Source()
            @contextlib.contextmanager
            def synthetic(*args):yield source
            with patch('backend.update_archive.runtime.source',synthetic),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['--config',str(config),'--region','global']),0)
                source.files=[{'source':'remote_asset','key':'new.txt','size':7,
                               'sha256':hashlib.sha256(b'new.txt').hexdigest()}]
                self.assertEqual(main(['--config',str(config),'--region','global']),0)
            repo=ArchiveRepository(LocalBucket(root/'store'))
            e=repo.entries('global')[0]
            self.assertEqual(repo.content(e['id']),b'new.txt')
            self.assertNotIn('previewStatus', e)  # Normal cloud runs only capture originals.

    def test_storage_credentials_are_absent_from_source_and_parser_children(self):
        from unittest.mock import patch
        from backend.update_archive.runtime import hide_storage_environment
        import secrets
        material = secrets.token_hex(24)
        values={name:material for name in ('OURNOTES_ARCHIVE_SECRET_ACCESS_KEY', 'CUSTOM_ARCHIVE_ACCESS_KEY_ID', 'OURNOTES_CRI_KEY')}
        config={'storage':{'envPrefix':'CUSTOM_ARCHIVE'}}
        with patch.dict(os.environ,values):
            with hide_storage_environment(config,'global'):
                self.assertNotIn('OURNOTES_ARCHIVE_SECRET_ACCESS_KEY',os.environ)
                self.assertNotIn('CUSTOM_ARCHIVE_ACCESS_KEY_ID',os.environ)
                self.assertEqual(os.environ['OURNOTES_CRI_KEY'],material)
            self.assertEqual(os.environ['CUSTOM_ARCHIVE_ACCESS_KEY_ID'],material)
