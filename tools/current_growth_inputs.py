"""Current training art and APK-serialized band-rank labels."""
from pathlib import Path
import re
import zipfile
from tools.global_remote_sync import file_hash, write_json


def growth(resources, output):
    from analysis.crypto.decrypt_global_formal_scores import UnityPy, decrypt_header
    from UnityPy.classes import PPtr
    output.mkdir(parents=True, exist_ok=True)
    images, ranks = [], []
    def save(image, name, source, sha):
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name): raise ValueError('unsafe growth image name')
        target = output / (name + '.webp')
        if target.exists(): raise ValueError('duplicate growth image')
        image.save(target, 'WEBP', quality=92)
        images.append({'name':name,'file':target.name,'source':source,'sourceSha256':sha,
            'sha256':file_hash(target),'width':image.width,'height':image.height})
        return target.name
    for name, loc in resources.locations.items():
        if not name.startswith('image_assets_image_tgw_') or not name.endswith('.bundle'): continue
        env = resources.environment(name)
        for obj in env.objects:
            if obj.type.name == 'Texture2D':
                data = obj.read(); save(data.image,data.m_Name,name,resources.used[name]['sha256'])
    env = UnityPy.Environment()
    with zipfile.ZipFile(resources.apk) as archive:
        names = archive.namelist()
        rank_parts = [name for name in names if '_fixparts_band_uibandrankicon_' in name and name.endswith('.bundle')]
        if not rank_parts:
            # Newer clients embed the same serialized component in the profile prefab.
            rank_parts = [name for name in names if '_fixparts_playerprofile_uiplayerprofilebandrankentity_' in name and name.endswith('.bundle')]
        if len(rank_parts) != 1: raise ValueError('missing or duplicate rank mapping')
        for name in names:
            if name in rank_parts or '_texture_bandrank_' in name:
                raw = archive.read(name)
                env.load_file(raw if raw.startswith(b'UnityFS\0') else decrypt_header(raw,Path(name).name,resources.key,resources.seed),name=Path(name).name)
    apk_sha = file_hash(resources.apk)
    for obj in env.objects:
        if obj.type.name != 'MonoBehaviour': continue
        tree = obj.read_typetree()
        for entry in tree.get('_type', []):
            sprite = PPtr(**entry['sprite'],assetsfile=obj.assets_file).read()
            label = sprite.m_Name.removeprefix('ImgScorerank_')
            if not re.fullmatch(r'[A-Za-z]+[0-9]+',label): raise ValueError('unsupported serialized rank label')
            filename = save(sprite.image,'band-rank-'+label.lower(),'base.apk:UIBandRankIcon._type',apk_sha)
            ranks.append({'rank':entry['bandRank'],'label':label,'image':filename})
    ranks.sort(key=lambda row:row['rank'])
    if not ranks or len({r['rank'] for r in ranks}) != len(ranks): raise ValueError('missing or duplicate rank mapping')
    write_json(output/'manifest.json',{'catalogSha256':resources.report['catalogSha256'],'bandRanks':ranks,'images':images})
    return len(images)
