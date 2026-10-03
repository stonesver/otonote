"""Build private, static browser-probe data from an explicit local catalog.

Game images, derived descriptors and screenshots belong in ignored output only.
No network, production configuration or user inventory access.
"""
import argparse
import gzip
import hashlib
import json
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--media-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--samples', type=Path, nargs=3)
    args = parser.parse_args()
    out = args.out.resolve()
    if 'output' not in out.parts:
        parser.error('Private derived data must be written under an output directory')
    (out/'assets').mkdir(parents=True, exist_ok=True)
    catalog = json.loads(args.catalog.read_text())
    assets = {a['id']: a for a in catalog['assets']}
    detector = cv2.ORB_create(nfeatures=1000, edgeThreshold=10, fastThreshold=7)
    cv2.setNumThreads(1)
    blob = bytearray()
    cards, missing = [], []
    for kind in ['member', 'support']:
        for card in catalog[kind+'Cards']:
            for asset_id in card['variantAssetIds']:
                asset = assets[asset_id]
                url = asset['previewUrl']
                relative = url.split('/public/')[-1] if '/public/' in url else url.lstrip('/')
                path = args.media_root/relative
                if not path.is_file():
                    missing.append({'id':card['id'], 'assetId':asset_id})
                    continue
                image = Image.open(path).convert('RGB')
                size = 450 if kind == 'member' else 300
                image.thumbnail((size,size))
                points, descriptors = detector.detectAndCompute(cv2.cvtColor(np.array(image),cv2.COLOR_RGB2GRAY), None)
                if descriptors is None:
                    missing.append({'id':card['id'], 'assetId':asset_id})
                    continue
                descriptor_offset = len(blob)
                blob.extend(descriptors.tobytes())
                point_offset = len(blob)
                blob.extend(np.asarray([p.pt for p in points], dtype='<f4').tobytes())
                thumb = image.copy()
                thumb.thumbnail((240,240))
                thumb.save(out/'assets'/f'{asset_id}.webp', quality=78)
                cards.append({'id':card['id'], 'name':card['displayName'], 'kind':kind,
                              'assetId':asset_id, 'rarity':card['rarity'],
                              'thumbnail':f'assets/{asset_id}.webp', 'count':len(points),
                              'descriptorOffset':descriptor_offset, 'pointOffset':point_offset})
    packed = gzip.compress(bytes(blob), compresslevel=6, mtime=0)
    (out/'features.bin.gz').write_bytes(packed)
    manifest = {'schemaVersion':1, 'algorithm':'ORB-1000-member450-support300-edge10-fast7-v2',
                'sourceReleaseId':catalog.get('release',{}).get('id'),
                'region':catalog.get('release',{}).get('region'),
                'featuresSha256':hashlib.sha256(packed).hexdigest(),
                'compressedBytes':len(packed), 'decodedBytes':len(blob),
                'cards':cards, 'missing':missing, 'samples':[]}
    if args.samples:
        (out/'samples').mkdir(exist_ok=True)
        for i,(path,mode) in enumerate(zip(args.samples,['member-training','member-level','support'])):
            target = f'samples/{i+1}.jpg'
            shutil.copyfile(path,out/target)
            manifest['samples'].append({'url':target, 'mode':mode, 'name':f'示例 {i+1}'})
    (out/'catalog.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
    for path in (Path(__file__).parent/'web').iterdir():
        if path.is_file():shutil.copyfile(path,out/path.name)
    print(json.dumps({'cards':len(cards), 'missing':len(missing), 'indexMiB':round(len(packed)/1048576,2)},ensure_ascii=False))


if __name__ == '__main__':
    main()
