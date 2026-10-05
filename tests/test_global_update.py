"""Workflow failures must not become successful website checkpoints."""
import json
import io
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

from tools import global_update as workflow
from tools.global_remote_sync import write_json, file_hash


class WorkflowTests(unittest.TestCase):
    def test_cli_emits_one_json_receipt_despite_download_progress(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        def produce(*_args, **_kwargs):
            print('Master 40/80')
            print('Assets 25/50')
            return {'status': 'content_published'}
        with patch.object(workflow, 'load_config', return_value={
                'workspace': self.workspace, 'clientVersion': '1.0.1'}), \
                patch.object(workflow, 'run_update', side_effect=produce), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            status = workflow.main(['run'])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {'status': 'content_published'})
        self.assertIn('Master 40/80', stderr.getvalue())
        self.assertIn('Assets 25/50', stderr.getvalue())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / 'workflow'
        self.plan = self.root / 'inputs.json'
        write_json(self.plan, {'environments': []})
        self.config = {'workspace': self.workspace, 'baseline': self.root / 'baseline', 'inputPlan': self.plan}
        self.synced = {'inputPlan': str(self.plan), 'observation': {'resourceVersion': '1.0.0.104'}}
        self.package = {'package': {'url': 'https://example.invalid/game.apk'}, 'packageChanged': False}

    def test_lock_excludes_concurrent_writer(self):
        with workflow.locked(self.workspace):
            with self.assertRaisesRegex(ValueError, 'another workflow'):
                with workflow.locked(self.workspace):
                    pass

    def test_content_mode_never_builds_or_seals_frontend(self):
        self.config['contentPublication']={'root':str(self.root/'content')}
        write_json(self.plan, {'environments':[{'masterRoot':str(self.root/'missing-master'),'contentReleaseId':'current'}]})
        journal=workflow.Journal(self.workspace,'run')
        def compile(name,args):
            self.assertEqual(name,'compile-data')
            self.assertEqual(Path(args[args.index('--conversion-cache') + 1]),
                             self.workspace / 'cache/image-conversions')
            write_json(Path(args[args.index('--output')+1])/'candidate.json',{'inputPlanSha256':file_hash(self.plan)})
        journal.command=Mock(side_effect=compile)
        with patch('tools.content_publication.publish_content',return_value={'status':'content_published'}) as publish, patch.object(workflow,'bundle') as seal, patch('tools.content_retention.cleanup_content'), patch('tools.update_retention.cleanup'):
            result=self.invoke(journal)
        self.assertEqual(result['status'],'content_published');publish.assert_called_once();seal.assert_not_called()
        self.assertEqual([c.args[0] for c in journal.command.call_args_list],['compile-data'])
        rules_path=publish.call_args.kwargs['scoring_rules']
        self.assertEqual(publish.call_args.kwargs['ranking_cache'], self.workspace/'cache/song-rankings')
        self.assertEqual(read_rules := json.loads(rules_path.read_text()), {
            'schemaVersion':1,'sourceReleaseId':'current','verificationStatus':'unavailable','reason':'missing_scoring_inputs'})
        retry=workflow.Journal(self.workspace,'run');retry.command=Mock()
        # A refreshed model must be rebound even if the input plan/candidate is unchanged.
        with patch('tools.scoring_content.bind_scoring_rules',return_value={**read_rules,'reason':'updated-model'}), \
             patch('tools.content_publication.publish_content',return_value={'status':'content_published'}) as again, \
             patch('tools.content_retention.cleanup_content'), patch('tools.update_retention.cleanup'):
            self.invoke(retry)
        retry.command.assert_not_called()
        self.assertEqual(json.loads(again.call_args.kwargs['scoring_rules'].read_text())['reason'],'updated-model')

    def test_enabled_recognition_is_bound_before_content_publication(self):
        self.config['contentPublication']={'root':str(self.root/'content'),'cardRecognition':True}
        write_json(self.plan, {'environments':[{'masterRoot':str(self.root/'missing-master'),'contentReleaseId':'current'}]})
        journal=workflow.Journal(self.workspace,'run')
        journal.command=Mock(side_effect=lambda name,args:write_json(
            Path(args[args.index('--output')+1])/'candidate.json',{'inputPlanSha256':file_hash(self.plan)}))
        with patch('tools.card_recognition.prepare_candidate_index',return_value=self.root/'index') as index, \
             patch('tools.content_publication.publish_content',return_value={'status':'content_published'}) as publish:
            self.invoke(journal)
        index.assert_called_once()
        self.assertEqual(publish.call_args.kwargs['recognition_index'],self.root/'index')
        with patch('tools.card_recognition.prepare_candidate_index',side_effect=ValueError('index failed')), \
             patch('tools.content_publication.publish_content') as publish:
            with self.assertRaisesRegex(ValueError,'index failed'):
                self.invoke(workflow.Journal(self.workspace,'run'))
        publish.assert_not_called()

    def test_content_success_defers_retention_and_preserves_old_builds_and_inputs(self):
        self.config['contentPublication']={'root':str(self.root/'content')}
        write_json(self.plan, {'environments':[{'masterRoot':str(self.root/'missing-master'),'contentReleaseId':'current'}]})
        old_build=self.workspace/'builds'/('b'*20)
        orphan_build=self.workspace/'builds'/('c'*20)
        old_input=self.workspace/'sync-complete/1.0.0-aaaaaaaa-bbbbbbbb-complete-v1-cccccccc/inputs/release-inputs.json'
        old_content=self.root/'content/releases'/('d'*24)/'manifest.json'
        for path in (old_build/'content-publication.json',orphan_build/'content-publication.json',old_input,old_content):
            write_json(path,{'fixture':'preserve'})
        protected={path:path.read_bytes() for path in (old_build/'content-publication.json',orphan_build/'content-publication.json',old_input,old_content)}
        write_json(self.workspace/'state.json',{'inputPlanSha256':'old','buildDirectory':str(old_build),
                                              'retainedBuilds':[str(orphan_build)]})
        journal=workflow.Journal(self.workspace,'run')
        journal.command=Mock(side_effect=lambda name,args:write_json(
            Path(args[args.index('--output')+1])/'candidate.json',{'inputPlanSha256':file_hash(self.plan)}))
        with patch('tools.content_publication.publish_content',return_value={'status':'content_published'}), \
             patch('tools.content_retention.cleanup_content',side_effect=AssertionError('automatic content deletion')) as content_cleanup, \
             patch('tools.update_retention.cleanup',side_effect=AssertionError('automatic input deletion')) as input_cleanup:
            result=self.invoke(journal)
        content_cleanup.assert_not_called();input_cleanup.assert_not_called()
        self.assertEqual(result['retention'],{'status':'deferred_to_operations'})
        self.assertIn(str(old_build),result['retainedBuilds'])
        self.assertEqual(json.loads((self.workspace/'state.json').read_text()),result)
        self.assertEqual(protected,{path:path.read_bytes() for path in protected})
        self.assertEqual(journal.report['steps'][-1]['name'],'save-success')
        self.assertTrue(all(row['status']=='passed' for row in journal.report['steps']))

    def test_failed_step_records_error_without_success_state(self):
        journal = workflow.Journal(self.workspace, 'run')
        with self.assertRaisesRegex(ValueError, 'network'):
            journal.step('sync-inputs', Mock(side_effect=ValueError('network failed')))
        report = json.loads((self.workspace / 'latest-run.json').read_text())
        self.assertEqual((report['status'], report['failedStep']), ('failed', 'sync-inputs'))
        self.assertFalse((self.workspace / 'state.json').exists())

    def test_projection_change_rebuilds_same_inputs_and_preserves_legacy_candidate(self):
        self.config['contentPublication']={'root':str(self.root/'content')}
        write_json(self.plan, {'environments':[{'masterRoot':str(self.root/'missing-master'),'contentReleaseId':'current'}]})
        legacy=self.workspace/'builds'/'legacy'
        write_json(legacy/'candidate/candidate.json',{'inputPlanSha256':file_hash(self.plan)})
        original=(legacy/'candidate/candidate.json').read_bytes()
        write_json(self.workspace/'state.json',{'inputPlanSha256':file_hash(self.plan),'buildDirectory':str(legacy)})
        def compile_data(name,args):
            self.assertEqual(name,'compile-data')
            write_json(Path(args[args.index('--output')+1])/'candidate.json',{'inputPlanSha256':file_hash(self.plan)})
        paths=[]
        for fingerprint, expected in [('a'*64,1),('a'*64,0),('b'*64,1)]:
            journal=workflow.Journal(self.workspace,'run');journal.command=Mock(side_effect=compile_data)
            with patch.object(workflow,'chart_projection_fingerprint',return_value=fingerprint), \
                 patch('tools.content_publication.publish_content',return_value={'status':'content_published'}), \
                 patch('tools.content_retention.cleanup_content'), patch('tools.update_retention.cleanup'):
                result=self.invoke(journal)
            self.assertEqual(journal.command.call_count,expected)
            self.assertEqual(result['chartProjectionFingerprint'],fingerprint)
            paths.append(result['buildDirectory'])
        self.assertEqual(paths[0],paths[1]);self.assertNotEqual(paths[0],paths[2])
        self.assertEqual((legacy/'candidate/candidate.json').read_bytes(),original)

    def test_projection_changed_during_build_is_not_published(self):
        self.config['contentPublication']={'root':str(self.root/'content')}
        write_json(self.plan, {'environments':[{'masterRoot':str(self.root/'missing-master'),'contentReleaseId':'current'}]})
        journal=workflow.Journal(self.workspace,'run')
        journal.command=Mock(side_effect=lambda name,args:write_json(
            Path(args[args.index('--output')+1])/'candidate.json',{'inputPlanSha256':file_hash(self.plan)}))
        with patch.object(workflow,'chart_projection_fingerprint',side_effect=['a'*64,'b'*64]), \
             patch('tools.content_publication.publish_content') as publish:
            with self.assertRaisesRegex(ValueError,'inputs changed'):
                self.invoke(journal)
            publish.assert_not_called()
        self.assertFalse((self.workspace/'state.json').exists())

    def test_reviewed_arena_evidence_change_invalidates_candidate_fingerprint(self):
        for name in workflow.CHART_PROJECTION_SOURCES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
        evidence = self.root / 'catalog/evidence/arena-client.json'
        self.assertTrue(evidence.is_file())
        with patch.object(workflow, 'ROOT', self.root):
            before = workflow.chart_projection_fingerprint()
            evidence.write_text('revised reviewed evidence')
            self.assertNotEqual(before, workflow.chart_projection_fingerprint())
            evidence.unlink()
            with self.assertRaises(FileNotFoundError):
                workflow.chart_projection_fingerprint()

    def invoke(self, journal, **kwargs):
        with patch.object(workflow, 'doctor'), patch.object(workflow, 'package_check', return_value=self.package), \
             patch.object(workflow, 'update', return_value=self.synced), \
             patch('tools.release_preflight.inspect_plan', return_value={'status': 'passed'}):
            return workflow.run_update(self.config, journal, Mock(), **kwargs)

    def test_site_failure_resumes_compiled_data_and_preserves_previous_success(self):
        old = {'inputPlanSha256': 'old', 'archiveSha256': 'old', 'buildDirectory': '/old'}
        write_json(self.workspace / 'state.json', old)
        journal = workflow.Journal(self.workspace, 'run')
        def command(name, args):
            destination = Path(args[args.index('--output') + 1])
            if name == 'compile-data':
                write_json(destination / 'candidate.json', {'inputPlanSha256': file_hash(self.plan)})
            else:
                raise ValueError('render failed')
        journal.command = Mock(side_effect=command)
        with self.assertRaisesRegex(ValueError, 'render failed'):
            self.invoke(journal)
        self.assertEqual(json.loads((self.workspace / 'state.json').read_text()), old)
        retry = workflow.Journal(self.workspace, 'run')
        retry.command = Mock()
        receipt = {'archive': '/new/website.tar.gz', 'archiveSha256': 'new', 'limitations': []}
        with patch.object(workflow, 'bundle', return_value=receipt):
            result = self.invoke(retry)
        self.assertEqual([c.args[0] for c in retry.command.call_args_list], ['build-site'])
        self.assertEqual(result['status'], 'candidate_built')
        self.assertEqual(json.loads((self.workspace / 'state.json').read_text())['archiveSha256'], 'new')

    def test_unchanged_validates_existing_bundle_without_recompiling(self):
        build = self.root / 'build'
        (build / 'site').mkdir(parents=True)
        write_json(self.workspace / 'state.json', {'inputPlanSha256': file_hash(self.plan),
                   'archiveSha256': 'same', 'buildDirectory': str(build)})
        journal = workflow.Journal(self.workspace, 'run')
        journal.command = Mock()
        with patch.object(workflow, 'bundle', return_value={'archive': '/archive', 'archiveSha256': 'same', 'limitations': []}) as seal:
            result = self.invoke(journal)
        journal.command.assert_not_called()
        seal.assert_called_once()
        self.assertEqual(result['status'], 'unchanged')

    def test_package_failure_prevents_sync_and_preserves_success(self):
        old = {'inputPlanSha256': 'old'}
        write_json(self.workspace / 'state.json', old)
        with patch.object(workflow, 'doctor'), patch.object(workflow, 'package_check', side_effect=ValueError('HTTP 429')), patch.object(workflow, 'update') as sync:
            with self.assertRaisesRegex(ValueError, '429'):
                workflow.run_update(self.config, workflow.Journal(self.workspace, 'run'), Mock())
        sync.assert_not_called()
        self.assertEqual(json.loads((self.workspace / 'state.json').read_text()), old)
        self.assertEqual(json.loads((self.workspace / 'latest-run.json').read_text())['failedStep'], 'official-package')

    def test_changed_cached_candidate_is_rejected_before_rendering(self):
        candidate = self.workspace / 'builds' / file_hash(self.plan)[:20] / 'candidate'
        write_json(candidate / 'candidate.json', {'inputPlanSha256': 'wrong'})
        journal = workflow.Journal(self.workspace, 'run')
        journal.command = Mock()
        with self.assertRaisesRegex(ValueError, 'input plan mismatch'):
            self.invoke(journal)
        journal.command.assert_not_called()
        self.assertFalse((self.workspace / 'state.json').exists())
        self.assertEqual(json.loads((self.workspace / 'latest-run.json').read_text())['failedStep'], 'candidate-binding')

    def test_corrupt_cached_bundle_does_not_replace_success(self):
        build = self.root / 'build'
        (build / 'site').mkdir(parents=True)
        old = {'inputPlanSha256': file_hash(self.plan), 'archiveSha256': 'same', 'buildDirectory': str(build)}
        write_json(self.workspace / 'state.json', old)
        with patch.object(workflow, 'bundle', side_effect=ValueError('site changed')):
            with self.assertRaisesRegex(ValueError, 'site changed'):
                self.invoke(workflow.Journal(self.workspace, 'run'))
        self.assertEqual(json.loads((self.workspace / 'state.json').read_text()), old)

    def test_bundle_contains_only_static_site_and_manifest_and_detects_tampering(self):
        site, output = self.root / 'site', self.root / 'package'
        site.mkdir()
        (site / 'index.html').write_text('hello')
        report = {'validation': {'status': 'passed'}, 'limitations': [], 'publicationReady': False}
        with patch.object(workflow, 'validate_site', return_value=report):
            result = workflow.bundle(site, output)
            with tarfile.open(result['archive']) as tar:
                self.assertEqual(set(tar.getnames()), {'site/index.html', 'bundle-manifest.json'})
                manifest = json.load(tar.extractfile('bundle-manifest.json'))
                self.assertEqual(manifest['files']['index.html'], file_hash(site / 'index.html'))
            self.assertEqual(workflow.bundle(site, output)['archiveSha256'], result['archiveSha256'])
            Path(result['archive']).write_text('corrupt archive')
            repaired = workflow.bundle(site, output)
            self.assertEqual(file_hash(Path(repaired['archive'])), repaired['archiveSha256'])
            (site / 'index.html').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'changed since sealing'):
                workflow.bundle(site, output)

    def test_bundle_rejects_symlinks_before_validation(self):
        site = self.root / 'site'
        site.mkdir()
        (site / 'secret').symlink_to(self.plan)
        with patch.object(workflow, 'validate_site') as verify:
            with self.assertRaisesRegex(ValueError, 'linked site entry'):
                workflow.bundle(site, self.root / 'package')
        verify.assert_not_called()

    def test_bad_config_cannot_write_over_inputs(self):
        with patch.object(workflow, 'ROOT', self.root):
            config = {'schemaVersion': 1, 'workspace': 'output', 'baseline': 'input',
                      'inputPlan': 'plan.json', 'initialObservation': 'observation.json', 'initialPackage': 'package.json'}
            write_json(self.root / 'config.json', config)
            with self.assertRaisesRegex(ValueError, 'under output'):
                workflow.load_config(self.root / 'config.json')
            config['workspace'] = 'output/state'
            config['inputPlan'] = 'output/state/plan.json'
            write_json(self.root / 'config.json', config)
            with self.assertRaisesRegex(ValueError, 'overlaps'):
                workflow.load_config(self.root / 'config.json')

    def test_resource_check_does_not_advance_success_checkpoint(self):
        observation = {'environment': 'global-production', 'areaId': '2', 'clientVersion': '1.0.1',
                       'resourceVersion': '1.0.0.104', 'masterVersion': 'a', 'catalogHash': 'b', 'cdnRoot': 'https://example.invalid'}
        path = self.root / 'observation.json'
        write_json(path, observation)
        self.config['initialObservation'] = path
        client = Mock()
        client.discover.return_value = observation
        result = workflow.observation_check(self.config, client)
        self.assertFalse(result['resourceChanged'])
        client.discover.return_value = {**observation, 'masterVersion': 'new'}
        self.assertEqual(workflow.observation_check(self.config, client)['changes'], ['masterVersion'])
        self.assertFalse((self.workspace / 'state.json').exists())
        client.discover.side_effect = ValueError('HTTP 429')
        with self.assertRaisesRegex(ValueError, '429'):
            workflow.observation_check(self.config, client)


if __name__ == '__main__':
    unittest.main()
