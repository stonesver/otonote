"""Deployment templates retain admin state and published edition routing."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class AdminStateExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location('fixture_status_export', ROOT / 'deploy/admin/export_resource_state.py')
        self.exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.exporter)
        self.exporter.SOURCE = self.folder / 'latest-run.json'
        self.exporter.TARGET = self.folder / 'status.json'
        self.pointer = self.folder / 'current.json'
        mapper = lambda value: self.pointer if str(value).endswith('/content/current.json') else Path(value)
        replace_path = patch.object(self.exporter, 'Path', side_effect=mapper)
        replace_path.start()
        self.addCleanup(replace_path.stop)
        self.exporter.SOURCE.write_text(json.dumps({'status': 'passed', 'steps': [{'name': 'verify', 'status': 'passed'}], 'error': 'synthetic-private-detail'}))

    def result(self):
        self.exporter.export()
        return json.loads(self.exporter.TARGET.read_text())

    def test_ready_inputs_and_verified_candidate_reach_admin_without_private_fields(self):
        (self.folder / 'manual-inputs.json').write_text('{}')
        self.pointer.write_text(json.dumps({'contentReleaseId': 'fixture-current'}))
        (self.folder / 'manual-candidate.json').write_text(json.dumps({
            'id': 'fixture-candidate', 'contentReleaseId': 'fixture-next',
            'publicationBaseline': hashlib.sha256(self.pointer.read_bytes()).hexdigest(),
            'privateConfiguration': 'synthetic-private-detail',
        }))
        result = self.result()
        self.assertTrue(result['inputsReady'])
        self.assertEqual(result['currentRelease'], 'fixture-current')
        self.assertEqual(result['candidate'], {'id': 'fixture-candidate', 'contentReleaseId': 'fixture-next', 'stale': False})
        self.assertNotIn('synthetic-private-detail', json.dumps(result))
        self.pointer.write_text(json.dumps({'contentReleaseId': 'fixture-changed'}))
        self.assertTrue(self.result()['candidate']['stale'])

    def test_absent_inputs_candidate_and_pointer_do_not_claim_readiness(self):
        result = self.result()
        self.assertFalse(result['inputsReady'])
        self.assertEqual(result['currentRelease'], '')
        self.assertNotIn('candidate', result)


class PublishedEditionRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = (ROOT / 'deploy/independent-content.locations.conf').read_text()
        cls.locations = [(selector, block or inline) for selector, block, inline in
                         re.findall(r'^location ([^\n]+?) \{(?:\n(.*?)^\}|([^\n]*?)\})', text, re.M | re.S)]

    def location(self, uri):
        for selector, body in self.locations:
            if selector.startswith('= ') and selector[2:] == uri:
                return body
        for selector, body in self.locations:
            if selector.startswith(('~ ', '~* ')):
                prefix, pattern = selector.split(' ', 1)
                if re.search(pattern.strip('"'), uri, re.I if prefix == '~*' else 0):
                    return body
        self.fail('Missing published route: ' + uri)

    def test_each_content_pointer_has_an_explicit_uncached_route(self):
        for uri, filename in (('/content/current.json', '/content/current.json'),
                              ('/content/global/current.json', '/content/current.json'),
                              ('/content/jp/current.json', '/content/jp/current.json')):
            with self.subTest(uri=uri):
                body = self.location(uri)
                self.assertIn(filename, body)
                self.assertIn('no-store', body)

    def test_both_editions_use_prerendered_pages_and_shared_static_assets(self):
        for edition in ('global', 'jp'):
            with self.subTest(edition=edition):
                body = self.location('/' + edition + '/en/database/members/')
                self.assertIn('/srv/ournotes-rendered/', body)
                self.assertIn('try_files', body)
                self.assertIn('/__ournotes_frontend', body)
                static = self.location('/' + edition + '/en/brand/fixture.svg')
                self.assertIn('/srv/ournotes-code/current/compiled/', static)

    def test_media_retains_existing_connection_limits(self):
        body = self.location('/content/releases/' + 'a' * 24 + '/public/media/fixture.m4a')
        self.assertIn('limit_conn ournotes_media_per_ip 8;', body)
        self.assertIn('limit_conn ournotes_media_global 24;', body)

    def test_sealed_render_payloads_are_served_and_content_receipts_remain_hidden(self):
        body = self.location('/rendered/releases/' + 'a' * 24 + '-' + 'b' * 24 + '/payloads/' + 'c' * 64 + '.json')
        self.assertIn('/srv/ournotes-rendered/releases/', body)
        self.assertIn('immutable', body)
        hidden = self.location('/content/releases/' + 'a' * 24 + '/.receipt.json')
        self.assertIn('return 404', hidden)


if __name__ == '__main__':
    unittest.main()
