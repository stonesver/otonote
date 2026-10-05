import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import errno
import hashlib
import subprocess
from types import SimpleNamespace
from tools.global_remote_sync import read_json
from tools.global_remote_sync import file_hash
from tools.content_publication import MEDIA_GROUPS, inventory, publish_content, rollback_content, write


class ContentPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=self.root/'content'

    def candidate(self, release='test-1', missing=False, region='global'):
        candidate=self.root/(release if region == 'global' else region+'-'+release);bound=candidate/region/release
        for group in MEDIA_GROUPS:
            (bound/'public'/group).mkdir(parents=True)
        for group in ('growth','system-banners','mission-rewards'): write(bound/'public'/group/'manifest.json',{})
        (bound/'public/media/icon.webp').write_bytes(b'image')
        for name in ('live2d-catalog.json','immersive-scenes.json','auto-stage-skin.json'): write(bound/'supplemental-data'/name,{})
        for locale in ('en','zh-CN'):
            write(bound/'generated/releases'/release/locale/'catalog.json',{
                'projectionContext':{'contentReleaseId':release,'region':region,'channel':'production','locale':locale},
                'image':'/media/missing.webp' if missing else '/media/icon.webp'})
        write(candidate/'candidate.json',{'status':'candidate_generated','historicalReplay':False,
            'regions':[{'region':region,'channel':'production','contentReleaseId':release,'path':region+'/'+release,
                        'projections':[{'locale':'zh-CN'},{'locale':'en'}]}], 'files':inventory(candidate)})
        return candidate

    def test_jp_publication_and_rollback_leave_global_pointer_unchanged(self):
        global_result=publish_content(self.candidate(),self.store)
        first=publish_content(self.candidate(region='jp'),self.store)
        publish_content(self.candidate('test-2',region='jp'),self.store)
        self.assertEqual(read_json(self.store/'current.json'),global_result['pointer'])
        self.assertEqual(read_json(self.store/'jp/previous.json'),first['pointer'])
        rollback_content(self.store,region='jp')
        self.assertEqual(read_json(self.store/'jp/current.json'),first['pointer'])
        self.assertEqual(read_json(self.store/'current.json'),global_result['pointer'])
        self.assertEqual(read_json(Path(first['snapshot'])/'manifest.json')['region'],'jp')

    def test_persistent_ranking_cache_is_private_and_shared_by_locales(self):
        candidate = self.candidate()
        for locale in ('en', 'zh-CN'):
            catalog = candidate/'global/test-1/generated/releases/test-1'/locale/'catalog.json'
            write(catalog, {**read_json(catalog), 'musicCharts': []})
        receipt = candidate/'candidate.json'
        write(receipt, {**read_json(receipt), 'files': inventory(candidate, exclude=('candidate.json',))})
        cache = (self.root/'private-cache/song-rankings').resolve()
        def generate(command, **_options):
            self.assertEqual(Path(command[7]), cache.resolve())
            write(Path(command[6]), {'unavailable': True})
            write(Path(command[6]).with_name('scoring-compatibility.json'), {'status': 'unavailable'})
        with patch('tools.content_publication.subprocess.run', side_effect=generate) as calculate:
            result = publish_content(candidate, self.store, ranking_cache=cache)
        self.assertEqual(calculate.call_count, 2)
        self.assertEqual(result['status'], 'content_published')
        self.assertFalse(any('private-cache' in name for name in inventory(Path(result['snapshot']))))
        for unsafe in (candidate/'cache', self.store/'releases/cache', self.root):
            with self.assertRaisesRegex(ValueError, 'ranking cache overlaps'):
                publish_content(candidate, self.store, ranking_cache=unsafe.resolve())
        link = self.root/'cache-link'; link.symlink_to(cache.parent)
        with self.assertRaisesRegex(ValueError, 'linked ranking cache'):
            publish_content(candidate, self.store, ranking_cache=link/'rankings')
    def test_finder_metadata_is_not_published(self):
        candidate=self.candidate(region='jp')
        (candidate/'jp/test-1/public/live2d/.DS_Store').write_bytes(b'finder metadata')
        result=publish_content(candidate,self.store)
        self.assertFalse((Path(result['snapshot'])/'public/live2d/.DS_Store').exists())

    def test_wrong_edition_catalog_and_rollback_are_rejected(self):
        candidate=self.candidate(region='jp')
        path=candidate/'jp/test-1/generated/releases/test-1/en/catalog.json'
        payload=read_json(path);payload['projectionContext']['region']='global';write(path,payload)
        meta=read_json(candidate/'candidate.json');meta['files']=inventory(candidate,exclude=('candidate.json',));write(candidate/'candidate.json',meta)
        with self.assertRaisesRegex(ValueError,'mixed projection identity'):publish_content(candidate,self.store)
        result=publish_content(self.candidate(),self.store)
        write(self.store/'jp/previous.json',result['pointer'])
        with self.assertRaisesRegex(ValueError,'edition mismatch'):rollback_content(self.store,region='jp')

    def test_increment_rewrites_resources_and_preserves_previous(self):
        first=publish_content(self.candidate(),self.store)
        old=(self.store/'current.json').read_bytes()
        second=publish_content(self.candidate('test-2'),self.store)
        self.assertNotEqual(first['pointer'],second['pointer'])
        self.assertEqual((self.store/'previous.json').read_bytes(),old)
        self.assertTrue(Path(first['snapshot']).is_dir())
        catalog=json.loads((Path(second['snapshot'])/'zh-CN/catalog.json').read_text())
        self.assertTrue(catalog['image'].startswith('/content/releases/'))
        self.assertEqual(publish_content(self.root/'test-2',self.store)['status'],'unchanged')
        rollback_content(self.store)
        self.assertEqual(json.loads((self.store/'current.json').read_text()),first['pointer'])

    def test_costume_projection_and_icons_publish_together_and_legacy_is_supported(self):
        candidate = self.candidate()
        bound = candidate / 'global/test-1'
        (bound/'public/costumes/icon.webp').write_bytes(b'costume image')
        (bound/'public/costumes/posters').mkdir()
        (bound/'public/costumes/posters/full.webp').write_bytes(b'full body')
        for locale in ('en','zh-CN'):
            write(bound/f'generated/releases/test-1/{locale}/costumes.json',
                  {'schemaVersion':1,'costumes':[{'icon':{'url':'/costumes/icon.webp'},'poster':{'url':'/costumes/posters/full.webp'}}]})
        metadata = read_json(candidate/'candidate.json')
        metadata['files'] = inventory(candidate, exclude=('candidate.json',))
        write(candidate/'candidate.json',metadata)
        result = publish_content(candidate,self.store)
        snapshot = Path(result['snapshot'])
        data = read_json(snapshot/'en/costumes.json')
        self.assertEqual(data['costumes'][0]['icon']['url'],result['pointer']['manifest'].removesuffix('manifest.json')+'public/costumes/icon.webp')
        self.assertEqual((snapshot/'public/costumes/icon.webp').read_bytes(),b'costume image')
        self.assertEqual(data['costumes'][0]['poster']['url'],result['pointer']['manifest'].removesuffix('manifest.json')+'public/costumes/posters/full.webp')
        self.assertEqual((snapshot/'public/costumes/posters/full.webp').read_bytes(),b'full body')
        # The old, sealed format predates the optional media directory.
        legacy = self.candidate('legacy')
        (legacy/'global/legacy/public/costumes').rmdir()
        self.assertEqual(publish_content(legacy,self.store)['status'],'content_published')

    def test_missing_costume_media_cannot_replace_current(self):
        publish_content(self.candidate(),self.store)
        pointer = (self.store/'current.json').read_bytes()
        candidate = self.candidate('broken-costume')
        bound = candidate/'global/broken-costume'
        write(bound/'generated/releases/broken-costume/en/costumes.json',{'icon':'/costumes/missing.webp'})
        metadata = read_json(candidate/'candidate.json')
        metadata['files'] = inventory(candidate,exclude=('candidate.json',))
        write(candidate/'candidate.json',metadata)
        with self.assertRaisesRegex(ValueError,'missing content reference'):
            publish_content(candidate,self.store)
        self.assertEqual((self.store/'current.json').read_bytes(),pointer)

    def test_publication_rechecks_expected_pointer_inside_lock(self):
        source=self.candidate();publish_content(source,self.store)
        current=(self.store/'current.json').read_bytes()
        with self.assertRaisesRegex(ValueError,'published content changed'):
            publish_content(source,self.store,expected_current='0'*64)
        self.assertEqual((self.store/'current.json').read_bytes(),current)
        self.assertEqual(publish_content(source,self.store,expected_current=hashlib.sha256(current).hexdigest())['status'],'unchanged')

    def test_missing_resource_and_corrupt_candidate_preserve_pointer(self):
        publish_content(self.candidate(),self.store);old=(self.store/'current.json').read_bytes()
        broken=self.candidate('missing',missing=True)
        with self.assertRaisesRegex(ValueError,'missing content reference'): publish_content(broken,self.store)
        self.assertEqual((self.store/'current.json').read_bytes(),old)
        (broken/'global/missing/public/media/icon.webp').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'inventory'): publish_content(broken,self.store)
        self.assertEqual((self.store/'current.json').read_bytes(),old)

    def test_scoring_artifact_is_version_bound_and_changes_snapshot_identity(self):
        candidate=self.candidate(); initial=publish_content(candidate,self.store)
        path=self.root/'rules.json'
        write(path,{'sourceReleaseId':'wrong','verificationStatus':'unavailable'})
        with self.assertRaisesRegex(ValueError,'scoring rules content release mismatch'):
            publish_content(candidate,self.store,scoring_rules=path)
        self.assertEqual(json.loads((self.store/'current.json').read_text()),initial['pointer'])
        rules={'sourceReleaseId':'test-1','verificationStatus':'unavailable','reason':'test'}
        write(path,rules); result=publish_content(candidate,self.store,scoring_rules=path)
        self.assertNotEqual(initial['pointer'],result['pointer'])
        manifest=json.loads((Path(result['snapshot'])/'manifest.json').read_text())
        for locale in ('en','zh-CN'):
            record=manifest['locales'][locale]['files']['supplemental/formal-scoring-rules.json']
            self.assertEqual(json.loads((Path(result['snapshot'])/record['path']).read_text()),rules)

    def test_sealed_target_tampering_rejected(self):
        source=self.candidate();result=publish_content(source,self.store)
        (Path(result['snapshot'])/'en/catalog.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'inventory'): publish_content(source,self.store)

    def test_unknown_scoring_mechanism_reports_coverage_without_blocking_content(self):
        publish_content(self.candidate(), self.store)
        previous = (self.store/'current.json').read_bytes()
        candidate = self.candidate('new-skill')
        bound = candidate/'global/new-skill'
        baseline = read_json(Path(__file__).resolve().parents[1]/'packages/scoring/data/formal-scoring-rules.json')
        rules = json.loads(json.dumps(baseline))
        rules.update(sourceReleaseId='new-skill', verificationStatus='reference_compatible',
                     referenceProfile={'sourceReleaseId': baseline['sourceReleaseId'],
                                       'nativeSha256': baseline['nativeSha256'],
                                       'dataCompatibility': 'supported_model',
                                       'modelId': 'ournotes-scoring-model-v1', 'currentGameplayVerified': False})
        for locale in ('en', 'zh-CN'):
            path = bound/f'generated/releases/new-skill/{locale}/catalog.json'
            catalog = read_json(path)
            catalog.update(release={'id': 'new-skill'}, musicTracks=[], musicCharts=[],
                           memberCards=[{'id': 'member-card-1'}], supportCards=[{'id': 'support-card-1'}])
            write(path, catalog)
        effect = next(row for row in rules['tables']['GekisouSkillEffect']
                      if row['_gekisouSkillID'] == rules['tables']['MemberCard'][0]['_gekisouSkillID'] and row['_level'] == 5)
        effect['_skillEffectType'] = 98765
        write(bound/'supplemental-data/formal-scoring-rules.json', rules)
        metadata = read_json(candidate/'candidate.json')
        metadata['files'] = inventory(candidate, exclude=('candidate.json',))
        write(candidate/'candidate.json', metadata)
        run = subprocess.run
        with patch('tools.content_publication.subprocess.run', side_effect=lambda *args, **kwargs: run(*args, **kwargs, capture_output=True)):
            result = publish_content(candidate, self.store)
        for locale in ('en', 'zh-CN'):
            report = read_json(Path(result['snapshot'])/locale/'_supplemental/scoring-compatibility.json')
            self.assertEqual(report['status'], 'partial')
            self.assertTrue(any(issue['message'] == 'Unsupported Gekisou effect 98765' for issue in report['issues']))
            self.assertEqual(report['issues'][0]['memberCardId'], 'member-card-1')
            self.assertEqual(report['issues'][0]['level'], 5)
        self.assertEqual(result['status'], 'content_published')
        self.assertEqual((self.store/'previous.json').read_bytes(), previous)

    def test_ranking_helpers_each_change_the_immutable_snapshot_identity(self):
        candidate=self.candidate()
        original=publish_content(candidate,self.store)
        for name in ('song-ranking-meta.mjs','song-skill-windows.mjs','scoring-engine.mjs','song-ranking-view.mjs'):
            with self.subTest(name=name):
                def modified_hash(path):
                    actual=file_hash(path)
                    return hashlib.sha256((actual+'changed').encode()).hexdigest() if Path(path).name==name else actual
                with patch('tools.content_publication.file_hash',side_effect=modified_hash):
                    changed=publish_content(candidate,self.store)
                self.assertNotEqual(changed['pointer']['manifest'],original['pointer']['manifest'])
        self.assertEqual(read_json(Path(original['snapshot'])/'manifest.json')['root'],
                         original['pointer']['manifest'].removesuffix('manifest.json'))

    def test_live2d_bundle_is_published_without_mutating_candidate(self):
        candidate = self.candidate()
        model = candidate / 'global/test-1/public/live2d/test-1/model'
        model.mkdir(parents=True)
        resources = []
        for name, data in [('model.json', b'{}\n'), ('motion.json', b'{"x":1}\n')]:
            (model/name).write_bytes(data)
            resources.append({'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        write(model/'manifest.json', {'model': 'model.json', 'resources': resources, 'totalBytes': sum(r['bytes'] for r in resources)})
        original = (model/'manifest.json').read_bytes()
        meta = json.loads((candidate/'candidate.json').read_text())
        meta['files'] = inventory(candidate, exclude=('candidate.json',))
        write(candidate/'candidate.json', meta)
        result = publish_content(candidate, self.store)
        published = Path(result['snapshot'])/'public/live2d/test-1/model'
        manifest = json.loads((published/'manifest.json').read_text())
        self.assertEqual((model/'manifest.json').read_bytes(), original)
        self.assertTrue((published/manifest['jsonBundle']['file']).is_file())
        self.assertEqual(publish_content(candidate, self.store)['status'], 'unchanged')

    def test_symlink_and_mixed_locale_rejected(self):
        source=self.candidate();(source/'secret').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'symlink'): publish_content(source,self.store)
        (source/'secret').unlink()
        meta=json.loads((source/'candidate.json').read_text());meta['regions'][0]['projections']=[{'locale':'en'}]
        write(source/'candidate.json',meta)
        with self.assertRaisesRegex(ValueError,'locales'): publish_content(source,self.store)

    def test_cross_mount_copy_is_blocked_before_running_out_of_disk(self):
        publish_content(self.candidate(),self.store);previous=(self.store/'current.json').read_bytes()
        next_candidate=self.candidate('cross-mount')
        with patch('tools.content_publication.os.link',side_effect=OSError(errno.EXDEV,'cross mount')), \
             patch('tools.content_publication.shutil.disk_usage',return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(ValueError,'insufficient disk'): publish_content(next_candidate,self.store)
        self.assertEqual((self.store/'current.json').read_bytes(),previous)

if __name__=='__main__': unittest.main()

class RecognitionPublicationTests(unittest.TestCase):
    setUp = ContentPublicationTests.setUp
    candidate = ContentPublicationTests.candidate
    def recognition(self,candidate):
        import gzip
        from tools.card_recognition import ALGORITHM
        source=read_json(candidate/'candidate.json');bound=candidate/source['regions'][0]['path']
        for locale in ('zh-CN','en'):
            path=bound/'generated/releases/test-1'/locale/'catalog.json';value=read_json(path)
            value['memberCards']=[{'id':'member-card-1'}];write(path,value)
        source['files']=inventory(candidate,exclude=('candidate.json',));write(candidate/'candidate.json',source)
        directory=self.root/'recognition';directory.mkdir()
        packed=gzip.compress(b'\0'*160)
        (directory/'features.bin.gz').write_bytes(packed)
        value={'schemaVersion':1,'algorithm':ALGORITHM,'region':'global','sourceReleaseId':'test-1',
            'featuresPath':'recognition/features.bin.gz','featuresSha256':hashlib.sha256(packed).hexdigest(),
            'compressedBytes':len(packed),'decodedBytes':160,'cards':[{'id':'member-card-1','kind':'member',
                'assetId':'asset-1','count':4,'descriptorOffset':0,'pointOffset':128,'name':'Synthetic'}]}
        write(directory/'card-recognition.json',value)
        return directory,value

    def test_recognition_is_optional_and_bound_to_snapshot_and_catalog(self):
        candidate=self.candidate();directory,value=self.recognition(candidate)
        initial=publish_content(candidate,self.store)
        result=publish_content(candidate,self.store,recognition_index=directory)
        self.assertNotEqual(initial['pointer'],result['pointer'])
        root=Path(result['snapshot']);manifest=read_json(root/'manifest.json')
        for locale in ('en','zh-CN'):
            record=manifest['locales'][locale]['files']['supplemental/card-recognition.json']
            self.assertEqual(read_json(root/record['path']),value)
        self.assertEqual((root/'recognition/features.bin.gz').read_bytes(),(directory/'features.bin.gz').read_bytes())
        self.assertEqual(read_json(self.store/'previous.json'),initial['pointer'])
        value['sourceReleaseId']='wrong';write(directory/'card-recognition.json',value)
        with self.assertRaisesRegex(ValueError,'recognition index content release mismatch'):
            publish_content(candidate,self.store,recognition_index=directory)
        self.assertEqual(read_json(self.store/'current.json'),result['pointer'])

    def test_recognition_tampering_ranges_and_unknown_ids_reject_without_pointer_changes(self):
        candidate=self.candidate();directory,value=self.recognition(candidate)
        result=publish_content(candidate,self.store)
        original=json.loads(json.dumps(value))
        for mutate in [lambda v:v.update(featuresSha256='0'*64),lambda v:v['cards'][0].update(pointOffset=999),
                       lambda v:v['cards'][0].update(id='member-card-999'),lambda v:v.update(region='jp')]:
            value=json.loads(json.dumps(original));mutate(value);write(directory/'card-recognition.json',value)
            with self.assertRaises(ValueError):publish_content(candidate,self.store,recognition_index=directory)
            self.assertEqual(read_json(self.store/'current.json'),result['pointer'])
