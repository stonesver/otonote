"""Read-only update health sampling; bounded alerts go to private state and logs."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import time

from tools.r2_content import S3Bucket, baseline
from tools.r2_run_record import key, validate

REGIONS = ('global', 'jp')
CODES = {'worker_errors', 'worker_budget', 'worker_metrics_stale', 'schedule_stale', 'receipt_missing', 'poll_stale', 'run_stuck', 'run_failed', 'delivery_unknown',
         'delivery_lag', 'remote_unavailable', 'ranking_stale', 'ranking_paused', 'disk_budget'}


def timestamp(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone required')
    return result.timestamp()


def read_json(path, now, max_age=None):
    path = Path(path)
    stat = path.stat()
    if path.is_symlink() or not path.is_file() or stat.st_size > 1024 * 1024:
        raise ValueError('unsafe sample')
    if max_age is not None and not -60 <= now - stat.st_mtime <= max_age:
        raise ValueError('stale sample')
    with path.open('rb') as source:
        raw = source.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('oversized sample')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('invalid sample')
    return value


def sample(bucket, delivery_path, ranking_path, disk_path, budget, now, worker_path=None):
    conditions, runs, versions = [], {}, {}

    def condition(code, region='all', grace=600):
        conditions.append({'id': region + ':' + code, 'code': code, 'region': region, 'grace': grace})

    try:
        delivery = read_json(delivery_path, now, 360)
        if delivery.get('status') != 'passed' or delivery.get('delivery', {}).get('status') != 'ready':
            raise ValueError('delivery unavailable')
        local = delivery['delivery']['regions']
    except (OSError, ValueError, TypeError, KeyError):
        local = {}
        condition('delivery_unknown')
    for region in REGIONS:
        try:
            raw = bucket.get(key(region))
            if raw is None or len(raw[0]) > 16384:
                raise ValueError('missing operational receipt')
            run = validate(json.loads(raw[0]))
            age = now - timestamp(run['observedAt'])
            if run['region'] != region or age < -60:
                raise ValueError('invalid operational receipt')
            runs[region] = {name: run[name] for name in
                            ('runId', 'attempt', 'sourceSha', 'status', 'outcome', 'failedStage', 'consecutiveFailures', 'observedAt', 'stages')}
            runs[region]['event'] = run.get('event', 'unknown')
            if run['status'] != 'running':
                scheduled = run.get('lastScheduledAt')
                if scheduled is None:
                    condition('schedule_stale', region, 3600)
                elif not -60 <= now - timestamp(scheduled) <= 3600:
                    condition('schedule_stale', region, 0)
            if run['status'] == 'running':
                if age > 6 * 3600:
                    condition('run_stuck', region, 0)
            elif age > 3600:
                condition('poll_stale', region, 0)
            if run['status'] == 'failure' or (run['status'] != 'success' and run['consecutiveFailures'] > 0):
                condition('run_failed', region, 0 if run['consecutiveFailures'] >= 2 else 900)
        except Exception:
            # Fixed condition codes only: no credentials or raw SDK failures.
            condition('receipt_missing', region)
        try:
            remote = baseline(bucket, region)['pointer']
            if remote is None:
                raise ValueError('no remote pointer')
            versions[region] = remote['manifest'].split('/')[3]
            row = local.get(region, {})
            if row.get('releaseId') != versions[region] or row.get('manifestSha256') != remote['sha256']:
                condition('delivery_lag', region)
        except Exception:
            condition('remote_unavailable', region)
    try:
        ranking = read_json(ranking_path, now, 900)
        age = now - timestamp(ranking['observedAt'])
        if ranking.get('paused') is True:
            condition('ranking_paused', grace=900)
        elif not -60 <= age <= 900 or ranking.get('status') not in ('complete', 'waiting'):
            condition('ranking_stale', grace=600)
    except (OSError, ValueError, TypeError, KeyError):
        condition('ranking_stale', grace=600)
    worker = {'status': 'not_configured'}
    if worker_path is not None:
        try:
            data = read_json(worker_path, now, 360)
            if data.get('schemaVersion') != 1 or data.get('status') not in ('ready', 'not_configured'):
                raise ValueError('worker metrics unavailable')
            if not -60 <= now - data['observedAt'] <= 360:
                raise ValueError('worker metrics stale')
            if data['status'] == 'ready':
                fields = ('recentRequests', 'recentErrors', 'cpuTimeP99Us', 'utcDayRequests', 'dailyRequestBudget')
                if any(type(data.get(k)) not in (int, float) or not math.isfinite(data[k]) or not 0 <= data[k] <= 10**15 for k in fields):
                    raise ValueError('invalid worker metrics')
                worker = {k: data[k] for k in fields};worker['status'] = 'ready'
                if worker['recentErrors'] > worker['recentRequests']:
                    raise ValueError('contradictory worker metrics')
                if worker['recentErrors'] >= 5 and worker['recentErrors'] / max(worker['recentRequests'], 1) >= 0.01:
                    condition('worker_errors', grace=0)
                if worker['dailyRequestBudget'] > 0 and worker['utcDayRequests'] >= worker['dailyRequestBudget'] * 0.8:
                    condition('worker_budget', grace=0)
        except (OSError, ValueError, TypeError, KeyError):
            worker = {'status': 'unavailable'}
            condition('worker_metrics_stale')
    free = shutil.disk_usage(disk_path).free
    if free < budget:
        condition('disk_budget', grace=0)
    return {'conditions': conditions, 'runs': runs, 'versions': versions,
            'diskFreeBytes': free, 'diskRequiredBytes': budget, 'worker': worker}


def advance(observed, previous, now):
    """Persist duration, deduplicate unchanged alerts, record bounded recoveries."""
    old = {a.get('id'): a for a in previous.get('alerts', []) if isinstance(a, dict)}
    alerts, transitions = [], []
    for item in observed['conditions']:
        prior = old.pop(item['id'], {})
        first = prior.get('firstSeen', now)
        if type(first) not in (int, float) or not math.isfinite(first) or not 0 <= first <= now:
            first = now
        state = 'firing' if now - first >= item['grace'] else 'pending'
        alert = {name: item[name] for name in ('id', 'code', 'region')}
        alert.update(state=state, firstSeen=first, lastSeen=now)
        alerts.append(alert)
        if state == 'firing' and prior.get('state') != 'firing':
            transitions.append(dict(alert, transition='opened', at=now))
    for item in old.values():
        if item.get('state') == 'firing' and item.get('code') in CODES and item.get('region') in (*REGIONS, 'all'):
            transitions.append({name: item[name] for name in ('id', 'code', 'region')} | {'transition': 'recovered', 'at': now})
    history = [h for h in previous.get('history', []) if isinstance(h, dict)
               and h.get('code') in CODES and h.get('transition') in ('opened', 'recovered')][-40:]
    report = {name: observed[name] for name in ('runs', 'versions', 'diskFreeBytes', 'diskRequiredBytes')}
    report['worker'] = observed.get('worker', {'status': 'not_configured'})
    report.update(schemaVersion=1, observedAt=now, status='attention' if any(a['state'] == 'firing' for a in alerts)
                  else ('waiting' if alerts else 'healthy'), alerts=alerts, history=(history + transitions)[-40:])
    return report, transitions


def write_atomic(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.health-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(report, output, separators=(',', ':'), allow_nan=False)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delivery', type=Path, required=True)
    parser.add_argument('--ranking', type=Path, required=True)
    parser.add_argument('--disk', type=Path, required=True)
    parser.add_argument('--budget', type=int, required=True)
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.budget <= 0:
        parser.error('budget must be positive')
    now = time.time()
    try:
        previous = read_json(args.output, now)
    except (OSError, ValueError):
        previous = {}
    observed = sample(S3Bucket.from_environment(), args.delivery, args.ranking, args.disk, args.budget, now, args.worker)
    report, transitions = advance(observed, previous, now)
    write_atomic(args.output, report)
    for transition in transitions:
        print(json.dumps(transition, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
