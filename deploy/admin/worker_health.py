"""Bounded Cloudflare Analytics sampling for the private ops page (Python 3.6)."""
import datetime as dt
import json
import math
import os
from pathlib import Path
import tempfile
import time
import urllib.request

QUERY = '''query($account:string,$start:string,$day:string,$end:string){viewer{accounts(filter:{accountTag:$account}){
recent:workersInvocationsAdaptive(limit:1,filter:{scriptName:"ournotes-content-gateway",datetime_geq:$start,datetime_leq:$end}){sum{requests errors} quantiles{cpuTimeP99}}
daily:workersInvocationsAdaptive(limit:1,filter:{scriptName:"ournotes-content-gateway",datetime_geq:$day,datetime_leq:$end}){sum{requests errors}}
}}}'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(account, token, now):
    end = dt.datetime.fromtimestamp(now, dt.timezone.utc)
    stamp = lambda value: value.isoformat().replace('+00:00', 'Z')
    payload = {'query': QUERY, 'variables': {'account': account, 'start': stamp(end-dt.timedelta(minutes=10)),
                                           'day': stamp(end.replace(hour=0, minute=0, second=0, microsecond=0)), 'end': stamp(end)}}
    req = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql',
            data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('oversized analytics response')
    return json.loads(raw)


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 10**15:
        raise ValueError('invalid analytics value')
    return value


def collect(account, token, now, daily_budget=0, query=request):
    report = {'schemaVersion': 1, 'observedAt': now, 'status': 'not_configured'}
    if not account or not token:
        return report
    report['status'] = 'unavailable'
    try:
        response = query(account, token, now)
        if response.get('errors'):
            raise ValueError('analytics query failed')
        accounts = response['data']['viewer']['accounts']
        if len(accounts) != 1:
            raise ValueError('analytics account absent')
        groups = accounts[0]
        def totals(name):
            rows = groups[name]
            if not isinstance(rows, list) or len(rows) > 1:
                raise ValueError('invalid analytics group')
            if not rows:
                return 0, 0, 0
            row = rows[0]
            requests, errors = number(row['sum']['requests']), number(row['sum']['errors'])
            if errors > requests:
                raise ValueError('contradictory analytics totals')
            return requests, errors, number(row.get('quantiles', {}).get('cpuTimeP99', 0))
        recent, errors, cpu = totals('recent')
        daily, _, _ = totals('daily')
        report.update(status='ready', recentRequests=recent, recentErrors=errors, cpuTimeP99Us=cpu,
                      utcDayRequests=daily, dailyRequestBudget=number(daily_budget), windowSeconds=600)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass  # Never emit response bodies, tokens or transport exception strings.
    return report


def write(path, value):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.worker-health-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, separators=(',', ':'), allow_nan=False)
            output.flush();os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


if __name__ == '__main__':
    budget = os.environ.get('CF_WORKER_DAILY_REQUEST_BUDGET', '0')
    if not budget.isdigit():raise SystemExit('Invalid worker request budget')
    write('/var/lib/ournotes-resource-state/worker-health.json', collect(
        os.environ.get('R2_ACCOUNT_ID'), os.environ.get('CF_ANALYTICS_READ_TOKEN'), time.time(), int(budget)))
