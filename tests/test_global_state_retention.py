import copy
import json
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tools import r2_state
from tools.global_remote_sync import write_json, file_hash
from tools.r2_production_gate import RECEIPT_FIELD, RECEIPT_SCHEMA, canonical, digest
from tests.test_r2_state import FakePrivateBucket


class GlobalWorkingSetTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root/'output/global-update-workflow'
        self.sync = self.workspace/'sync-complete'
        self.current = self.sync/'1.0.0.400-aaaaaaaa-bbbbbbbb-complete-v3-cccccccc-ddddddddddddd'
        self.old = self.sync/'1.0.0.300-aaaaaaaa-bbbbbbbb-complete-v3-cccccccc-ddddddddddddd'
        self.plan = self.current/'inputs/release-inputs.json'
        write_json(self.plan, {'schemaVersion': 1, 'environments': [{'region': 'global',
            'manifest': str(self.current.relative_to(self.root)/'inputs/content-release.json')}]})
        write_json(self.current/'inputs/content-release.json', {'schemaVersion': 1})
        write_json(self.current/'snapshot/report.json', {'status': 'verified_snapshot'})
        for i in range(20):
            write_json(self.old/f'inputs/{i}.json', {'old': i})
        observation = {'clientVersion': '1.2.3', 'resourceVersion': '1.0.0.400',
                       'masterVersion': 'a'*32, 'catalogHash': 'b'*32, 'cdnRoot': 'https://example.invalid'}
        write_json(self.sync/'state.json', {'inputPlan': str(self.plan), 'snapshot': str(self.current/'snapshot'),
                                          'observation': observation, 'pipelineVersion': 3})
        self.config = self.root/'config/global.json'
        write_json(self.config, {'workspace': str(self.workspace.relative_to(self.root)), 'completeContent': True})
        self.production = {'status': 'content_published', 'inputPlan': str(self.plan),
            'inputPlanSha256': file_hash(self.plan), 'observation': observation,
            'publication': {'pointer': {'releaseId': 'synthetic'}}}
        self.state = copy.deepcopy(self.production)
        receipt = {key: 'a'*64 for key in ('sourceSha256', 'packageSha256', 'producerCodeSha256',
            'codeSha256', 'inputSha256', 'imageDigest', 'publicPointerSha256')}
        receipt.update(schemaVersion=RECEIPT_SCHEMA, region='global',
            stateSha256=digest(canonical(self.production)), publicPointer=self.production['publication']['pointer'],
            inputPaths={'config': 'config/global.json', 'decoderProfile': 'config/decoder.json'},
            trustedInputInventory=[{'path': 'config/global.json', 'sha256': file_hash(self.config), 'size': self.config.stat().st_size}])
        self.state[RECEIPT_FIELD] = receipt
        write_json(self.workspace/'state.json', self.state)
        write_json(self.workspace/'clients/old-trusted/decoder.json', {'trusted': True})
        self.paths = ['config', 'output/global-update-workflow']
        self.bucket = FakePrivateBucket()
        self.addCleanup(patch.stopall)
        patch('tools.r2_production_gate.trusted_input_inventory', return_value=receipt['trustedInputInventory']).start()
        self.preflight = patch('tools.r2_production_gate.verified_plan', return_value=True).start()

    def checkpoint(self):
        return r2_state.checkpoint(self.bucket, self.root, 'global', self.paths, 'none',
            global_working_set=(self.config, self.production))

    def test_bounded_manifest_retains_current_and_trusted_client_without_deletion(self):
        with patch.object(r2_state, 'MANIFEST_LIMIT', 3500):
            with self.assertRaisesRegex(ValueError, 'manifest is too large'):
                r2_state.checkpoint(self.bucket, self.root, 'global', self.paths, 'none')
            result = self.checkpoint()
        self.assertEqual(result['status'], 'checkpointed')
        self.assertEqual(result['excludedGlobalRuns'], 1)
        self.assertTrue(self.old.exists())
        manifest, _ = self.bucket.read_manifest('state/manifests/global/'+result['manifestSha256']+'.json')
        names = [row['path'] for row in json.loads(manifest)['files']]
        self.assertTrue(any('old-trusted/decoder.json' in p for p in names))
        self.assertIn(str(self.plan.relative_to(self.root)), names)
        self.assertFalse(any(str(self.old.relative_to(self.root)) in p for p in names))

    def test_missing_receipt_or_invalid_production_fails_before_writes(self):
        self.state.pop(RECEIPT_FIELD)
        write_json(self.workspace/'state.json', self.state)
        with self.assertRaises(ValueError): self.checkpoint()
        self.assertEqual(self.bucket.objects, {})

    def test_cold_restore_uses_small_working_set_and_old_cloud_manifest_survives(self):
        previous = r2_state.checkpoint(self.bucket, self.root, 'global', self.paths, 'none')
        old_key = 'state/manifests/global/'+previous['manifestSha256']+'.json'
        old_manifest = self.bucket.objects[old_key]
        result = r2_state.checkpoint(self.bucket, self.root, 'global', self.paths, previous['pointerSha256'],
            global_working_set=(self.config, self.production))
        shutil.rmtree(self.root/'output'); shutil.rmtree(self.root/'config')
        r2_state.restore(self.bucket, self.root, 'global', self.paths)
        self.assertTrue(self.plan.is_file())
        self.assertTrue((self.workspace/'clients/old-trusted/decoder.json').is_file())
        self.assertFalse(self.old.exists())
        self.assertEqual(self.bucket.objects[old_key], old_manifest)
        self.assertLess(result['manifestBytes'], previous['manifestBytes'])

    def test_new_observation_time_does_not_invalidate_same_source(self):
        self.production['observation']['observedAt'] = 'later'
        self.state['observation'] = self.production['observation']
        self.state[RECEIPT_FIELD]['stateSha256'] = digest(canonical(self.production))
        write_json(self.workspace/'state.json', self.state)
        self.assertEqual(self.checkpoint()['excludedGlobalRuns'], 1)

    def test_failed_preflight_preserves_everything(self):
        self.preflight.return_value = False
        with self.assertRaises(ValueError): self.checkpoint()
        self.assertEqual(self.bucket.objects, {})
        self.assertTrue(self.old.exists())

    def test_plan_reference_to_old_run_keeps_it(self):
        value = json.loads(self.plan.read_text())
        value['environments'][0]['supplementalInputs'] = {'root': str(self.old.relative_to(self.root)/'inputs')}
        write_json(self.plan, value)
        self.production['inputPlanSha256'] = file_hash(self.plan)
        self.state.update(self.production)
        self.state[RECEIPT_FIELD]['stateSha256'] = digest(canonical(self.production))
        write_json(self.workspace/'state.json', self.state)
        self.assertEqual(self.checkpoint()['excludedGlobalRuns'], 0)

    def test_unknown_directory_or_link_aborts_without_remote_writes(self):
        unknown = self.sync/'unrecognized'; unknown.mkdir()
        with self.assertRaises(ValueError): self.checkpoint()
        unknown.rmdir()
        (self.old/'linked').symlink_to(self.config)
        with self.assertRaises(ValueError): self.checkpoint()
        self.assertEqual(self.bucket.objects, {})
