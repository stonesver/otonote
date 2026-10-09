"""Read-only, secret-free diagnostics for the official Global upgrade route."""
import json
from urllib.request import getproxies, proxy_bypass

from tools.resource_pipeline.adapters.global_public import (
    APK_HOSTS, APK_USER_AGENT, BOOTSTRAP, ClientUpdateRequired,
    GlobalPublicClient, discover_package,
)
from tools.resource_pipeline.transport import HttpRequest, HttpTransport


def report(stage, **fields):
    print(json.dumps({'stage': stage, **fields}, sort_keys=True), flush=True)


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
