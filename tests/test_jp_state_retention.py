import copy
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from tools.global_remote_sync import file_hash, write_json
from tools.jp_state_retention import prune, verified_run
from tools.r2_production_gate import RECEIPT_FIELD, RECEIPT_SCHEMA, canonical, digest, source_identity
from tools.resource_pipeline.adapters.global_public import version_identity
from tests.test_jp_update import observation


class JpRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.workspace=self.root/'output/r2-jp/workspace'
        self.source=observation();identity=list(version_identity(self.source));code='f'*64
        run=hashlib.sha256(json.dumps({'source':identity,'code':code},sort_keys=True).encode()).hexdigest()[:24]
        self.current=self.workspace/'runs'/run
        self.catalog=self.current/'snapshot/RemoteCatalog/catalog_main.bin'
        self.catalog.parent.mkdir(parents=True);self.catalog.write_bytes(b'catalog')
        write_json(self.current/'snapshot/report.json',{'status':'verified_snapshot','observation':self.source,'catalogSha256':file_hash(self.catalog)})
        manifest=self.current/'inputs/content-release.json'
        write_json(manifest,{'objects':{'remoteCatalog':{'sha256':file_hash(self.catalog)}}})
        plan=self.current/'inputs/release-inputs.json'
        write_json(plan,{'environments':[{'region':'jp','manifest':str(manifest.relative_to(self.root)),'manifestSha256':file_hash(manifest)}]})
        self.state={'schemaVersion':1,'region':'jp','status':'built','runId':run,'versionIdentity':identity,
                    'codeFingerprint':code,'inputPlanSha256':file_hash(plan),'publication':{'pointer':{'test':'pointer'}}}
        self.production=copy.deepcopy(self.state)
        receipt={key:'a'*64 for key in ('sourceSha256','packageSha256','producerCodeSha256','codeSha256','inputSha256','imageDigest','publicPointerSha256')}
        receipt.update(schemaVersion=RECEIPT_SCHEMA,region='jp',stateSha256=digest(canonical(self.state)),
            publicPointer=self.state['publication']['pointer'],
            inputPaths={'metadata':'output/r2-jp/metadata.v39.dat','apkRoot':'output/r2-jp/apks','unityVersion':'output/r2-jp/unity-version.txt'},
            trustedInputInventory=[{'test':'input'}],producerCodeSha256=code,sourceSha256=source_identity(identity))
        self.state[RECEIPT_FIELD]=receipt
        self.state_path=self.workspace/'state.json';write_json(self.state_path,self.state)
        self.old=self.workspace/'runs'/('a'*24);self.old.mkdir();(self.old/'old').write_text('old')
        for name in ('apks/base.apk','metadata.v39.dat','unity-version.txt','workspace/cache/image-conversions/test'):
            path=self.root/'output/r2-jp'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('keep')
        self.addCleanup(patch.stopall)
        patch('tools.r2_production_gate.trusted_input_inventory',return_value=[{'test':'input'}]).start()
        self.preflight=patch('tools.r2_production_gate.verified_plan',return_value=True).start()

    def test_only_old_runs_removed_after_bound_success(self):
        before=self.state_path.read_bytes()
        self.assertEqual(verified_run(self.root,self.workspace,self.state),(self.current,self.catalog))
        result=prune(self.root,self.production)
        self.assertEqual(result['removedRuns'],1);self.assertFalse(self.old.exists())
        self.assertTrue(self.current.exists());self.assertEqual(self.state_path.read_bytes(),before)
        self.assertTrue((self.workspace/'cache/image-conversions/test').exists())
        self.assertTrue((self.root/'output/r2-jp/apks/base.apk').exists())

    def test_new_code_run_supplies_verified_previous_catalog_and_cache(self):
        from tools.jp_update import run
        cache=self.current/'inputs/.cache/remote';cache.mkdir(parents=True)
        client=Mock();client.discover.return_value=self.source
        def snapshot(_client, output):
            write_json(output/'report.json',{'status':'verified_snapshot','observation':self.source})
        with patch('tools.jp_update.ROOT',self.root), \
                patch('tools.jp_update.fingerprint',return_value='e'*64), \
                patch('tools.jp_update.client_from_metadata',return_value=client), \
                patch('tools.jp_update.snapshot',side_effect=snapshot), \
                patch('tools.jp_update.build_inputs',side_effect=ValueError('stop before extraction')) as build:
            with self.assertRaisesRegex(ValueError,'stop before extraction'):
                run(metadata=self.root/'metadata',apk_root=self.root/'apks',
                    unity_version_file=self.root/'unity',workspace=self.workspace,content_store=self.root/'content')
        self.assertEqual(build.call_args.kwargs['reuse_catalog'],self.catalog)
        self.assertEqual(build.call_args.kwargs['reuse_cache'],(cache,))
        self.assertTrue(self.old.exists())

    def test_receipt_production_or_catalog_mismatch_preserves_old_run(self):
        cases=('no_receipt','changed_state','changed_production','changed_catalog','failed_preflight')
        for case in cases:
            with self.subTest(case=case):
                state=copy.deepcopy(self.state);production=copy.deepcopy(self.production)
                self.catalog.write_bytes(b'catalog');self.preflight.return_value=True
                if case=='no_receipt':state.pop(RECEIPT_FIELD)
                if case=='changed_state':state['runId']='b'*24
                if case=='changed_production':production['status']='failed'
                if case=='changed_catalog':self.catalog.write_bytes(b'changed')
                if case=='failed_preflight':self.preflight.return_value=False
                write_json(self.state_path,state)
                with self.assertRaises(ValueError):prune(self.root,production)
                self.assertTrue(self.old.exists())

    def test_unexpected_or_linked_runs_abort_before_any_delete(self):
        strange=self.workspace/'runs'/'unexpected';strange.mkdir()
        with self.assertRaisesRegex(ValueError,'unexpected'):prune(self.root,self.production)
        self.assertTrue(self.old.exists());strange.rmdir()
        external=self.root/'external';external.mkdir();(external/'keep').write_text('keep')
        linked=self.workspace/'runs'/('b'*24);linked.symlink_to(external)
        with self.assertRaisesRegex(ValueError,'linked'):prune(self.root,self.production)
        self.assertTrue(self.old.exists());self.assertTrue((external/'keep').exists())

    def test_prior_plan_cannot_reference_another_run(self):
        plan=self.current/'inputs/release-inputs.json';value=json.loads(plan.read_text())
        external=self.root/'elsewhere.json';write_json(external,{'objects':{}})
        value['environments'][0].update(manifest='elsewhere.json',manifestSha256=file_hash(external))
        write_json(plan,value);state={**self.state,'inputPlanSha256':file_hash(plan)}
        with self.assertRaisesRegex(ValueError,'source manifest'):verified_run(self.root,self.workspace,state)
