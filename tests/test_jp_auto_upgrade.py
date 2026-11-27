"""JP upgrade behavior across the official probe and verified private seed."""
import base64
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from tools.resource_pipeline.adapters import jp_public


class UpgradeSignalTests(unittest.TestCase):
    def test_forced_upgrade_accepts_store_link_without_global_apk_rules(self):
        client = jp_public.JpPublicClient('1.0.5', 'Basic '+base64.b64encode(b'client:fixture').decode())
        def response(command, **kwargs):
            Path(command[command.index('--dump-header')+1]).write_text(
                'HTTP/2 200\r\ncontent-type: application/grpc\r\ngrpc-status: 2\r\n'
                'grpc-message: client%20update%20required\r\nx-client-recommended-version: 1.0.6\r\n'
                'x-client-download-url: https://play.google.com/store/apps/details?id=com.bushiroad.sirius\r\n')
            Path(command[command.index('--output')+1]).write_bytes(b'')
            return Mock(returncode=0)
        with patch.object(jp_public.subprocess, 'run', side_effect=response):
            with self.assertRaises(jp_public.JpClientUpdateRequired) as caught:
                client.discover()
        self.assertEqual(caught.exception.version, '1.0.6')
        self.assertNotIn('http', str(caught.exception))

    def test_success_response_signals_upgrade_before_parsing_old_assets(self):
        client = jp_public.JpPublicClient('1.0.5', 'Basic '+base64.b64encode(b'client:fixture').decode())
        with patch.object(client, 'rpc', return_value=({'x-client-recommended-version':'1.0.6'}, b'')):
            with self.assertRaises(jp_public.JpClientUpdateRequired):
                client.discover()

class ClientBindingTests(unittest.TestCase):
    def test_unknown_metadata_is_not_accepted_without_verified_binding(self):
        from tempfile import TemporaryDirectory
        from tools.jp_client_profile import load_binding
        with TemporaryDirectory() as tmp:
            path = Path(tmp)/'metadata.v39.dat'
            path.write_bytes(b'unknown metadata')
            with self.assertRaisesRegex(ValueError, 'binding'):
                load_binding(path)

class SeedUpgradeTests(unittest.TestCase):
    def test_no_upgrade_does_not_download_or_replace_seed(self):
        from tempfile import TemporaryDirectory
        from tools import jp_client_upgrade as upgrade
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = Mock()
            client.discover.return_value = {'clientVersion':'1.0.5'}
            with patch.object(upgrade, 'validate_package', return_value=({'versionCode':10059}, {})), \
                 patch.object(upgrade, 'client_from_metadata', return_value=client), \
                 patch.object(upgrade, 'download_file') as download:
                self.assertEqual(upgrade.ensure_current(root), {'clientVersion':'1.0.5'})
            download.assert_not_called()

# Fully synthetic v39 metadata with actual field/default and literal tables.
def metadata_fixture(*, relocated=False, duplicate=False, rotate=False):
    import struct
    names = b'\0<PrivateImplementationDetails>\0'
    literals = ([b'P'*32, b'other', b'CLIENT'] if relocated else [b'other', b'CLIENT', b'P'*32])
    if duplicate:
        literals.append(b'CLIENT')
    if rotate:
        literals = [b'Q'*32 if value == b'P'*32 else value for value in literals]
    offsets = [0]
    for value in literals:
        offsets.append(offsets[-1]+len(value))
    tables = {0:(struct.pack('<'+'I'*len(offsets),*offsets),len(offsets)),
              1:(b''.join(literals),len(literals)), 2:(names,2), 5:(bytes(32),1),
              7:(struct.pack('<IIIIII',100,0,0,101,0,16),2),
              8:(b'K'*16+b'S'*8,0), 20:(bytes(36),1)}
    kind = bytearray(82)
    struct.pack_into('<III',kind,0,1,0,7)
    struct.pack_into('<I',kind,26,100)
    tables[19]=(bytes(kind),1)
    refs = bytearray(266*8)
    for i in range(266):
        struct.pack_into('<II',refs,i*8,99,0)
    for i,field in ((3,0),(7,1)) if relocated else ((261,0),(265,1)):
        struct.pack_into('<II',refs,i*8,7,field)
    tables[22]=(bytes(refs),266)
    data=bytearray(380)
    struct.pack_into('<II',data,0,0xFAB11BAF,39)
    for i in range(31):
        body,count=tables.get(i,(b'',0))
        struct.pack_into('<III',data,8+i*12,len(data),len(body),count)
        data.extend(body)
    return bytes(data)


class RelocatedBindingTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        from tempfile import TemporaryDirectory
        from tools import jp_client_profile as profile, jp_phone_inputs as pins
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.anchor=self.root/profile.ANCHOR_NAME
        self.anchor.write_bytes(metadata_fixture())
        self.metadata=self.root/'metadata.v39.dat'
        self.metadata.write_bytes(metadata_fixture(relocated=True))
        self.patches=[patch.object(pins,'JP_METADATA_SHA256',hashlib.sha256(self.anchor.read_bytes()).hexdigest()),
                      patch.object(profile,'NETWORK_INDICES',(1,2))]
        for p in self.patches:p.start();self.addCleanup(p.stop)

    def test_relocated_material_and_credentials_roundtrip_without_secret_receipt(self):
        import json
        from tools import jp_client_profile as profile
        binding=profile.derive_binding(self.anchor,self.metadata,'1.0.6')
        self.assertEqual(binding['networkIndices'],[2,0])
        self.assertEqual(binding['decoderProfile']['keyFieldUsage'],0x80000007)
        self.assertEqual(binding['decoderProfile']['nonceSeedFieldUsage'],0x8000000F)
        receipt={'schemaVersion':2,'status':'verified_seed','signatureVerified':True,
                 'clientVersion':'1.0.6','metadataSha256':binding['metadataSha256'],'binding':binding}
        raw=json.dumps(receipt)
        self.assertNotIn('CLIENT',raw);self.assertNotIn('P'*32,raw)
        (self.root/profile.PROFILE_NAME).write_text(raw)
        self.assertEqual(profile.load_binding(self.metadata),binding)
        from tools.jp_remote_sync import client_from_metadata
        client=client_from_metadata(self.metadata,authorize_builtin_credentials=True)
        self.assertEqual(client.client_version,'1.0.6')
        receipt['binding']['networkIndices']=[1,0]
        (self.root/profile.PROFILE_NAME).write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'differs from trusted'):
            profile.load_binding(self.metadata)

    def test_new_client_can_reuse_identical_metadata_without_reverting_its_version(self):
        import json
        from tools import jp_client_profile as profile
        self.metadata.write_bytes(self.anchor.read_bytes())
        binding=profile.derive_binding(self.anchor,self.metadata,'1.0.6')
        receipt={'schemaVersion':2,'status':'verified_seed','signatureVerified':True,
                 'clientVersion':'1.0.6','metadataSha256':binding['metadataSha256'],'binding':binding}
        (self.root/profile.PROFILE_NAME).write_text(json.dumps(receipt))
        self.assertEqual(profile.load_binding(self.metadata)['clientVersion'],'1.0.6')

    def test_changed_or_ambiguous_authentication_material_is_rejected(self):
        from tools.jp_client_profile import derive_binding
        for options in ({'duplicate':True},{'rotate':True}):
            self.metadata.write_bytes(metadata_fixture(relocated=True,**options))
            with self.assertRaisesRegex(ValueError,'no unique new location'):
                derive_binding(self.anchor,self.metadata,'1.0.6')

    def test_reviewed_rotation_requires_exact_version_and_metadata(self):
        import hashlib, json, os
        from tools import jp_client_profile as profile
        self.metadata.write_bytes(metadata_fixture(relocated=True, rotate=True))
        sha = hashlib.sha256(self.metadata.read_bytes()).hexdigest()
        reviewed = [{'clientVersion': '1.2.0', 'metadataSha256': sha, 'networkIndices': [2, 0]}]
        with patch.dict(os.environ, {profile.NETWORK_BINDINGS_ENV: json.dumps(reviewed)}):
            binding = profile.derive_binding(self.anchor, self.metadata, '1.2.0')
            receipt = {'schemaVersion': 2, 'status': 'verified_seed', 'signatureVerified': True,
                       'clientVersion': '1.2.0', 'metadataSha256': sha, 'binding': binding}
            (self.root/profile.PROFILE_NAME).write_text(json.dumps(receipt))
            self.assertEqual(profile.load_binding(self.metadata), binding)
            self.assertEqual(profile.credentials(self.metadata.read_bytes(), binding['networkIndices']),
                             (b'CLIENT', b'Q'*32))
            with self.assertRaisesRegex(ValueError, 'no unique new location'):
                profile.derive_binding(self.anchor, self.metadata, '1.2.1')
            self.metadata.write_bytes(self.metadata.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'no unique new location'):
                profile.derive_binding(self.anchor, self.metadata, '1.2.0')

    def test_invalid_or_duplicate_reviewed_rotations_are_rejected(self):
        import hashlib, json, os
        from tools import jp_client_profile as profile
        sha = hashlib.sha256(self.metadata.read_bytes()).hexdigest()
        row = {'clientVersion': '1.2.0', 'metadataSha256': sha, 'networkIndices': [2, 0]}
        for raw in ('not json', json.dumps([row, row]),
                    json.dumps([{**row, 'networkIndices': [True, 0]}])):
            with patch.dict(os.environ, {profile.NETWORK_BINDINGS_ENV: raw}):
                with self.assertRaisesRegex(ValueError, 'invalid reviewed JP network bindings'):
                    profile.derive_binding(self.anchor, self.metadata, '1.2.0')

    def test_changed_key_and_untrusted_anchor_are_rejected(self):
        from tools.jp_client_profile import derive_binding
        raw=self.metadata.read_bytes().replace(b'K'*16,b'J'*16)
        self.metadata.write_bytes(raw)
        with self.assertRaisesRegex(ValueError,'no unique new FieldRefs'):
            derive_binding(self.anchor,self.metadata,'1.0.6')
        self.anchor.write_bytes(b'not trusted')
        with self.assertRaisesRegex(ValueError,'anchor mismatch'):
            derive_binding(self.anchor,self.metadata,'1.0.6')

    def make_archive(self, *, samples=3, corrupt=False):
        import io,struct,zipfile
        from tools.jp_client_upgrade import XAPK_APKS
        import hashlib, subprocess
        archive=self.root/'client.xapk'
        with zipfile.ZipFile(archive,'w') as xapk:
            for source,target in XAPK_APKS.items():
                buffer=io.BytesIO()
                with zipfile.ZipFile(buffer,'w') as apk:
                    if target=='base.apk':
                        apk.writestr('assets/bin/Data/Managed/Metadata/global-metadata.dat',self.metadata.read_bytes())
                        apk.writestr('assets/bin/Data/data.unity3d',b'UnityFS\0'+struct.pack('>I',6)+b'5.x.x\0' + b'6000.3.12f1\0'+bytes(128))
                    elif target=='split_UnityDataAssetPack.apk':
                        for i in range(samples):
                            name=f'sample{i}.bundle'
                            clear=b'UnityFS\0'+bytes([i])*120
                            iv=hashlib.sha256(b'S'*8+name.encode()).digest()[:8]+bytes(8)
                            cipher=subprocess.check_output(['openssl','enc','-aes-128-ctr','-K',(b'K'*16).hex(),'-iv',iv.hex()],input=clear)
                            if corrupt and i==0:cipher=bytes([cipher[0]^1])+cipher[1:]
                            apk.writestr('assets/'+name,cipher)
                    else:
                        apk.writestr('lib/arm64-v8a/libil2cpp.so',b'fixture')
                xapk.writestr(source,buffer.getvalue())
        return archive

    def test_new_client_intake_verifies_all_splits_and_three_actual_ciphertexts(self):
        from tools import jp_client_upgrade as upgrade
        from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256
        archive=self.make_archive();stage=self.root/'stage';stage.mkdir()
        jar=self.root/'apksig.jar';jar.write_bytes(b'fixture verifier')
        package={'packageName':'com.bushiroad.sirius','certificateSha256':JP_CERTIFICATE_SHA256,
                 'versionName':'1.0.6','versionCode':10060,'packageSetSha256':'a'*64,
                 'splits':[{'logicalName':name,'sha256':'b'*64} for name in ('base','UnityDataAssetPack','config.arm64_v8a')]}
        with patch.object(upgrade,'JP_METADATA_SHA256',upgrade.file_hash(self.anchor)), \
             patch.object(upgrade,'JP_APKSIG_SHA256',upgrade.file_hash(jar)), \
             patch.object(upgrade,'build_package_set_manifest',return_value=package), \
             patch.object(upgrade,'verify_apk_signature') as signature:
            result=upgrade.prepare_client(archive,jar,stage,anchor=self.anchor,expected_version='1.0.6',previous_code=10059)
        self.assertEqual(signature.call_count,3)
        self.assertEqual(len(result['verifiedBundleSamples']),3)
        self.assertEqual(result['binding']['networkIndices'],[2,0])

    def test_corrupt_or_insufficient_packaged_samples_reject_intake(self):
        from tools import jp_client_upgrade as upgrade
        from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256
        jar=self.root/'verifier';jar.write_bytes(b'fixture')
        package={'packageName':'com.bushiroad.sirius','certificateSha256':JP_CERTIFICATE_SHA256,
                 'versionName':'1.0.6','versionCode':10060,'packageSetSha256':'a'*64,'splits':[]}
        for i,options in enumerate(({'samples':2},{'corrupt':True})):
            archive=self.make_archive(**options);stage=self.root/str(i);stage.mkdir()
            with patch.object(upgrade,'JP_METADATA_SHA256',upgrade.file_hash(self.anchor)), \
                 patch.object(upgrade,'JP_APKSIG_SHA256',upgrade.file_hash(jar)), \
                 patch.object(upgrade,'build_package_set_manifest',return_value=package), \
                 patch.object(upgrade,'verify_apk_signature'):
                with self.assertRaisesRegex(ValueError,'fewer than three|validation failed'):
                    upgrade.prepare_client(archive,jar,stage,anchor=self.anchor,expected_version='1.0.6',previous_code=10059)

    def test_duplicate_archive_member_is_rejected_before_identity_or_signature(self):
        import zipfile,warnings
        from tools import jp_client_upgrade as upgrade
        archive=self.make_archive();jar=self.root/'verifier';jar.write_bytes(b'fixture');stage=self.root/'stage';stage.mkdir()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(archive,'a') as xapk:xapk.writestr('com.bushiroad.sirius.apk',b'duplicate')
        with patch.object(upgrade,'JP_METADATA_SHA256',upgrade.file_hash(self.anchor)), \
             patch.object(upgrade,'JP_APKSIG_SHA256',upgrade.file_hash(jar)), \
             patch.object(upgrade,'build_package_set_manifest') as package:
            with self.assertRaisesRegex(ValueError,'duplicated'):
                upgrade.prepare_client(archive,jar,stage,anchor=self.anchor,expected_version='1.0.6',previous_code=10059)
        package.assert_not_called()

    def test_intake_wrong_version_signer_and_failed_crypto_signature_leave_current_untouched(self):
        from tools import jp_client_upgrade as upgrade
        from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256
        archive=self.make_archive();jar=self.root/'verifier';jar.write_bytes(b'fixture')
        package={'packageName':'com.bushiroad.sirius','certificateSha256':JP_CERTIFICATE_SHA256,
                 'versionName':'1.0.6','versionCode':10060,'packageSetSha256':'a'*64,'splits':[]}
        original=self.metadata.read_bytes()
        for i,changes in enumerate(({'versionName':'1.0.5'},{'versionName':'1.0.7'},
                                     {'versionCode':10059},{'certificateSha256':'0'*64},{})):
            stage=self.root/str(i);stage.mkdir()
            with patch.object(upgrade,'JP_METADATA_SHA256',upgrade.file_hash(self.anchor)), \
                 patch.object(upgrade,'JP_APKSIG_SHA256',upgrade.file_hash(jar)), \
                 patch.object(upgrade,'build_package_set_manifest',return_value=dict(package,**changes)), \
                 patch.object(upgrade,'verify_apk_signature',side_effect=ValueError('signature failed')):
                with self.assertRaises(ValueError):
                    upgrade.prepare_client(archive,jar,stage,anchor=self.anchor,expected_version='1.0.6',previous_code=10059)
            self.assertEqual(self.metadata.read_bytes(),original)


class ReplacementTests(unittest.TestCase):
    def test_installation_failure_rolls_back_every_old_file_and_preserves_workspace(self):
        import os
        from tempfile import TemporaryDirectory
        from tools import jp_client_upgrade as upgrade
        with TemporaryDirectory() as tmp:
            root=Path(tmp);stage=root/'stage';seed=root/'seed';stage.mkdir();seed.mkdir()
            for folder,contents in ((seed,b'old'),(stage,b'new')):
                for name in upgrade.SEED_FILES:
                    if name=='apks':(folder/name).mkdir();(folder/name/'base.apk').write_bytes(contents)
                    else:(folder/name).write_bytes(contents)
            (seed/'workspace').mkdir();(seed/'workspace/state.json').write_bytes(b'keep')
            replace=os.replace
            def fail(source,target):
                if Path(source)==stage/'unity-version.txt':raise OSError('simulated disk failure')
                return replace(source,target)
            with patch.object(upgrade.os,'replace',side_effect=fail):
                with self.assertRaises(OSError):upgrade.install_seed(stage,seed)
            self.assertEqual((seed/'workspace/state.json').read_bytes(),b'keep')
            for name in upgrade.SEED_FILES:
                self.assertEqual((seed/name/ 'base.apk' if name=='apks' else seed/name).read_bytes(),b'old')

    def test_failed_new_official_probe_never_installs_seed(self):
        from tempfile import TemporaryDirectory
        from tools import jp_client_upgrade as upgrade
        with TemporaryDirectory() as tmp:
            seed=Path(tmp)/'seed';seed.mkdir();(seed/'metadata.v39.dat').write_bytes(b'old')
            client=Mock();client.discover.side_effect=ValueError('maintenance')
            with patch.object(upgrade,'prepare_client'), \
                 patch.object(upgrade,'client_from_metadata',return_value=client), \
                 patch.object(upgrade,'install_seed') as install:
                with self.assertRaisesRegex(ValueError,'maintenance'):
                    upgrade.upgrade_from_archive(seed,Path(tmp)/'archive',Path(tmp)/'jar','1.0.6',10059)
            install.assert_not_called()
            self.assertEqual((seed/'metadata.v39.dat').read_bytes(),b'old')


class DownloadTests(unittest.TestCase):
    def test_redirect_to_untrusted_host_stops_before_second_request(self):
        from tempfile import TemporaryDirectory
        from tools import jp_client_upgrade as upgrade
        def redirect(command,**kwargs):
            Path(command[command.index('--dump-header')+1]).write_text('HTTP/2 302\nLocation: https://evil.invalid/client\n')
            Path(command[command.index('--output')+1]).write_bytes(b'')
            return Mock(returncode=0,stdout=b'302')
        with TemporaryDirectory() as tmp,patch.object(upgrade.subprocess,'run',side_effect=redirect) as run:
            target=Path(tmp)/'client.xapk'
            with self.assertRaisesRegex(ValueError,'untrusted'):
                upgrade.download_file(upgrade.LATEST_XAPK,target)
            self.assertEqual(run.call_count,1);self.assertFalse(target.exists())

    def test_download_error_does_not_echo_signed_url_or_stderr(self):
        from tempfile import TemporaryDirectory
        from tools import jp_client_upgrade as upgrade
        with TemporaryDirectory() as tmp, patch.object(upgrade.subprocess,'run',return_value=Mock(returncode=22,stderr=b'secret')):
            with self.assertRaisesRegex(ValueError,'transport failed') as caught:
                upgrade.download_file(upgrade.LATEST_XAPK,Path(tmp)/'client.xapk')
            self.assertNotIn('secret',str(caught.exception))

class UpgradeGateTests(unittest.TestCase):
    def setUp(self):
        from tests.test_r2_production_gate import LightJpGateTests
        self.fixture=LightJpGateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_legacy_light_probe_promotes_upgrade_signal_to_full_restore(self):
        from tools import r2_production_gate as gate
        from tests.test_r2_production_gate import IMAGE
        f=self.fixture
        gate.light_prepare(f.private,f.root,'jp',['output/r2-jp'],f.stage,image=IMAGE)
        client=Mock();client.discover.side_effect=jp_public.JpClientUpdateRequired('1.0.6')
        with patch('tools.jp_remote_sync.client_from_metadata',return_value=client):
            result=gate.light_probe(f.root,'jp',f.stage/'proof.json',image=IMAGE)
        self.assertEqual(result,{'status':'needs_full','skip':False,'reason':'client_update_required'})

    def test_upgraded_checkpoint_restores_binding_and_skips_without_apk_download(self):
        from tools import r2_production_gate as gate, jp_client_profile as profile, jp_phone_inputs as pins
        from tests.test_r2_production_gate import IMAGE, PrivateBucket
        f=self.fixture
        anchor=metadata_fixture();metadata=metadata_fixture(relocated=True)
        folder=f.root/'binding';folder.mkdir()
        (folder/profile.ANCHOR_NAME).write_bytes(anchor)
        (folder/'metadata.v39.dat').write_bytes(metadata)
        with patch.object(pins,'JP_METADATA_SHA256',gate.digest(anchor)),patch.object(profile,'NETWORK_INDICES',(1,2)):
            binding=profile.derive_binding(folder/profile.ANCHOR_NAME,folder/'metadata.v39.dat','1.0.6')
            client={'clientVersion':'1.0.6','versionCode':10060,'packageSetSha256':'f'*64,'certificateSha256':pins.JP_CERTIFICATE_SHA256}
            seed=dict(client,schemaVersion=2,status='verified_seed',signatureVerified=True,
                      metadataSha256=gate.digest(metadata),binding=binding)
            prefix='output/r2-jp/'
            f.files[f.paths['metadata']]=metadata
            f.files[prefix+profile.PROFILE_NAME]=gate.canonical(seed)
            f.files[prefix+profile.ANCHOR_NAME]=anchor
            f.observation['clientVersion']='1.0.6'
            f.state['versionIdentity']=list(gate.version_identity(f.observation))
            receipt=f.state[gate.RECEIPT_FIELD]
            receipt.update(jpClient=client,sourceSha256=gate.source_identity(f.observation),
                packageSha256=gate.package_identity('jp',dict(client,versionName='1.0.6')),
                stateSha256=gate.digest(gate.canonical(gate.state_without_receipt(f.state))))
            receipt['inputSha256']=gate.digest(gate.canonical({'metadata':gate.digest(metadata),
                'unityVersion':gate.digest(f.unity),'packageSetSha256':'f'*64,
                'clientBinding':gate.digest(f.files[prefix+profile.PROFILE_NAME]),'trustedMetadata':gate.digest(anchor)}))
            receipt['trustedInputInventory']=sorted([{'path':name,'sha256':gate.digest(data),'size':len(data)}
                for name,data in f.files.items() if not name.endswith('/workspace/state.json')],key=lambda r:r['path'])
            f.files['output/r2-jp/workspace/state.json']=gate.canonical(f.state)
            private=PrivateBucket(f.root,'jp',['output/r2-jp'],f.files)
            prepared=gate.light_prepare(private,f.root,'jp',['output/r2-jp'],f.stage,image=IMAGE)
            self.assertEqual(prepared['status'],'ready')
            with patch.object(jp_public.JpPublicClient,'discover',return_value=f.observation):
                observed=gate.light_probe(f.root,'jp',f.stage/'proof.json',image=IMAGE)
            result=gate.light_check(private,f.public,f.root,'jp',f.stage/'proof.json',observed,f.before,image=IMAGE)
            self.assertTrue(result['skip'])
            self.assertEqual(len(private.downloads),4)
            self.assertNotIn('state/objects/'+gate.digest(f.package_bytes),private.downloads)
            (f.stage/profile.PROFILE_NAME).write_text('{}')
            with self.assertRaisesRegex(ValueError,'unverified JP client'):
                gate.light_probe(f.root,'jp',f.stage/'proof.json',image=IMAGE)
