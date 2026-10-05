from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import r2_delivery_probe as probe
from tools import r2_content as content
from tests.test_r2_shared_media import TrackedBucket
from tests.test_r2_content import fixture


class DeliveryProbeTests(unittest.TestCase):
    def test_fixture_uploads_shared_json_without_changing_public_pointer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bucket = TrackedBucket()
            for region, letter in [('global', 'a'), ('jp', 'b')]:
                fixture(root, region=region, release_id=letter * 24)
                content.upload_release(bucket, root, region)
                content.promote(bucket, root, region, 'none', source_run='baseline')
            before = {k: bucket.objects[k] for k in ('content/current.json', 'content/jp/current.json')}
            identifier, files = probe.prepare(root)
            report = content.upload_release(bucket, root, 'global', shared_media=True)
            self.assertEqual(report['mediaFiles'], 3)
            self.assertNotIn('content/releases/' + identifier + '/public/live2d/delivery-probe/model3.json', bucket.objects)
            self.assertEqual({k: bucket.objects[k] for k in before}, before)

    def test_old_worker_404_is_a_failed_probe(self):
        with self.assertRaisesRegex(ValueError, 'HTTP 404'):
            probe.verify('a' * 24, {'public/model.json': b'{}'}, fetch=lambda *a, **k: (404, {}, b''))

    def test_failure_artifact_is_written_without_promoting(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = Path(temporary) / 'result.json'
            bucket = TrackedBucket()
            with patch.object(probe.S3Bucket, 'from_environment', return_value=bucket), \
                    patch.object(probe, 'verify', side_effect=ValueError('old gateway')):
                with self.assertRaisesRegex(ValueError, 'old gateway'):
                    probe.main(['--output', str(report)])
            self.assertIn(b'"status":"failed"', report.read_bytes())
            self.assertNotIn('content/current.json', bucket.objects)
            self.assertNotIn('content/jp/current.json', bucket.objects)


if __name__ == '__main__':
    unittest.main()
