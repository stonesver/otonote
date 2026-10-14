import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from tools.r2_functional_check import check, DOCUMENTS

class FunctionalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / 'releases' / ('a' * 24);self.release.mkdir(parents=True)
        self.docs = [
            {'release': {'id': 'source'}, 'memberCards': [1], 'supportCards': [2], 'musicTracks': [3]},
            {'sourceReleaseId': 'source', 'events': {'records': []}},
            {'sourceReleaseId': 'source', 'skills': [1]},
            {'sourceReleaseId': 'source', 'verificationStatus': 'reference_compatible'},
            {'sourceReleaseId': 'source', 'status': 'compatible', 'checks': 5, 'issues': []}]
        self.recognition = None
        self.release_record = None
        self.write()

    def write(self):
        manifest = {'schemaVersion': 1, 'region': 'jp', 'contentReleaseId': 'source',
                    'root': '/content/releases/' + 'a' * 24 + '/', 'locales': {}}
        for locale in ('en', 'zh-CN'):
            files = {}
            for name, source in zip(DOCUMENTS, self.docs):
                doc = copy.deepcopy(source)
                if name == DOCUMENTS[0]:
                    doc['projectionContext'] = {'contentReleaseId': 'source', 'region': 'jp', 'channel': 'production', 'locale': locale}
                relative = locale + '/' + name
                target = self.release / relative;target.parent.mkdir(parents=True, exist_ok=True)
                raw = json.dumps(doc).encode();target.write_bytes(raw)
                files[name] = {'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            if self.recognition:
                relative = locale + '/recognition.json'
                raw = json.dumps(self.recognition).encode();(self.release/relative).write_bytes(raw)
                files['supplemental/card-recognition.json'] = {'path':relative,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            manifest['locales'][locale] = {'files': files}
        if self.release_record is not None:manifest['releaseRecord'] = self.release_record
        raw = json.dumps(manifest).encode();(self.release / 'manifest.json').write_bytes(raw)
        (self.root / 'jp').mkdir(exist_ok=True)
        (self.root / 'jp/current.json').write_text(json.dumps({'manifest': manifest['root'] + 'manifest.json', 'sha256': hashlib.sha256(raw).hexdigest(), 'contentReleaseId': 'source'}))

    def test_optional_scoring_degradation_does_not_block_new_catalog(self):
        self.docs[-1] = {'status': 'unavailable', 'issues': [{'message': 'not supported'}]}
        self.docs[-2]['verificationStatus'] = 'unavailable'
        self.write()
        result = check(self.root, 'jp')
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['locales']['en']['scoring'], 'unavailable')
        self.assertIs(result['locales']['en']['gameplayVerified'], False)

    def test_cross_release_or_locale_damage_fails_before_upload(self):
        self.docs[2]['sourceReleaseId'] = 'wrong';self.write()
        with self.assertRaisesRegex(ValueError, 'release mismatch'):check(self.root, 'jp')
        self.docs[2]['sourceReleaseId'] = 'source';self.write()
        (self.release / 'en/projection/catalog.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):check(self.root, 'jp')

    def test_empty_success_and_missing_required_capability_rejected(self):
        self.docs[-1]['checks'] = 0;self.write()
        with self.assertRaisesRegex(ValueError, 'scoring success'):check(self.root, 'jp')
        self.docs[-1]['checks'] = 5;self.docs[0]['memberCards'] = [];self.write()
        with self.assertRaisesRegex(ValueError, 'capability absent'):check(self.root, 'jp')

    def add_recognition(self):
        import gzip
        from tools.card_recognition import ALGORITHM
        packed=gzip.compress(bytes(160))
        self.docs[0]['memberCards']=[{'id':'member-card-1','variantAssetIds':['a']}]
        self.docs[0]['supportCards']=[{'id':'support-card-2','variantAssetIds':['b']}]
        self.recognition={'schemaVersion':1,'algorithm':ALGORITHM,'region':'jp','sourceReleaseId':'source',
            'featuresPath':'recognition/features.bin.gz','compressedBytes':len(packed),'decodedBytes':160,
            'featuresSha256':hashlib.sha256(packed).hexdigest(),'cards':[{'id':'member-card-1','kind':'member','assetId':'a','count':4,'descriptorOffset':0,'pointOffset':128}],
            'missing':[{'id':'support-card-2','assetId':'b','reason':'image_missing'}]}
        (self.release/'recognition').mkdir(exist_ok=True)
        (self.release/'recognition/features.bin.gz').write_bytes(packed)
        self.write()

    def test_required_index_and_partial_coverage(self):
        with self.assertRaisesRegex(ValueError,'index absent'):check(self.root,'jp',require_recognition=True)
        self.add_recognition()
        result=check(self.root,'jp',require_recognition=True)
        for locale in ('en','zh-CN'):
            self.assertEqual(result['locales'][locale]['screenshotImport']['status'],'partial')
            self.assertEqual(result['locales'][locale]['screenshotImport']['missingCardIds'],['support-card-2'])
        self.recognition['missing']=[];self.write()
        with self.assertRaisesRegex(ValueError,'coverage is incomplete'):check(self.root,'jp')

    def test_index_cross_release_corruption_and_unknown_artwork_fail_closed(self):
        for field,value in [('sourceReleaseId','old'),('region','global'),('featuresSha256','0'*64)]:
            self.add_recognition();self.recognition[field]=value;self.write()
            with self.assertRaises(ValueError):check(self.root,'jp')
        self.add_recognition();self.recognition['cards'][0]['assetId']='foreign';self.write()
        with self.assertRaisesRegex(ValueError,'artwork is absent'):check(self.root,'jp')
        self.add_recognition();(self.release/'recognition/features.bin.gz').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):check(self.root,'jp')

    def test_release_record_must_match_catalog_and_each_locale_timestamp(self):
        self.docs[0]['release'].update(versionName='1.0.5',versionCode=10059)
        self.docs[0]['generatedAt']='2026-10-13T08:00:00Z'
        record={'region':'jp','sourceReleaseId':'source','clientVersion':'1.0.5','clientVersionCode':10059,
                'generatedAtByLocale':{'en':'2026-10-13T08:00:00Z','zh-CN':'2026-10-13T08:00:00Z'}}
        self.release_record=record;self.write()
        self.assertEqual(check(self.root,'jp')['releaseRecord'],record)
        for field,value in [('clientVersion','old'),('region','global'),('generatedAtByLocale',{'en':'2026-10-13T08:00:00Z','zh-CN':'old'})]:
            self.release_record={**record,field:value};self.write()
            with self.assertRaisesRegex(ValueError,'release record mismatch'):check(self.root,'jp')
