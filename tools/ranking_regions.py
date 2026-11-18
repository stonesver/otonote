"""Reuse the site's event projection only when official region tables match.

Master versions differ across Global regions. Compare the four source tables
against the exact HMT version that produced the published content, before login.
No private keys, downloaded Master payloads, or account data are needed.
"""
import json
import re
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from tools.global_game_config import GLOBAL_SERVERS
from tools.growth_export import fields
from tools.growth_login import BOOTSTRAP, LOGIN_SERVICE, LoginError, string

TABLES = ('MasterEvent.bin', 'MasterChallengeMusic.bin', 'MasterLiveMusic.bin', 'MasterText.bin')
# These tables control season membership, open leagues and score-to-rank rules.
# Names and other content continue to come from the manually approved projection.
ARENA_RANK_TABLES = ('MasterArenaSeason.bin', 'MasterArenaLeague.bin', 'MasterArenaRank.bin')
CDN = {
    'global-hmt': ('hk', ('l14-prod-hk-patch-sirius.gamerfusiontech.com',
                          'l12-prod-hk-patch-sirius.gamerfusiontech.com')),
    'global-en': ('en', ('l14-prod-sg-patch-sirius.bilibiligame.net',
                         'l12-prod-sg-patch-sirius.bilibiligame.net')),
    'global-kr': ('kr', ('l14-prod-sg-patch-sirius.bilibiligame.net',
                         'l12-prod-sg-patch-sirius.bilibiligame.net')),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('ranking_manifest_redirect_refused')


def manifest_tables(value, version, *, tables=TABLES):
    if not isinstance(value, dict) or value.get('version') != version or not isinstance(value.get('files'), list):
        raise ValueError('invalid_ranking_master_manifest')
    result = {}
    for row in value['files']:
        if not isinstance(row, dict):
            raise ValueError('invalid_ranking_master_manifest')
        name = row.get('name')
        if name not in tables:
            continue
        if (name in result or not re.fullmatch('[a-f0-9]{64}', str(row.get('hash', '')))
                or type(row.get('size')) is not int or not 0 < row['size'] <= 32_000_000):
            raise ValueError('invalid_ranking_master_manifest')
        result[name] = {'sha256': row['hash'], 'byteSize': row['size']}
    if len(result) != len(tables):
        raise ValueError('missing_ranking_master_tables')
    return result


def fetch_manifest(cdn, version, *, tables=TABLES):
    request = Request(cdn + '/master/' + version + '/MasterManifest.json',
                      headers={'User-Agent': 'OurNotes-Ranking-Capture/1.0', 'Accept': 'application/json'})
    with build_opener(NoRedirect).open(request, timeout=15) as response:
        raw = response.read(4_000_001)
    if len(raw) > 4_000_000:
        raise ValueError('oversized_ranking_master_manifest')
    return manifest_tables(json.loads(raw), version, tables=tables)


def server_cdn(servers, server):
    definition = GLOBAL_SERVERS[server]
    matches = [row for n, wire, row in fields(servers) if n == 1 and wire == 2
               and string(row, 8) == definition['wireId'] and string(row, 1) == definition['name']]
    if len(matches) != 1:
        raise ValueError('ranking_cdn_not_unique')
    cdn = string(matches[0], 2).split('|')[0]
    parsed = urlsplit(cdn)
    prefix, hosts = CDN[server]
    if (parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not re.fullmatch('/prod/' + prefix + '_[a-f0-9]{32}', parsed.path)):
        raise ValueError('ranking_cdn_refused')
    return cdn


def verify_arena_rank_tables(game, source_version, target_version):
    """Admit a version change only when the approved rank rules are byte-identical.

    Read official manifests for the selected server before any account login.
    This does not publish new Master rows or change the content/review identity.
    """
    try:
        if any(not isinstance(v, str) or not re.fullmatch('[a-f0-9]{32}', v)
               for v in (source_version, target_version)):
            raise ValueError('invalid_arena_master_version')
        servers = game._public_rpc(BOOTSTRAP, LOGIN_SERVICE + 'GetServerList')
        cdn = server_cdn(servers, game.server_id)
        source = fetch_manifest(cdn, source_version, tables=ARENA_RANK_TABLES)
        target = fetch_manifest(cdn, target_version, tables=ARENA_RANK_TABLES)
        if source != target:
            raise LoginError('arena_rank_tables_changed')
    except LoginError:
        raise
    except Exception:
        raise LoginError('arena_master_verification_failed') from None


def verify_shared_event_tables(game, host, plan, *, fetch=fetch_manifest):
    try:
        source_version = plan.get('contentMasterVersion')
        if not isinstance(source_version, str) or not re.fullmatch('[a-f0-9]{32}', source_version):
            raise ValueError('ranking_content_master_version_required')
        target_version = string(game._public_rpc(host, 'app.masterdata.MasterdataService/Version'), 1)
        if not re.fullmatch('[a-f0-9]{32}', target_version):
            raise ValueError('invalid_ranking_master_version')
        servers = game._public_rpc(BOOTSTRAP, LOGIN_SERVICE + 'GetServerList')
        cdns = {}
        for server in ('global-hmt', game.server_id):
            cdns[server] = server_cdn(servers, server)
        source = fetch(cdns['global-hmt'], source_version)
        target = fetch(cdns[game.server_id], target_version)
        if source != target:
            raise LoginError('ranking_region_event_tables_differ')
        return {'sourceServerId': 'global-hmt', 'sourceMasterVersion': source_version,
                'targetServerId': game.server_id, 'targetMasterVersion': target_version, 'tables': target}
    except LoginError:
        raise
    except Exception:
        raise LoginError('ranking_region_event_verification_failed') from None
