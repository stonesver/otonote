import json
from pathlib import Path
import tempfile
import unittest

from tools import r2_content as content
from tools import r2_verified_release as verified
from tests.test_r2_content import fixture, MemoryBucket
from tests.test_r2_shared_media import TrackedBucket, reseal


class VerifiedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fixture(self.root)
        self.bucket = TrackedBucket()
        self.prefix = 'content/releases/' + 'a' * 24 + '/'

    def upload(self):
        return content.upload_release(self.bucket, self.root, 'global', workers=2)

    def promote(self, dry=False):
        return content.promote(self.bucket, self.root, 'global', 'none', source_run='test', dry_run=dry)

    def test_full_readback_then_repeat_and_promotion_use_only_fresh_listing(self):
        report = self.upload()
        self.assertEqual(report['uploaded'], 4)
        for key in self.bucket.objects:
            if key.startswith(self.prefix):
                self.assertIn(key, self.bucket.gets)
        self.bucket.gets.clear(); self.bucket.puts.clear(); self.bucket.lists.clear()
        self.assertEqual(self.upload()['verification'], 'catalog-and-fresh-list')
        self.assertEqual(self.promote(True)['status'], 'ready')
        self.assertEqual(self.promote()['status'], 'published')
        self.assertFalse(any(k.startswith(self.prefix) for k in self.bucket.gets + self.bucket.puts))
        self.assertEqual(self.bucket.lists, [self.prefix] * 3)

    def test_fresh_listing_rejects_removed_replaced_and_extra_objects(self):
        self.upload()
        original = dict(self.bucket.objects), dict(self.bucket.etags)
        for mutation in ('removed', 'replaced', 'extra'):
            with self.subTest(mutation=mutation):
                self.bucket.objects, self.bucket.etags = map(dict, original)
                key = self.prefix + 'en/catalog.json'
                if mutation == 'removed':
                    del self.bucket.objects[key]
                elif mutation == 'replaced':
                    self.bucket.replace(key, b'[]', self.bucket.etags[key])
                else:
                    self.bucket.put_new(self.prefix + 'en/extra.json', b'{}')
                with self.assertRaisesRegex(ValueError, 'missing or changed'):
                    self.promote()
                self.assertNotIn('content/current.json', self.bucket.objects)

    def test_damage_never_creates_completion(self):
        original = self.bucket.get
        def damaged(key):
            value = original(key)
            return (b'corrupt', value[1]) if value and key.endswith('/en/catalog.json') else value
        self.bucket.get = damaged
        with self.assertRaisesRegex(ValueError, 'different bytes'):
            self.upload()
        self.assertNotIn(verified.completion_key('a' * 24), self.bucket.objects)

    def test_legacy_without_catalog_falls_back_to_full_readback(self):
        old = MemoryBucket()
        content.upload_release(old, self.root, 'global')
        self.bucket.objects, self.bucket.etags = old.objects, old.etags
        self.promote(True)
        self.assertEqual(len([k for k in self.bucket.gets if k.startswith(self.prefix)]), 4)

    def test_corrupt_catalog_does_not_fall_back(self):
        self.upload()
        key = verified.completion_key('a' * 24)
        completion = self.bucket.objects[key]
        for raw in (b'{}', b'{"schemaVersion":1,"schemaVersion":1}',
                    completion.replace(b'"manifestSha256":"', b'"manifestSha256":"0')):
            self.bucket.objects[key] = raw
            with self.assertRaises(ValueError):
                self.promote()
            self.assertNotIn('content/current.json', self.bucket.objects)

    def test_damaged_shard_and_local_inventory_cannot_promote(self):
        self.upload()
        complete = json.loads(self.bucket.objects[verified.completion_key('a' * 24)])
        shard = next(iter(complete['shards']))
        key = verified.catalog_prefix('a' * 24) + shard + '.json'
        raw = self.bucket.objects[key]
        self.bucket.objects[key] = b'{}'
        with self.assertRaisesRegex(ValueError, 'missing or damaged'):
            self.promote()
        self.bucket.objects[key] = raw
        (self.root / 'releases' / ('a' * 24) / 'public/media/sample.webp').write_bytes(b'other image!')
        reseal(self.root, 'a' * 24)
        with self.assertRaisesRegex(ValueError, 'binding mismatch'):
            self.promote()

    def test_incomplete_first_catalog_is_not_completion_evidence(self):
        self.upload()
        del self.bucket.objects[verified.completion_key('a' * 24)]
        self.bucket.gets.clear()
        self.promote(True)
        self.assertEqual(len([k for k in self.bucket.gets if k.startswith(self.prefix)]), 4)


if __name__ == '__main__':
    unittest.main()
