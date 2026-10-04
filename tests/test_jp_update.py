"""Safety gates for unattended JP production, using only synthetic sources."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tools.jp_remote_sync import snapshot
from tools.jp_update import run
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
