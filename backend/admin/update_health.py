"""Bounded, fail-closed view of private operational health. No raw error text."""
import json
import math
from pathlib import Path
import re
import time

CODES = {'worker_errors', 'worker_budget', 'worker_metrics_stale', 'schedule_stale', 'receipt_missing', 'poll_stale', 'run_stuck', 'run_failed', 'delivery_unknown',
         'delivery_lag', 'remote_unavailable', 'ranking_stale', 'ranking_paused', 'disk_budget',
         'trigger_failed', 'trigger_unconfirmed', 'trigger_stale'}

STAGES = ('configuration', 'prepare', 'baseline', 'image', 'proxy', 'light_prepare',
          'light_gate', 'restore', 'capacity', 'client', 'production_gate',
          'produce', 'functional', 'upload', 'receipt', 'retention', 'checkpoint', 'publication', 'promote')

def read_health(workspace):
    unavailable = {'status': 'unavailable'}
    try:
        path = Path(workspace) / 'update-health.json'
        now = time.time()
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
            return unavailable
        value = json.loads(path.read_text())
        observed = value.get('observedAt')
        if (value.get('schemaVersion') != 1 or type(observed) not in (int, float)
                or not math.isfinite(observed) or not -60 <= now - observed <= 360
                or value.get('status') not in ('healthy', 'waiting', 'attention')):
            return unavailable
        result = {'status': value['status'], 'observedAt': observed, 'alerts': [], 'history': [], 'runs': {}, 'delivery': {}}
        reviews = value.get('publicationReviews', {'status': 'unavailable'})
        if reviews.get('status') not in ('ready', 'disabled', 'unavailable'):
            return unavailable
        result['publicationReviews'] = {'status': reviews['status']}
        if reviews['status'] == 'ready':
            fields = ('region', 'publication', 'releaseId', 'manifestSha256', 'contentReleaseId',
                      'revision', 'status', 'publishAt', 'serverScopes', 'updatedAt', 'summary')
            result['publicationReviews']['regions'] = {
                region: {key: row[key] for key in fields} if row else None
                for region in ('global', 'jp')
                for row in [reviews['regions'].get(region)]}
        for region, row in value.get('delivery', {}).items():
            if region not in ('global', 'jp') or row.get('status') not in (
                    'unavailable', 'running', 'failed', 'produced', 'awaiting_delivery', 'delivered', 'unchanged'):
                return unavailable
            clean = {'status': row['status']}
            if row['status'] != 'unavailable' or 'currentDelivered' in row:
                if (not re.fullmatch('[a-f0-9]{24}', row.get('releaseId', ''))
                        or not re.fullmatch('[a-f0-9]{64}', row.get('manifestSha256', ''))
                        or type(row.get('currentDelivered')) is not bool):
                    return unavailable
                clean.update({k: row[k] for k in ('releaseId', 'manifestSha256', 'currentDelivered')})
            result['delivery'][region] = clean
        for field in ('alerts', 'history'):
            rows = value.get(field)
            if not isinstance(rows, list) or len(rows) > 40:
                return unavailable
            for row in rows:
                if not isinstance(row, dict) or row.get('code') not in CODES or row.get('region') not in ('all', 'global', 'jp'):
                    return unavailable
                clean = {'code': row['code'], 'region': row['region']}
                if field == 'alerts':
                    if row.get('state') not in ('pending', 'firing'):
                        return unavailable
                    clean['state'] = row['state']
                    keys = ('firstSeen', 'lastSeen')
                else:
                    if row.get('transition') not in ('opened', 'recovered'):
                        return unavailable
                    clean['transition'] = row['transition']
                    keys = ('at',)
                for key in keys:
                    stamp = row.get(key)
                    if type(stamp) not in (int, float) or not math.isfinite(stamp) or not 0 <= stamp <= now + 60:
                        return unavailable
                    clean[key] = stamp
                result[field].append(clean)
        for region in ('global', 'jp'):
            row = value.get('runs', {}).get(region)
            if row is None:
                continue
            if (not isinstance(row, dict) or type(row.get('runId')) is not int or not 0 < row['runId'] < 10**20
                    or row.get('status') not in ('running', 'success', 'failure', 'cancelled', 'skipped')
                    or not isinstance(row.get('sourceSha'), str) or not re.fullmatch('[a-f0-9]{40}', row['sourceSha'])):
                return unavailable
            if row.get('failedStage') not in (None,) + STAGES or row.get('event', 'unknown') not in ('unknown', 'schedule', 'workflow_dispatch'):
                return unavailable
            result['runs'][region] = {key: row[key] for key in ('runId', 'status', 'sourceSha')}
            result['runs'][region].update(event=row.get('event', 'unknown'), failedStage=row.get('failedStage'))
            origin = row.get('origin', row.get('event', 'unknown'))
            if origin not in ('unknown', 'schedule', 'workflow_dispatch', 'external'):
                return unavailable
            result['runs'][region]['origin'] = origin
        worker = value.get('worker', {'status': 'not_configured'})
        if not isinstance(worker, dict) or worker.get('status') not in ('ready', 'not_configured', 'unavailable'):
            return unavailable
        result['worker'] = {'status': worker['status']}
        if worker['status'] == 'ready':
            for key in ('recentRequests', 'recentErrors', 'cpuTimeP99Us', 'utcDayRequests', 'dailyRequestBudget'):
                number = worker.get(key)
                if type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 10**15:
                    return unavailable
                result['worker'][key] = number
            if worker['recentErrors'] > worker['recentRequests']:
                return unavailable
        expected = 'attention' if any(row['state'] == 'firing' for row in result['alerts']) else ('waiting' if result['alerts'] else 'healthy')
        if result['status'] != expected:
            return unavailable
        return result
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return unavailable
