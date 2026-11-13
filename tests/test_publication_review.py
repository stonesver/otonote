import json
import tempfile
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import publication_review as review, r2_content as content, r2_publication as publication
from tests.test_r2_content import fixture, sha
from tests.test_r2_shared_media import TrackedBucket
from tools.r2_shared_media import blob_key


class PublicationReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bucket = TrackedBucket()
        review.bootstrap(self.bucket)

    def prepare(self, region='global', identifier='a'*24, run='123_1'):
        store = self.root/identifier
        pointer = fixture(store, region=region, release_id=identifier)
        content.upload_release(self.bucket, store, region, shared_media=True)
        current = self.bucket.get(content.pointer_key(region))
        publication.record(self.bucket, store, region, run, sha(current[0]) if current else 'none')
        return store, json.loads(pointer.read_bytes())

    def decide(self, action, stamp=None, region='global'):
        row, _ = review.read(self.bucket, region)
        return review.decide(self.bucket, region, row['publication'], row['revision'], action, stamp)

    def test_upload_and_all_promotion_paths_wait_for_the_exact_region_decision(self):
        store, pointer = self.prepare()
        self.prepare('jp', 'b'*24, '124_1')
        self.assertEqual(content.promote(self.bucket, store, 'global', 'none', source_run='run')['status'], 'awaiting_review')
        self.assertEqual(publication.retry(self.bucket, 'global', '123_1', source_run='retry', publish=True)['status'], 'awaiting_review')
        self.assertIsNone(self.bucket.get('content/current.json'))
        self.assertFalse(review.has_access(self.bucket, pointer, 'global'))
        self.decide('publish')
        self.assertEqual(review.process(self.bucket, 'global', source_run='review')['status'], 'published')
        self.assertTrue(review.has_access(self.bucket, pointer, 'global'))
        self.assertEqual(review.read(self.bucket, 'global')[0]['status'], 'published')
        self.assertEqual(review.read(self.bucket, 'jp')[0]['status'], 'pending')
        self.assertIsNone(self.bucket.get('content/jp/current.json'))

    def test_confirmed_schedule_never_publishes_early_and_hold_survives_repeat(self):
        store, pointer = self.prepare()
        with patch.object(review.time, 'time', return_value=100):
            self.decide('schedule', 200)
            publication.record(self.bucket, store, 'global', '125_1', 'none')
            self.assertEqual(review.process(self.bucket, 'global', source_run='early')['status'], 'scheduled')
            self.assertFalse(review.authorize(self.bucket, pointer, 'global', now=199))
            held = self.decide('hold')
            publication.record(self.bucket, store, 'global', '126_1', 'none')
            self.assertEqual(review.read(self.bucket, 'global')[0], held)
        with patch.object(review.time, 'time', return_value=250):
            self.assertEqual(review.process(self.bucket, 'global', source_run='held')['status'], 'held')
            self.decide('schedule', 300)
        with patch.object(review.time, 'time', return_value=300):
            self.assertEqual(review.process(self.bucket, 'global', source_run='due')['status'], 'published')

    def test_old_decisions_and_changed_public_baseline_cannot_publish(self):
        _, pointer = self.prepare()
        old, _ = review.read(self.bucket, 'global')
        self.decide('hold')
        with self.assertRaisesRegex(ValueError, 'changed'):
            review.decide(self.bucket, 'global', old['publication'], old['revision'], 'publish')
        self.decide('publish')
        self.bucket.put_new('content/current.json', b'newer-publication')
        self.assertEqual(review.process(self.bucket, 'global', source_run='stale')['status'], 'stale')
        self.assertFalse(review.has_access(self.bucket, pointer, 'global'))

    def test_missing_media_prevents_access_even_after_approval(self):
        _, pointer = self.prepare()
        self.decide('publish')
        del self.bucket.objects[blob_key(sha(b'public image'))]
        with self.assertRaises(ValueError):
            review.process(self.bucket, 'global', source_run='broken')
        self.assertFalse(review.has_access(self.bucket, pointer, 'global'))
        self.assertIsNone(self.bucket.get('content/current.json'))

    def test_new_candidate_requires_new_decision(self):
        self.prepare()
        self.decide('schedule', 253402300799)
        self.prepare(identifier='b'*24, run='124_1')
        row, _ = review.read(self.bucket, 'global')
        self.assertEqual((row['status'], row['publishAt'], row['publication']), ('pending', None, '124_1'))

    def test_activation_preserves_only_verified_current_and_previous(self):
        self.bucket = TrackedBucket()
        store, pointer = self.prepare()
        content.promote(self.bucket, store, 'global', 'none', source_run='existing')
        previous_bytes = self.bucket.get('content/current.json')[0]
        next_store, next_pointer = self.prepare(identifier='b'*24, run='124_1')
        content.promote(self.bucket, next_store, 'global', sha(previous_bytes), source_run='next')
        self.prepare(identifier='c'*24, run='125_1')
        review.bootstrap(self.bucket)
        self.assertTrue(review.has_access(self.bucket, pointer, 'global'))
        self.assertTrue(review.has_access(self.bucket, next_pointer, 'global'))
        self.assertIsNone(self.bucket.get(review.access_key('c'*24)))
        self.assertEqual(review.bootstrap(self.bucket)['status'], 'enabled')
        current = self.bucket.get('content/current.json')[0]
        content.rollback(self.bucket, 'global', sha(current), source_run='rollback')
        self.assertEqual(self.bucket.get('content/current.json')[0], previous_bytes)

    def test_same_prepared_batch_matches_only_its_public_baseline(self):
        _, pointer = self.prepare()
        self.assertTrue(review.pending_matches(self.bucket, 'global', pointer, 'none'))
        self.assertFalse(review.pending_matches(self.bucket, 'global', pointer, 'f'*64))

    def test_workflow_light_gate_accepts_pending_without_claiming_publication(self):
        source = (Path(__file__).resolve().parents[1]/'.github/workflows/content-r2.yml').read_text()
        inline = source.split('python - "$RUNNER_TEMP/light-check.json"')[1].split("<<'PY'", 1)[1].split('\n          PY', 1)[0]
        script = textwrap.dedent(inline)
        for status, skip in [('awaiting_review', True), ('unchanged', True), ('needs_full', False)]:
            path, output = self.root/'check.json', self.root/'outputs'
            path.write_text(json.dumps({'status': status, 'skip': skip}))
            output.write_text('')
            result = subprocess.run([sys.executable, '-', str(path)], input=script, text=True, capture_output=True,
                                    env={**os.environ, 'GITHUB_OUTPUT': str(output)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text(), f'skip={str(skip).lower()}\npublicStatus={status}\n')
