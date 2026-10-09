"""Protocol, provenance and failure checks for the real Global public adapter."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tools.global_remote_sync import acquire, plan_assets, remote_path, validate_manifest, _update
from tools.resource_pipeline.adapters.global_public import (
    APK_HOSTS, APK_USER_AGENT, KV_CONFIG_URL, ClientUpdateRequired, GlobalPublicClient,
    ProtocolError, allowed_url, decode_grpc, discover_package,
    protobuf_fields, string_field, version_identity, website_config_package,
)
from tools.resource_pipeline.catalog_adapter import CatalogAdapter
from tools.resource_pipeline.transport import DownloadReceipt, HttpResponse
from tools.build_remote_global_inputs import bundle_stem, contained, same_bundle, release_id


def field(number, value):
    value = value.encode() if isinstance(value, str) else value
    size = len(value)
    length = bytearray()
    while size > 127:
        length.append((size & 127) | 128)
        size >>= 7
    length.append(size)
    return bytes([number * 8 + 2]) + length + value


CDN = "https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_" + "a" * 32
API = "https://l12-prod-hk-all-gs-sirius.gamerfusiontech.com"


class FakeClient(GlobalPublicClient):
    def rpc(self, root, method):
        if method.endswith("GetServerList"):
            row = field(1, "TW/HK/MO") + field(2, CDN) + field(3, API) + field(8, "2")
            return {}, field(1, row)
        return {}, field(1, "b" * 32) + field(2, "1.0.0.104")

    def get(self, url, limit, *, method="GET"):
        return HttpResponse(200, {}, b"c" * 32)


class GlobalRemoteTest(unittest.TestCase):
    def test_real_protocol_shape_selects_hk_without_credentials(self):
        result = FakeClient().discover()
        self.assertEqual(result["authentication"], "not_required")
        self.assertEqual(result["catalogUrl"], CDN + "/asset/Android/catalog_1.0.0.104.bin")
        self.assertEqual(result["masterManifestUrl"], CDN + "/master/" + "b" * 32 + "/MasterManifest.json")

    def test_empty_server_list_is_not_unchanged(self):
        with patch.object(FakeClient, "rpc", return_value=({}, b"")):
            with self.assertRaises(ProtocolError):
                FakeClient().discover()

    def test_grpc_requires_success_trailer_and_exact_frame(self):
        header = "HTTP/2 200\r\ncontent-type: application/grpc\r\n\r\ngrpc-status: 0\r\n"
        self.assertEqual(decode_grpc(header, bytes(5))[1], b"")
        for h, body in [(header.replace("grpc-status: 0", "grpc-status: 16"), bytes(5)),
                        (header.replace("grpc-status: 0", ""), bytes(5)),
                        (header, b"\x01\0\0\0\0"), (header, b"\0\0\0\0\x02x"),
                        (header, bytes(10)), (header.replace("200", "429"), bytes(5))]:
            with self.subTest(h=h, body=body), self.assertRaises(ProtocolError):
                decode_grpc(h, body)

    def test_auth_headers_are_never_persisted(self):
        headers, _ = decode_grpc("HTTP/2 200\ncontent-type: application/grpc\nx-auth-token: SECRET\ngrpc-status: 0\n", bytes(5))
        self.assertNotIn("x-auth-token", headers)

    def test_forced_client_upgrade_uses_only_matching_official_apk_hint(self):
        url = "https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02_22_46_55.apk"
        def response(version="1.0.3", address=url):
            return ("HTTP/2 200\ncontent-type: application/grpc\ngrpc-status: 2\n"
                    "grpc-message: client update required\n"
                    f"x-client-recommended-version: {version}\n"
                    f"x-client-download-url: {address}\n")
        with self.assertRaises(ClientUpdateRequired) as caught:
            decode_grpc(response(), b"")
        self.assertEqual((caught.exception.version, caught.exception.url), ("1.0.3", url))
        with self.assertRaises(ClientUpdateRequired) as missing:
            decode_grpc(response(address=""), b"")
        self.assertIsNone(missing.exception.url)
        for version, address in (("1.0.4", url),
                                 ("1.0.3", url.replace("pkg.biligame.com", "example.net")),
                                 ("1.0.3", url + "?token=bad")):
            with self.subTest(version=version, address=address), self.assertRaises(ProtocolError):
                decode_grpc(response(version, address), b"")

    def test_official_apk_metadata_uses_android_client_and_requires_complete_headers(self):
        notice = ClientUpdateRequired(
            "1.0.3", "https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02.apk")
        headers = {"content-type": "application/vnd.android.package-archive",
                   "content-length": "457342191", "etag": '"multipart-55"',
                   "last-modified": "Mon, 05 Oct 2026 04:07:49 GMT"}
        with patch("tools.resource_pipeline.adapters.global_public.HttpTransport") as transport:
            transport.return_value.request.return_value = HttpResponse(200, headers, b"")
            package = GlobalPublicClient().official_apk(notice)
        request = transport.return_value.request.call_args.args[0]
        self.assertEqual((request.method, request.url, request.headers["User-Agent"]),
                         ("HEAD", notice.url, APK_USER_AGENT))
        self.assertEqual(transport.call_args.kwargs["allowed_hosts"], APK_HOSTS)
        self.assertEqual((package["clientVersion"], package["byteSize"]), ("1.0.3", 457342191))
        with patch("tools.resource_pipeline.adapters.global_public.HttpTransport") as transport:
            transport.return_value.request.return_value = HttpResponse(403, {}, b"")
            with self.assertRaises(ProtocolError):
                GlobalPublicClient().official_apk(notice)

    def test_accepted_client_reuses_verified_package_without_web_script(self):
        package = {"url": "https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02.apk",
                   "byteSize": 123, "etag": '"etag"', "lastModified": "date"}
        client = Mock()
        self.assertEqual(discover_package(client, previous=package), package)
        client.rpc.assert_called_once()
        client.get.assert_not_called()

    def test_upgrade_without_usable_hint_uses_only_matching_official_site_package(self):
        url = "https://l12-pkg-download.biligames.com/sirius/apk/BanGDreamOurNotes_1.0.3.apk"
        class Website:
            def rpc(self, root, method):
                raise ClientUpdateRequired("1.0.3", None)

            def get(self, address, limit, *, method="GET"):
                if method == "HEAD":
                    return HttpResponse(200, {"content-length": "1234", "etag": '"etag"',
                                              "last-modified": "date"}, b"")
                if address.endswith(".js"):
                    return HttpResponse(200, {}, ('var apk="' + url + '"').encode())
                return HttpResponse(200, {}, b'<script src="//s1.biligames.com/fe-static/game-global-bangdreamon/gw/js/index.abc123.js"></script>')
        package = discover_package(Website())
        self.assertEqual((package["url"], package["clientVersion"]), (url, "1.0.3"))

    def test_upgrade_uses_current_official_website_config_when_hint_is_blocked(self):
        url = ('https://l14-pkg-download.biligames.com/sirius/apk/'
               'BanGDreamOurNotes_1.0.3_2026_10_02_22_46_55.apk')
        assert_equal = self.assertEqual
        class Website:
            def rpc(self, root, method):
                raise ClientUpdateRequired('1.0.3', 'https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_1.apk')

            def official_apk(self, notice):
                raise ProtocolError('official hint blocked')

            def get(self, address, limit, *, method='GET', headers=None):
                if address == KV_CONFIG_URL:
                    return HttpResponse(200, {}, json.dumps({'code': 0, 'data': {
                        'data': {'apklink.link': url}}}).encode())
                assert_equal(address, url)
                assert_equal((method, headers), ('HEAD', {'User-Agent': APK_USER_AGENT}))
                return HttpResponse(200, {'content-length': '457342191', 'etag': '"etag"',
                                          'last-modified': 'Fri, 09 Oct 2026 00:00:00 GMT'}, b'')
        package = discover_package(Website())
        self.assertEqual((package['url'], package['clientVersion'], package['byteSize']),
                         (url, '1.0.3', 457342191))
        self.assertEqual(package['source'], KV_CONFIG_URL)

    def test_website_config_rejects_wrong_version_and_untrusted_url(self):
        class Website:
            def __init__(self, link):
                self.link = link

            def get(self, address, limit, *, method='GET', headers=None):
                return HttpResponse(200, {}, json.dumps({'code': 0, 'data': {
                    'data': {'apklink.link': self.link}}}).encode())
        links = (
            'https://l14-pkg-download.biligames.com/sirius/apk/BanGDreamOurNotes_1.0.2_1.apk',
            'https://example.org/sirius/apk/BanGDreamOurNotes_1.0.3_1.apk',
            'https://l14-pkg-download.biligames.com/sirius/apk/BanGDreamOurNotes_1.0.3_1.apk?token=x',
        )
        for link in links:
            with self.subTest(link=link), self.assertRaises(ProtocolError):
                website_config_package(Website(link), '1.0.3')

    def test_protobuf_rejects_truncation_and_repeated_identity(self):
        for payload in (b"\x0a\x10a", b"\x80", b"\x00", b"\x08" + b"\xff" * 10):
            with self.subTest(payload=payload), self.assertRaises(ProtocolError):
                protobuf_fields(payload)
        with self.assertRaises(ProtocolError):
            string_field(protobuf_fields(field(1, "a") + field(1, "b")), 1)

    def test_paths_and_hosts_are_closed(self):
        self.assertEqual(remote_path("https://dummy.net/asset/Android/volume(1).bundle"), "/asset/Android/volume(1).bundle")
        for url in ("https://dummy.net/asset/Android/../x", "https://dummy.net/asset/Android/%2e%2e/x",
                    "https://dummy.net/asset/Android/x?token=1", "https://attacker.test/asset/Android/x"):
            with self.subTest(url=url), self.assertRaises(ProtocolError):
                remote_path(url)
        for url in ("http://example.org/a", "https://user@example.org/a", "https://example.org:444/a"):
            with self.assertRaises(ProtocolError):
                allowed_url(url, ("example.org",))

    def test_master_manifest_rejects_duplicate_escape_size_and_wrong_digest(self):
        valid = {"name": "MasterText.bin", "hash": "a" * 64, "size": 100}
        self.assertEqual(validate_manifest({"version": "v", "files": [valid]}, "v"), [valid])
        for files in ([valid, valid], [{**valid, "name": "../MasterText.bin"}],
                      [{**valid, "size": -1}], [{**valid, "hash": "a" * 32}]):
            with self.subTest(files=files), self.assertRaises(ProtocolError):
                validate_manifest({"version": "v", "files": files}, "v")

    def test_catalog_plan_distinguishes_local_and_remote_code(self):
        def catalog(rows):
            return CatalogAdapter().parse_bytes(json.dumps({"locations": rows}).encode())
        a = {"primaryKey": "image_a.bundle", "internalId": "https://dummy.net/asset/Android/image_a.bundle",
             "providerId": "Fwk.Crypt.AssetBundleCryptProvider", "resourceType": "Bundle", "expectedSize": 100}
        b = {**a, "primaryKey": "patch_b.bundle", "internalId": "https://dummy.net/asset/Android/patch_b.bundle"}
        local = {**a, "primaryKey": "local", "internalId": "{RuntimePath}/local"}
        plan = plan_assets(catalog([a, b, local]), catalog([a]))
        self.assertEqual((plan["remoteCount"], plan["changedCount"], plan["changedBytes"]), (2, 1, 100))
        self.assertTrue(plan["remoteCodeChanged"])

    def test_resume_requires_actual_hash_not_only_file_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.bin"
            path.write_bytes(b"bad")
            with self.assertRaises(ProtocolError):
                acquire(CDN + "/master/table.bin", path, 3, "0" * 64)

    def test_package_resume_rejects_changed_server_etag(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "package.apk"
            path.write_bytes(b"old")
            path.with_name(path.name + ".receipt.json").write_text(json.dumps({
                "url": CDN + "/package.apk", "sha256": hashlib.sha256(b"old").hexdigest(), "etag": "old"}))
            with self.assertRaises(ProtocolError):
                acquire(CDN + "/package.apk", path, 3, expected_etag="new")

    def test_official_apk_download_preserves_android_header_and_etag(self):
        url = "https://pkg.biligame.com/games/BanGDreamOurNotes_1.0.3_2026_10_02.apk"
        with tempfile.TemporaryDirectory() as tmp, patch("tools.global_remote_sync.HttpTransport") as transport:
            def download(request, output):
                output.write(b"apk")
                return DownloadReceipt(200, {"etag": '"expected"'}, 3)
            transport.return_value.download.side_effect = download
            path = Path(tmp) / "official.apk"
            result = acquire(url, path, 3, expected_etag='"expected"',
                             allowed_hosts=APK_HOSTS, request_headers={"User-Agent": APK_USER_AGENT})
            request = transport.return_value.download.call_args.args[0]
            self.assertEqual((request.url, request.headers["User-Agent"]), (url, APK_USER_AGENT))
            self.assertEqual(transport.call_args.kwargs["allowed_hosts"], APK_HOSTS)
            self.assertEqual((result["reused"], path.read_bytes()), (False, b"apk"))

    def test_unchanged_update_does_not_download_or_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = root / "plan.json"
            plan.write_text("{}")
            (root / "state.json").write_text(json.dumps({"observation": FakeClient().discover(), "inputPlan": str(plan), "site": None}))
            with patch("tools.global_remote_sync.snapshot", side_effect=AssertionError("unexpected download")):
                result = _update(FakeClient(), root, root / "absent", root / "absent-plan", False)
            self.assertEqual(result["status"], "unchanged")

    def test_cached_success_with_missing_decoder_binding_is_not_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=root/'plan.json';plan.write_text('{}')
            old={'observation':FakeClient().discover(),'inputPlan':str(plan),'snapshot':str(root/'old'),
                 'site':None,'decoderSha256':'a'*64,'pipelineVersion':2}
            (root/'state.json').write_text(json.dumps(old))
            decoder={'apkSha256':'a'*64,'bundleDecoderBindingSha256':'d'*64}
            def capture(client,path,*args):
                self.assertTrue(path.parent.name.endswith('-d'+'d'*12))
                raise ProtocolError('binding forces isolated candidate')
            with patch('tools.release_preflight.load_plan',return_value=[{'id':'global-production','masterRoot':'old'}]),patch('tools.global_remote_sync.snapshot',side_effect=capture):
                with self.assertRaisesRegex(ProtocolError,'isolated candidate'):
                    _update(FakeClient(),root,root,plan,False,complete_content=True,decoder=decoder)
            self.assertEqual(json.loads((root/'state.json').read_text()),old)

    def test_old_complete_pipeline_rebuilds_even_when_remote_and_decoder_are_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=root/'plan.json';plan.write_text('{}')
            old={'observation':FakeClient().discover(),'inputPlan':str(plan),'snapshot':str(root/'old'),
                 'site':None,'decoderSha256':'a'*64,'bundleDecoderBindingSha256':'d'*64,'pipelineVersion':2}
            (root/'state.json').write_text(json.dumps(old))
            decoder={'apkSha256':'a'*64,'bundleDecoderBindingSha256':'d'*64}
            def capture(client,path,*args):
                self.assertIn('-complete-v3-',path.parent.name)
                raise ProtocolError('new pipeline needs new inputs')
            with patch('tools.release_preflight.load_plan',return_value=[{'id':'global-production','masterRoot':'old'}]),patch('tools.global_remote_sync.snapshot',side_effect=capture):
                with self.assertRaisesRegex(ProtocolError,'new pipeline'):
                    _update(FakeClient(),root,root,plan,False,complete_content=True,decoder=decoder)
            self.assertEqual(json.loads((root/'state.json').read_text()),old)

    def test_initial_complete_inputs_without_binding_cannot_be_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);baseline=root/'baseline';baseline.mkdir()
            (baseline/'observation.json').write_text(json.dumps(FakeClient().discover()))
            (root/'manifest.json').write_text(json.dumps({'provenance':{'apkSha256':{'base.apk':'a'*64}}}))
            previous={'id':'global-production','manifest':'manifest.json','masterRoot':'master','supplementalInputs':True,'bgmAudioInputs':True}
            decoder={'apkSha256':'a'*64,'bundleDecoderBindingSha256':'d'*64}
            with patch('tools.build_remote_global_inputs.ROOT',root),patch('tools.release_preflight.load_plan',return_value=[previous]),patch('tools.global_remote_sync.snapshot',side_effect=ProtocolError('unbound baseline rejected')):
                with self.assertRaisesRegex(ProtocolError,'unbound baseline rejected'):
                    _update(FakeClient(),root,baseline,root/'plan',False,complete_content=True,decoder=decoder)
            self.assertFalse((root/'state.json').exists())

    def test_existing_inputs_without_binding_receipt_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);observed=FakeClient().discover()
            decoder={'apkSha256':'a'*64,'bundleDecoderBindingSha256':'d'*64}
            current=root/('1.0.0.104-bbbbbbbb-cccccccc-complete-v3-aaaaaaaa-d'+'d'*12)
            captured=current/'snapshot';captured.mkdir(parents=True);(current/'inputs').mkdir()
            (captured/'report.json').write_text(json.dumps({'observation':observed}))
            (captured/'status.json').write_text(json.dumps({'status':'verified_snapshot'}))
            with patch('tools.release_preflight.load_plan',return_value=[{'id':'global-production'}]):
                with self.assertRaisesRegex(ProtocolError,'cached inputs bundle decoder binding mismatch'):
                    _update(FakeClient(),root,root,root/'plan',False,complete_content=True,decoder=decoder)
            self.assertFalse((root/'state.json').exists())

    def test_unverified_decoder_binding_rejected_before_discovery(self):
        client=Mock()
        with self.assertRaisesRegex(ProtocolError,'missing verified bundle decoder binding'):
            _update(client,Path('/unused'),Path('/unused'),Path('/unused'),False,decoder={'apkSha256':'a'*64})
        client.discover.assert_not_called()

    def test_version_identity_ignores_observation_time(self):
        a = FakeClient().discover()
        self.assertEqual(version_identity(a), version_identity({**a, "observedAt": "later"}))
        self.assertNotEqual(version_identity(a), version_identity({**a, "masterVersion": "d" * 32}))

    def test_master_only_update_has_distinct_public_cache_identity(self):
        observation = FakeClient().discover()
        self.assertNotEqual(release_id(observation, "a" * 64),
                            release_id({**observation, "masterVersion": "d" * 32}, "a" * 64))

    def test_failed_acquisition_does_not_advance_saved_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = {"observation": {**FakeClient().discover(), "resourceVersion": "1.0.0.103"},
                     "snapshot": str(root / "old-snapshot"), "inputPlan": str(root / "old-plan")}
            state_path = root / "state.json"
            state_path.write_text(json.dumps(state))
            original = state_path.read_bytes()
            with patch("tools.release_preflight.load_plan", return_value=[{"id": "global-production", "masterRoot": "old-master"}]), \
                    patch("tools.global_remote_sync.snapshot", side_effect=ProtocolError("interrupted")):
                with self.assertRaisesRegex(ProtocolError, "interrupted"):
                    _update(FakeClient(), root, root, root, False)
            self.assertEqual(state_path.read_bytes(), original)

    def test_candidate_rebinding_checks_paths_and_bundle_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                contained(Path(tmp), "../outside")
        self.assertEqual(bundle_stem("image_name_" + "a" * 32 + ".bundle"), "image_name")
        def bundle(size):
            doc = {"locations": [{"primaryKey": "a.bundle", "internalId": "https://dummy.net/asset/Android/a.bundle",
                                  "providerId": "Fwk.Crypt.AssetBundleCryptProvider", "resourceType": "Bundle", "expectedSize": size}]}
            return CatalogAdapter().parse_bytes(json.dumps(doc).encode()).locations[0]
        self.assertTrue(same_bundle("a.bundle", {"a.bundle": bundle(10)}, {"a.bundle": bundle(10)}))
        self.assertFalse(same_bundle("a.bundle", {"a.bundle": bundle(10)}, {"a.bundle": bundle(11)}))

    def test_release_change_during_media_extraction_preserves_previous_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            observed = FakeClient().discover()
            state = {"observation": {**observed, "resourceVersion": "1.0.0.103"},
                     "snapshot": str(root / "old-snapshot"), "inputPlan": str(root / "old-plan")}
            state_path = root / "state.json"
            state_path.write_text(json.dumps(state))
            original = state_path.read_bytes()
            current = root / "1.0.0.104-bbbbbbbb-cccccccc-complete-v3"
            captured = current / "snapshot"
            captured.mkdir(parents=True)
            (captured / "report.json").write_text(json.dumps({"observation": observed}))
            (captured / "status.json").write_text(json.dumps({"status": "verified_snapshot"}))
            (current / "inputs").mkdir()
            client = Mock()
            client.discover.side_effect = [observed, {**observed, "resourceVersion": "1.0.0.105"}]
            with patch("tools.release_preflight.load_plan", return_value=[{"id": "global-production"}]), \
                    patch("tools.release_preflight.inspect_plan") as preflight:
                with self.assertRaisesRegex(ProtocolError, "during content extraction"):
                    _update(client, root, root, root, False, complete_content=True)
                preflight.assert_not_called()
            self.assertEqual(state_path.read_bytes(), original)

    def test_package_url_comes_from_current_official_scripts(self):
        url = "https://l12-pkg-download.biligames.com/sirius/apk/BanGDreamOurNotes_1.0.1.apk"
        class Website:
            def rpc(self, root, method):
                return {}, b""

            def get(self, address, limit, *, method="GET"):
                if method == "HEAD":
                    return HttpResponse(200, {"content-length": "1234"}, b"")
                if address.endswith(".js"):
                    return HttpResponse(200, {}, ('var apk="' + url + '"').encode())
                return HttpResponse(200, {}, b'<script src="//s1.biligames.com/fe-static/game-global-bangdreamon/gw/js/chunk-common.abc123.js"></script>')
        result = discover_package(Website())
        self.assertEqual(result["url"], url)
        self.assertFalse(result["packageIdentityVerified"])


if __name__ == "__main__":
    unittest.main()
