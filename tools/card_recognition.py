"""Build and validate optional, release-bound browser card recognition indexes.

OpenCV is only needed by the offline build command, never by publication or HTTP.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

ALGORITHM = 'ORB-1000-member450-support300-edge10-fast7-v2'
MAX_BYTES = 128 * 1024 * 1024


def read_index(directory, region, release):
    directory = Path(directory)
    manifest = json.loads((directory/'card-recognition.json').read_text())
    if (manifest.get('schemaVersion') != 1 or manifest.get('algorithm') != ALGORITHM
            or manifest.get('region') != region or manifest.get('sourceReleaseId') != release):
        raise ValueError('recognition index content release mismatch')
    if manifest.get('featuresPath') != 'recognition/features.bin.gz':
        raise ValueError('unsafe recognition feature path')
    source = directory/'features.bin.gz'
    size = source.stat().st_size
    if not 0 < size <= MAX_BYTES or size != manifest.get('compressedBytes'):
        raise ValueError('recognition compressed size mismatch')
    packed = source.read_bytes()
    if hashlib.sha256(packed).hexdigest() != manifest.get('featuresSha256'):
        raise ValueError('recognition feature digest mismatch')
    with gzip.open(source, 'rb') as stream:
        decoded = stream.read(MAX_BYTES+1)
    if len(decoded) > MAX_BYTES or len(decoded) != manifest.get('decodedBytes'):
        raise ValueError('recognition decoded size mismatch')
    cards = manifest.get('cards')
    if not isinstance(cards, list) or not cards or len(cards) > 10000:
        raise ValueError('invalid recognition cards')
    seen = set()
    for card in cards:
        kind = card.get('kind')
        if kind not in {'member','support'} or not card.get('id','').startswith(kind+'-card-'):
            raise ValueError('invalid recognition card identity')
        key = (card['id'],card.get('assetId'))
        if key in seen: raise ValueError('duplicate recognition asset')
        seen.add(key)
        count = card.get('count')
        if type(count) is not int or not 4 <= count <= 1000: raise ValueError('invalid recognition descriptor count')
        for field,width in [('descriptorOffset',32),('pointOffset',8)]:
            offset = card.get(field)
            if type(offset) is not int or offset < 0 or offset % 4 or offset+count*width > len(decoded):
                raise ValueError('invalid recognition feature range')
    return manifest, packed


def build_index(catalog_path, media_root, output):
    import cv2
    import numpy as np
    from PIL import Image
    catalog = json.loads(Path(catalog_path).read_text())
    context = catalog.get('projectionContext',{})
    region = context.get('region') or catalog.get('release',{}).get('region')
    release = context.get('contentReleaseId') or catalog.get('release',{}).get('id')
    if region not in {'global','jp'} or not release: raise ValueError('catalog release identity is missing')
    output = Path(output).resolve()
    if 'output' not in output.parts: raise ValueError('derived data must be stored in an ignored output directory')
    output.mkdir(parents=True,exist_ok=False)
    media_root = Path(media_root).resolve()
    assets = {a['id']:a for a in catalog['assets']}
    cv2.setNumThreads(1)
    detector = cv2.ORB_create(nfeatures=1000,edgeThreshold=10,fastThreshold=7)
    blob = bytearray(); cards = []; missing = []
    for kind in ('member','support'):
        for card in catalog[kind+'Cards']:
            for asset_id in card['variantAssetIds']:
                asset = assets[asset_id]; url = asset['previewUrl']
                relative = url.split('/public/')[-1] if '/public/' in url else url.lstrip('/')
                path = (media_root/relative).resolve()
                if media_root not in path.parents: raise ValueError('unsafe card asset path')
                if not path.is_file():
                    missing.append({'id':card['id'],'assetId':asset_id});continue
                image = Image.open(path).convert('RGB');size = 450 if kind=='member' else 300
                image.thumbnail((size,size))
                points,descriptors = detector.detectAndCompute(cv2.cvtColor(np.array(image),cv2.COLOR_RGB2GRAY),None)
                if descriptors is None or len(points)<4:
                    missing.append({'id':card['id'],'assetId':asset_id});continue
                descriptor_offset = len(blob);blob.extend(descriptors.tobytes())
                point_offset = len(blob);blob.extend(np.asarray([p.pt for p in points],dtype='<f4').tobytes())
                cards.append({'id':card['id'],'name':card['displayName'],'kind':kind,'assetId':asset_id,
                    'thumbnail':'/'+relative,'count':len(points),'descriptorOffset':descriptor_offset,'pointOffset':point_offset})
    packed = gzip.compress(bytes(blob),compresslevel=6,mtime=0)
    manifest = {'schemaVersion':1,'algorithm':ALGORITHM,'region':region,'sourceReleaseId':release,
        'featuresPath':'recognition/features.bin.gz','featuresSha256':hashlib.sha256(packed).hexdigest(),
        'compressedBytes':len(packed),'decodedBytes':len(blob),'cards':cards,'missing':missing}
    (output/'features.bin.gz').write_bytes(packed)
    (output/'card-recognition.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n')
    read_index(output,region,release)
    return {'cards':len({c['id'] for c in cards}),'assets':len(cards),'missingAssets':len(missing),'compressedBytes':len(packed)}


def prepare_candidate_index(candidate, directory):
    """Cache a sealed candidate's index without modifying the candidate itself."""
    candidate, directory = Path(candidate), Path(directory)
    raw = (candidate/'candidate.json').read_bytes()
    source = json.loads(raw)
    regions = source.get('regions', [])
    if source.get('status') != 'candidate_generated' or len(regions) != 1:
        raise ValueError('recognition requires one sealed candidate')
    region = regions[0]
    release, edition = region['contentReleaseId'], region['region']
    if edition not in {'global', 'jp'} or region['path'] != edition+'/'+release:
        raise ValueError('invalid recognition candidate region')
    root = (candidate/region['path']).resolve()
    if candidate.resolve() not in root.parents:
        raise ValueError('unsafe recognition candidate path')
    identity = hashlib.sha256(raw+ALGORITHM.encode()).hexdigest()[:24]
    final = directory/identity
    if final.exists():
        read_index(final, edition, release)
        return final
    directory.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.recognition-', dir=directory))
    try:
        generated = temporary/'index'
        build_index(root/'generated/releases'/release/'zh-CN/catalog.json', root/'public', generated)
        generated.rename(final)
    finally:
        shutil.rmtree(temporary)
    return final


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=Path,required=True)
    parser.add_argument('--media-root',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(build_index(args.catalog,args.media_root,args.out)))


if __name__=='__main__': main()
