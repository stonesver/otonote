import io
import tempfile
import unittest
from pathlib import Path
from backend.update_archive.bootstrap import restore_materials
from backend.update_archive.models import canonical, digest, ArchiveError
from backend.update_archive.store import S3Bucket


class CheckpointTests(unittest.TestCase):
    def test_reads_only_selected_material_from_one_digest_bound_manifest(self):
        content = b'trusted synthetic material'
        sha = digest(content)
        manifest = canonical({'schemaVersion':2,'region':'jp','files':[
            {'path':'private/metadata.dat','sha256':sha,'size':len(content)},
            {'path':'private/huge.apk','sha256':'b'*64,'size':2*1024**3}]})
        manifest_sha = digest(manifest)
        objects = {'state/jp/current.json':canonical({'schemaVersion':1,'region':'jp','sha256':manifest_sha,
                    'manifest':f'state/manifests/jp/{manifest_sha}.json'}),
                   f'state/manifests/jp/{manifest_sha}.json':manifest, 'state/objects/'+sha:content}
        class ReadOnly:
            calls=[]
            def get_object(self, **kw):
                self.calls.append(kw['Key']); return {'Body':io.BytesIO(objects[kw['Key']])}
        client = ReadOnly()
        with tempfile.TemporaryDirectory() as root:
            result = restore_materials(client, 'producer', 'jp', {'seed/metadata.dat':'private/metadata.dat'}, root)
            self.assertEqual((Path(root)/'seed/metadata.dat').read_bytes(), content)
            self.assertEqual(len(client.calls),3)
            self.assertEqual(result['manifestSha256'],manifest_sha)

    def test_archive_adapter_distinguishes_forbidden_from_missing(self):
        class Failed(Exception):
            def __init__(self,code):self.response={'Error':{'Code':code}}
        class Client:
            code='403'
            def head_object(self,**kw):raise Failed(self.code)
        client=Client(); bucket=S3Bucket(client,'archive')
        key='global/objects/'+'a'*64+'-'+'b'*32
        with self.assertRaisesRegex(ArchiveError,'archive_head_failed'):bucket.exists(key)
        client.code='404';self.assertFalse(bucket.exists(key))
        with self.assertRaises(ArchiveError):bucket.name('state/global/current.json')

    def test_s3_control_uses_conditional_updates_and_fixed_prefix(self):
        class Client:
            def put_object(self,**kw):self.kw=kw
        client=Client();bucket=S3Bucket(client,'archive')
        bucket.replace('control/ledger.json',b'{}',None)
        self.assertEqual(client.kw['IfNoneMatch'],'*')
        bucket.replace('control/ledger.json',b'{}','"known"')
        self.assertEqual(client.kw['IfMatch'],'"known"')
        self.assertEqual(client.kw['Key'],'update-archive/v1/control/ledger.json')
