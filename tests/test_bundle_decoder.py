import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools.bundle_decoder import bundle_material, relocated_profile, resolve_bundle_decoder


def metadata_fixture(*, swapped=False, owner='<PrivateImplementationDetails>'):
    data=bytearray(320)
    for index,local in enumerate((1,0) if swapped else (0,1)):
        struct.pack_into('<II',data,index*8,7,local)
    struct.pack_into('<I',data,32+8,7)
    struct.pack_into('<I',data,32+26,100)
    struct.pack_into('<III',data,128,100,0,0)
    struct.pack_into('<III',data,140,101,0,16)
    data[256:272]=bytes(range(16));data[272:280]=b'SEEDDEMO'
    sections=[(0,0,0)]*31
    sections[22]=(0,16,2);sections[7]=(128,24,2);sections[8]=(256,24,0)
    return SimpleNamespace(data=bytes(data),sections=sections,type_offset=32,type_count=1,type_name=lambda _:owner)


def entry(metadata,version='fixture.2',*,swapped=False):
    return {'clientVersion':version,'metadataSha256':hashlib.sha256(metadata.data).hexdigest(),
            'keyFieldUsage':0x80000003 if swapped else 0x80000001,
            'nonceSeedFieldUsage':0x80000001 if swapped else 0x80000003}


class BundleDecoderProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'profile.json'

    def write(self,profiles):
        self.path.write_text(json.dumps({'schemaVersion':1,'profiles':profiles}))

    def test_shifted_fieldrefs_require_exact_new_metadata_binding(self):
        prior=metadata_fixture();current=metadata_fixture(swapped=True)
        self.write([entry(prior)])
        with self.assertRaisesRegex(ValueError,'unsupported bundle decoder binding'):
            bundle_material(current,'fixture.2',profile_path=self.path)
        self.write([entry(prior,'fixture.1'),entry(current,swapped=True)])
        self.assertEqual(bundle_material(current,'fixture.2',profile_path=self.path),(bytes(range(16)),b'SEEDDEMO'))
        self.assertEqual(bundle_material(prior,'fixture.1',profile_path=self.path),(bytes(range(16)),b'SEEDDEMO'))

    def test_version_cannot_reuse_another_versions_mapping(self):
        metadata=metadata_fixture();self.write([entry(metadata)])
        with self.assertRaisesRegex(ValueError,'unsupported bundle decoder binding'):
            bundle_material(metadata,'unknown',profile_path=self.path)

    def test_mapping_requires_private_implementation_field_owner(self):
        metadata=metadata_fixture(owner='OtherType');self.write([entry(metadata)])
        with self.assertRaisesRegex(ValueError,'private implementation type'):
            bundle_material(metadata,'fixture.2',profile_path=self.path)

    def test_duplicate_binding_and_malformed_usage_fail_closed(self):
        metadata=metadata_fixture();profile=entry(metadata)
        self.write([profile,profile])
        with self.assertRaisesRegex(ValueError,'invalid bundle decoder profile'):
            bundle_material(metadata,'fixture.2',profile_path=self.path)
        for usage in (True,-1,0x80000002,0xA0000001,'0x80000001'):
            self.write([{**profile,'keyFieldUsage':usage}])
            with self.assertRaisesRegex(ValueError,'invalid bundle decoder profile'):
                bundle_material(metadata,'fixture.2',profile_path=self.path)

    def test_external_environment_path_and_absent_profile(self):
        metadata=metadata_fixture();self.write([entry(metadata)])
        with patch.dict(os.environ,{'OURNOTES_BUNDLE_DECODER_PROFILE':str(self.path)}):
            self.assertEqual(bundle_material(metadata,'fixture.2')[1],b'SEEDDEMO')
        with patch.dict(os.environ,{},clear=True):
            with self.assertRaisesRegex(ValueError,'bundle decoder profile is required'):
                bundle_material(metadata,'fixture.2')

    def test_material_and_receipt_use_one_profile_snapshot(self):
        metadata=metadata_fixture();self.write([entry(metadata)])
        raw=self.path.read_bytes()
        with patch.object(Path,'read_bytes',side_effect=[raw]) as read:
            key,seed,binding=resolve_bundle_decoder(metadata,'fixture.2',profile_path=self.path)
        self.assertEqual((key,seed),(bytes(range(16)),b'SEEDDEMO'))
        self.assertRegex(binding,r'^[a-f0-9]{64}$')
        read.assert_called_once()

    def test_out_of_bounds_usage_rejected_without_material_in_error(self):
        metadata=metadata_fixture();self.write([{**entry(metadata),'keyFieldUsage':0x8000FFFF}])
        with self.assertRaisesRegex(ValueError,'outside metadata'):
            bundle_material(metadata,'fixture.2',profile_path=self.path)

    def test_relocation_requires_unique_prior_material_in_new_metadata(self):
        current=metadata_fixture(swapped=True)
        derived=relocated_profile(current,'fixture.2',bytes(range(16)),b'SEEDDEMO')
        self.assertEqual(derived,entry(current,swapped=True))
        self.assertEqual(resolve_bundle_decoder(current,'fixture.2',profile=derived)[:2],
                         (bytes(range(16)),b'SEEDDEMO'))
        with self.assertRaisesRegex(ValueError,'no unique new FieldRefs'):
            relocated_profile(current,'fixture.2',b'X'*16,b'SEEDDEMO')
        duplicate=bytearray(current.data)
        struct.pack_into('<II',duplicate,16,7,1)
        current.data=bytes(duplicate)
        current.sections[22]=(0,24,3)
        with self.assertRaisesRegex(ValueError,'no unique new FieldRefs'):
            relocated_profile(current,'fixture.2',bytes(range(16)),b'SEEDDEMO')

    def test_explicit_relocation_remains_bound_to_exact_metadata_and_version(self):
        current=metadata_fixture(swapped=True)
        derived=relocated_profile(current,'fixture.2',bytes(range(16)),b'SEEDDEMO')
        for version, metadata in [('fixture.3',current),('fixture.2',metadata_fixture())]:
            with self.subTest(version=version), self.assertRaisesRegex(ValueError,'unsupported bundle decoder binding'):
                resolve_bundle_decoder(metadata,version,profile=derived)

class CachedClientBindingTests(unittest.TestCase):
    def test_preexisting_cached_decoder_cannot_bypass_external_binding(self):
        from tools import current_client
        import sys
        with tempfile.TemporaryDirectory() as temp:
            cache=Path(temp);metadata=metadata_fixture(swapped=True)
            metadata_path=cache/'metadata.bin';metadata_path.write_bytes(metadata.data)
            apk_sha='b'*64
            profile={'apkSha256':apk_sha,'certificateSha256':current_client.CERTIFICATE,
                     'signatureVerified':True,'metadata':str(metadata_path),
                     'metadataSha256':hashlib.sha256(metadata.data).hexdigest(),
                     'clientVersion':'fixture.2'}
            directory=cache/apk_sha;directory.mkdir();(directory/'decoder.json').write_text(json.dumps(profile))
            binding=cache/'bindings.json'
            binding.write_text(json.dumps({'schemaVersion':1,'profiles':[entry(metadata_fixture())]}))
            verifier=cache/'verifier.jar'
            def file_hash(path):
                if Path(path)==verifier:return current_client.APKSIG_SHA256
                if Path(path)==metadata_path:return profile['metadataSha256']
                return apk_sha
            fake=SimpleNamespace(MetadataV39=lambda _:metadata)
            with patch.dict(sys.modules,{'analysis.crypto.decrypt_global_formal_scores':fake}),patch.dict(os.environ,{'OURNOTES_BUNDLE_DECODER_PROFILE':str(binding)}),patch.object(current_client,'file_hash',side_effect=file_hash),patch.object(current_client,'acquire'):
                with self.assertRaisesRegex(ValueError,'unsupported bundle decoder binding'):
                    current_client.intake({'url':'https://example.invalid/client.apk','byteSize':4,'etag':'test'},cache,verifier)
                binding.write_text(json.dumps({'schemaVersion':1,'profiles':[entry(metadata,swapped=True)]}))
                result=current_client.intake({'url':'https://example.invalid/client.apk','byteSize':4,'etag':'test'},cache,verifier)
                self.assertEqual({k:result[k] for k in profile},profile)
                self.assertRegex(result['bundleDecoderBindingSha256'],r'^[a-f0-9]{64}$')
                (directory/'decoder.json').write_text(json.dumps({**profile,'bundleDecoderBindingSha256':'0'*64}))
                with self.assertRaisesRegex(ValueError,'cached bundle decoder binding mismatch'):
                    current_client.intake({'url':'https://example.invalid/client.apk','byteSize':4,'etag':'test'},cache,verifier)
