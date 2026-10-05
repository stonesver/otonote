import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.admin.node import create_node, profile_state
from deploy.admin.export_r2_delivery_state import collect, export


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class DeliveryExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = self.root / 'content'
        self.rendered = self.root / 'rendered'
        self.target = self.root / 'status/latest-run.json'
        self.content.mkdir()
        (self.content / 'jp').mkdir()
        (self.content / 'releases').mkdir()
        (self.rendered / 'releases').mkdir(parents=True)
        pointers = {}
        for region, release_id in (('global', 'a' * 24), ('jp', 'b' * 24)):
            content_id = region + '-release'
            manifest = {'schemaVersion': 1, 'region': region,
                        'root': '/content/releases/' + release_id + '/',
                        'contentReleaseId': content_id}
            raw_manifest = encoded(manifest)
            release = self.content / 'releases' / release_id
            release.mkdir()
            (release / 'manifest.json').write_bytes(raw_manifest)
            pointer = {'schemaVersion': 1, 'manifest': '/content/releases/' + release_id + '/manifest.json',
                       'sha256': hashlib.sha256(raw_manifest).hexdigest(), 'contentReleaseId': content_id}
            raw_pointer = encoded(pointer)
            (self.content / ('current.json' if region == 'global' else 'jp/current.json')).write_bytes(raw_pointer)
            receipt = {'schemaVersion': 1, 'region': region, 'releaseId': release_id,
                       'pointerSha256': hashlib.sha256(raw_pointer).hexdigest(),
                       'manifestSha256': pointer['sha256'],
                       'objects': {'manifest.json': {'sha256': pointer['sha256'], 'bytes': len(raw_manifest)}}}
            (release / '.r2-materialization-receipt.json').write_bytes(encoded(receipt))
            pointers[region] = pointer
        for region, suffix, pair in (('global', '', 'c' * 24 + '-' + 'a' * 24),
                                     ('jp', '-jp', 'c' * 24 + '-' + 'b' * 24)):
            other = 'jp' if region == 'global' else 'global'
            final = self.rendered / 'releases' / pair
            final.mkdir()
            augmented = dict(pointers[region], libraryPointers={other: pointers[other]})
            (final / 'complete.json').write_bytes(encoded({'schemaVersion': 1, 'region': region,
                                                            'pair': pair, 'codeId': 'c' * 24,
                                                            'pointer': augmented}))
            (self.rendered / ('current' + suffix)).symlink_to('releases/' + pair)

    def test_exports_only_local_verified_delivery_and_replaces_stale_success(self):
        self.assertTrue(export(self.content, self.rendered, self.target))
        data = json.loads(self.target.read_text())
        self.assertEqual(data['productionOwner'], 'github-actions-r2')
        self.assertEqual(data['delivery']['status'], 'ready')
        self.assertEqual(set(data['delivery']['regions']), {'global', 'jp'})
        self.assertNotIn('currentRelease', data)
        (self.rendered / 'releases' / ('c' * 24 + '-' + 'b' * 24) / 'complete.json').write_text('{}')
        self.assertFalse(export(self.content, self.rendered, self.target))
        self.assertEqual(json.loads(self.target.read_text())['delivery'],
                         {'status': 'unavailable', 'regions': {}})

    def test_pointer_or_receipt_identity_mismatch_fails_closed(self):
        self.assertEqual(len(collect(self.content, self.rendered)), 2)
        pointer = self.content / 'jp/current.json'
        pointer.write_bytes(pointer.read_bytes() + b' ')
        self.assertFalse(export(self.content, self.rendered, self.target))

    def test_linked_materialization_receipt_is_rejected(self):
        receipt = self.content / 'releases' / ('a' * 24) / '.r2-materialization-receipt.json'
        saved = receipt.read_bytes()
        receipt.unlink()
        elsewhere = self.root / 'elsewhere.json'
        elsewhere.write_bytes(saved)
        receipt.symlink_to(elsewhere)
        self.assertFalse(export(self.content, self.rendered, self.target))


class DeliveryNodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'latest-run.json'
        self.profile = {'id': 'global', 'workspace': str(self.root),
                        'productionSource': 'github-actions-r2',
                        'capabilities': ['check', 'fetch', 'build', 'publish'],
                        'publishUsers': ['owner']}

    def test_explicit_migration_marker_rejects_legacy_state_without_affecting_other_profiles(self):
        self.state.write_text(json.dumps({'status': 'passed', 'currentRelease': 'old-release'}))
        migrated = profile_state(self.profile)
        self.assertEqual(migrated['status'], 'unavailable')
        self.assertEqual(migrated['capabilities'], [])
        self.assertEqual(migrated['publication'], 'disabled')
        self.assertNotIn('currentRelease', migrated)
        original = profile_state({key: value for key, value in self.profile.items()
                                  if key != 'productionSource'})
        self.assertEqual(original['status'], 'passed')
        self.assertEqual(original['currentRelease'], 'old-release')

    def test_new_delivery_status_is_read_only_and_old_tasks_are_rejected(self):
        regions = {region: {'contentReleaseId': region + '-release', 'releaseId': 'a' * 24,
                            'manifestSha256': 'b' * 64, 'renderPair': 'c' * 24 + '-' + 'd' * 24}
                   for region in ('global', 'jp')}
        self.state.write_text(json.dumps({'schemaVersion': 2, 'productionOwner': 'github-actions-r2',
                                          'status': 'passed', 'delivery': {'status': 'ready', 'regions': regions}}))
        self.assertEqual(profile_state(self.profile)['delivery']['regions'], regions)
        config = {'schemaVersion': 1, 'role': 'node', 'port': 18082,
                  'database': str(self.root / 'tasks.sqlite'),
                  'readTokenEnv': 'ADMIN_R2_READ', 'writeTokenEnv': 'ADMIN_R2_WRITE',
                  'profiles': [self.profile]}
        with patch.dict('os.environ', {'ADMIN_R2_READ': 'r' * 40, 'ADMIN_R2_WRITE': 'w' * 40}):
            app = create_node(config)
            try:
                with TestClient(app) as client:
                    response = client.post('/tasks', json={'profile': 'global', 'action': 'check',
                                                           'key': 'x' * 32, 'actor': 'owner'},
                                           headers={'Authorization': 'Bearer ' + 'w' * 40})
                    self.assertEqual(response.status_code, 403)
                    state = client.get('/state', headers={'Authorization': 'Bearer ' + 'r' * 40}).json()
                    self.assertEqual(state['profiles'][0]['delivery']['status'], 'ready')
            finally:
                app.state.jobs.close()

    def test_old_or_future_delivery_sample_never_remains_ready(self):
        regions = {region: {'contentReleaseId': region + '-release', 'releaseId': 'a' * 24,
                            'manifestSha256': 'b' * 64, 'renderPair': 'c' * 24 + '-' + 'd' * 24}
                   for region in ('global', 'jp')}
        self.state.write_text(json.dumps({'schemaVersion': 2, 'productionOwner': 'github-actions-r2',
                                          'status': 'passed', 'delivery': {'status': 'ready', 'regions': regions}}))
        self.assertEqual(profile_state(self.profile)['status'], 'passed')
        for stamp in (time.time() - 361, time.time() + 61):
            os.utime(self.state, (stamp, stamp))
            result = profile_state(self.profile)
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['updatedAt'], stamp)
            self.assertNotIn('delivery', result)
