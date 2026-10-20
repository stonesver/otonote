import tempfile
import unittest
import zipfile
from pathlib import Path
from backend.update_archive.sources.client_entries import members
from backend.update_archive.models import ArchiveError


class ClientEntryTests(unittest.TestCase):
    def test_package_inventory_is_bound_to_exact_member_bytes(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'sample.apk'
            with zipfile.ZipFile(p,'w') as z:z.writestr('assets/new.txt',b'hello')
            self.assertEqual(members(p),[('assets/new.txt',5,hashlib.sha256(b'hello').hexdigest())])

    def test_archive_expansion_and_path_limits_apply_before_extraction(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'sample.apk'
            with zipfile.ZipFile(p,'w') as z:z.writestr('../unsafe',b'hello')
            with self.assertRaises(ArchiveError):members(p)
            with zipfile.ZipFile(p,'w') as z:z.writestr('safe',b'hello')
            with self.assertRaisesRegex(ArchiveError,'package_expansion_exceeded'):members(p,max_total=4)

    def test_verified_jp_split_without_version_name_keeps_stable_member_identity(self):
        from unittest.mock import patch
        from backend.update_archive.sources.client_entries import VerifiedPackages
        from backend.update_archive.store import file_digest
        from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256, JP_APKSIG_SHA256
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);jar=root/'verifier.jar';jar.write_bytes(b'synthetic verifier')
            packages=[]; facts={}
            for i,split in enumerate((None,'config.arm64_v8a','UnityDataAssetPack')):
                path=root/f'{i}.apk'
                with zipfile.ZipFile(path,'w') as z:z.writestr('assets/example.txt',b'hello')
                packages.append({'path':str(path),'sha256':file_digest(path),'name':path.name})
                facts[str(path)]={'versionName':'1.0.4' if split is None else None,'versionCode':4,
                    'packageName':'com.bushiroad.sirius','certificateSha256':JP_CERTIFICATE_SHA256,'splitName':split}
            real_digest=file_digest
            with patch('tools.resource_pipeline.package_intake.inspect_apk',side_effect=lambda p:facts[str(p)]), \
                 patch('tools.global_remote_sync.verify_apk_signature'), \
                 patch('backend.update_archive.sources.client_entries.file_digest',side_effect=lambda p:JP_APKSIG_SHA256 if Path(p)==jar else real_digest(p)):
                rows=VerifiedPackages('jp',packages,jar).inventory('1.0.4')
            self.assertEqual({r['key'] for r in rows},{'base/assets/example.txt',
                'config.arm64_v8a/assets/example.txt','UnityDataAssetPack/assets/example.txt'})
