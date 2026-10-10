import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess
import contextlib
import io
from unittest.mock import patch

from tools.operations import AuditError, apply_deduplication, plan_deduplication, task_status, plan_code_deduplication, apply_code_deduplication, main


class MaintenanceTests(unittest.TestCase):
    def test_r2_publication_lock_blocks_maintenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.payload(root, 1)
            with (root/'.r2-prerender.lock').open('a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(AuditError, 'render_in_progress'):
                    plan_deduplication(root)

    def payload(self, root, number, data=b'{"fixture":true}'):
        pair = ('%024x' % number) + '-' + ('a' * 24)
        release = root / 'releases' / pair
        (release / 'payloads').mkdir(parents=True)
        (release / 'complete.json').write_text(json.dumps({'pair':pair,'codeId':pair[:24]}))
        path = release / 'payloads' / (hashlib.sha256(data).hexdigest() + '.json')
        path.write_bytes(data)
        return path

    def test_lossless_idempotent_dedup_preserves_every_release_and_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a,b,c = [self.payload(root,n) for n in range(3)]
            (root/'current').symlink_to(a.parent.parent.relative_to(root))
            (root/'previous').symlink_to(b.parent.parent.relative_to(root))
            pointer = os.readlink(root/'current')
            plan = plan_deduplication(root)
            self.assertEqual(len(plan['actions']),2)
            self.assertGreater(plan['estimatedReclaimBytes'],0)
            apply_deduplication(root,plan)
            self.assertEqual(len({p.stat().st_ino for p in (a,b,c)}),1)
            self.assertEqual(os.readlink(root/'current'),pointer)
            self.assertTrue(all(p.read_bytes()==b'{"fixture":true}' for p in (a,b,c)))
            self.assertEqual(plan_deduplication(root)['actions'],[])

    def test_changed_or_forged_plan_never_mutates_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.payload(root,1);b=self.payload(root,2)
            plan=plan_deduplication(root)
            plan['actions'][0]['target']='../../outside'
            with self.assertRaisesRegex(AuditError,'plan_changed'):
                apply_deduplication(root,plan)
            self.assertNotEqual(a.stat().st_ino,b.stat().st_ino)

    def test_corrupt_content_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.payload(root,1);b=self.payload(root,2)
            b.write_bytes(b'changed')
            with self.assertRaisesRegex(AuditError,'digest_mismatch'):
                plan_deduplication(root)
            b.unlink();b.symlink_to(a)
            with self.assertRaisesRegex(AuditError,'linked_payload'):
                plan_deduplication(root)

    def test_different_permissions_are_not_merged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.payload(root,1);b=self.payload(root,2)
            a.chmod(0o644);b.chmod(0o600)
            self.assertEqual(plan_deduplication(root)['actions'],[])

    def test_invalid_receipt_is_a_sanitized_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.payload(root,1)
            for value in ([],None,'not-an-object'):
                (a.parent.parent/'complete.json').write_text(json.dumps(value))
                with self.assertRaisesRegex(AuditError,'invalid_release_receipt'):
                    plan_deduplication(root)

    @unittest.skipUnless(hasattr(os,'setxattr') or sys.platform=='darwin','extended attributes unavailable')
    def test_different_extended_attributes_are_not_merged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.payload(root,1);b=self.payload(root,2)
            key='user.ournotes-test' if sys.platform.startswith('linux') else 'com.ournotes.test'
            try:
                if hasattr(os,'setxattr'):
                    os.setxattr(a,key,b'one');os.setxattr(b,key,b'two')
                else:
                    subprocess.check_call(['/usr/bin/xattr','-w',key,'one',str(a)])
                    subprocess.check_call(['/usr/bin/xattr','-w',key,'two',str(b)])
            except OSError:
                self.skipTest('filesystem does not support test attributes')
            self.assertEqual(plan_deduplication(root)['actions'],[])

    def test_running_renderer_blocks_maintenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.payload(root,1)
            with (root/'.render.lock').open('w') as stream:
                fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaisesRegex(AuditError,'render_in_progress'):
                    plan_deduplication(root)

    def test_external_hardlink_does_not_overestimate_reclaim(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.payload(root,1);b=self.payload(root,2)
            os.link(b,root/'outside-payload-store')
            plan=plan_deduplication(root)
            self.assertEqual(plan['estimatedReclaimBytes'],0)
            apply_deduplication(root,plan)
            self.assertEqual((root/'outside-payload-store').read_bytes(),b.read_bytes())

    def test_status_report_never_echoes_private_error(self):
        result=task_status({'status':'failed','error':'password=do-not-echo /private/path'})
        self.assertNotIn('do-not-echo',json.dumps(result))
        self.assertEqual(result['reason'],'task_failed')
        self.assertEqual(task_status({'status':'failed','error':'ValueError: insufficient free disk space'})['reason'],'disk_capacity_blocked')


class CodeMaintenanceTests(unittest.TestCase):
    def release(self, root, number, extra=None):
        data = {'assets/shared.js':b'export const shared = true;', 'boot-TEST.js':('boot-' + str(number)).encode()}
        data.update(extra or {})
        files = {name:hashlib.sha256(value).hexdigest() for name,value in sorted(data.items())}
        code = hashlib.sha256(json.dumps(files,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()[:24]
        release = root/'releases'/code
        for name,value in data.items():
            path=release/'compiled'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value)
        (release/'code-release.json').write_text(json.dumps({'schemaVersion':1,'contentSchemaVersion':1,'codeId':code,'files':files}))
        (release/'index.html').write_text('<script src="/app/releases/'+code+'/boot-TEST.js"></script>')
        return release

    def test_code_dedup_preserves_versions_receipts_shells_and_every_byte(self):
        from tools.code_publication import verify_code
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);b=self.release(root,2)
            (root/'current').symlink_to(a.relative_to(root));(root/'previous').symlink_to(b.relative_to(root))
            before={p.relative_to(root).as_posix():p.read_bytes() for p in (root/'releases').rglob('*') if p.is_file()}
            protected={p:p.stat().st_ino for release in (a,b) for p in (release/'index.html',release/'code-release.json')}
            identities=[verify_code(path)[0] for path in (a,b)]
            plan=plan_code_deduplication(root)
            self.assertEqual(plan['operation'],'deduplicate-code-assets')
            self.assertEqual(len(plan['actions']),1)
            self.assertGreater(plan['estimatedReclaimBytes'],0)
            apply_code_deduplication(root,plan)
            self.assertEqual((a/'compiled/assets/shared.js').stat().st_ino,(b/'compiled/assets/shared.js').stat().st_ino)
            self.assertEqual(protected,{p:p.stat().st_ino for p in protected})
            self.assertEqual(before,{p.relative_to(root).as_posix():p.read_bytes() for p in (root/'releases').rglob('*') if p.is_file()})
            self.assertEqual(identities,[verify_code(path)[0] for path in (a,b)])
            self.assertEqual(os.readlink(root/'current'),a.relative_to(root).as_posix())
            self.assertEqual(os.readlink(root/'previous'),b.relative_to(root).as_posix())
            self.assertEqual(plan_code_deduplication(root)['actions'],[])

    def test_code_manifest_and_digest_corruption_fail_before_mutation(self):
        for malformed in ([],None,{'schemaVersion':2},'PRIVATE-INVALID'):
            with self.subTest(malformed=malformed),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);release=self.release(root,1)
                (release/'code-release.json').write_text(json.dumps(malformed))
                with self.assertRaises(AuditError):plan_code_deduplication(root)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);release=self.release(root,1);marker=release/'code-release.json'
            metadata=json.loads(marker.read_text());metadata['files']['assets/shared.js']='a'*64
            marker.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(AuditError,'code_identity_mismatch'):plan_code_deduplication(root)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);release=self.release(root,1)
            (release/'compiled/assets/shared.js').write_bytes(b'corrupt')
            with self.assertRaisesRegex(AuditError,'code_asset_digest_mismatch'):plan_code_deduplication(root)

    def test_traversal_and_symlink_assets_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);release=self.release(root,1);marker=release/'code-release.json'
            metadata=json.loads(marker.read_text());metadata['files']['../../outside.js']=hashlib.sha256(b'outside').hexdigest()
            metadata['codeId']=hashlib.sha256(json.dumps(metadata['files'],separators=(',',':')).encode()).hexdigest()[:24]
            marker.write_text(json.dumps(metadata));release.rename(release.parent/metadata['codeId'])
            with self.assertRaises(AuditError):plan_code_deduplication(root)
        for target in ('compiled/assets/shared.js','compiled/assets','code-release.json'):
            with self.subTest(target=target),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);release=self.release(root,1);path=release/target;outside=root/'outside'
                path.rename(outside);path.symlink_to(outside)
                with self.assertRaises(AuditError):plan_code_deduplication(root)

    def test_unknown_release_is_skipped_but_owned_invalid_release_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release(root,1);(root/'releases/unknown').mkdir()
            self.assertEqual(plan_code_deduplication(root)['skippedUnknown'],1)
            (root/'releases'/('f'*24)).mkdir()
            with self.assertRaises(AuditError):plan_code_deduplication(root)

    def test_code_lock_and_stale_plan_refuse_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);b=self.release(root,2)
            with (root/'.publication.lock').open('w') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaisesRegex(AuditError,'code_publication_in_progress'):plan_code_deduplication(root)
            plan=plan_code_deduplication(root)
            (a/'verification.json').write_text('{"privateReceipt":"local-only"}')
            with self.assertRaisesRegex(AuditError,'plan_changed'):apply_code_deduplication(root,plan)
            plan=plan_code_deduplication(root);plan['actions'][0]['target']='releases/'+a.name+'/index.html'
            with self.assertRaisesRegex(AuditError,'plan_changed'):apply_code_deduplication(root,plan)
            self.assertNotEqual((a/'compiled/assets/shared.js').stat().st_ino,(b/'compiled/assets/shared.js').stat().st_ino)

    def test_code_external_links_remain_valid_and_are_not_counted_as_reclaimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);releases=sorted([self.release(root,1),self.release(root,2)])
            target=releases[1]/'compiled/assets/shared.js';os.link(target,root/'external-copy')
            plan=plan_code_deduplication(root)
            self.assertEqual(plan['estimatedReclaimBytes'],0)
            apply_code_deduplication(root,plan)
            self.assertEqual((root/'external-copy').read_bytes(),target.read_bytes())

    def test_code_permissions_and_attribute_groups_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);b=self.release(root,2)
            asset=b/'compiled/assets/shared.js';asset.chmod(0o600)
            self.assertEqual(plan_code_deduplication(root)['actions'],[])
            asset.chmod(0o644)
            with patch('tools.operations.attribute_identity',side_effect=lambda p: 'second-label' if p==asset.resolve() else 'first-label'):
                self.assertEqual(plan_code_deduplication(root)['actions'],[])

    def test_shell_integrity_records_and_compiled_receipts_are_never_linked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            shell='<script src="/app/releases/__CODE_ID__/boot-TEST.js"></script>'
            extras={'entry-shell.json':json.dumps({'sha256':hashlib.sha256(shell.encode()).hexdigest()}).encode(),
                    'nested/index.html':b'preserved html','verification.json':b'{"fixed":"receipt"}'}
            releases=[self.release(root,n,extras) for n in (1,2)]
            protected={p:p.stat().st_ino for release in releases for p in (release/'compiled'/name for name in extras)}
            plan=plan_code_deduplication(root)
            self.assertEqual(len(plan['actions']),1)
            apply_code_deduplication(root,plan)
            self.assertEqual(protected,{p:p.stat().st_ino for p in protected})

    def test_code_cli_plan_apply_and_invalid_receipt_errors_are_sanitized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);self.release(root,2);plan=root/'private-plan.json'
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(main(['dedupe-plan','--code-root',str(root),'--plan',str(plan)]),0)
            self.assertNotIn('actions',json.loads(out.getvalue()))
            self.assertEqual(plan.stat().st_mode & 0o777,0o600)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['dedupe-apply','--code-root',str(root),'--plan',str(plan)]),0)
            (a/'code-release.json').write_text('["PRIVATE-value"]')
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(main(['dedupe-plan','--code-root',str(root),'--plan',str(root/'invalid-plan')]),2)
            self.assertEqual(json.loads(err.getvalue()),{'status':'blocked','reason':'invalid_code_receipt'})

    def test_partial_code_apply_is_lossless_and_can_be_reaudited(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);releases=[self.release(root,n) for n in range(3)]
            plan=plan_code_deduplication(root);replace=os.replace;calls=[]
            def fail_second(source,target):
                calls.append(target)
                if len(calls)==2:raise OSError('synthetic failure')
                replace(source,target)
            with patch('tools.operations.os.replace',side_effect=fail_second):
                with self.assertRaises(OSError):apply_code_deduplication(root,plan)
            self.assertTrue(all((p/'compiled/assets/shared.js').read_bytes()==b'export const shared = true;' for p in releases))
            self.assertEqual(len(plan_code_deduplication(root)['actions']),1)
            self.assertFalse(list(root.rglob('.dedupe-*')))

    def test_explicit_exclusion_never_reads_or_changes_the_whole_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);b=self.release(root,2);excluded=self.release(root,3)
            unexpected=excluded/'compiled/unlisted.js';unexpected.write_bytes(b'untouched extra asset')
            (root/'current').symlink_to(excluded.relative_to(root))
            before={p:(p.stat().st_ino,p.read_bytes()) for p in excluded.rglob('*') if p.is_file()}
            original_open=Path.open;original_stat=Path.stat
            def guard_open(path,*args,**kwargs):
                if path==excluded or excluded in path.parents:raise AssertionError('excluded version was opened')
                return original_open(path,*args,**kwargs)
            def guard_stat(path,*args,**kwargs):
                if path==excluded or excluded in path.parents:raise AssertionError('excluded version was inspected')
                return original_stat(path,*args,**kwargs)
            with patch.object(Path,'open',guard_open),patch.object(Path,'stat',guard_stat):
                plan=plan_code_deduplication(root,[excluded.name])
                self.assertEqual(plan['excludedCodeIds'],[excluded.name])
                self.assertEqual(len(plan['actions']),1)
                self.assertTrue(all(excluded.name not in action['source']+action['target'] for action in plan['actions']))
                apply_code_deduplication(root,plan,[excluded.name])
            self.assertEqual(before,{p:(p.stat().st_ino,p.read_bytes()) for p in before})
            self.assertEqual(os.readlink(root/'current'),excluded.relative_to(root).as_posix())
            self.assertEqual((a/'compiled/assets/shared.js').stat().st_ino,(b/'compiled/assets/shared.js').stat().st_ino)

    def test_exclusion_does_not_relax_other_release_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);excluded=self.release(root,2)
            (excluded/'code-release.json').write_text('invalid excluded receipt')
            (a/'compiled/unlisted.js').write_bytes(b'unlisted')
            with self.assertRaisesRegex(AuditError,'code_inventory_mismatch'):
                plan_code_deduplication(root,[excluded.name])
            (a/'compiled/unlisted.js').unlink()
            (a/'compiled/assets/shared.js').write_bytes(b'corrupt')
            with self.assertRaisesRegex(AuditError,'code_asset_digest_mismatch'):
                plan_code_deduplication(root,[excluded.name])

    def test_apply_requires_the_same_explicit_exclusions_and_untampered_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.release(root,1);b=self.release(root,2);excluded=self.release(root,3)
            plan=plan_code_deduplication(root,[excluded.name])
            for supplied in ((),[a.name],[excluded.name,a.name]):
                with self.assertRaisesRegex(AuditError,'plan_changed'):
                    apply_code_deduplication(root,plan,supplied)
            altered=dict(plan,excludedCodeIds=[a.name])
            with self.assertRaisesRegex(AuditError,'plan_changed'):
                apply_code_deduplication(root,altered,[a.name])
            self.assertNotEqual((a/'compiled/assets/shared.js').stat().st_ino,(b/'compiled/assets/shared.js').stat().st_ino)

    def test_exclusion_ids_are_strict_and_legacy_plans_still_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release(root,1);self.release(root,2)
            for invalid in ('F'*24,'f'*23,'f'*25,'../'+'f'*24,'f'*24+'\n',None,24):
                with self.subTest(invalid=invalid),self.assertRaisesRegex(AuditError,'invalid_excluded_code_id'):
                    plan_code_deduplication(root,[invalid])
            legacy=plan_code_deduplication(root)
            self.assertNotIn('excludedCodeIds',legacy)
            apply_code_deduplication(root,legacy)

    def test_cli_repeats_exclusions_and_rejects_them_for_render_stores(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.release(root,1);self.release(root,2);a=self.release(root,3);b=self.release(root,4)
            plan=root/'private-plan.json'; exclusions=['--exclude-code-id',b.name,'--exclude-code-id',a.name]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['dedupe-plan','--code-root',str(root),'--plan',str(plan)]+exclusions),0)
                self.assertEqual(main(['dedupe-apply','--code-root',str(root),'--plan',str(plan)]+exclusions),0)
            self.assertEqual(json.loads(plan.read_text())['excludedCodeIds'],sorted([a.name,b.name]))
            for command in ('dedupe-plan','dedupe-apply'):
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(main([command,'--rendered-root',str(root),'--plan',str(plan)]+exclusions),2)
                self.assertEqual(json.loads(err.getvalue())['reason'],'code_exclusions_require_code_root')

class ContentMaintenanceTests(unittest.TestCase):
    def setUp(self):
        from tools.operations import plan_content_deduplication, apply_content_deduplication
        self.plan = plan_content_deduplication
        self.apply = apply_content_deduplication

    def snapshot(self, root, number, region='global'):
        name = '%024x' % number
        release = root/'releases'/name
        data = {'public/media/shared.bin':b'fixture-media-'*1024,
                'en/catalog.json':b'{"fixture":true}', 'zh-CN/catalog.json':b'{"fixture":true}'}
        for relative, value in data.items():
            path=release/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value)
        manifest={'schemaVersion':1,'root':'/content/releases/'+name+'/', 'contentReleaseId':'fixture-'+str(number),
                  'region':region,'channel':'production','locales':{}}
        for locale in ('en','zh-CN'):
            relative=locale+'/catalog.json';value=data[relative]
            manifest['locales'][locale]={'files':{'catalog':{'path':relative,'bytes':len(value),'sha256':hashlib.sha256(value).hexdigest()}},'groups':{}}
        (release/'manifest.json').write_text(json.dumps(manifest))
        self.seal(release)
        return release

    def seal(self, release):
        files={p.relative_to(release).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
               for p in sorted(release.rglob('*')) if p.is_file() and p.name!='.receipt.json'}
        (release/'.receipt.json').write_text(json.dumps({'schemaVersion':1,'candidateSha256':'a'*64,'files':files}))

    def pointer(self, root, release, previous=False):
        manifest=json.loads((release/'manifest.json').read_text())
        folder=root if manifest['region']=='global' else root/'jp';folder.mkdir(exist_ok=True)
        path=folder/('previous.json' if previous else 'current.json')
        path.write_text(json.dumps({'schemaVersion':1,'contentReleaseId':manifest['contentReleaseId'],
            'manifest':manifest['root']+'manifest.json','sha256':hashlib.sha256((release/'manifest.json').read_bytes()).hexdigest()}))
        return path

    def test_four_snapshots_preserve_every_byte_pointer_and_protected_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);snapshots=[self.snapshot(root,n,'global' if n<3 else 'jp') for n in range(1,5)]
            pointers=[self.pointer(root,s,previous=i%2==1) for i,s in enumerate(snapshots)]
            before={p:p.read_bytes() for p in root.rglob('*') if p.is_file()}
            protected={p:p.stat().st_ino for p in list(pointers)+[s/n for s in snapshots for n in ('manifest.json','.receipt.json')]}
            plan=self.plan(root)
            self.assertEqual(plan['operation'],'deduplicate-content-assets')
            self.assertEqual(len(plan['actions']),10)
            self.assertGreater(plan['estimatedReclaimBytes'],0)
            self.apply(root,plan)
            self.assertEqual(before,{p:p.read_bytes() for p in before})
            self.assertEqual(protected,{p:p.stat().st_ino for p in protected})
            self.assertEqual(len({(s/'public/media/shared.bin').stat().st_ino for s in snapshots}),1)
            self.assertEqual(self.plan(root)['actions'],[])

    def test_external_links_are_not_targets_or_estimated_reclaim(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.snapshot(root,1);b=self.snapshot(root,2)
            # Every eligible inode has an external link: there must be no work.
            for i,p in enumerate([p for s in (a,b) for p in s.rglob('*') if p.is_file() and p.name not in ('.receipt.json','manifest.json')]):
                os.link(p,root/('outside-'+str(i)))
            plan=self.plan(root)
            self.assertEqual(plan['actions'],[]);self.assertEqual(plan['estimatedReclaimBytes'],0)
            self.apply(root,plan)

    def test_externally_linked_keeper_reclaims_all_internal_target_links_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.snapshot(root,1);b=self.snapshot(root,2)
            keeper=a/'public/media/shared.bin';target=b/'public/media/shared.bin'
            os.link(keeper,root/'outside');os.link(target,b/'public/media/alias.bin');self.seal(b)
            plan=self.plan(root)
            media=[action for action in plan['actions'] if '/media/' in action['target']]
            self.assertEqual(len(media),2)
            self.assertTrue(all(action['source']==keeper.relative_to(root).as_posix() for action in media))
            self.apply(root,plan)
            self.assertEqual(keeper.stat().st_ino,target.stat().st_ino)
            self.assertEqual((root/'outside').read_bytes(),target.read_bytes())

    def test_receipt_actual_bytes_missing_extra_and_duplicate_keys_rejected(self):
        mutations=('bad-json','candidate','digest','missing','extra','duplicate','traversal')
        for kind in mutations:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);s=self.snapshot(root,1);marker=s/'.receipt.json';value=json.loads(marker.read_text())
                if kind=='bad-json':marker.write_text('[]')
                elif kind=='candidate':value['candidateSha256']='invalid';marker.write_text(json.dumps(value))
                elif kind=='digest':(s/'public/media/shared.bin').write_bytes(b'corrupt')
                elif kind=='missing':(s/'en/catalog.json').unlink()
                elif kind=='extra':(s/'extra.bin').write_bytes(b'extra')
                elif kind=='duplicate':marker.write_text('{"schemaVersion":1,"schemaVersion":1}')
                else:value['files']['../escape']='a'*64;marker.write_text(json.dumps(value))
                with self.assertRaises(AuditError):self.plan(root)

    def test_symlink_files_directories_receipts_and_pointers_rejected(self):
        for relative in ('public/media/shared.bin','public/media','.receipt.json','manifest.json'):
            with self.subTest(relative=relative),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);s=self.snapshot(root,1);p=s/relative;outside=root/'outside';p.rename(outside);p.symlink_to(outside)
                with self.assertRaises(AuditError):self.plan(root)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);s=self.snapshot(root,1);p=self.pointer(root,s);p.rename(root/'outside');p.symlink_to(root/'outside')
            with self.assertRaises(AuditError):self.plan(root)

    def test_manifest_and_pointer_bindings_rejected(self):
        for kind in ('root','locale-digest','locale-size','pointer-digest','pointer-region','pointer-release'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);s=self.snapshot(root,1);p=self.pointer(root,s)
                if kind.startswith('pointer'):
                    value=json.loads(p.read_text())
                    if kind=='pointer-digest':value['sha256']='b'*64
                    elif kind=='pointer-release':value['contentReleaseId']='other'
                    else:(root/'jp').mkdir();p.rename(root/'jp/current.json');p=root/'jp/current.json'
                    p.write_text(json.dumps(value))
                else:
                    value=json.loads((s/'manifest.json').read_text())
                    if kind=='root':value['root']='/content/releases/'+'f'*24+'/'
                    elif kind=='locale-digest':value['locales']['en']['files']['catalog']['sha256']='b'*64
                    else:value['locales']['en']['files']['catalog']['bytes']+=1
                    (s/'manifest.json').write_text(json.dumps(value));self.seal(s)
                with self.assertRaises(AuditError):self.plan(root)

    def test_plan_tampering_and_changed_receipt_pointer_or_links_block_before_apply(self):
        for kind in ('forged','receipt','pointer','external-link'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);a=self.snapshot(root,1);b=self.snapshot(root,2);p=self.pointer(root,a)
                plan=self.plan(root);before=(a/'public/media/shared.bin').stat().st_ino
                if kind=='forged':plan['actions'][0]['target']='../../outside'
                elif kind=='receipt':
                    value=json.loads((a/'.receipt.json').read_text());value['candidateSha256']='b'*64;(a/'.receipt.json').write_text(json.dumps(value))
                elif kind=='pointer':self.pointer(root,b)
                else:os.link(b/'public/media/shared.bin',root/'outside')
                with self.assertRaisesRegex(AuditError,'plan_changed'):self.apply(root,plan)
                self.assertEqual((a/'public/media/shared.bin').stat().st_ino,before)
                self.assertNotEqual(before,(b/'public/media/shared.bin').stat().st_ino)

    def test_shared_publication_lock_blocks_plan_and_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.snapshot(root,1);plan=self.plan(root)
            with (root/'.publication.lock').open('a+') as stream:
                fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaisesRegex(AuditError,'content_publication_in_progress'):self.plan(root)
                with self.assertRaisesRegex(AuditError,'content_publication_in_progress'):self.apply(root,plan)

    def test_permissions_attributes_and_actual_flags_are_not_merged(self):
        for kind in ('mode','attributes','flags','immutable'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);a=self.snapshot(root,1);b=self.snapshot(root,2);target=b/'public/media/shared.bin'
                if kind=='mode':target.chmod(0o600)
                with contextlib.ExitStack() as stack:
                    if kind=='attributes':stack.enter_context(patch('tools.operations.attribute_identity',side_effect=lambda p:'other' if p==target.resolve() else 'common'))
                    if kind in ('flags','immutable'):
                        stack.enter_context(patch('tools.operations.filesystem_flags',side_effect=lambda p:(0x10 if sys.platform.startswith('linux') else 0x2) if kind=='immutable' else (1 if p==target.resolve() else 0)))
                    plan=self.plan(root)
                self.assertFalse(any('/media/' in action['target'] for action in plan['actions']))

    def test_linux_flags_use_ioctl_and_fail_closed_if_unavailable(self):
        from tools.operations import filesystem_flags
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'file';path.write_bytes(b'fixture')
            def ioctl(fd,request,buffer,mutate):buffer[0]=0x80000
            with patch('tools.operations.sys.platform','linux'),patch('tools.operations.fcntl.ioctl',side_effect=ioctl) as called:
                self.assertEqual(filesystem_flags(path),0x80000);self.assertEqual(called.call_count,1)
            with patch('tools.operations.sys.platform','linux'),patch('tools.operations.fcntl.ioctl',side_effect=OSError()):
                with self.assertRaisesRegex(AuditError,'flags_unavailable'):filesystem_flags(path)

    def test_stable_hardlinks_are_hashed_once_and_late_metadata_changes_block(self):
        import tools.operations as operations
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=self.snapshot(root,1);self.snapshot(root,2)
            os.link(a/'public/media/shared.bin',a/'public/media/alias.bin');self.seal(a)
            with patch('tools.operations.digest',wraps=operations.digest) as hashed:
                plan=self.plan(root)
            paths=[call.args[0] for call in hashed.call_args_list]
            self.assertEqual(sum(path.name in ('shared.bin','alias.bin') for path in paths),2)
            original=operations.make_content_plan
            def changed_after_inventory(store):
                fresh=original(store)
                target=store/fresh['actions'][0]['target']
                target.chmod(target.stat().st_mode ^ 0o100)
                return fresh
            with patch('tools.operations.make_content_plan',side_effect=changed_after_inventory):
                with self.assertRaisesRegex(AuditError,'content_metadata_changed_during_apply'):
                    self.apply(root,plan)

    def test_link_added_after_inventory_blocks_before_replacement(self):
        import tools.operations as operations
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.snapshot(root,1);self.snapshot(root,2);plan=self.plan(root)
            original=operations.make_content_plan
            def changed_after_inventory(store):
                fresh=original(store)
                os.link(store/fresh['actions'][0]['target'],store/'late-external-link')
                return fresh
            with patch('tools.operations.make_content_plan',side_effect=changed_after_inventory):
                with self.assertRaisesRegex(AuditError,'content_links_changed_during_apply'):
                    self.apply(root,plan)

    def test_cli_private_plan_mutual_exclusion_and_sanitized_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.snapshot(root,1);self.snapshot(root,2);plan=root/'plan.json'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['dedupe-plan','--content-root',str(root),'--plan',str(plan)]),0)
                self.assertEqual(plan.stat().st_mode&0o777,0o600)
                self.assertEqual(main(['dedupe-apply','--content-root',str(root),'--plan',str(plan)]),0)
            with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                main(['dedupe-plan','--content-root',str(root),'--code-root',str(root),'--plan',str(plan)])
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(main(['dedupe-plan','--content-root',str(root),'--exclude-code-id','a'*24,'--plan',str(plan)]),2)
            self.assertNotIn(tmp,err.getvalue())


if __name__=='__main__':
    unittest.main()
