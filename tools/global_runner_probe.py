"""Read-only, secret-free diagnostics for the official Global upgrade route."""
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import getproxies, proxy_bypass

from tools.resource_pipeline.adapters.global_public import (
    APK_HOSTS, APK_USER_AGENT, BOOTSTRAP, WEB_HOSTS, ClientUpdateRequired, allowed_url,
    GlobalPublicClient, discover_package, website_config_package,
)
from tools.resource_pipeline.transport import HttpRequest, HttpTransport


def report(stage, **fields):
    print(json.dumps({'stage': stage, **fields}, sort_keys=True), flush=True)


def probe_website_apk(version):
    """Inspect the current official website's public apklink configuration."""
    config_url = ('https://kv1.biligames.com/x/kv-frontend/namespace/data'
                  '?appKey=555.187&nscode=24&unlimit=true')
    config_transport = HttpTransport(allowed_hosts=('kv1.biligames.com',),
                                     connect_timeout_seconds=30, read_timeout_seconds=30,
                                     max_response_bytes=4096)
    try:
        response = config_transport.request(HttpRequest('GET', config_url))
        value = json.loads(response.body)
        link = value['data']['data']['apklink.link']
        if response.status != 200 or value.get('code') != 0 or not isinstance(link, str):
            raise ValueError('invalid public APK configuration')
        allowed_url(link, ('l14-pkg-download.biligames.com',))
        match = re.fullmatch(r'/sirius/apk/BanGDreamOurNotes_([0-9]+(?:\.[0-9]+){1,4})_[0-9_]+\.apk',
                             urlsplit(link).path)
        if not match or match.group(1) != version:
            raise ValueError('public APK version mismatch')
    except Exception as error:
        report('website_apk_config', status='failed', errorType=type(error).__name__)
        return
    report('website_apk_config', status='available', version=version)
    transport = HttpTransport(allowed_hosts=('l14-pkg-download.biligames.com',),
                              connect_timeout_seconds=30, read_timeout_seconds=30,
                              max_response_bytes=1024)
    try:
        head = transport.request(HttpRequest('HEAD', link, {'User-Agent': APK_USER_AGENT}))
        report('website_apk_head', status=head.status,
               hasLength=bool(head.headers.get('content-length')),
               hasEtag=bool(head.headers.get('etag')),
               hasModified=bool(head.headers.get('last-modified')))
    except Exception as error:
        report('website_apk_head', status='failed', errorType=type(error).__name__)
    try:
        response = transport._send(HttpRequest('GET', link, {'User-Agent': APK_USER_AGENT}))
        with response:
            status = response.status
            first = response.read(16)
        report('website_apk_get', status=status, firstBytes=len(first))
    except Exception as error:
        report('website_apk_get', status='failed', errorType=type(error).__name__)


def main():
    client = GlobalPublicClient('1.0.1')
    upgrade = None
    try:
        client.rpc(BOOTSTRAP, 'app.playerlogin.PlayerLoginService/GetServerList')
    except ClientUpdateRequired as notice:
        upgrade = notice
        report('rpc', status='update_required', version=notice.version, hasOfficialUrl=bool(notice.url))
    except Exception as error:
        report('rpc', status='failed', errorType=type(error).__name__)
        return 1
    else:
        report('rpc', status='accepted')
        return 0

    report('proxy_selection', httpsProxyConfigured=bool(getproxies().get('https')),
           apkHostBypassed=proxy_bypass('pkg.biligame.com'))
    transport = HttpTransport(allowed_hosts=APK_HOSTS, connect_timeout_seconds=30,
                              read_timeout_seconds=30, max_response_bytes=1024)
    try:
        head = transport.request(HttpRequest('HEAD', upgrade.url, {'User-Agent': APK_USER_AGENT}))
        report('apk_head_response', status=head.status,
               isApkType=head.headers.get('content-type', '').split(';', 1)[0] == 'application/vnd.android.package-archive',
               hasEtag=bool(head.headers.get('etag')),
               serverIsCloudflare='cloudflare' in head.headers.get('server', '').lower())
    except Exception as error:
        report('apk_head_response', status='failed', errorType=type(error).__name__)
    try:
        package = client.official_apk(upgrade)
    except Exception as error:
        report('apk_head', status='failed', errorType=type(error).__name__)
    else:
        report('apk_head', status='available', byteSize=package['byteSize'], hasEtag=bool(package['etag']))

    if upgrade.url:
        try:
            response = transport._send(HttpRequest('GET', upgrade.url, {'User-Agent': APK_USER_AGENT}))
            with response:
                status = response.status
                first = response.read(16)
                has_length = bool(response.headers.get('content-length'))
                has_etag = bool(response.headers.get('etag'))
            report('apk_get', status=status, firstBytes=len(first), hasLength=has_length, hasEtag=has_etag)
        except Exception as error:
            report('apk_get', status='failed', errorType=type(error).__name__)

    probe_website_apk(upgrade.version)
    if os.environ.get('FULL_WEBSITE_APK') == 'true':
        try:
            from tools.global_remote_sync import acquire
            from tools.resource_pipeline.package_intake import inspect_apk
            package = website_config_package(client, upgrade.version)
            with tempfile.TemporaryDirectory(prefix='global-apk-probe-') as temporary:
                target = Path(temporary) / 'official.apk'
                receipt = acquire(package['url'], target, package['byteSize'],
                                  expected_etag=package['etag'], allowed_hosts=WEB_HOSTS,
                                  request_headers={'User-Agent': APK_USER_AGENT})
                identity = inspect_apk(target)
            report('website_apk_full_download', status='verified',
                   matchesKnown103=(receipt['sha256'] ==
                                    'e9f2ad502d77f4790ceb872972064715f57f24856eefa461bc4bcfa97616b149'),
                   version=identity['versionName'], packageName=identity['packageName'],
                   certificateMatches=identity['certificateSha256'] ==
                                      'bf683e367551a3f629b90e16a63b315af74e387bcc5d94f26dcd626e7eea3637')
        except Exception as error:
            report('website_apk_full_download', status='failed', errorType=type(error).__name__)
    try:
        package = discover_package(client)
    except Exception as error:
        report('package_discovery', status='failed', errorType=type(error).__name__)
        return 1
    report('package_discovery', status='available', version=package.get('clientVersion'))
    try:
        observation = GlobalPublicClient(upgrade.version).discover()
    except Exception as error:
        report('upgraded_client_discovery', status='failed', errorType=type(error).__name__)
        return 1
    report('upgraded_client_discovery', status='available', clientVersion=observation['clientVersion'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
