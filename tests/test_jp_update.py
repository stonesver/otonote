"""Safety gates for unattended JP production, using only synthetic sources."""

import json
import io
from contextlib import redirect_stdout, redirect_stderr
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tools.jp_remote_sync import snapshot
from tools.jp_update import FINGERPRINT_FILES, fingerprint, run, main
from tools.resource_pipeline.adapters.global_public import ProtocolError


def observation(version='1.0.4', resource='1.0.0.300/' + 'a' * 32):
    return {
        'schemaVersion': 1, 'environmentId': 'jp-production', 'region': 'jp',
        'observedAt': '2026-10-05T00:00:00Z', 'clientVersion': version,
        'masterVersion': '1.0.0.300/' + 'b' * 32,
        'resourceVersion': resource, 'catalogHash': 'c' * 32,
        'apiRoot': 'https://api.bang-dream-on.jp',
        'cdnRoot': 'https://static.bang-dream-on.jp',
        'catalogUrl': 'https://static.bang-dream-on.jp/catalog',
        'masterManifestUrl': 'https://static.bang-dream-on.jp/master/manifest',
    }


class JpUpdateSafetyTests(unittest.TestCase):
    def test_cli_emits_one_json_receipt_despite_extraction_progress(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        def produce(**_kwargs):
            print('Extracting master')
            print('Reused music')
            return {'status': 'built', 'region': 'jp'}
        with patch('tools.jp_update.run', side_effect=produce), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            status = main(['--metadata', 'metadata', '--apk-root', 'apks',
                           '--unity-version-file', 'unity', '--workspace', 'work',
                           '--content-store', 'content'])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {'status': 'built', 'region': 'jp'})
        self.assertIn('Extracting master', stderr.getvalue())
        self.assertIn('Reused music', stderr.getvalue())

    def test_fingerprint_ignores_documentation_and_commit_identity(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('tools/jp_update.py', 'analysis/crypto/decrypt_master.py',
                         'packages/scoring/scoring-engine.mjs', 'config/site-product.json',
                         *FINGERPRINT_FILES):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            docs = root / 'docs/operation.md'
            docs.parent.mkdir()
            docs.write_text('first version')
            with patch('tools.jp_update.ROOT', root), patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}):
                first = fingerprint()
                docs.write_text('second version')
                os.environ['GITHUB_SHA'] = 'b' * 40
                self.assertEqual(fingerprint(), first)

    def test_fingerprint_tracks_production_helpers_node_code_and_config(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            names = ('tools/jp_update.py', 'tools/current_content_inputs.py',
                     'tools/current_content_media.py', 'tools/current_bgm_inputs.py',
                     'tools/release_candidates.py', 'tools/content_derivatives.mjs',
                     'analysis/crypto/decrypt_master.py',
                     'packages/scoring/scoring-engine.mjs',
                     'packages/scoring/data/formal-scoring-rules.json',
                     'config/site-product.json', 'config/resource-platform.toml',
                     *FINGERPRINT_FILES)
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            with patch('tools.jp_update.ROOT', root):
                baseline = fingerprint()
                for name in names:
                    path = root / name
                    path.write_text('changed')
                    self.assertNotEqual(fingerprint(), baseline, name)
                    path.write_text('original')
                added = root / 'tools/resource_pipeline/new_decoder.py'
                added.parent.mkdir(parents=True)
                added.write_text('new producer')
                self.assertNotEqual(fingerprint(), baseline)

    def test_fingerprint_tracks_updater_image_build_inputs(self):
        self.assertIn('catalog/evidence/arena-client.json', FINGERPRINT_FILES)
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('tools/jp_update.py', 'analysis/crypto/decrypt_master.py',
                         'packages/scoring/scoring-engine.mjs', 'config/site-product.json',
                         *FINGERPRINT_FILES):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            with patch('tools.jp_update.ROOT', root):
                baseline = fingerprint()
                for name in FINGERPRINT_FILES:
                    path = root / name
                    path.write_text('changed')
                    self.assertNotEqual(fingerprint(), baseline, name)
                    path.write_text('original')

    def test_fingerprint_fails_if_source_root_is_missing(self):
        with TemporaryDirectory() as directory, patch('tools.jp_update.ROOT', Path(directory)):
            with self.assertRaisesRegex(ValueError, 'source directory missing'):
                fingerprint()

    def test_unknown_client_is_rejected_before_any_download_or_snapshot(self):
        client = Mock(client_version='1.0.4')
        client.discover.return_value = observation(version='1.0.5')
        with TemporaryDirectory() as directory:
            output = Path(directory) / 'snapshot'
            with self.assertRaisesRegex(ProtocolError, 'verified client'):
                snapshot(client, output)
            self.assertFalse(output.exists())
            self.assertFalse((output.parent / '.snapshot.working').exists())
            client.get.assert_not_called()

    def test_source_change_before_publication_preserves_current_pointer(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / 'output' / 'jp-work'
            content_store = root / 'content'
            current = content_store / 'jp' / 'current.json'
            current.parent.mkdir(parents=True)
            current.write_text('{"release":"previous"}')
            first = observation()
            changed = observation(resource='1.0.0.300/' + 'd' * 32)
            client = Mock(client_version='1.0.4')
            client.discover.side_effect = [first, changed]

            def create_snapshot(_client, path):
                path.mkdir(parents=True)
                (path / 'report.json').write_text(json.dumps({
                    'status': 'verified_snapshot', 'observation': first,
                }))

            def create_inputs(_source, _master, _metadata, _apk, path, **_options):
                path.mkdir()
                (path / 'release-inputs.json').write_text(json.dumps({
                    'environments': [{'masterRoot': 'master',
                                      'contentReleaseId': 'jp-test'}],
                }))

            def create_candidate(command, **_options):
                self.assertEqual(Path(command[command.index('--conversion-cache') + 1]),
                                 workspace.resolve() / 'cache/image-conversions')
                # The child also emits JSON; only the updater's result may reach
                # stdout, where Actions records the machine-readable receipt.
                self.assertEqual(_options.get('stdout'), subprocess.DEVNULL)
                from tools.global_remote_sync import file_hash
                path = Path(command[command.index('--output') + 1])
                plan = Path(command[command.index('--plan') + 1])
                path.mkdir()
                (path / 'candidate.json').write_text(json.dumps({
                    'inputPlanSha256': file_hash(plan),
                }))
                return SimpleNamespace(returncode=0)

            with (patch('tools.jp_update.ROOT', root),
                  patch('tools.jp_update.fingerprint', return_value='code-fingerprint'),
                  patch('tools.jp_update.client_from_metadata', return_value=client),
                  patch('tools.jp_update.snapshot', side_effect=create_snapshot),
                  patch('tools.jp_update.build_inputs', side_effect=create_inputs),
                  patch('tools.release_preflight.inspect_plan', return_value={'status': 'passed'}),
                  patch('tools.jp_update.subprocess.run', side_effect=create_candidate),
                  patch('tools.scoring_content.bind_scoring_rules', return_value={}),
                  patch('tools.content_publication.publish_content') as publish):
                with self.assertRaisesRegex(ValueError, 'JP source changed'):
                    run(metadata=root / 'metadata', apk_root=root / 'apks',
                        unity_version_file=root / 'unity.ver', workspace=workspace,
                        content_store=content_store)
                publish.assert_not_called()
            self.assertEqual(current.read_text(), '{"release":"previous"}')
            self.assertFalse((workspace / 'state.json').exists())


if __name__ == '__main__':
    unittest.main()
