import tempfile
import unittest
from pathlib import Path
from tools.release_candidate import canonical,digest
from tools.runtime_bundle import permitted,verify


class RuntimeBundleTests(unittest.TestCase):
    def test_allowlist_separates_program_config_and_state(self):
        self.assertTrue(permitted('catalog/evidence/arena-client.json'))
        self.assertFalse(permitted('catalog/evidence/unreviewed.json'))
        for name in ('tools/global_update.py','tools/resource_pipeline/models.py','packages/scoring/scoring-engine.mjs','packages/scoring/data/formal-scoring-rules.json','analysis/crypto/decrypt_master.py','backend/contracts.py'):
            self.assertTrue(permitted(name),name)
        for name in ('config/global-update.server.json','site/node_modules/astro/index.mjs','input/game.apk','output/state.json','deploy/live.env','../tools/escape.py','packaging/growth-tool/sdk.bhk.xml'):
            self.assertFalse(permitted(name),name)

    def test_manifest_pin_and_exact_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'tools').mkdir();source=root/'tools/demo.py';source.write_text('print(1)\n')
            manifest={'schemaVersion':1,'sourceCommit':'a'*40,'files':{'tools/demo.py':digest(source.read_bytes())}}
            (root/'runtime.json').write_bytes(canonical(manifest));expected=digest((root/'runtime.json').read_bytes())
            verify(root,expected)
            with self.assertRaisesRegex(ValueError,'manifest digest'):verify(root,'f'*64)
            source.write_text('print(2)\n')
            with self.assertRaisesRegex(ValueError,'inventory'):verify(root,expected)
            source.write_text('print(1)\n');(root/'config').mkdir();(root/'config/live.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'configuration'):verify(root,expected)

    def test_bootstrap_verifies_before_importing_remote_code(self):
        import subprocess,sys
        from tools.deploy_code import RUNTIME_BOOTSTRAP
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'tools').mkdir()
            (root/'tools/runtime_bundle.py').write_text("raise SystemExit('must never import')")
            files={'tools/runtime_bundle.py':digest((root/'tools/runtime_bundle.py').read_bytes())}
            (root/'runtime.json').write_bytes(canonical({'schemaVersion':1,'files':files}))
            expected=digest((root/'runtime.json').read_bytes())
            command=[sys.executable,'-I','-',str(root),expected]
            self.assertEqual(subprocess.run(command,input=RUNTIME_BOOTSTRAP.encode(),capture_output=True).returncode,0)
            (root/'tools/runtime.json').write_text('{}')
            self.assertNotEqual(subprocess.run(command,input=RUNTIME_BOOTSTRAP.encode(),capture_output=True).returncode,0)


class RuntimeExecutionTests(unittest.TestCase):
    def test_packaged_entrypoints_run_without_original_checkout(self):
        import os, shutil, subprocess, sys
        repo=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            program=Path(tmp)/'program';program.mkdir()
            # Only the packaging allowlist is available to the subprocess. No
            # original checkout/PYTHONPATH/node_modules/vendor can satisfy imports.
            for base in ('tools','analysis','backend','packages/scoring','catalog/evidence'):
                for path in (repo/base).rglob('*'):
                    name=path.relative_to(repo).as_posix()
                    if path.is_file() and permitted(name) and '__pycache__' not in path.parts:
                        target=program/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
            # Empty directories stand for separate read-only input/config and
            # writable output bind mounts. No program file is modified.
            (program/'input').mkdir();(program/'output').mkdir();(program/'config').mkdir()
            for name in ('baseline','plan','observation','package'):
                (program/'input'/name).write_text('{}')
            config={'schemaVersion':1,'workspace':'output/jobs','baseline':'input/baseline','inputPlan':'input/plan',
                    'initialObservation':'input/observation','initialPackage':'input/package','contentPublication':{'root':'/content'}}
            private=Path(tmp)/'workflow.json';private.write_bytes(canonical(config))
            env={'PATH':os.environ['PATH'],'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':str(program)}
            script="""import json,sys
from pathlib import Path
from unittest.mock import patch
from tools import global_update, content_publication, publish_prerender, release_candidates
config=global_update.load_config(Path(sys.argv[1]))
class Curl:
    returncode=0
    stdout='curl HTTP2'
    stderr=''
with patch('tools.global_update.subprocess.run',return_value=Curl()):
    assert global_update.doctor(config)['status']=='passed'
assert global_update.chart_projection_fingerprint()
assert (global_update.ROOT/'tools/resource_pipeline/VerifyApk.java').is_file()
assert global_update.main(['status','--config',sys.argv[1]])==0
"""
            result=subprocess.run([sys.executable,'-c',script,str(private)],cwd=program,env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(list((program/'output').iterdir()),[],'read-only status must not create a journal')
            for module in ('tools.global_update','tools.publish_prerender','tools.code_publication'):
                result=subprocess.run([sys.executable,'-m',module,'--help'],cwd=program,env=env,capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr.decode())


if __name__=='__main__':unittest.main()
