"""Build allowlisted source and optional Windows portable ZIPs, without account data."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'packaging/growth-tool'
MODULES = ('growth_export.py', 'growth_login.py', 'growth_login_local.py', 'game_service_status.py', 'global_game_config.py',
           'growth_levels.py', 'growth_package_check.py', 'build_growth_distribution.py',
           'build_growth_macos.py')
DOCUMENTS = ('README.md', 'LICENSE', 'requirements.txt', 'sdk.example.xml', 'sdk.bhk.xml', 'launcher.py', 'Start.cmd', 'Start.command')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_tree(destination):
    from tools.growth_login import Profile
    Profile.from_resources(TEMPLATE / 'sdk.bhk.xml')
    destination.mkdir(parents=True)
    (destination / 'tools').mkdir()
    (destination / 'tools/__init__.py').write_text('')
    for name in MODULES:
        shutil.copyfile(ROOT / 'tools' / name, destination / 'tools' / name)
    for name in DOCUMENTS:
        shutil.copyfile(TEMPLATE / name, destination / name)
    (destination / 'Start.command').chmod(0o755)
    # Retain the complete build inputs in the source archive so it can be rebuilt.
    build_inputs = destination / 'packaging/growth-tool'
    build_inputs.mkdir(parents=True)
    for name in (*DOCUMENTS, 'windows-lock.json'):
        shutil.copyfile(TEMPLATE / name, build_inputs / name)
    (destination / '.gitignore').write_text('sdk.xml\n*.snapshot.json\nournotes-growth*.json\n.venv/\n__pycache__/\noutput/\n')


def safe_extract(archive, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            name = entry.filename
            if '\\' in name or name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('unsafe_archive_path')
            target = (destination / name).resolve()
            if destination not in target.parents:
                raise ValueError('unsafe_archive_path')
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('archive_symlink_refused')
        source.extractall(destination)


def write_zip(root, output):
    def content(path):
        return os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
    files = {str(p.relative_to(root)): hashlib.sha256(content(p)).hexdigest()
             for p in sorted(root.rglob('*')) if p.is_file() or p.is_symlink()}
    (root / 'FILES.sha256.json').write_text(json.dumps(files, indent=2) + '\n')
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(root.rglob('*')):
            if path.is_file() or path.is_symlink():
                entry = zipfile.ZipInfo(str(Path(root.name) / path.relative_to(root)), (2026, 9, 29, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = path.lstat().st_mode << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, content(path))
    return {'file': output.name, 'bytes': output.stat().st_size, 'sha256': digest(output),
            'expandedBytes': sum(len(content(p)) for p in root.rglob('*') if p.is_file() or p.is_symlink())}


def build(output, downloads=None):
    output.mkdir(parents=True, exist_ok=False)
    source = output / 'ournotes-growth-source'
    source_tree(source)
    result = {'source': write_zip(source, output / (source.name + '.zip')),
              'sdkConfigIncluded': True, 'windowsExecutionVerified': False}
    if downloads is not None:
        lock = json.loads((TEMPLATE / 'windows-lock.json').read_text())
        for item in lock['files']:
            if digest(downloads / item['filename']) != item['sha256']:
                raise ValueError('download_digest_mismatch: ' + item['filename'])
        portable = output / 'ournotes-growth-windows-x64'
        source_tree(portable)
        runtime = portable / 'runtime'
        runtime.mkdir()
        for item in lock['files']:
            destination = runtime if item['kind'] == 'python' else runtime / 'Lib/site-packages'
            safe_extract(downloads / item['filename'], destination)
        # Explicit import paths avoid the user's Python environment and executable .pth files.
        (runtime / 'python313._pth').write_text('python313.zip\n.\n..\nLib/site-packages\n')
        (portable / 'THIRD_PARTY.md').write_text(
            '# Third-party components\n\nPython runtime: see runtime/LICENSE.txt.\n'
            'Python packages: see runtime/Lib/site-packages/*.dist-info/licenses or LICENSE files.\n'
            'Runtime and wheel source URLs and SHA-256 digests are in packaging/growth-tool/windows-lock.json.\n')
        result['windows'] = write_zip(portable, output / (portable.name + '.zip'))
    (output / 'release.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='new output directory')
    parser.add_argument('--downloads', type=Path, help='verified Windows runtime and wheels directory')
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.downloads), indent=2))


if __name__ == '__main__':
    main()
