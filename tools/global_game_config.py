"""Public region identities and bounded client-version negotiation helpers."""
import re

# This seed starts public discovery; an official upgrade response can replace it
# before credentials are used. It is never the authoritative live version.
DISCOVERY_VERSION = '1.0.3'
GLOBAL_SERVERS = {
    'global-hmt': {'name': 'TW/HK/MO', 'wireId': '2', 'language': 'zh',
                   'hosts': ('l14-prod-hk-all-gs-sirius.gamerfusiontech.com',
                             'l12-prod-hk-all-gs-sirius.gamerfusiontech.com')},
    'global-en': {'name': 'EN Region', 'wireId': '3', 'language': 'en',
                  'hosts': ('l14-prod-va-all-gs-sirius.bilibiligame.net',)},
    'global-kr': {'name': 'Korea', 'wireId': '4', 'language': 'ko',
                  'hosts': ('l14-prod-kr-all-gs-sirius.bilibiligame.net',)},
}


def valid_version(value):
    return (isinstance(value, str) and len(value) <= 32
            and re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,4}', value) is not None)


def recommended_version(metadata):
    values = [value for key, value in metadata or () if key == 'x-client-recommended-version']
    return values[0] if len(values) == 1 and valid_version(values[0]) else None


def export_source(server_id, version):
    if server_id not in GLOBAL_SERVERS or not valid_version(version):
        raise ValueError('invalid_export_source')
    return {'kind': 'direct_game_read', 'region': 'global', 'edition': 'global',
            'serverId': server_id, 'clientVersion': version}
