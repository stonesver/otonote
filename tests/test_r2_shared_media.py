import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools import r2_content as content
from tools import r2_shared_media as shared
from tests.test_r2_content import MemoryBucket, fixture, sha


class TrackedBucket(MemoryBucket):
    def __init__(self):
        super().__init__()
        self.gets, self.puts, self.lists = [], [], []

    def get(self, key):
        self.gets.append(key)
        return super().get(key)

    def put_new(self, key, data, **kwargs):
        self.puts.append(key)
        return super().put_new(key, data, **kwargs)

    def list_identities(self, prefix):
        self.lists.append(prefix)
        return {key: (len(value), self.etags[key]) for key, value in self.objects.items() if key.startswith(prefix)}


def reseal(store, release_id):
    release = store / 'releases' / release_id
    files = {str(p.relative_to(release)): sha(p.read_bytes()) for p in release.rglob('*')
             if p.is_file() and p.name != '.receipt.json'}
    (release / '.receipt.json').write_text(json.dumps({'schemaVersion': 1, 'files': files}))


class SharedMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bucket = TrackedBucket()

    def build(self, identifier='a' * 24):
        fixture(self.root, release_id=identifier)
        return self.root / 'releases' / identifier

    def upload(self):
        return content.upload_release(self.bucket, self.root, 'global', shared_media=True, workers=3)

    def promote(self, baseline='none'):
        return content.promote(self.bucket, self.root, 'global', baseline, source_run='test', workers=3)

    def test_cross_release_only_changed_media_is_transferred(self):
        self.build()
        first = self.upload()
        self.promote()
        baseline = content.baseline(self.bucket, 'global')['currentSha256']
        new = self.build('b' * 24)
        (new / 'public/media/new.webp').write_bytes(b'one new image')
        reseal(self.root, 'b' * 24)
        self.bucket.gets.clear(); self.bucket.puts.clear(); self.bucket.lists.clear()
        second = self.upload()
        old_key = shared.blob_key(sha(b'public image'))
        self.assertEqual(first['uniqueMedia'], 1)
        self.assertEqual(second['uniqueMedia'], 2)
        self.assertEqual(second['mediaWithoutReadback'], 1)
        self.assertNotIn(old_key, self.bucket.gets)
        self.assertNotIn(old_key, self.bucket.puts)
        self.assertEqual(len([k for k in self.bucket.puts if k.startswith('content/blobs/')]), 1)
        self.promote(baseline)
        self.assertNotIn(old_key, self.bucket.gets)
        self.assertEqual(self.bucket.lists, ['content/blobs/', 'content/blobs/'])
        # The original release still points at the same bytes and remains usable.
        resolver = shared.SharedMediaResolver(lambda k: self.bucket.objects.get(k), 'a' * 24,
                                              self.bucket.objects['content/releases/' + 'a' * 24 + '/manifest.json'])
        self.assertEqual(resolver.resolve('public/media/sample.webp')['key'], old_key)

    def test_many_unchanged_files_need_no_media_get_or_put(self):
        for identifier in ('a' * 24, 'b' * 24):
            release = self.build(identifier)
            for i in range(256):
                (release / f'public/media/image-{i}.webp').write_bytes(f'bytes-{i}'.encode())
            reseal(self.root, identifier)
            self.bucket.gets.clear(); self.bucket.puts.clear(); self.bucket.lists.clear()
            report = self.upload()
            if identifier[0] == 'a':
                self.promote()
            else:
                self.assertEqual(report['mediaWithoutReadback'], 257)
                self.assertFalse(any(k.startswith('content/blobs/') for k in self.bucket.gets + self.bucket.puts))
                self.assertEqual(len(self.bucket.lists), 1)

    def test_new_blob_corruption_never_seals_or_promotes(self):
        self.build()
        original = self.bucket.get
        def damaged(key):
            value = original(key)
            return (b'damaged', value[1]) if value and key.startswith('content/blobs/') else value
        self.bucket.get = damaged
        with self.assertRaisesRegex(ValueError, 'different bytes'):
            self.upload()
        self.assertNotIn(shared.descriptor_key('a' * 24), self.bucket.objects)
        self.assertNotIn('content/releases/' + 'a' * 24 + '/manifest.json', self.bucket.objects)
        self.assertNotIn('content/current.json', self.bucket.objects)

    def test_promote_rejects_removed_or_replaced_previously_verified_blob(self):
        for mutation in ('delete', 'replace'):
            with self.subTest(mutation=mutation):
                self.bucket = TrackedBucket()
                self.build(('a' if mutation == 'delete' else 'b') * 24)
                self.upload()
                key = shared.blob_key(sha(b'public image'))
                if mutation == 'delete':
                    del self.bucket.objects[key]
                else:
                    self.bucket.replace(key, b'wrong bytes', self.bucket.etags[key])
                with self.assertRaisesRegex(ValueError, 'missing or changed'):
                    self.promote()
                self.assertNotIn('content/current.json', self.bucket.objects)

    def test_absent_reused_blob_is_reuploaded_and_verified(self):
        self.build(); self.upload(); self.promote()
        key = shared.blob_key(sha(b'public image'))
        del self.bucket.objects[key]; del self.bucket.etags[key]
        self.build('b' * 24)
        self.bucket.gets.clear(); self.bucket.puts.clear()
        result = self.upload()
        self.assertEqual(result['mediaWithoutReadback'], 0)
        self.assertIn(key, self.bucket.puts)
        self.assertEqual(self.bucket.objects[key], b'public image')
        self.assertIn(key, self.bucket.gets)

    def test_changed_existing_blob_fails_without_overwrite(self):
        self.build(); self.upload(); self.promote()
        key = shared.blob_key(sha(b'public image'))
        self.bucket.replace(key, b'corrupted', self.bucket.etags[key])
        self.build('b' * 24)
        before = self.bucket.objects['content/current.json']
        with self.assertRaisesRegex(ValueError, 'different bytes'):
            self.upload()
        self.assertEqual(self.bucket.objects[key], b'corrupted')
        self.assertEqual(self.bucket.objects['content/current.json'], before)

    def test_model_json_is_shared_and_duplicate_media_has_one_blob(self):
        release = self.build()
        (release / 'public/media/model.json').write_bytes(b'{"textures":["sample.webp"]}')
        (release / 'public/media/duplicate.png').write_bytes(b'public image')
        reseal(self.root, 'a' * 24)
        report = self.upload()
        self.assertEqual(report['mediaFiles'], 3)
        self.assertEqual(report['uniqueMedia'], 2)
        self.assertNotIn('content/releases/' + 'a' * 24 + '/public/media/model.json', self.bucket.objects)
        self.assertIn(shared.blob_key(sha(b'{"textures":["sample.webp"]}')), self.bucket.objects)
        self.assertIn('content/releases/' + 'a' * 24 + '/en/catalog.json', self.bucket.objects)
        self.assertNotIn('content/releases/' + 'a' * 24 + '/public/media/sample.webp', self.bucket.objects)

    def test_old_and_shared_layout_cannot_overwrite_each_other(self):
        self.build()
        content.upload_release(self.bucket, self.root, 'global')
        with self.assertRaisesRegex(ValueError, 'cannot change'):
            self.upload()
        self.bucket = TrackedBucket()
        self.upload()
        with self.assertRaisesRegex(ValueError, 'requires --shared-media'):
            content.upload_release(self.bucket, self.root, 'global')

    def test_broken_shard_cannot_be_used_for_reuse_or_promotion(self):
        self.build(); self.upload(); self.promote()
        descriptor = json.loads(self.bucket.objects[shared.descriptor_key('a' * 24)])
        name = next(iter(descriptor['shards']))
        self.bucket.objects['content/storage/' + 'a' * 24 + '/' + name + '.json'] = b'{}'
        with self.assertRaisesRegex(ValueError, 'missing or damaged'):
            self.promote(content.baseline(self.bucket, 'global')['currentSha256'])
        self.build('b' * 24)
        with self.assertRaisesRegex(ValueError, 'missing or damaged'):
            self.upload()

    def test_inventory_mismatch_cannot_promote(self):
        release = self.build(); self.upload()
        (release / 'public/media/unrecorded.png').write_bytes(b'another asset')
        reseal(self.root, 'a' * 24)
        with self.assertRaisesRegex(ValueError, 'inventory binding'):
            self.promote()

    def test_partial_upload_resumes_and_manifest_is_last(self):
        self.build()
        original = self.bucket.put_new
        failed = False
        def interrupt(key, data, **kwargs):
            nonlocal failed
            if key.endswith('/manifest.json') and not failed:
                failed = True
                raise OSError('simulated interruption')
            return original(key, data, **kwargs)
        self.bucket.put_new = interrupt
        with self.assertRaises(OSError):
            self.upload()
        self.assertIn(shared.descriptor_key('a' * 24), self.bucket.objects)
        self.bucket.gets.clear(); self.bucket.puts.clear()
        result = self.upload()
        self.assertEqual(result['mediaWithoutReadback'], 1)
        self.assertTrue(self.bucket.puts[-1].endswith('/manifest.json'))
        self.promote()


if __name__ == '__main__':
    unittest.main()
