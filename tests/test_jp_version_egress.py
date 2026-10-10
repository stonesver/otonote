import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from tools import jp_version_egress as egress


def sample_node(**updates):
    node = {'name': 'private descriptive name', 'type': 'trojan',
            'server': 'proxy.example', 'port': 443, 'password': 'test-secret',
            'network': 'grpc', 'grpc-opts': {'grpc-service-name': 'service'},
            'sni': 'tls.example', 'skip-cert-verify': False, 'udp': True}
    node.update(updates)
    return node


class NodeConfigurationTests(unittest.TestCase):
    def test_grpc_node_is_normalized_and_restricted_to_version_domain(self):
        node = egress.node_config(json.dumps(sample_node()))
        self.assertEqual(node['name'], egress.NODE_NAME)
        self.assertFalse(node['udp'])
        self.assertFalse(node['skip-cert-verify'])
        self.assertEqual(node['grpc-opts'], {'grpc-service-name': 'service'})
        config = egress.configuration(node)
        self.assertEqual(config['rules'], ['DOMAIN,api.bang-dream-on.jp,jp-version-node', 'MATCH,REJECT'])
        self.assertEqual(config['bind-address'], '127.0.0.1')
        self.assertEqual(config['mixed-port'], 17897)
        self.assertFalse(config['allow-lan'])
        self.assertFalse(config['tun']['enable'])
        self.assertEqual(config['log-level'], 'silent')
        self.assertNotIn('external-controller', config)
        self.assertNotIn('proxy-providers', config)
        self.assertNotIn('proxy-groups', config)

    def test_tcp_and_ip_server_are_supported_without_grpc_options(self):
        node = sample_node(network='tcp', server='2001:db8::1')
        del node['grpc-opts']
        self.assertEqual(egress.node_config(json.dumps(node))['network'], 'tcp')

    def test_global_apk_mode_only_routes_the_official_apk_host(self):
        config = egress.configuration(egress.node_config(json.dumps(sample_node())), global_apk=True)
        self.assertEqual(config['rules'], ['DOMAIN,pkg.biligame.com,jp-version-node',
                                           'DOMAIN,l12-pkg-download.biligames.com,jp-version-node',
                                           'MATCH,REJECT'])
        self.assertNotIn('api.bang-dream-on.jp', str(config['rules']))

    def test_rejects_full_configuration_injection_and_unsafe_tls_without_echo(self):
        bad = [[], {}, {'proxies': [sample_node()]},
               sample_node(**{'skip-cert-verify': True}), sample_node(**{'skip-cert-verify': 0}),
               sample_node(type='ss'), sample_node(port=True), sample_node(port=0),
               sample_node(port=65536), sample_node(port='443'), sample_node(network='ws'),
               sample_node(server='https://proxy.example'), sample_node(server='bad\n.example'),
               sample_node(password='test-secret\u0000bad'), sample_node(sni='bad/path'),
               sample_node(**{'external-controller': ':9090'}),
               sample_node(**{'proxy-providers': {'bad': {}}}),
               sample_node(**{'dialer-proxy': 'DIRECT'}), sample_node(**{'tun': {'enable': True}}),
               sample_node(**{'grpc-opts': {'grpc-service-name': 'service', 'extra': True}}),
               sample_node(**{'grpc-opts': {'grpc-service-name': 'bad\nline'}}),
               sample_node(**{'grpc-opts': None}), sample_node(network='tcp'),
               sample_node(udp='true'), sample_node(name='x\n'), sample_node(password='')]
        for node in bad:
            with self.subTest(fields=list(node) if isinstance(node, dict) else type(node).__name__):
                with self.assertRaisesRegex(egress.EgressError, '^invalid JP proxy node configuration$'):
                    egress.node_config(json.dumps(node))
        for raw in ('{"type":"trojan","type":"trojan"}', 'secret-not-json', 'x' * 16385,
                    '[' * 2000 + ']' * 2000):
            with self.assertRaisesRegex(egress.EgressError, '^invalid JP proxy node configuration$'):
                egress.node_config(raw)


class EgressLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {egress.NODE_ENV: json.dumps(sample_node())}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def _run_mocked(self, *, exit_code=0, ready_error=None, producer_error=None):
        daemon = Mock(pid=12345, returncode=None)
        daemon.poll.return_value = None
        producer = Mock(pid=12346, returncode=exit_code)
        producer.poll.return_value = exit_code
        files = []

        def popen(command, **options):
            self.assertNotIn('test-secret', str(command))
            self.assertNotIn(egress.NODE_ENV, options['env'])
            self.assertTrue(options['start_new_session'])
            if len(command) > 1 and command[1] == '-d':
                config = Path(command[command.index('-f') + 1])
                files.append(config.parent)
                self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(config.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE((config.parent / 'client.log').stat().st_mode), 0o600)
                self.assertIs(options['stdout'], options['stderr'])
                self.assertNotIn('R2_SECRET_ACCESS_KEY', options['env'])
                self.assertEqual(json.loads(config.read_text())['proxies'][0]['password'], 'test-secret')
                return daemon
            self.assertEqual(options['env'][egress.PROXY_ENV], egress.PROXY_URL)
            if producer_error:
                raise producer_error
            return producer

        with patch.dict(os.environ, {'R2_SECRET_ACCESS_KEY': 'test-separate-secret'}), \
                patch.object(egress, '_require_free_port'), \
                patch.object(egress, '_wait_ready', side_effect=ready_error), \
                patch.object(egress.subprocess, 'Popen', side_effect=popen), \
                patch.object(egress.os, 'killpg') as kill:
            try:
                result = egress.run(['producer'], sys.executable)
            finally:
                self.assertTrue(files)
                self.assertTrue(all(not path.exists() for path in files))
                self.assertIn(unittest.mock.call(daemon.pid, signal.SIGTERM), kill.call_args_list)
        return result

    def test_success_and_child_failure_clean_processes_and_files(self):
        for code in (0, 17, -signal.SIGTERM):
            with self.subTest(code=code):
                self.assertEqual(self._run_mocked(exit_code=code), code if code >= 0 else 128 - code)

    def test_readiness_failure_cleans_without_running_producer(self):
        with self.assertRaisesRegex(egress.EgressError, 'readiness'):
            self._run_mocked(ready_error=egress.EgressError('readiness timed out'))

    def test_launch_failure_does_not_echo_os_error_or_credentials(self):
        with self.assertRaisesRegex(egress.EgressError, '^JP egress process operation failed$'):
            self._run_mocked(producer_error=OSError('test-secret'))

    def test_signal_interrupt_cleans_and_returns_signal_exit_code(self):
        original = signal.getsignal(signal.SIGTERM)
        def send_signal(_process):
            os.kill(os.getpid(), signal.SIGTERM)
        self.assertEqual(self._run_mocked(ready_error=send_signal), 143)
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)

    def test_conflicting_proxy_and_node_are_rejected_before_process_start(self):
        with patch.dict(os.environ, {egress.PROXY_ENV: 'http://local:7897'}), \
                patch.object(egress.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(egress.EgressError, 'choose either'):
                egress.run(['producer'], sys.executable)
            popen.assert_not_called()

    def test_global_apk_mode_sets_only_restricted_proxy_environment(self):
        daemon = Mock(pid=12345, returncode=0)
        daemon.poll.return_value = None
        producer = Mock(pid=12346, returncode=0)
        producer.poll.return_value = 0
        def popen(command, **options):
            if len(command) > 1 and command[1] == '-d':
                config = json.loads(Path(command[command.index('-f') + 1]).read_text())
                self.assertEqual(config['rules'], ['DOMAIN,pkg.biligame.com,jp-version-node',
                                                   'DOMAIN,l12-pkg-download.biligames.com,jp-version-node',
                                                   'MATCH,REJECT'])
                return daemon
            environment = options['env']
            self.assertEqual(environment['HTTPS_PROXY'], egress.PROXY_URL)
            self.assertEqual(environment['https_proxy'], egress.PROXY_URL)
            self.assertEqual(environment['NO_PROXY'], ','.join(egress.GLOBAL_DIRECT_HOSTS))
            self.assertEqual(environment['no_proxy'], ','.join(egress.GLOBAL_DIRECT_HOSTS))
            self.assertNotIn(egress.NODE_ENV, environment)
            self.assertNotIn(egress.GLOBAL_NODE_ENV, environment)
            self.assertNotIn(egress.PROXY_ENV, environment)
            return producer
        with patch.dict(os.environ, {egress.PROXY_ENV: '',
                                  egress.GLOBAL_NODE_ENV: json.dumps(sample_node())}), \
                patch.object(egress, '_require_free_port'), \
                patch.object(egress, '_wait_ready'), \
                patch.object(egress.subprocess, 'Popen', side_effect=popen), \
                patch.object(egress.os, 'killpg'):
            self.assertEqual(egress.run(['producer'], sys.executable, global_apk=True), 0)

    def test_global_apk_mode_requires_separate_node(self):
        with patch.dict(os.environ, {egress.GLOBAL_NODE_ENV: ''}), \
                patch.object(egress.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(egress.EgressError, 'Global APK egress node is required'):
                egress.run(['producer'], sys.executable, global_apk=True)
            popen.assert_not_called()

    def test_absent_node_preserves_existing_proxy_and_removes_empty_node_env(self):
        with patch.dict(os.environ, {egress.NODE_ENV: '', egress.PROXY_ENV: 'http://local:7897'}), \
                patch.object(egress.subprocess, 'Popen') as popen, patch.object(egress.os, 'killpg'):
            popen.return_value.poll.return_value = 0
            popen.return_value.returncode = 0
            self.assertEqual(egress.run(['producer']), 0)
            self.assertEqual(popen.call_args.kwargs['env'][egress.PROXY_ENV], 'http://local:7897')
            self.assertNotIn(egress.NODE_ENV, popen.call_args.kwargs['env'])
            self.assertEqual(popen.call_count, 1)

    def test_dead_proxy_stops_active_producer(self):
        daemon = Mock(pid=12345)
        daemon.poll.return_value = 1
        producer = Mock(pid=12346)
        producer.poll.return_value = None
        with patch.object(egress, '_require_free_port'), patch.object(egress, '_wait_ready'), \
                patch.object(egress.subprocess, 'Popen', side_effect=[daemon, producer]), \
                patch.object(egress.os, 'killpg') as kill:
            with self.assertRaisesRegex(egress.EgressError, 'proxy exited'):
                egress.run(['producer'], sys.executable)
            self.assertIn(unittest.mock.call(producer.pid, signal.SIGTERM), kill.call_args_list)

    def test_stuck_process_is_killed_after_grace_period(self):
        process = Mock(pid=12345)
        process.wait.side_effect = [subprocess.TimeoutExpired('safe', 3), 0]
        with patch.object(egress.os, 'killpg') as kill:
            egress._stop(process)
        self.assertEqual(kill.call_args_list, [unittest.mock.call(12345, signal.SIGTERM),
                                               unittest.mock.call(12345, signal.SIGKILL)])

    def test_readiness_rejects_exited_process(self):
        process = Mock()
        process.poll.return_value = 1
        with self.assertRaisesRegex(egress.EgressError, 'before readiness'):
            egress._wait_ready(process)

    def test_readiness_times_out_without_upstream_network(self):
        process = Mock()
        process.poll.return_value = None
        with patch.object(egress.time, 'monotonic', side_effect=[0, 0, 20]), \
                patch.object(egress.time, 'sleep'), \
                patch.object(egress.socket, 'create_connection', side_effect=OSError()):
            with self.assertRaisesRegex(egress.EgressError, 'readiness timed out'):
                egress._wait_ready(process)

    def test_existing_listener_rejected_instead_of_reused(self):
        with patch.object(egress.socket, 'socket') as socket:
            socket.return_value.__enter__.return_value.bind.side_effect = OSError('private data')
            with self.assertRaisesRegex(egress.EgressError, '^JP proxy listener is unavailable$'):
                egress._require_free_port()

    def test_binary_must_be_preprovisioned_executable_absolute_path(self):
        for binary in (None, 'mihomo', '/nonexistent/mihomo'):
            with self.subTest(binary=binary), patch.object(egress.subprocess, 'Popen') as popen:
                with self.assertRaisesRegex(egress.EgressError, 'verified executable'):
                    egress.run(['producer'], binary)
                popen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
