"""Dispatch one fixed publication decision workflow; never store R2 write keys."""
import json
import math
import re
import time
import logging
from urllib.request import Request, build_opener, ProxyHandler

from .config import secret
from .transport import NoRedirect


def validate_decision(value):
    if (not isinstance(value, dict) or set(value) != {'region', 'publication', 'revision', 'action', 'publishAt'}
            or value['region'] not in ('global', 'jp')
            or not isinstance(value['publication'], str) or not re.fullmatch(r'[1-9][0-9]*_[1-9][0-9]*', value['publication'])
            or type(value['revision']) is not int or value['revision'] < 1
            or value['action'] not in ('publish', 'schedule', 'hold')):
        raise ValueError('invalid publication decision')
    stamp = value['publishAt']
    if value['action'] == 'schedule':
        if type(stamp) not in (int, float) or not math.isfinite(stamp) or not 0 < stamp <= 253402300799:
            raise ValueError('invalid publication time')
    elif stamp is not None:
        raise ValueError('unexpected publication time')
    return value


def dispatch(settings, decision, *, send=None):
    value = validate_decision(decision)
    inputs = {'region': value['region'], 'publication': value['publication'],
              'mode': value['action'], 'revision': str(value['revision']),
              'publish_at': str(value['publishAt']) if value['publishAt'] is not None else ''}
    url = 'https://api.github.com/repos/' + settings['repository'] + '/actions/workflows/retry-content-publication.yml/dispatches'
    request = Request(url, data=json.dumps({'ref': 'main', 'inputs': inputs}).encode(),
        headers={'Authorization': 'Bearer ' + secret(settings['tokenEnv']),
                 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OtoNote-Publication-Review'})
    with (send or build_opener(ProxyHandler({}), NoRedirect()).open)(request, timeout=10) as response:
        if response.status not in (200, 204):
            raise ValueError('unexpected workflow response')
    return {'status': 'submitted'}


def publish_due(config, transport, attempts, *, send=dispatch, now=None):
    """One workbench tick. Actions rechecks the revision before doing any work."""
    epoch = time.time() if now is None else now
    for node in config.get('nodes', []):
        if not node.get('publishUsers'):
            continue
        try:
            state = transport(node, '/state')
            for profile in state['profiles']:
                health = profile.get('health', {})
                reviews = health.get('publicationReviews', {})
                if (profile.get('productionOwner') != 'github-actions-r2'
                        or health.get('status') == 'unavailable' or reviews.get('status') != 'ready'):
                    continue
                for region, row in reviews['regions'].items():
                    if not row or row['status'] != 'scheduled' or row['publishAt'] > epoch:
                        continue
                    key, identity = (node['id'], region), (row['publication'], row['revision'])
                    previous = attempts.get(key)
                    if previous and previous[0] == identity and epoch < previous[1]:
                        continue
                    attempts[key] = (identity, epoch + 600)
                    send(config['publicationReview'], {'region': region, 'publication': row['publication'],
                         'revision': row['revision'], 'action': 'publish', 'publishAt': None})
                    attempts[key] = (identity, math.inf)
        except (OSError, ValueError, KeyError, TypeError) as error:
            # A lost response may already have dispatched. Wait ten minutes;
            # a duplicate can only target the same revision and cannot republish.
            logging.getLogger(__name__).warning('Publication timer unavailable: %s', type(error).__name__)
