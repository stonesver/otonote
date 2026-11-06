import json
import tempfile
import unittest
from pathlib import Path

from tools.release_preflight import PreflightError, digest
from tools.release_candidates import build_candidates, capture_gallery_inputs
from tests import test_release_preflight as fixtures


class ReleaseCandidatesTest(unittest.TestCase):
    write_plan = fixtures.ReleasePreflightTest.write_plan

    def setUp(self):
        fixtures.ReleasePreflightTest.setUp(self)
        self.entry['extractedRoot'] = 'master'
        self.write_plan([self.entry])
        self.output = self.root / 'output' / 'candidate'

    @staticmethod
    def compiler(source, target, locales, root):
        for locale in locales:
            data = target / 'public' / locale
            data.mkdir(parents=True)
            (data / 'card-1.json').write_text(json.dumps({'region': source['region'], 'locale': locale}))
        (target / 'same-media.png').write_bytes(source['region'].encode())
        return {'publicationReady': False}

    def build(self, compiler=None, **kwargs):
        return build_candidates(self.plan, self.output, root=self.root,
                                compiler=compiler or self.compiler, **kwargs)

    def test_global_candidate_has_verified_files_and_locales(self):
        report = self.build()
        self.assertFalse(report['publicationReady'])
        target = self.output / 'global' / self.entry['contentReleaseId']
        self.assertEqual((target / 'same-media.png').read_bytes(), b'global')
        self.assertTrue((target / 'public/zh-CN/card-1.json').is_file())
        self.assertTrue((target / 'public/en/card-1.json').is_file())
        for relative, expected in report['files'].items():
            self.assertEqual(digest(self.output / relative), expected)

    def test_compiler_failure_leaves_no_partial_candidate(self):
        with self.assertRaisesRegex(ValueError, 'bad global'):
            self.build(compiler=lambda *args: (_ for _ in ()).throw(ValueError('bad global input')))
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.output.parent.iterdir()), [])

    def test_existing_candidate_is_preserved(self):
        self.build()
        before = (self.output / 'candidate.json').read_bytes()
        with self.assertRaisesRegex(PreflightError, 'already exists'):
            self.build()
        self.assertEqual((self.output / 'candidate.json').read_bytes(), before)

    def test_gallery_locales_use_one_snapshot_despite_live_manifest_replacement(self):
        from tools.gallery import project_gallery
        from tools.gallery_sources import TABLES
        master, live, frozen = self.root / 'gallery-master', self.root / 'gallery-live', self.root / 'gallery-frozen'
        master.mkdir()
        live.mkdir()
        for table in {*TABLES.values(), 'MasterText', 'MasterCharacter', 'MasterBand'}:
            (master / f'{table}.json').write_text('{"_allData": []}')
        manifest = {'schemaVersion': 2, 'resourceVersion': '1.0.0.104', 'assets': [],
                    'masterSha256': {name: digest(master / f'{name}.json') for name in TABLES.values()}}
        (live / 'manifest.json').write_text(json.dumps(manifest))
        capture_gallery_inputs(master, 'remote-release', 'zh-CN', live, frozen)
        (live / 'manifest.json').write_text('{"schemaVersion": 999}')
        self.assertEqual(project_gallery(master, 'remote-release', 'en', frozen)['resourceVersion'], '1.0.0.104')
        with self.assertRaisesRegex(ValueError, 'Unsupported gallery manifest'):
            project_gallery(master, 'remote-release', 'en', live)

    def test_opt_in_failed_build_retains_media_without_candidate_manifest(self):
        def fail(source, target, locales, root):
            (target / 'image.webp').write_bytes(b'completed image')
            raise ValueError('render failed')
        with self.assertRaisesRegex(ValueError, 'render failed'):
            self.build(compiler=fail, keep_failed=True)
        self.assertFalse(self.output.exists())
        retained = list(self.output.parent.glob('*.failed'))
        self.assertEqual(len(retained), 1)
        self.assertFalse((retained[0] / 'candidate.json').exists())
        self.assertEqual(json.loads((retained[0] / 'failed-candidate.json').read_text())['status'], 'failed')
        self.assertEqual(next(retained[0].rglob('image.webp')).read_bytes(), b'completed image')

    def test_nonproduction_input_is_rejected(self):
        self.entry['channel'] = 'staging'
        self.write_plan([self.entry])
        with self.assertRaisesRegex(PreflightError, 'environment id'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_changing_inputs_during_generation_discards_result(self):
        def mutate(source, target, locales, root):
            result = self.compiler(source, target, locales, root)
            (root / 'master/MasterBand.json').write_text('[]')
            return result
        with self.assertRaisesRegex(PreflightError, 'changed'):
            self.build(compiler=mutate)
        self.assertFalse(self.output.exists())

    def test_missing_extracted_binding_is_not_silent_empty_media(self):
        self.entry.pop('extractedRoot')
        self.write_plan([self.entry])
        with self.assertRaisesRegex(PreflightError, 'extractedRoot'):
            self.build()

    def test_output_cannot_overlap_source(self):
        self.output = self.master / 'new-output'
        with self.assertRaisesRegex(PreflightError, 'overlaps'):
            self.build()

    def test_changed_bound_score_discards_entire_candidate(self):
        from tools.score_inputs import write_score_inputs
        self.entry['scoreInputs'] = write_score_inputs(self.entry, {'one.bytes': b'score'}, self.root / 'scores')
        self.write_plan([self.entry])
        def mutate(source, target, locales, root):
            result = self.compiler(source, target, locales, root)
            next((root / 'scores/payloads').iterdir()).write_bytes(b'other')
            return result
        with self.assertRaisesRegex(PreflightError, 'digest'):
            self.build(compiler=mutate)
        self.assertFalse(self.output.exists())

    def test_review_is_not_copied_and_mutation_during_build_is_rejected(self):
        review = self.root / 'arena-review.json'
        review.write_text(json.dumps({'schemaVersion': 1, 'region': self.entry['region'],
            'sourceReleaseId': self.entry['contentReleaseId'], 'serverScopes': []}))
        self.entry['arenaReview'] = {'path': 'arena-review.json', 'sha256': digest(review)}
        self.write_plan([self.entry])
        report = self.build()
        self.assertFalse(any('arena-review' in name for name in report['files']))
        self.output = self.root / 'output' / 'changed-review'
        def mutate(source, target, locales, root):
            result = self.compiler(source, target, locales, root)
            review.write_text('{}')
            return result
        with self.assertRaisesRegex(PreflightError, 'changed'):
            self.build(compiler=mutate)
        self.assertFalse(self.output.exists())
