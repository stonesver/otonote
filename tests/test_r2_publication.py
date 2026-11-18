import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tools import r2_content as content, r2_publication as publication
from tools.r2_shared_media import blob_key
from tests.test_r2_content import fixture, sha
from tests.test_r2_shared_media import TrackedBucket


class PublicationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bucket = TrackedBucket()

    def prepare(self, shared=True):
        fixture(self.root)
        content.upload_release(self.bucket, self.root, 'global', shared_media=shared)
        publication.record(self.bucket, self.root, 'global', '123_1', 'none')
        shutil.rmtree(self.root / 'releases')

    def retry(self, publish=True):
        return publication.retry(self.bucket, 'global', '123_1', source_run='retry-456_1', publish=publish)

    def test_recovery_uses_uploaded_artifact_without_original_working_tree(self):
        for shared in (True, False):
            with self.subTest(shared=shared):
                self.bucket = TrackedBucket()
                self.prepare(shared)
                self.assertEqual(self.retry(False)['status'], 'ready')
                self.assertNotIn('content/current.json', self.bucket.objects)
                self.assertEqual(self.retry()['status'], 'published')
                self.assertEqual(self.retry()['status'], 'unchanged')

    def test_newer_pointer_is_never_replaced_by_recovery(self):
        self.prepare()
        self.bucket.put_new('content/current.json', b'newer publication')
        with self.assertRaisesRegex(ValueError, 'changed since'):
            self.retry()
        self.assertEqual(self.bucket.objects['content/current.json'], b'newer publication')

    def test_missing_media_or_changed_projection_blocks_publication(self):
        for key in (blob_key(sha(b'public image')), 'content/releases/' + 'a'*24 + '/en/catalog.json'):
            with self.subTest(key=key):
                self.bucket = TrackedBucket()
                self.prepare()
                del self.bucket.objects[key]
                with self.assertRaises(ValueError):
                    self.retry()
                self.assertNotIn('content/current.json', self.bucket.objects)

    def test_wrong_region_or_incomplete_manifest_inventory_is_rejected(self):
        self.prepare()
        key = publication.publication_key('global', '123_1')
        value = json.loads(self.bucket.objects[key])
        del value['files']['en/catalog.json']
        self.bucket.objects[key] = content.canonical(value)
        with self.assertRaisesRegex(ValueError, 'required record'):
            self.retry()
        with self.assertRaisesRegex(ValueError, 'missing'):
            publication.retry(self.bucket, 'jp', '123_1', source_run='retry')
