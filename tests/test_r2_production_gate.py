from __future__ import annotations

import json
from pathlib import Path
import shutil
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


class PrivateBucket:
    def __init__(self, root: Path, region: str, selections: list[str], files: dict[str, bytes],
                 *, extra: list[dict] = ()):
        manifest = {'schemaVersion': 2, 'region': region, 'root': str(root),
                    'selections': sorted(selections), 'directories': [],
                    'files': sorted([{'path': name, 'sha256': gate.digest(data), 'size': len(data)}
                                     for name, data in files.items()] + list(extra),
                                    key=lambda entry: entry['path'])}
        manifest_bytes = gate.canonical(manifest)
        manifest_sha = gate.digest(manifest_bytes)
        self.pointer = gate.canonical({'schemaVersion': 1, 'region': region,
                                       'manifest': f'state/manifests/{region}/{manifest_sha}.json',
                                       'sha256': manifest_sha})
        self.manifest = manifest_bytes
        self.objects = {f'state/objects/{gate.digest(data)}': data for data in files.values()}
        self.downloads = []
        self.reads = []
        self.next_pointer = None

    def read_small(self, key):
        self.reads.append(key)
        raw = self.next_pointer if self.next_pointer is not None and self.reads.count(key) > 2 else self.pointer
        return raw, 'etag'

    def read_manifest(self, key):
        self.reads.append(key)
        return self.manifest, 'etag'

    def download_file(self, key, target, sha, size):
        self.downloads.append(key)
        data = self.objects[key]
        if gate.digest(data) != sha or len(data) != size:
            raise ValueError('private state object missing or damaged')
        target.write_bytes(data)


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

    def light_fixture(self, *, with_receipt=True):
        self.package.update(etag='"trusted-etag"', lastModified='Tue, 01 Oct 2026 00:00:00 GMT')
        self.probe['packageSha256'] = gate.package_identity('global', self.package)
        self.state['package'] = self.package
        self.state_path.write_bytes(gate.canonical(self.state))
        if with_receipt:
            self.recorded()
        (self.root / 'output/tmp').mkdir(parents=True, exist_ok=True)
        selections = ['config/production.json', 'config/decoder.json',
                      'output/global-update-workflow/state.json',
                      'output/global-update-workflow/cache']
        files = {str(self.config.relative_to(self.root)): self.config.read_bytes(),
                 str(self.profile.relative_to(self.root)): self.profile.read_bytes(),
                 str(self.state_path.relative_to(self.root)): self.state_path.read_bytes()}
        large = {'path': 'output/global-update-workflow/cache/large.bin',
                 'sha256': '9' * 64, 'size': 10_000_000_000}
        private = PrivateBucket(self.root, 'global', selections, files, extra=[large])
        return private, selections, self.root / 'output/tmp/r2-light'

    def test_promoted_unchanged_release_skips_without_mutation(self):
        self.recorded()
        before = self.state_path.read_bytes()
        result = self.check()
        self.assertEqual(result['status'], 'unchanged')
        self.assertTrue(result['skip'])
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertEqual(self.bucket.calls, ['content/current.json',
                         f'content/releases/{RELEASE}/manifest.json', 'content/current.json'])

    def test_light_gate_skips_without_downloading_large_private_state(self):
        private, selections, stage = self.light_fixture()
        with patch.object(gate, 'stable_root', return_value=self.root):
            prepared = gate.light_prepare(private, self.root, 'global', selections, stage,
                                          image=IMAGE, config='config/production.json',
                                          decoder_profile='config/decoder.json')
            self.assertEqual(prepared['status'], 'ready')
            class Client:
                def __init__(self, version):
                    self.version = version

                def discover(self):
                    return dict(self_observation, clientVersion=self.version)

            self_observation = self.observation
            with patch('tools.resource_pipeline.adapters.global_public.GlobalPublicClient', Client), \
                 patch('tools.resource_pipeline.adapters.global_public.discover_package', return_value=self.package):
                observed = gate.light_probe(self.root, 'global', stage / 'proof.json', image=IMAGE)
            result = gate.light_check(private, self.bucket, self.root, 'global',
                                      stage / 'proof.json', observed, self.public_before, image=IMAGE)
        self.assertTrue(result['skip'])
        self.assertEqual(result['status'], 'unchanged')
        self.assertEqual(len(private.downloads), 2)
        self.assertNotIn('state/objects/' + '9' * 64, private.downloads)

    def test_light_gate_legacy_receipt_and_client_upgrade_require_full_path(self):
        private, selections, stage = self.light_fixture(with_receipt=False)
        with patch.object(gate, 'stable_root', return_value=self.root):
            self.assertEqual(gate.light_prepare(private, self.root, 'global', selections, stage,
                             image=IMAGE, config='config/production.json',
                             decoder_profile='config/decoder.json')['status'], 'needs_full')
        (stage / 'state.json').unlink()
        stage.rmdir()
        private, selections, stage = self.light_fixture()
        with patch.object(gate, 'stable_root', return_value=self.root):
            prepared = gate.light_prepare(private, self.root, 'global', selections, stage,
                                          image=IMAGE, config='config/production.json',
                                          decoder_profile='config/decoder.json')
            self.assertEqual(prepared['status'], 'ready')
            from tools.resource_pipeline.adapters.global_public import ClientUpdateRequired
            with patch('tools.resource_pipeline.adapters.global_public.GlobalPublicClient') as client:
                client.return_value.discover.side_effect = ClientUpdateRequired(
                    '1.0.3', 'https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02.apk')
                observed = gate.light_probe(self.root, 'global', stage / 'proof.json', image=IMAGE)
                client.return_value.discover.assert_called_once()
            self.assertEqual(observed['reason'], 'client_update_required')
            self.assertEqual(gate.light_check(private, self.bucket, self.root, 'global',
                             stage / 'proof.json', observed, self.public_before,
                             image=IMAGE)['status'], 'needs_full')

    def test_light_gate_corrupt_private_manifest_fails_before_skip(self):
        private, selections, stage = self.light_fixture()
        private.manifest = b'corrupt'
        with patch.object(gate, 'stable_root', return_value=self.root):
            with self.assertRaises(ValueError):
                gate.light_prepare(private, self.root, 'global', selections, stage,
                                   image=IMAGE, config='config/production.json',
                                   decoder_profile='config/decoder.json')

    def test_light_gate_changed_private_config_requires_full_restore(self):
        private, selections, stage = self.light_fixture()
        files = {'config/production.json': b'{"changed":true}',
                 'config/decoder.json': self.profile.read_bytes(),
                 'output/global-update-workflow/state.json': self.state_path.read_bytes()}
        changed = PrivateBucket(self.root, 'global', selections, files,
                                extra=[{'path': 'output/global-update-workflow/cache/large.bin',
                                        'sha256': '9' * 64, 'size': 10_000_000_000}])
        with patch.object(gate, 'stable_root', return_value=self.root):
            result = gate.light_prepare(changed, self.root, 'global', selections, stage,
                                        image=IMAGE, config='config/production.json',
                                        decoder_profile='config/decoder.json')
        self.assertEqual(result['status'], 'needs_full')
        self.assertEqual(result['reason'], 'private_inputs_changed')

    def test_light_gate_private_pointer_change_during_prepare_requires_full(self):
        private, selections, stage = self.light_fixture()
        private.next_pointer = gate.canonical({'schemaVersion': 1, 'region': 'global',
            'manifest': 'state/manifests/global/' + '8' * 64 + '.json', 'sha256': '8' * 64})
        with patch.object(gate, 'stable_root', return_value=self.root):
            result = gate.light_prepare(private, self.root, 'global', selections, stage,
                                        image=IMAGE, config='config/production.json',
                                        decoder_profile='config/decoder.json')
        self.assertEqual(result['reason'], 'private_pointer_changed')
        self.assertFalse(stage.exists())

    def test_global_receipt_matches_clean_runner_without_private_config_files(self):
        from tools import jp_update
        root = self.root.resolve()
        private_config = self.root / 'config/global-update.r2.json'
        private_profile = self.root / 'config/bundle-decoder-profiles.json'
        public_config = self.root / 'config/public.json'
        private_config.write_text('{}')
        private_profile.write_text('{}')
        public_config.write_text('{"edition":"global"}')
        workflow = self.root / '.github/workflows/content-r2.yml'
        workflow.parent.mkdir(parents=True)
        workflow.write_text('name: fixture\n')
        self.package.update(etag='"trusted-etag"', lastModified='Tue, 01 Oct 2026 00:00:00 GMT')
        self.state['package'] = self.package
        self.state['inputPlan'] = str(root / self.plan.relative_to(self.root))
        self.state_path.write_bytes(gate.canonical(self.state))
        paths = {'config': 'config/global-update.r2.json',
                 'decoderProfile': 'config/bundle-decoder-profiles.json'}

        class Client:
            def __init__(self, version):
                self.version = version

            def discover(self):
                return observation

        observation = self.observation
        selections = [*paths.values(), 'output/global-update-workflow/state.json']
        stage = root / 'output/tmp/r2-light'
        stage.parent.mkdir(parents=True)
        with patch.object(gate, 'ROOT', root), \
             patch.object(jp_update, 'ROOT', root), \
             patch.object(jp_update, 'FINGERPRINT_ROOTS', {'config': frozenset({'.json'})}), \
             patch.object(jp_update, 'FINGERPRINT_FILES', ()), \
             patch.object(gate, 'code_fingerprints', ORIGINAL_CODE_FINGERPRINTS), \
             patch('tools.global_update.load_config', return_value={'clientVersion': '1.0.1', 'intakePackages': False,
                                                                      'workspace': root / 'output/global-update-workflow'}), \
             patch('tools.resource_pipeline.adapters.global_public.GlobalPublicClient', Client), \
             patch('tools.resource_pipeline.adapters.global_public.discover_package', return_value=self.package):
            observed = gate.probe(root, 'global', IMAGE, **{
                'config': paths['config'], 'decoder_profile': paths['decoderProfile']})
            gate.record(root, 'global', observed, self.state, self.upload, self.store, image=IMAGE)
            files = {name: (root / name).read_bytes() for name in paths.values()}
            files['output/global-update-workflow/state.json'] = self.state_path.read_bytes()
            private = PrivateBucket(root, 'global', selections, files)
            private_config.unlink()
            private_profile.unlink()
            result = gate.light_prepare(private, root, 'global', selections, stage,
                                        image=IMAGE, config=paths['config'],
                                        decoder_profile=paths['decoderProfile'])
            self.assertEqual(result['status'], 'ready')
            light_observation = {'status': 'probed', 'region': 'global',
                'sourceSha256': observed['sourceSha256'],
                'packageSha256': observed['packageSha256'],
                'stablePackageSha256': gate.digest(gate.canonical({key: self.package[key]
                    for key in ('url', 'byteSize', 'etag', 'lastModified')}))}
            self.assertTrue(gate.light_check(private, self.bucket, root, 'global',
                stage / 'proof.json', light_observation, self.public_before, image=IMAGE)['skip'])

            shutil.rmtree(stage)
            changed = dict(files, **{paths['config']: b'{"changed":true}'})
            changed_private = PrivateBucket(root, 'global', selections, changed)
            self.assertEqual(gate.light_prepare(changed_private, root, 'global', selections, stage,
                image=IMAGE, config=paths['config'], decoder_profile=paths['decoderProfile'])['reason'],
                'private_inputs_changed')
            shutil.rmtree(stage)
            public_config.write_text('{"edition":"changed"}')
            self.assertEqual(gate.light_prepare(private, root, 'global', selections, stage,
                image=IMAGE, config=paths['config'], decoder_profile=paths['decoderProfile'])['reason'],
                'source_changed')

    def test_light_gate_pointer_changes_after_probe_require_full(self):
        private, selections, stage = self.light_fixture()
        with patch.object(gate, 'stable_root', return_value=self.root):
            gate.light_prepare(private, self.root, 'global', selections, stage,
                               image=IMAGE, config='config/production.json',
                               decoder_profile='config/decoder.json')
            observed = {'status': 'probed', 'region': 'global',
                        'sourceSha256': gate.source_identity(self.observation),
                        'packageSha256': gate.package_identity('global', self.package),
                        'stablePackageSha256': gate.digest(gate.canonical({key: self.package[key]
                            for key in ('url', 'byteSize', 'etag', 'lastModified')}))}
            self.bucket.next_pointer = (self.pointer_bytes + b'changed', 'changed')
            result = gate.light_check(private, self.bucket, self.root, 'global',
                                      stage / 'proof.json', observed, self.public_before, image=IMAGE)
            self.assertEqual(result['reason'], 'pointer_changed')
            self.bucket.next_pointer = None
            private.next_pointer = gate.canonical({'schemaVersion': 1, 'region': 'global',
                'manifest': 'state/manifests/global/' + '8' * 64 + '.json', 'sha256': '8' * 64})
            result = gate.light_check(private, self.bucket, self.root, 'global',
                                      stage / 'proof.json', observed, self.public_before, image=IMAGE)
            self.assertEqual(result['reason'], 'pointer_changed')

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
        package = {'packageSetSha256': 'e' * 64, 'versionName': '1.0.5',
                   'versionCode': 10059, 'certificateSha256': 'f' * 64}
        with patch.object(jp_phone_inputs, 'JP_METADATA_SHA256', gate.file_hash(metadata)), \
             patch.object(jp_phone_inputs, 'JP_REVIEWED_PACKAGE_SET_SHA256', 'e' * 64), \
             patch.object(jp_phone_inputs, 'JP_CERTIFICATE_SHA256', 'f' * 64), \
             patch.object(jp_phone_inputs, 'JP_CLIENT_VERSION', '1.0.5'), \
             patch.object(jp_phone_inputs, 'JP_VERSION_CODE', 10059), \
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
                           clientVersion='1.0.5')
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
        seed = self.root / 'output/r2-jp'
        (seed / 'apks').mkdir(parents=True)
        (seed / 'metadata.v39.dat').write_bytes(b'reviewed metadata fixture')
        (seed / 'unity-version.txt').write_text('2022.3.17f1')
        (seed / 'apks/base.apk').write_bytes(b'reviewed package fixture')
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


class LightJpGateTests(unittest.TestCase):
    def setUp(self):
        from tools import jp_phone_inputs
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / 'output/tmp/r2-light'
        self.stage.parent.mkdir(parents=True)
        self.metadata = b'reviewed JP metadata fixture'
        self.metadata_sha = gate.digest(self.metadata)
        self.package_sha = 'd' * 64
        self.paths = {'metadata': 'output/r2-jp/metadata.v39.dat',
                      'apkRoot': 'output/r2-jp/apks',
                      'unityVersion': 'output/r2-jp/unity-version.txt'}
        self.package_bytes = b'JP signed APK fixture'
        self.unity = b'2022.3.17f1\n'
        observation = {'environmentId': 'jp-production', 'serverAreaId': '1',
                       'clientVersion': '1.0.5', 'cdnRoot': 'https://example.invalid/jp',
                       'masterVersion': 'master-jp', 'resourceVersion': 'resource-jp',
                       'catalogHash': 'catalog-jp'}
        self.observation = observation
        self.version = list(gate.version_identity(observation))
        self.manifest = gate.canonical({'schemaVersion': 1, 'region': 'jp',
                                       'channel': 'production', 'contentReleaseId': 'jp-source',
                                       'root': f'/content/releases/{RELEASE}/',
                                       'locales': {'en': {}, 'zh-CN': {}}})
        self.pointer = {'schemaVersion': 1, 'contentReleaseId': 'jp-source',
                        'manifest': f'/content/releases/{RELEASE}/manifest.json',
                        'sha256': gate.digest(self.manifest)}
        pointer_bytes = gate.canonical(self.pointer)
        self.public = Bucket(pointer_bytes, self.manifest)
        self.public.objects['content/jp/current.json'] = self.public.objects.pop('content/current.json')
        self.before = {'region': 'jp', 'currentSha256': gate.digest(pointer_bytes)}
        input_sha = gate.digest(gate.canonical({'metadata': self.metadata_sha,
            'unityVersion': gate.digest(self.unity), 'packageSetSha256': 'f' * 64}))
        self.state = {'status': 'built', 'codeFingerprint': 'b' * 64,
                      'versionIdentity': self.version, 'publication': {'pointer': self.pointer}}
        inventory = [{'path': self.paths['metadata'], 'sha256': self.metadata_sha, 'size': len(self.metadata)},
                     {'path': self.paths['apkRoot'] + '/base.apk',
                      'sha256': gate.digest(self.package_bytes), 'size': len(self.package_bytes)},
                     {'path': self.paths['unityVersion'], 'sha256': gate.digest(self.unity), 'size': len(self.unity)}]
        inventory.sort(key=lambda entry: entry['path'])
        self.state[gate.RECEIPT_FIELD] = {'schemaVersion': gate.RECEIPT_SCHEMA, 'region': 'jp',
            'sourceSha256': gate.source_identity(self.version), 'packageSha256': self.package_sha,
            'producerCodeSha256': 'b' * 64, 'codeSha256': 'c' * 64, 'inputSha256': input_sha,
            'imageDigest': 'a' * 64, 'inputPaths': self.paths,
            'trustedInputInventory': inventory, 'publicPointer': self.pointer,
            'publicPointerSha256': gate.digest(pointer_bytes),
            'stateSha256': gate.digest(gate.canonical(self.state))}
        self.files = {'output/r2-jp/workspace/state.json': gate.canonical(self.state),
                      self.paths['metadata']: self.metadata,
                      self.paths['unityVersion']: self.unity,
                      self.paths['apkRoot'] + '/base.apk': self.package_bytes}
        self.private = PrivateBucket(self.root, 'jp', ['output/r2-jp'], self.files)
        self.patches = [patch.object(gate, 'stable_root', return_value=self.root),
                        patch.object(gate, 'code_fingerprints', return_value=('b' * 64, 'c' * 64)),
                        patch.object(jp_phone_inputs, 'JP_METADATA_SHA256', self.metadata_sha),
                        patch.object(jp_phone_inputs, 'JP_REVIEWED_PACKAGE_SET_SHA256', 'f' * 64)]
        for active in self.patches:
            active.start()
            self.addCleanup(active.stop)

    def test_jp_light_probe_keeps_reviewed_metadata_and_skips_apk_download(self):
        prepared = gate.light_prepare(self.private, self.root, 'jp', ['output/r2-jp'],
                                      self.stage, image=IMAGE)
        self.assertEqual(prepared['status'], 'ready')

        class Client:
            def discover(self):
                return current_observation

        current_observation = self.observation
        with patch('tools.jp_remote_sync.client_from_metadata', return_value=Client()) as client:
            observed = gate.light_probe(self.root, 'jp', self.stage / 'proof.json', image=IMAGE)
        client.assert_called_once_with((self.stage / 'metadata.v39.dat').resolve(),
                                       authorize_builtin_credentials=True)
        result = gate.light_check(self.private, self.public, self.root, 'jp',
                                  self.stage / 'proof.json', observed, self.before, image=IMAGE)
        self.assertTrue(result['skip'])
        self.assertEqual(len(self.private.downloads), 2)
        self.assertNotIn('state/objects/' + gate.digest(self.package_bytes), self.private.downloads)

    def test_jp_light_gate_rejects_changed_package_manifest_and_public_damage(self):
        self.private.manifest = self.private.manifest.replace(gate.digest(self.package_bytes).encode(), b'0' * 64)
        with self.assertRaises(ValueError):
            gate.light_prepare(self.private, self.root, 'jp', ['output/r2-jp'], self.stage, image=IMAGE)
        self.private = PrivateBucket(self.root, 'jp', ['output/r2-jp'], self.files)
        gate.light_prepare(self.private, self.root, 'jp', ['output/r2-jp'], self.stage, image=IMAGE)
        self.public.objects[f'content/releases/{RELEASE}/manifest.json'] = b'damaged'
        observed = {'status': 'probed', 'region': 'jp',
                    'sourceSha256': gate.source_identity(self.version),
                    'packageSha256': self.package_sha}
        with self.assertRaisesRegex(gate.GateError, 'manifest is missing or damaged'):
            gate.light_check(self.private, self.public, self.root, 'jp',
                             self.stage / 'proof.json', observed, self.before, image=IMAGE)

    def test_jp_seed_without_producer_state_uses_full_restore(self):
        seeded = dict(self.files)
        seeded.pop('output/r2-jp/workspace/state.json')
        private = PrivateBucket(self.root, 'jp', ['output/r2-jp'], seeded)
        result = gate.light_prepare(private, self.root, 'jp', ['output/r2-jp'],
                                    self.stage, image=IMAGE)
        self.assertEqual(result['reason'], 'producer_state_not_seeded')
        self.assertFalse(self.stage.exists())


if __name__ == '__main__':
    unittest.main()
