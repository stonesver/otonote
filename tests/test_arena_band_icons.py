import base64
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from io import BytesIO
from email.message import Message

from tools.publish_arena_band_icons import publish, canonical, verify_public


class Bucket:
    def __init__(self):
        self.objects = {}

    def put_new(self, key, raw, **kwargs):
        self.objects.setdefault(key, raw)

    def get(self, key):
        return (self.objects[key], 'etag') if key in self.objects else None

    def list_identities(self, prefix):
        return {key for key in self.objects if key.startswith(prefix)}


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
        access = 'content/access/' + inventory['releaseId'] + '.json'
        self.assertEqual(json.loads(bucket.objects[access])['manifestSha256'],
                         hashlib.sha256(bucket.get('content/releases/' + inventory['releaseId'] + '/manifest.json')[0]).hexdigest())
        self.assertEqual(len(bucket.objects), 7)
        before = dict(bucket.objects)
        publish(bucket, None, inventory)
        self.assertEqual(bucket.objects, before)
        bucket.objects[next(iter(bucket.objects))] = b'conflicting remote bytes'
        with self.assertRaises(ValueError):
            publish(bucket, payload, inventory)

    def test_backfill_rejects_extra_objects_before_grant(self):
        payload, inventory = self.fixture()
        bucket = Bucket()
        publish(bucket, payload, inventory)
        identifier = inventory['releaseId']
        access = f'content/access/{identifier}.json'
        del bucket.objects[access]
        bucket.objects[f'content/releases/{identifier}/public/other.png'] = b'other'
        with self.assertRaises(ValueError):
            publish(bucket, None, inventory)
        self.assertNotIn(access, bucket.objects)

    def test_public_verification_reads_every_png_and_rejects_wrong_bytes(self):
        payload, inventory = self.fixture()
        def serve(url, timeout):
            name = url.split(inventory['releaseId'] + '/')[1]
            response = BytesIO(base64.b64decode(payload[name]))
            response.status = 200
            response.geturl = lambda: url
            response.headers = Message()
            response.headers['Content-Type'] = 'image/png'
            return response
        with patch('tools.publish_arena_band_icons.urlopen', side_effect=serve) as request:
            self.assertEqual(verify_public('https://example.invalid', inventory), 5)
            self.assertEqual(request.call_count, 5)
            payload[next(iter(payload))] = base64.b64encode(b'wrong')
            with self.assertRaises(ValueError):
                verify_public('https://example.invalid', inventory)

    def test_unreviewed_path_is_rejected(self):
        payload, inventory = self.fixture()
        payload['current.json'] = base64.b64encode(b'{}').decode()
        with self.assertRaises(ValueError):
            publish(Bucket(), payload, inventory)
