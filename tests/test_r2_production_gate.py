from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tools import r2_production_gate as gate


IMAGE = "ghcr.io/example/producer@sha256:" + "a" * 64
RELEASE = "1" * 24
ORIGINAL_CODE_FINGERPRINTS = gate.code_fingerprints


class Bucket:
    def __init__(self, pointer: bytes, manifest: bytes):
        self.objects = {
            "content/current.json": pointer,
            f"content/releases/{RELEASE}/manifest.json": manifest,
        }
        self.calls = []
        self.next_pointer = None

    def get(self, key):
        self.calls.append(key)
        if key == "content/current.json" and self.next_pointer is not None and self.calls.count(key) == 2:
            return self.next_pointer, 'changed'
        raw = self.objects.get(key)
        return (raw, 'same') if raw is not None else None


class ProductionGateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "config/production.json"
        self.profile = self.root / "config/decoder.json"
        self.config.parent.mkdir(parents=True)
        self.config.write_text('{}')
        self.profile.write_text('{}')
        self.plan = self.root / "output/global-update-workflow/sync-complete/inputs/release-inputs.json"
        self.plan.parent.mkdir(parents=True)
        self.plan.write_text('{}')
        self.state_path = self.root / "output/global-update-workflow/state.json"
        self.store = self.root / "output/r2-global-content"
        (self.store / 'releases' / RELEASE).mkdir(parents=True)
        self.manifest = gate.canonical({
            'schemaVersion': 1, 'channel': 'production', 'region': 'global',
            'contentReleaseId': 'global-source',
            'root': f'/content/releases/{RELEASE}/', 'locales': {'en': {}, 'zh-CN': {}},
        })
        (self.store / 'releases' / RELEASE / 'manifest.json').write_bytes(self.manifest)
        self.pointer = {
            'schemaVersion': 1, 'contentReleaseId': 'global-source',
            'manifest': f'/content/releases/{RELEASE}/manifest.json',
            'sha256': gate.digest(self.manifest),
        }
        self.pointer_bytes = gate.canonical(self.pointer)
        (self.store / 'current.json').write_bytes(self.pointer_bytes)
        self.bucket = Bucket(self.pointer_bytes, self.manifest)
        self.observation = {
            'environmentId': 'global-production', 'serverAreaId': '2',
            'clientVersion': '1.0.1', 'cdnRoot': 'https://example.invalid/prod',
            'masterVersion': 'master-a', 'resourceVersion': 'resource-a',
            'catalogHash': 'catalog-a',
        }
        self.package = {'url': 'https://example.invalid/client.apk', 'byteSize': 123,
                        'etag': None}
        input_paths = {'config': 'config/production.json', 'decoderProfile': 'config/decoder.json'}
        input_sha, _ = gate.input_identity(self.root, 'global', input_paths)
        self.probe = {
            'schemaVersion': 1, 'region': 'global',
            'sourceSha256': gate.source_identity(self.observation),
            'packageSha256': gate.package_identity('global', self.package),
            'producerCodeSha256': 'b' * 64, 'codeSha256': 'c' * 64,
            'inputSha256': input_sha, 'imageDigest': 'a' * 64,
            'inputPaths': input_paths,
        }
        self.state = {
            'status': 'content_published', 'inputPlan': str(self.plan),
            'inputPlanSha256': gate.file_hash(self.plan),
            'observation': self.observation, 'package': self.package,
            'publication': {'status': 'content_published', 'pointer': self.pointer,
                            'snapshot': str(self.store / 'releases' / RELEASE)},
        }
        self.state_path.write_bytes(gate.canonical(self.state))
        self.upload = {'region': 'global', 'releaseId': RELEASE,
                       'pointerSha256': gate.digest(self.pointer_bytes), 'files': 3,
                       'uploaded': 3, 'reused': 0}
        self.public_before = {'region': 'global',
                              'currentSha256': gate.digest(self.pointer_bytes)}
        self.code_patch = patch.object(gate, 'code_fingerprints', return_value=('b' * 64, 'c' * 64))
        self.code_patch.start()
        self.addCleanup(self.code_patch.stop)
        self.preflight_patch = patch('tools.release_preflight.inspect_plan', return_value={'status': 'passed'})
        self.preflight_patch.start()
        self.addCleanup(self.preflight_patch.stop)

    def recorded(self):
        result = gate.record(self.root, 'global', self.probe, self.state, self.upload,
                             self.store, image=IMAGE)
        self.assertEqual(result['status'], 'recorded')
        return gate.read_json(self.state_path)

    def check(self, *, probe=None, image=IMAGE):
        return gate.check(self.bucket, self.root, 'global', probe or self.probe,
                          self.public_before, image=image)

    def test_promoted_unchanged_release_skips_without_mutation(self):
        self.recorded()
        before = self.state_path.read_bytes()
        result = self.check()
        self.assertEqual(result['status'], 'unchanged')
        self.assertTrue(result['skip'])
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertEqual(self.bucket.calls, ['content/current.json',
                         f'content/releases/{RELEASE}/manifest.json', 'content/current.json'])

    def test_missing_receipt_needs_production_without_public_requests(self):
        result = self.check()
        self.assertEqual(result['status'], 'needs_production')
        self.assertFalse(result['skip'])
        self.assertEqual(self.bucket.calls, [])

    def test_code_image_version_and_package_changes_need_production(self):
        self.recorded()
        for key in ('codeSha256', 'sourceSha256', 'packageSha256'):
            changed = dict(self.probe, **{key: 'f' * 64})
            with self.subTest(key=key):
                self.assertEqual(self.check(probe=changed)['status'], 'needs_production')
        self.assertEqual(self.check(image='ghcr.io/example/producer@sha256:' + 'e' * 64)['status'],
                         'needs_production')

    def test_config_and_plan_changes_cannot_skip(self):
        self.recorded()
        self.config.write_text('{"changed":true}')
        self.assertEqual(self.check()['reason'], 'input_changed')
        self.config.write_text('{}')
        self.profile.write_text('{"changed":true}')
        self.assertEqual(self.check()['reason'], 'input_changed')
        self.profile.write_text('{}')
        self.plan.write_text('{"changed":true}')
        self.assertEqual(self.check()['reason'], 'plan_unverified')

    def test_jp_trusted_metadata_package_and_unity_inputs_are_bound(self):
        from tools import jp_phone_inputs
        folder = self.root / 'output/r2-jp'
        folder.mkdir(parents=True)
        metadata = folder / 'metadata.v39.dat'
        metadata.write_bytes(b'reviewed metadata')
        apk_root = folder / 'apks'
        apk_root.mkdir()
        unity = folder / 'unity-version.txt'
        unity.write_text('2022.3.17f1')
        paths = {'metadata': 'output/r2-jp/metadata.v39.dat',
                 'apkRoot': 'output/r2-jp/apks',
                 'unityVersion': 'output/r2-jp/unity-version.txt'}
        package = {'packageSetSha256': 'e' * 64, 'versionName': '1.0.4',
                   'versionCode': 10053, 'certificateSha256': 'f' * 64}
        with patch.object(jp_phone_inputs, 'JP_METADATA_SHA256', gate.file_hash(metadata)), \
             patch.object(jp_phone_inputs, 'JP_REVIEWED_PACKAGE_SET_SHA256', 'e' * 64), \
             patch.object(jp_phone_inputs, 'JP_CERTIFICATE_SHA256', 'f' * 64), \
             patch('tools.resource_pipeline.package_intake.build_package_set_manifest', return_value=package):
            original, package_sha = gate.input_identity(self.root, 'jp', paths)
            self.assertEqual(package_sha, gate.package_identity('jp', package))
            unity.write_text('2022.3.18f1')
            changed, _ = gate.input_identity(self.root, 'jp', paths)
            self.assertNotEqual(changed, original)
            metadata.write_bytes(b'unreviewed metadata')
            with self.assertRaisesRegex(gate.GateError, 'unreviewed JP package or metadata'):
                gate.input_identity(self.root, 'jp', paths)

    def test_shadow_never_promoted_cannot_skip(self):
        self.recorded()
        self.bucket.objects['content/current.json'] = b'{"other":"old"}\n'
        self.assertEqual(self.check()['reason'], 'public_pointer_unmatched')

    def test_matched_but_damaged_manifest_fails_closed(self):
        self.recorded()
        self.bucket.objects[f'content/releases/{RELEASE}/manifest.json'] = b'broken'
        with self.assertRaisesRegex(gate.GateError, 'manifest is missing or damaged'):
            self.check()

    def test_pointer_change_during_manifest_check_cannot_skip(self):
        self.recorded()
        self.bucket.next_pointer = b'{"other":"new"}\n'
        self.assertEqual(self.check()['reason'], 'public_pointer_changed')

    def test_probe_production_mismatch_does_not_write_receipt(self):
        before = self.state_path.read_bytes()
        changed = dict(self.state, observation=dict(self.observation, catalogHash='new'))
        with self.assertRaisesRegex(gate.GateError, 'production output differs from probe'):
            gate.record(self.root, 'global', self.probe, changed, self.upload, self.store,
                        image=IMAGE)
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_record_rejects_missing_upload_evidence(self):
        before = self.state_path.read_bytes()
        with self.assertRaisesRegex(gate.GateError, 'verified R2 upload differs'):
            gate.record(self.root, 'global', self.probe, self.state,
                        dict(self.upload, pointerSha256='0' * 64), self.store, image=IMAGE)
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_plan_binding_checks_actual_file_sha_before_preflight(self):
        self.assertTrue(gate.verified_plan(self.root, 'global', self.state))
        self.plan.write_text('different')
        self.assertFalse(gate.verified_plan(self.root, 'global', self.state))

    def test_workflow_hash_changes_complete_code_fingerprint(self):
        with patch('tools.jp_update.fingerprint', return_value='b' * 64):
            with patch.object(gate, 'file_hash', return_value='1' * 64):
                first = ORIGINAL_CODE_FINGERPRINTS(gate.ROOT)
            with patch.object(gate, 'file_hash', return_value='2' * 64):
                second = ORIGINAL_CODE_FINGERPRINTS(gate.ROOT)
        self.assertEqual(first[0], second[0])
        self.assertNotEqual(first[1], second[1])

    def test_global_probe_uses_verified_new_apk_version_before_source_discovery(self):
        package = dict(self.package)
        clients = []

        class Client:
            def __init__(self, version):
                self.version = version
                clients.append(version)

            def discover(self):
                return dict(self_observation, clientVersion=self.version)

        self_observation = self.observation
        loaded = {'clientVersion': '1.0.1', 'intakePackages': True,
                  'workspace': self.root / 'output/global-update-workflow',
                  'apksigJar': 'tools/resource_pipeline/apksig.jar'}
        with patch.object(gate, 'stable_root', return_value=self.root), \
             patch('tools.global_update.load_config', return_value=loaded), \
             patch('tools.resource_pipeline.adapters.global_public.GlobalPublicClient', Client), \
             patch('tools.resource_pipeline.adapters.global_public.discover_package', return_value=package), \
             patch('tools.current_client.intake', return_value={'clientVersion': '1.0.2'}) as verified:
            observed = gate.probe(self.root, 'global', IMAGE, config=self.config,
                                  decoder_profile=self.profile)
        self.assertEqual(clients, ['1.0.1', '1.0.2'])
        verified.assert_called_once_with(package, loaded['workspace'] / 'clients',
                                         self.root / loaded['apksigJar'])
        self.assertEqual(observed['sourceSha256'],
                         gate.source_identity(dict(self.observation, clientVersion='1.0.2')))
        self.assertEqual(observed['packageSha256'], gate.package_identity('global', package))

    def test_global_probe_refuses_unverified_apk_and_never_discovers_source(self):
        class Client:
            def __init__(self, version):
                self.version = version

            def discover(self):
                raise AssertionError('unverified APK must not reach the source probe')

        loaded = {'clientVersion': '1.0.1', 'intakePackages': True,
                  'workspace': self.root / 'output/global-update-workflow',
                  'apksigJar': 'tools/resource_pipeline/apksig.jar'}
        with patch.object(gate, 'stable_root', return_value=self.root), \
             patch('tools.global_update.load_config', return_value=loaded), \
             patch('tools.resource_pipeline.adapters.global_public.GlobalPublicClient', Client), \
             patch('tools.resource_pipeline.adapters.global_public.discover_package', return_value=self.package), \
             patch('tools.current_client.intake', side_effect=ValueError('invalid signer')):
            with self.assertRaisesRegex(ValueError, 'invalid signer'):
                gate.probe(self.root, 'global', IMAGE, config=self.config,
                           decoder_profile=self.profile)

    def test_record_accepts_verified_new_client_version_from_probe(self):
        upgraded = dict(self.observation, clientVersion='1.0.2')
        self.probe['sourceSha256'] = gate.source_identity(upgraded)
        self.state['observation'] = upgraded
        self.state_path.write_bytes(gate.canonical(self.state))
        result = self.recorded()
        self.assertEqual(result[gate.RECEIPT_FIELD]['sourceSha256'], self.probe['sourceSha256'])

    def test_jp_receipt_uses_restored_workspace_and_detects_observation_change(self):
        jp_store = self.root / 'output/r2-jp-content'
        (jp_store / 'jp').mkdir(parents=True)
        (jp_store / 'releases' / RELEASE).mkdir(parents=True)
        manifest = gate.canonical({'schemaVersion': 1, 'region': 'jp',
            'channel': 'production', 'contentReleaseId': 'jp-source',
            'root': f'/content/releases/{RELEASE}/', 'locales': {'en': {}, 'zh-CN': {}}})
        (jp_store / 'releases' / RELEASE / 'manifest.json').write_bytes(manifest)
        pointer = {'schemaVersion': 1, 'contentReleaseId': 'jp-source',
                   'manifest': f'/content/releases/{RELEASE}/manifest.json',
                   'sha256': gate.digest(manifest)}
        pointer_bytes = gate.canonical(pointer)
        (jp_store / 'jp/current.json').write_bytes(pointer_bytes)
        run_id = '4' * 24
        plan = self.root / 'output/r2-jp/workspace/runs' / run_id / 'inputs/release-inputs.json'
        plan.parent.mkdir(parents=True)
        plan.write_text('{}')
        observation = dict(self.observation, environmentId='jp-production', serverAreaId='1',
                           clientVersion='1.0.4')
        identity = list(gate.version_identity(observation))
        state = {'status': 'built', 'runId': run_id,
                 'inputPlanSha256': gate.file_hash(plan),
                 'versionIdentity': identity, 'codeFingerprint': 'b' * 64,
                 'publication': {'pointer': pointer, 'status': 'content_published'}}
        state_path = gate.state_path(self.root, 'jp')
        state_path.write_bytes(gate.canonical(state))
        probe = dict(self.probe, region='jp', sourceSha256=gate.source_identity(identity),
                     packageSha256='e' * 64, inputSha256='d' * 64,
                     inputPaths={'metadata': 'output/r2-jp/metadata.v39.dat',
                                 'apkRoot': 'output/r2-jp/apks',
                                 'unityVersion': 'output/r2-jp/unity-version.txt'})
        upload = dict(self.upload, region='jp', pointerSha256=gate.digest(pointer_bytes))
        bucket = Bucket(pointer_bytes, manifest)
        bucket.objects['content/jp/current.json'] = bucket.objects.pop('content/current.json')
        with patch.object(gate, 'current_input_identity', return_value=True):
            result = gate.record(self.root, 'jp', probe, state, upload, jp_store, image=IMAGE)
            self.assertEqual(result['status'], 'recorded')
            before = {'region': 'jp', 'currentSha256': gate.digest(pointer_bytes)}
            self.assertTrue(gate.check(bucket, self.root, 'jp', probe, before, image=IMAGE)['skip'])
            state['versionIdentity'][-1] = 'changed'
            state_path.write_bytes(gate.canonical(state))
            with self.assertRaisesRegex(gate.GateError, 'JP observation changed'):
                gate.record(self.root, 'jp', probe, state, upload, jp_store, image=IMAGE)


if __name__ == '__main__':
    unittest.main()
