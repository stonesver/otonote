"""Bounded operational receipts, inaccessible through the public content gateway."""
import argparse
import datetime as dt
import json
import os
import re

from tools.r2_content import S3Bucket, canonical

STAGES = ('configuration', 'prepare', 'baseline', 'image', 'proxy', 'light_prepare',
          'light_gate', 'restore', 'capacity', 'client', 'production_gate',
          'produce', 'functional', 'upload', 'receipt', 'retention', 'checkpoint', 'publication', 'promote')
RESULTS = {'success', 'failure', 'cancelled', 'skipped'}


def key(region):
    if region not in ('global', 'jp'):
        raise ValueError('invalid region')
    return 'content/operations/' + region + '/latest.json'


def validate(value):
    if (not isinstance(value, dict) or value.get('schemaVersion') != 1
            or value.get('region') not in ('global', 'jp')
            or type(value.get('runId')) is not int or not 0 < value['runId'] < 10**20
            or type(value.get('attempt')) is not int or not 0 < value['attempt'] < 10000
            or not isinstance(value.get('sourceSha'), str)
            or not re.fullmatch('[a-f0-9]{40}', value['sourceSha'])
            or value.get('status') not in RESULTS | {'running'}
            or type(value.get('consecutiveFailures')) is not int
            or not 0 <= value['consecutiveFailures'] <= 1000000
            or value.get('failedStage') not in (None,) + STAGES
            or value.get('outcome') not in ('running', 'failed', 'cancelled', 'skipped', 'unchanged', 'produced', 'promoted', 'checked')
            or not isinstance(value.get('stages'), dict)
            or any(k not in STAGES or v not in RESULTS for k, v in value['stages'].items())):
        raise ValueError('invalid operational receipt')
    stamp = dt.datetime.fromisoformat(value['observedAt'].replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('receipt time lacks timezone')
    if value.get('event', 'unknown') not in ('unknown', 'schedule', 'workflow_dispatch'):
        raise ValueError('invalid run event')
    if value.get('lastScheduledAt') is not None:
        last = dt.datetime.fromisoformat(value['lastScheduledAt'].replace('Z', '+00:00'))
        if last.tzinfo is None:
            raise ValueError('scheduled receipt time lacks timezone')
    return value


def build(region, run_id, attempt, sha, status, steps, previous=None, now=None, event='workflow_dispatch'):
    stages = {name: steps[name]['outcome'] for name in STAGES
              if isinstance(steps.get(name), dict) and steps[name].get('outcome') in RESULTS}
    failed = next((name for name in STAGES if stages.get(name) == 'failure'), None)
    count = previous.get('consecutiveFailures', 0) if previous else 0
    if status == 'running' and count:
        failed = (previous or {}).get('failedStage')
    if status == 'success':
        count = 0
    elif status == 'failure':
        count = min(count + 1, 1000000)
    outcome = {'running': 'running', 'failure': 'failed', 'cancelled': 'cancelled', 'skipped': 'skipped'}.get(status, 'checked')
    if status == 'success':
        if stages.get('promote') == 'success':
            outcome = 'promoted'
        elif stages.get('produce') == 'success':
            outcome = 'produced'
        elif (stages.get('light_gate') == 'success' or stages.get('production_gate') == 'success'):
            outcome = 'unchanged'
    value = {'schemaVersion': 1, 'region': region, 'runId': run_id, 'attempt': attempt,
             'sourceSha': sha, 'status': status, 'outcome': outcome, 'stages': stages,
             'failedStage': failed, 'consecutiveFailures': count,
             'observedAt': (now or dt.datetime.now(dt.timezone.utc)).isoformat()}
    value['event'] = event
    value['lastScheduledAt'] = value['observedAt'] if event == 'schedule' else (previous or {}).get('lastScheduledAt')
    value['lastSuccessAt'] = value['observedAt'] if status == 'success' else (previous or {}).get('lastSuccessAt')
    return validate(value)


def publish(bucket, region, run_id, attempt, sha, status, steps, now=None, event='workflow_dispatch'):
    name = key(region)
    previous = bucket.get(name)
    old = validate(json.loads(previous[0])) if previous else None
    if old and old['region'] != region:
        raise ValueError('cross-region operational receipt')
    identity = (run_id, attempt)
    if old:
        prior = (old['runId'], old['attempt'])
        # Late completions must not overwrite newer runs; repeated finalization
        # must not count the same failure twice or refresh a stale heartbeat.
        if prior > identity or (prior == identity and old['status'] != 'running'):
            return {'status': 'superseded'}
        if prior == identity and status == 'running':
            return {'status': 'unchanged'}
    value = build(region, run_id, attempt, sha, status, steps, old, now, event)
    raw = canonical(value)
    bucket.replace(name, raw, previous[1] if previous else None,
                   content_type='application/json', cache_control='no-store')
    verified = bucket.get(name)
    if verified is None or verified[0] != raw:
        raise ValueError('operational receipt readback mismatch')
    return {'status': 'recorded', 'region': region, 'result': value['status']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--status', required=True, choices=sorted(RESULTS | {'running'}))
    args = parser.parse_args()
    try:
        steps = json.loads(os.environ.get('RUN_STEPS', '{}'))
        if not isinstance(steps, dict):
            raise ValueError('invalid steps')
        result = publish(S3Bucket.from_environment(), os.environ['REGION'],
                         int(os.environ['GITHUB_RUN_ID']), int(os.environ['GITHUB_RUN_ATTEMPT']),
                         os.environ['GITHUB_SHA'], args.status, steps, event=os.environ['GITHUB_EVENT_NAME'])
        print(json.dumps(result))
    except Exception as error:
        # Never print arbitrary SDK/step strings or credentials.
        raise SystemExit('Operational receipt failed: ' + type(error).__name__)


if __name__ == '__main__':
    main()
