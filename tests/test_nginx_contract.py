from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
NGINX_TEMPLATE = REPO_ROOT / "deploy/nginx.conf.template"
GROWTH_LOCATION = REPO_ROOT / "deploy/growth.locations.conf"


class NginxContractTest(unittest.TestCase):
    def test_growth_diagnostics_have_no_visitor_or_payload_fields(self) -> None:
        source = NGINX_TEMPLATE.read_text(encoding="utf-8")
        growth_format = source.split("log_format ournotes_growth", 1)[1].split(";", 1)[0]
        for field in ("$remote_addr", "$http_user_agent", "$http_referer", "$request_uri",
                      "$uri", "$request_body", "$http_cookie", "$http_authorization"):
            self.assertNotIn(field, growth_format)
        for field in ("$request_id", "$status", "$request_time", "$upstream_response_time"):
            self.assertIn(field, growth_format)
        location = GROWTH_LOCATION.read_text(encoding="utf-8")
        self.assertIn("access_log /var/log/nginx/ournotes-growth.access.log ournotes_growth;", location)
        self.assertIn("proxy_set_header X-Request-ID $request_id;", location)
        self.assertIn("add_header X-Request-ID $request_id always;", location)

    def test_access_log_exposes_capacity_rejection_without_sensitive_fields(self) -> None:
        source = NGINX_TEMPLATE.read_text(encoding="utf-8")
        access_format = source[: source.index("server {")]
        self.assertIn('"limit_conn_status":"$limit_conn_status"', access_format)
        self.assertIn('"limit_req_status":"$limit_req_status"', access_format)
        self.assertNotIn("$http_cookie", access_format)
        self.assertNotIn("$http_authorization", access_format)
        self.assertNotIn("$request_body", access_format)
        self.assertNotIn("$request_uri", access_format)

    def test_hashed_media_is_immutable_and_media_limits_are_removed(self) -> None:
        source = NGINX_TEMPLATE.read_text(encoding="utf-8")
        marker = 'location ~* "^/(?:media|(?:jp|global)'
        start = source.index(marker)
        end = source.index("\n    }", start)
        immutable_media = source[start:end]
        self.assertIn(
            "moc3|mp3|m4a|aac|flac|wav|ogg|mp4|webm|mov",
            immutable_media,
        )
        self.assertIn(
            'Cache-Control "public, max-age=31536000, immutable";',
            immutable_media,
        )
        for config in (NGINX_TEMPLATE, REPO_ROOT / "deploy/independent-content.locations.conf"):
            with self.subTest(config=config.name):
                self.assertNotRegex(
                    config.read_text(encoding="utf-8"),
                    re.compile(r"^\s*limit_(?:conn(?:_zone)?|req(?:_zone)?|rate(?:_after)?)\s", re.MULTILINE),
                )


class NginxQueryDisabledContractTest(unittest.TestCase):
    """The failed production capacity gate keeps Query disabled.

    Static releases must preserve public 404s for both Query and internal
    adapter paths until a separately approved capacity pass changes this
    deployment-owned template.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = NGINX_TEMPLATE.read_text(encoding="utf-8")

    def test_api_v1_is_rejected_while_query_is_disabled(self) -> None:
        self.assertRegex(
            self.source,
            re.compile(
                r"location\s+\^~\s+/api/v1/\s*\{[^}]*return\s+404;\s*\}",
                re.DOTALL,
            ),
        )
        self.assertNotIn("proxy_pass http://127.0.0.1:8090;", self.source)

    def test_internal_path_is_rejected_at_the_edge(self) -> None:
        # ``/internal/`` MUST return 404 even if the request somehow
        # reaches Nginx; the loopback adapter is the only legitimate
        # caller.
        self.assertRegex(
            self.source,
            re.compile(
                r"location\s+\^~\s+/internal/\s*\{[^}]*return\s+404;\s*\}",
                re.DOTALL,
            ),
        )

    def test_request_body_size_is_capped(self) -> None:
        # 64 KiB cap matches the documented body budget.
        self.assertIn("client_max_body_size 64k;", self.source)

    def test_no_wildcard_cors_header(self) -> None:
        # ``Access-Control-Allow-Origin: *`` is forbidden on the
        # cross-origin API surface; same-origin only.
        self.assertNotIn("Access-Control-Allow-Origin: *", self.source)
        self.assertNotIn("add_header Access-Control-Allow-Origin \"*\"", self.source)

    def test_api_routes_are_first_in_match_order(self) -> None:
        # The API rejection MUST be evaluated before any generic static-file
        # catch-all so a future ``/api/v1/index.html`` does not shadow
        # the boundary. Compare against the https server's catch-all, not
        # the http redirect that appears first in the file.
        api_index = self.source.index("location ^~ /api/v1/")
        https_catchall = self.source.index("location / {", api_index)
        self.assertLess(api_index, https_catchall)


if __name__ == "__main__":
    unittest.main()
