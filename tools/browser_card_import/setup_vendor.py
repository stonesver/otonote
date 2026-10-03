"""Materialize pinned browser dependencies in ignored output, never at runtime."""
import argparse
import hashlib
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

ARTIFACTS = [
    ('opencv.js', 'https://docs.opencv.org/4.13.0/opencv.js',
     '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0'),
    ('lang/eng.traineddata.gz', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
     '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if 'output' not in out.parts:
        parser.error('Use an ignored output directory')
    runtime, vendor = out/'runtime', out/'vendor'
    runtime.mkdir(parents=True, exist_ok=True)
    vendor.mkdir(exist_ok=True)
    for name in ['package.json', 'package-lock.json']:
        shutil.copyfile(Path(__file__).parent/'vendor'/name, runtime/name)
    subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', str(runtime)], check=True)
    modules = runtime/'node_modules'
    for source, target in [('tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'),
                           ('tesseract.js/dist/worker.min.js', 'worker.min.js'),
                           ('tesseract.js/LICENSE.md', 'tesseract-LICENSE.md'),
                           ('tesseract.js-core/LICENSE', 'tesseract-core-LICENSE')]:
        shutil.copyfile(modules/source, vendor/target)
    (vendor/'core').mkdir(exist_ok=True)
    for path in (modules/'tesseract.js-core').glob('*.wasm*'):
        shutil.copyfile(path, vendor/'core'/path.name)
    for name, url, expected in ARTIFACTS:
        target = vendor/name
        target.parent.mkdir(exist_ok=True)
        data = target.read_bytes() if target.exists() else urllib.request.urlopen(url, timeout=60).read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'Checksum mismatch: {name}; review upstream before changing pins')
        target.write_bytes(data)
    # Both OpenCV 4.x and tessdata use Apache-2.0. Retain the license with this bundle.
    shutil.copyfile(modules/'tesseract.js-core/LICENSE', vendor/'OpenCV-and-tessdata-LICENSE')
    inventory = [{'path':str(p.relative_to(out)), 'bytes':p.stat().st_size,
                  'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
                 for p in sorted(vendor.rglob('*')) if p.is_file()]
    (out/'vendor-manifest.json').write_text(json.dumps(inventory, indent=2)+'\n')
    print(f'{len(inventory)} vendor files, {sum(p["bytes"] for p in inventory)/1048576:.2f} MiB on disk')


if __name__ == '__main__':
    main()
