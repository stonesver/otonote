import socket
import threading
import unittest
from backend.update_archive.egress import destination, Relay


class EgressTests(unittest.TestCase):
    def test_only_configured_archive_tls_destination_is_allowed(self):
        host='a'*32+'.r2.cloudflarestorage.com'
        self.assertEqual(destination(('CONNECT '+host+':443 HTTP/1.1\r\n\r\n').encode(),host),(host,443))
        for request in ('GET https://'+host+'/ HTTP/1.1','CONNECT elsewhere.example:443 HTTP/1.1',
                        'CONNECT '+host+':80 HTTP/1.1','CONNECT '+host+'.evil.example:443 HTTP/1.1'):
            with self.assertRaises(ValueError):destination((request+'\r\n\r\n').encode(),host)

    def test_forbidden_destination_is_rejected_without_outbound_connection(self):
        from unittest.mock import patch
        with Relay('a'*32+'.r2.cloudflarestorage.com',0) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                with socket.create_connection(server.server_address,timeout=3) as client:
                    with patch('backend.update_archive.egress.socket.create_connection') as connect:
                        client.sendall(b'CONNECT elsewhere.example:443 HTTP/1.1\r\n\r\n')
                        self.assertTrue(client.recv(1024).startswith(b'HTTP/1.1 403'))
                        connect.assert_not_called()
            finally:server.shutdown();thread.join()
