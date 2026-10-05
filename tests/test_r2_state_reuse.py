import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from tools import r2_state
from tests.test_r2_state import FakePrivateBucket


class EvidenceBucket(FakePrivateBucket):
    def __init__(self):
        super().__init__()
        self.scope = 'account-one/private-state'
        self.etags = {}
        self.list_calls = 0
        self.list_error = None
        self.include_etag = True

    def verification_identity(self):
        return self.scope

    def _etag(self, key):
        return self.etags.get(key, '"' + r2_state.digest(self.objects[key]) + '"')

    def download_file(self, key, target, sha, size):
        super().download_file(key, target, sha, size)
        return {'sha256': sha, 'size': size, 'etag': self._etag(key)} if self.include_etag else None

    def list_verified_objects(self, keys):
        self.list_calls += 1
        if self.list_error:
            raise self.list_error
        return {key: {'size': len(self.objects[key]), 'etag': self._etag(key)}
                for key in keys if key in self.objects}


class StateReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'root'
        self.root.mkdir()
        (self.root / 'state').mkdir()
        (self.root / 'state/a').write_bytes(b'alpha')
        (self.root / 'state/b').write_bytes(b'beta')
        self.cache = self.base / 'restore-proof.json'
        self.bucket = EvidenceBucket()
        self.first = r2_state.checkpoint(self.bucket, self.root, 'global', ['state'], 'none')
        shutil.rmtree(self.root / 'state')

    def tearDown(self):
        self.temp.cleanup()

    def restore(self, bucket=None):
        return r2_state.restore(bucket or self.bucket, self.root, 'global', ['state'],
                                verification_cache=self.cache, workers=2)

    def checkpoint(self, **kwargs):
        return r2_state.checkpoint(self.bucket, self.root, 'global', ['state'],
                                   self.first['pointerSha256'], verification_cache=self.cache, **kwargs)

    def mutate_cache(self, action):
        data = json.loads(self.cache.read_bytes())
        action(data)
        self.cache.write_bytes(r2_state.canonical(data))

    def test_changed_checkpoint_reuses_verified_restore_and_only_reads_new_content(self):
        self.restore()
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o600)
        (self.root / 'state/c').write_bytes(b'new-content')
        self.bucket.verify_calls.clear()
        self.bucket.upload_calls.clear()
        result = self.checkpoint(workers=2)
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(result['verifiedReuse'], 2)
        self.assertEqual(self.bucket.list_calls, 1)
        self.assertEqual(len(self.bucket.verify_calls), 2)
        self.assertEqual(len(self.bucket.upload_calls), 1)
        self.assertEqual({call[1] for call in self.bucket.verify_calls}, {r2_state.digest(b'new-content')})

    def test_missing_cache_or_missing_get_etag_falls_back_to_full_verification(self):
        for missing in ('cache', 'etag'):
            with self.subTest(missing=missing):
                if (self.root / 'state').exists():
                    shutil.rmtree(self.root / 'state')
                self.bucket.include_etag = missing != 'etag'
                self.restore()
                if missing == 'cache':
                    self.cache.unlink()
                self.bucket.verify_calls.clear()
                self.assertEqual(self.checkpoint()['verifiedReuse'], 0)
                self.assertEqual(len(self.bucket.verify_calls), 2)

    def test_unsupported_adapter_preserves_restore_and_checkpoint(self):
        old = FakePrivateBucket()
        old.objects = self.bucket.objects
        self.restore(old)
        self.assertFalse(self.cache.exists())
        r2_state.checkpoint(old, self.root, 'global', ['state'], self.first['pointerSha256'],
                            verification_cache=self.cache)
        self.assertEqual(len(old.verify_calls), 2)

    def test_changed_etag_for_valid_content_forces_body_verification(self):
        self.restore()
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        self.bucket.etags[key] = '"different-version"'
        self.bucket.verify_calls.clear()
        self.assertEqual(self.checkpoint()['verifiedReuse'], 1)
        self.assertEqual([c[0] for c in self.bucket.verify_calls], [key])

    def test_damaged_remote_content_never_advances_pointer(self):
        self.restore()
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        self.bucket.objects[key] = b'wrong'
        before = self.bucket.objects[r2_state.pointer_key('global')]
        with self.assertRaisesRegex(ValueError, 'missing or damaged'):
            self.checkpoint()
        self.assertEqual(self.bucket.objects[r2_state.pointer_key('global')], before)

    def test_missing_remote_object_is_reuploaded_and_fully_verified(self):
        self.restore()
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        del self.bucket.objects[key]
        self.bucket.verify_calls.clear()
        result = self.checkpoint()
        self.assertEqual(result['verifiedReuse'], 1)
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual([c[0] for c in self.bucket.verify_calls], [key, key])

    def test_corrupt_or_cross_scope_proof_is_rejected_before_writes(self):
        self.restore()
        original = self.cache.read_bytes()
        mutations = [lambda d: d.update(bucketIdentity='other-bucket'),
                     lambda d: d.update(root='/other/root'),
                     lambda d: d.update(region='jp'),
                     lambda d: d.update(manifestSha256='0' * 64),
                     lambda d: d.update(pointerSha256='0' * 64)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.cache.write_bytes(original)
                self.mutate_cache(mutate)
                before = dict(self.bucket.objects)
                with self.assertRaises(ValueError):
                    self.checkpoint()
                self.assertEqual(self.bucket.objects, before)
        self.cache.write_bytes(b'{bad-json')
        with self.assertRaises(ValueError):
            self.checkpoint()

    def test_world_readable_and_symlink_proofs_are_rejected(self):
        self.restore()
        self.cache.chmod(0o644)
        with self.assertRaises(ValueError):
            self.checkpoint()
        self.cache.chmod(0o600)
        real = self.cache.with_suffix('.real')
        self.cache.rename(real)
        self.cache.symlink_to(real)
        with self.assertRaises(ValueError):
            self.checkpoint()

    def test_list_error_never_writes_objects_or_advances_pointer(self):
        self.restore()
        (self.root / 'state/c').write_bytes(b'new-content')
        before = dict(self.bucket.objects)
        self.bucket.list_error = OSError('listing unavailable')
        with self.assertRaisesRegex(OSError, 'listing unavailable'):
            self.checkpoint()
        self.assertEqual(self.bucket.objects, before)

    def test_listing_without_etag_or_with_wrong_size_forces_body_read(self):
        self.restore()
        original = self.bucket.list_verified_objects
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        for changed in ({'size': 5}, {'size': 4, 'etag': self.bucket._etag(key)}):
            with self.subTest(listed=changed):
                def listed(keys):
                    result = original(keys)
                    result[key] = changed
                    return result
                self.bucket.list_verified_objects = listed
                self.bucket.verify_calls.clear()
                self.assertEqual(self.checkpoint()['verifiedReuse'], 1)
                self.assertEqual([call[0] for call in self.bucket.verify_calls], [key])

    def test_partial_proof_preserves_full_verification_for_unrecorded_objects(self):
        self.restore()
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        self.mutate_cache(lambda d: d['objects'].pop(key))
        self.bucket.verify_calls.clear()
        self.assertEqual(self.checkpoint()['verifiedReuse'], 1)
        self.assertEqual([call[0] for call in self.bucket.verify_calls], [key])

    def test_cache_inside_checkpoint_root_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside ROOT'):
            r2_state.restore(self.bucket, self.root, 'global', ['state'],
                             verification_cache=self.root / 'proof.json')

    def test_malformed_object_evidence_fails_closed(self):
        self.restore()
        initial = self.cache.read_bytes()
        key = r2_state.object_key(r2_state.digest(b'alpha'))
        for field, value in [('sha256', 'not-a-sha'), ('size', True), ('etag', None)]:
            with self.subTest(field=field):
                self.cache.write_bytes(initial)
                self.mutate_cache(lambda d: d['objects'][key].update({field: value}))
                before = dict(self.bucket.objects)
                with self.assertRaises(ValueError):
                    self.checkpoint()
                self.assertEqual(self.bucket.objects, before)

    def test_restore_failure_does_not_leave_stale_proof(self):
        self.restore()
        shutil.rmtree(self.root / 'state')
        self.bucket.objects[r2_state.object_key(r2_state.digest(b'alpha'))] = b'wrong'
        with self.assertRaisesRegex(ValueError, 'missing or damaged'):
            self.restore()
        self.assertFalse(self.cache.exists())

    def test_source_second_hash_and_pointer_cas_are_not_bypassed(self):
        self.restore()
        original = self.bucket.list_verified_objects
        def changed(keys):
            result = original(keys)
            (self.root / 'state/a').write_bytes(b'changed-during-list')
            return result
        self.bucket.list_verified_objects = changed
        before = self.bucket.objects[r2_state.pointer_key('global')]
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.checkpoint()
        self.assertEqual(self.bucket.objects[r2_state.pointer_key('global')], before)
        self.bucket.list_verified_objects = original
        self.bucket.conflict_at_replace = True
        with self.assertRaisesRegex(ValueError, 'pointer changed'):
            self.checkpoint()
        self.assertEqual(self.bucket.objects[r2_state.pointer_key('global')], before)


class S3EvidenceTests(unittest.TestCase):
    def test_bucket_identity_includes_endpoint_and_bucket(self):
        class Client:
            class meta:
                endpoint_url = 'https://account-one.r2.cloudflarestorage.com'
        one = r2_state.PrivateS3Bucket(Client(), 'private')
        two = r2_state.PrivateS3Bucket(Client(), 'other')
        self.assertNotEqual(one.verification_identity(), two.verification_identity())
        initial = one.verification_identity()
        one.client.meta.endpoint_url = 'https://account-two.r2.cloudflarestorage.com'
        self.assertNotEqual(initial, one.verification_identity())

    def test_listing_is_paginated_bounded_and_returns_only_requested_keys(self):
        wanted = {r2_state.object_key('a' * 64), r2_state.object_key('b' * 64)}
        class Client:
            def __init__(self): self.calls = []
            def list_objects_v2(self, **kwargs):
                self.calls.append(kwargs)
                key = sorted(wanted)[len(self.calls) - 1]
                return {'Contents': [{'Key': key, 'Size': 3, 'ETag': '"opaque"'},
                                     {'Key': 'state/objects/not-wanted', 'Size': 2, 'ETag': '"x"'}],
                        'IsTruncated': len(self.calls) == 1, 'NextContinuationToken': 'fixture-next'}
        client = Client()
        result = r2_state.PrivateS3Bucket(client, 'private').list_verified_objects(wanted)
        self.assertEqual(set(result), wanted)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[1]['ContinuationToken'], 'fixture-next')
        self.assertTrue(all(c['MaxKeys'] == 1000 and c['Prefix'] == 'state/objects/' for c in client.calls))

    def test_listing_invalid_pagination_or_page_limit_fails_closed(self):
        class Client:
            def list_objects_v2(self, **kwargs):
                return {'Contents': [], 'IsTruncated': True, 'NextContinuationToken': 'fixture-same'}
        bucket = r2_state.PrivateS3Bucket(Client(), 'private')
        with self.assertRaises(ValueError):
            bucket.list_verified_objects({'state/objects/' + 'a' * 64})
        with patch.object(r2_state, 'MAX_LIST_PAGES', 1):
            with self.assertRaises(ValueError):
                bucket.list_verified_objects({'state/objects/' + 'a' * 64})

    def test_later_page_error_does_not_return_partial_evidence(self):
        key = r2_state.object_key('a' * 64)
        class Client:
            def list_objects_v2(self, **kwargs):
                if kwargs.get('ContinuationToken'):
                    raise OSError('page two failed')
                return {'Contents': [{'Key': key, 'Size': 3, 'ETag': '"opaque"'}],
                        'IsTruncated': True, 'NextContinuationToken': 'fixture-next'}
        with self.assertRaisesRegex(OSError, 'page two failed'):
            r2_state.PrivateS3Bucket(Client(), 'private').list_verified_objects({key})

    def test_listing_missing_etag_does_not_establish_evidence(self):
        key = r2_state.object_key('a' * 64)
        class Client:
            def list_objects_v2(self, **kwargs):
                return {'Contents': [{'Key': key, 'Size': 3}], 'IsTruncated': False}
        self.assertEqual(r2_state.PrivateS3Bucket(Client(), 'private').list_verified_objects({key}), {})

    def test_stream_proof_uses_same_verified_get_and_not_object_metadata(self):
        body = b'verified bytes'
        class Client:
            def __init__(self): self.calls = 0
            def get_object(self, **kwargs):
                self.calls += 1
                return {'Body': io.BytesIO(body), 'ContentLength': len(body), 'ETag': '"get-version"',
                        'Metadata': {'sha256': '0' * 64}}
        client = Client()
        bucket = r2_state.PrivateS3Bucket(client, 'private')
        with tempfile.TemporaryDirectory() as tmp:
            proof = bucket.download_file('state/objects/' + r2_state.digest(body), Path(tmp) / 'file',
                                         r2_state.digest(body), len(body))
        self.assertEqual(client.calls, 1)
        self.assertEqual(proof, {'sha256': r2_state.digest(body), 'size': len(body), 'etag': '"get-version"'})

    def test_stream_missing_etag_restores_without_proof_and_forged_metadata_does_not_validate_bytes(self):
        expected = b'good'
        class Client:
            payload = expected
            def get_object(self, **kwargs):
                return {'Body': io.BytesIO(self.payload), 'ContentLength': len(self.payload),
                        'Metadata': {'sha256': r2_state.digest(expected)}}
        client = Client()
        bucket = r2_state.PrivateS3Bucket(client, 'private')
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(bucket.download_file(r2_state.object_key(r2_state.digest(expected)),
                                                   Path(tmp) / 'good', r2_state.digest(expected), len(expected)))
            self.assertEqual((Path(tmp) / 'good').read_bytes(), expected)
            client.payload = b'evil'
            with self.assertRaisesRegex(ValueError, 'missing or damaged'):
                bucket.download_file(r2_state.object_key(r2_state.digest(expected)), Path(tmp) / 'bad',
                                     r2_state.digest(expected), len(expected))


if __name__ == '__main__':
    unittest.main()
