import base64
import hashlib
import json
import unittest
from pathlib import Path

from tools.publish_arena_band_icons import publish, canonical


class Bucket:
    def __init__(self):
        self.objects = {}

    def put_new(self, key, raw, **kwargs):
        self.objects.setdefault(key, raw)

    def get(self, key):
        return self.objects[key], 'etag'


class ArenaBandIconTests(unittest.TestCase):
    def test_checked_in_release_identity_matches_published_manifest(self):
        inventory = json.loads((Path(__file__).resolve().parents[1] / 'site/src/lib/arena-band-icons.json').read_text())
        manifest = canonical({'schemaVersion': 1, 'kind': 'arena-band-icons', 'files': inventory['files']})
        self.assertEqual(hashlib.sha256(manifest).hexdigest()[:24], inventory['releaseId'])

    def fixture(self):
        files = {f'public/images/filter-bands/band-{i}.png': f'badge-{i}'.encode() for i in range(1, 6)}
        hashes = {key: hashlib.sha256(raw).hexdigest() for key, raw in files.items()}
        manifest = canonical({'schemaVersion': 1, 'kind': 'arena-band-icons', 'files': hashes})
        return {key: base64.b64encode(raw).decode() for key, raw in files.items()}, {
            'releaseId': hashlib.sha256(manifest).hexdigest()[:24], 'files': hashes}

    def test_all_bytes_are_reviewed_before_any_remote_write(self):
        payload, inventory = self.fixture()
        payload[next(reversed(payload))] = base64.b64encode(b'wrong').decode()
        bucket = Bucket()
        with self.assertRaises(ValueError):
            publish(bucket, payload, inventory)
        self.assertEqual(bucket.objects, {})

    def test_conditional_upload_readback_and_no_pointer_writes(self):
        payload, inventory = self.fixture()
        bucket = Bucket()
        self.assertEqual(publish(bucket, payload, inventory)['verifiedObjects'], 6)
        self.assertTrue(all(key.startswith('content/releases/' + inventory['releaseId'] + '/') for key in bucket.objects))
        before = dict(bucket.objects)
        publish(bucket, payload, inventory)
        self.assertEqual(bucket.objects, before)
        bucket.objects[next(iter(bucket.objects))] = b'conflicting remote bytes'
        with self.assertRaises(ValueError):
            publish(bucket, payload, inventory)

    def test_unreviewed_path_is_rejected(self):
        payload, inventory = self.fixture()
        payload['current.json'] = base64.b64encode(b'{}').decode()
        with self.assertRaises(ValueError):
            publish(Bucket(), payload, inventory)
