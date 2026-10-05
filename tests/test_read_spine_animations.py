"""The JP Spine helper must find the updater image's installed runtime."""

import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools/read_spine_animations.mjs'


@unittest.skipUnless(shutil.which('node'), 'Node.js is required')
class SpineRuntimeTests(unittest.TestCase):
    def prepare(self, root, *, local=False, runtime=False):
        script = root / 'tools/read_spine_animations.mjs'
        script.parent.mkdir()
        shutil.copy2(SCRIPT, script)
        (root / 'input.skel').write_bytes(b'valid-test-skeleton')
        (root / 'input.atlas').write_text('test atlas')
        for present, module_root, duration in (
                (local, root / 'site/node_modules', 2.0),
                (runtime, root / 'runtime/node_modules', 3.0)):
            if not present:
                continue
            package = module_root / '@esotericsoftware/spine-core'
            (package / 'dist').mkdir(parents=True)
            (package / 'package.json').write_text('{"type":"module"}')
            (package / 'dist/index.js').write_text(
                'export class TextureAtlas { constructor(text) { if (!text) throw Error("empty atlas") } }\n'
                'export class AtlasAttachmentLoader {}\n'
                'export class SkeletonJson {}\n'
                'export class SkeletonBinary { readSkeletonData(bytes) {\n'
                '  if (!bytes.length) throw Error("empty skeleton");\n'
                f'  return {{ animations: [{{ name: "idle", duration: {duration} }}] }};\n'
                '} }\n')
        return script

    def execute(self, root, script):
        env = os.environ.copy()
        env['OURNOTES_NODE_MODULES_DIR'] = str(root / 'runtime/node_modules')
        return subprocess.run(
            ['node', str(script), str(root / 'input.skel'), str(root / 'input.atlas'), 'binary'],
            capture_output=True, text=True, env=env, timeout=10)

    def test_uses_image_runtime_when_site_modules_are_absent(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.execute(root, self.prepare(root, runtime=True))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'idle': 3})

    def test_prefers_local_site_modules(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.execute(root, self.prepare(root, local=True, runtime=True))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'idle': 2})

    def test_missing_spine_runtime_fails_closed(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.execute(root, self.prepare(root))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('spine-core', result.stderr)
            self.assertFalse(result.stdout)


if __name__ == '__main__':
    unittest.main()
