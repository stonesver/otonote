"""The JP scene exporter must surface bounded Node failure diagnostics."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_exporter():
    # The exporter imports optional Unity analysis dependencies at module load.
    # Stub those dependencies to exercise the actual subprocess boundary.
    catalog = types.ModuleType('tools.prepare_immersive_catalog')
    for name in ('CAPTURE', 'MASTER', 'PUBLIC'):
        setattr(catalog, name, ROOT)
    catalog.RELEASE = 'test-release'
    catalog.write = lambda *_: None
    catalog.animation_times = lambda *_: ()
    crypto = types.ModuleType('analysis.crypto.decrypt_global_formal_scores')
    for name in ('CatalogAdapter', 'MetadataV39', 'UnityPy', 'KEY_FIELD_USAGE',
                 'NONCE_SEED_FIELD_USAGE', 'METADATA_SHA256', 'CATALOG_SHA256',
                 'field_bytes', 'decrypt_header', 'text_payload', 'sha256'):
        setattr(crypto, name, object())
    mesh = types.ModuleType('UnityPy.helpers.MeshHelper')
    mesh.MeshHandler = object
    spec = importlib.util.spec_from_file_location('test_scene_exporter', ROOT / 'tools/export_immersive_scenes.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        catalog.__name__: catalog,
        crypto.__name__: crypto,
        mesh.__name__: mesh,
    }):
        spec.loader.exec_module(module)
    return module


class SpineDiagnosticsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.exporter = load_exporter()

    def test_missing_module_surfaces_code_without_path_or_token(self):
        failure = subprocess.CalledProcessError(
            1, ['node', '/private/sensitive/input.skel'],
            stderr="Error [ERR_MODULE_NOT_FOUND]: Cannot find /private/sensitive/input.skel token=SECRET_VALUE",
        )
        with patch.object(self.exporter.subprocess, 'run', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'ERR_MODULE_NOT_FOUND') as caught:
                self.exporter._read_binary_animations(Path('/private/sensitive/input.skel'), Path('/private/sensitive/input.atlas'))
        self.assertNotIn('/private/sensitive', str(caught.exception))
        self.assertNotIn('SECRET_VALUE', str(caught.exception))
        self.assertLess(len(str(caught.exception)), 160)

    def test_generic_failure_stays_bounded_and_stops(self):
        failure = subprocess.CalledProcessError(1, ['node'], stderr='Unexpected skeleton data: /private/input ' + 'X' * 10000)
        with patch.object(self.exporter.subprocess, 'run', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'parser or runtime error') as caught:
                self.exporter._read_binary_animations(Path('/private/input'), Path('/private/atlas'))
        self.assertNotIn('/private/input', str(caught.exception))
        self.assertLess(len(str(caught.exception)), 160)

    def test_success_parses_node_json(self):
        expected = {'idle': 2.5}
        with patch.object(self.exporter.subprocess, 'run', return_value=subprocess.CompletedProcess(['node'], 0, json.dumps(expected), '')):
            self.assertEqual(self.exporter._read_binary_animations(Path('s.skel'), Path('a.atlas')), expected)


if __name__ == '__main__':
    unittest.main()
