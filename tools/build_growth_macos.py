"""Build an arm64 macOS portable directory with an isolated PyInstaller environment."""
from __future__ import annotations
import argparse
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

from tools.build_growth_distribution import DOCUMENTS, TEMPLATE, source_tree, write_zip


def build(output):
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise SystemExit('Build this distribution on an Apple Silicon Mac.')
    output.mkdir(parents=True, exist_ok=False)
    output = output.resolve()
    source = output / 'source'
    source_tree(source)
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
        '--console', '--name', 'OurNotesGrowth', '--target-arch', 'arm64',
        '--distpath', str(output / 'dist'), '--workpath', str(output / 'work'),
        '--specpath', str(output), '--paths', str(source),
        '--copy-metadata', 'cryptography', '--copy-metadata', 'grpcio',
        str(source / 'launcher.py'),
    ], cwd=source, check=True)
    portable = output / 'ournotes-growth-macos-arm64'
    shutil.copytree(output / 'dist/OurNotesGrowth', portable, symlinks=True)
    for name in DOCUMENTS:
        if name not in ('launcher.py', 'Start.cmd'):
            shutil.copyfile(TEMPLATE / name, portable / name)
    (portable / 'Start.command').chmod(0o755)
    licenses = portable / 'third-party-licenses'
    licenses.mkdir()
    dependencies = {}
    for name in ('cryptography', 'grpcio', 'cffi', 'pycparser', 'typing_extensions', 'pyinstaller'):
        dist = importlib.metadata.distribution(name)
        dependencies[name] = dist.version
        for file in dist.files or []:
            if 'license' in str(file).lower() or 'copying' in str(file).lower():
                path = Path(dist.locate_file(file))
                if path.is_file():
                    target = licenses / name / str(file)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
    python_license = Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt'
    if not python_license.is_file():
        raise SystemExit('Python license missing; do not distribute this build.')
    shutil.copyfile(python_license, licenses / 'Python-LICENSE.txt')
    (portable / 'BUILD.json').write_text(json.dumps({
        'pythonVersion': platform.python_version(), 'platform': 'macos-arm64',
        'buildMacOS': platform.mac_ver()[0], 'dependencies': dependencies,
        'sdkConfigIncluded': False, 'appleNotarized': False,
    }, indent=2) + '\n')
    result = write_zip(portable, output / (portable.name + '.zip'))
    (output / 'release.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output)
