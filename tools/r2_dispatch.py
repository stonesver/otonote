"""Bounded external trigger for the existing Actions pipeline (Python 3.6+).

This does no production work and never treats an accepted dispatch as a release.
Keep it independent of producers so its operational changes need no rebuild.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

from tools.r2_schedule import activity_slots, due_slot, slot_time, parse_slot
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, 'redirect refused', headers, fp)


class CalendarUnavailable(ValueError):
    pass


def read_private(path, limit, credential=False):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        # The root-owned 0640 credential is readable only by the dedicated group.
        group_read = credential and info.st_uid == 0 and info.st_gid == os.getegid()
        allowed = 0o640 if group_read else 0o600
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or stat.S_IMODE(info.st_mode) & ~allowed or info.st_size > limit):
            raise ValueError('invalid private file')
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('private file too large')
        return raw


def save(path, value):
    temporary = path.with_suffix('.tmp')
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(path))


def response_json(response, limit=1024*1024):
    raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('response too large')
    return json.loads(raw)


def fetch_calendar(repository, send):
    request = Request('https://api.github.com/repos/' + repository + '/contents/config/arena-sync-schedule.json?ref=main',
                      headers={'User-Agent': 'OurNotes-Update-Trigger/2.0',
                               'Accept': 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with send(request, timeout=15) as response:
        calendar = response_json(response, 65536)
    activity_slots(calendar, 'global')
    return calendar


def load_calendar(repository, directory, epoch, send):
    # Share a five-minute public-calendar cache between both region services.
    # No credential goes to this read; twelve fetches/hour stay below the
    # public API quota. Failed refreshes do not silently use expired calendars.
    fd = os.open(str(directory / 'calendar.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / 'calendar.json'
        if path.exists():
            cached = json.loads(read_private(path, 131072))
            if cached.get('repository') == repository and 0 <= epoch - cached['fetchedAt'] < 300:
                return cached['calendar']
        calendar = fetch_calendar(repository, send)
        save(path, {'repository': repository, 'fetchedAt': epoch, 'calendar': calendar})
        return calendar


def request_for(repository, token, suffix, data=None):
    return Request('https://api.github.com/repos/' + repository + '/actions/workflows/content-r2.yml/' + suffix,
                   data=json.dumps(data).encode() if data is not None else None,
                   headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                            'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
                            'User-Agent': 'OurNotes-Update-Trigger/2.0'})


def reconcile(repository, region, token, result, send):
    # An absent match is not proof that a timed-out POST was rejected. Never
    # submit another POST for an ambiguous slot, even if listing is also down.
    query = urlencode({'event': 'workflow_dispatch', 'branch': 'main', 'per_page': 100,
                       'created': '>=' + slot_time(result['attemptEpoch'] - 60)})
    with send(request_for(repository, token, 'runs?' + query), timeout=15) as response:
        runs = response_json(response)['workflow_runs']
    title = 'Content update / ' + region + ' / ' + result['dispatchId']
    matches = [r for r in runs if r.get('display_title') == title and r.get('head_branch') == 'main'
               and r.get('event') == 'workflow_dispatch']
    if len(matches) == 1 and type(matches[0].get('id')) is int and matches[0]['id'] > 0:
        result.update(status='accepted', runId=matches[0]['id'], lastAcceptedAt=result['attemptAt'])
        result.pop('reason', None)
    else:
        result.update(status='unknown', reason='acceptance_unconfirmed')


def dispatch(repository, region, token_file, state_dir, *, now=None, send=None, scheduled=False, calendar=None):
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}', repository)
            or repository.split('/')[-1] in ('.', '..') or region not in ('global', 'jp')):
        raise ValueError('invalid dispatch target')
    directory = Path(state_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.stat()
    if directory.resolve() != directory or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('private state directory required')
    epoch = int(time.time() if now is None else now)
    if epoch < 0:
        raise ValueError('invalid clock')
    if send is None:
        send = build_opener(ProxyHandler({}), NoRedirect()).open
    path = directory / (region + ('.json' if scheduled else '-probe.json'))
    lock_fd = os.open(str(directory / (region + '.lock')), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'skipped', 'region': region, 'reason': 'already_running'}
        if scheduled and calendar is None:
            try:
                calendar = load_calendar(repository, directory, epoch, send)
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise CalendarUnavailable('calendar unavailable') from error
        slot = due_slot(epoch, region, calendar) if scheduled else epoch // 900 * 900
        identity = ('scheduled-' if scheduled else 'probe-') + str(slot)
        previous = json.loads(read_private(path, 8192)) if path.exists() else {}
        if not isinstance(previous, dict):
            raise ValueError('invalid previous state')
        if previous.get('attemptEpoch', 0) > epoch:
            return {'status': 'skipped', 'region': region, 'reason': 'clock_moved_backwards'}
        if scheduled and previous.get('scheduledFor') and parse_slot(previous['scheduledFor']) > slot:
            previous['checkedAt'] = epoch
            save(path, previous)
            return previous
        same_slot = previous.get('dispatchId') == identity
        if same_slot:
            result = previous
            result['checkedAt'] = epoch
            if (result['status'] == 'accepted' or (result['status'] == 'failed' and result.get('attempts', 0) >= 3)
                    or (result['status'] == 'failed' and result.get('reason') != 'rate_limit')
                    or epoch < result.get('retryAfter', 0)):
                save(path, result)
                return result
        token = read_private(Path(token_file), 4096, credential=True).decode('ascii').strip()
        if not re.fullmatch(r'[A-Za-z0-9_]+', token):
            raise ValueError('invalid token')
        if same_slot and result['status'] in ('pending', 'unknown'):
            try:
                reconcile(repository, region, token, result, send)
            except (HTTPError, URLError, OSError, ValueError, KeyError, TypeError):
                result.update(status='unknown', reason='acceptance_unconfirmed')
            save(path, result)
            return result
        result = {'status': 'pending', 'region': region, 'dispatchId': identity, 'attemptEpoch': epoch,
                  'attemptAt': slot_time(epoch), 'checkedAt': epoch, 'scheduledFor': slot_time(slot) if scheduled else '',
                  'attempts': previous.get('attempts', 0) + 1 if same_slot else 1}
        if isinstance(previous.get('lastAcceptedAt'), str):
            result['lastAcceptedAt'] = previous['lastAcceptedAt']
        save(path, result)
        inputs = {'region': region, 'mode': 'auto', 'dispatch_id': identity, 'scheduled_for': result['scheduledFor']}
        request = request_for(repository, token, 'dispatches',
                              {'ref': 'main', 'inputs': inputs, 'return_run_details': True})
        try:
            with send(request, timeout=15) as response:
                code = response.getcode()
                if code == 200:
                    run_id = response_json(response, 16384)['workflow_run_id']
                    if type(run_id) is not int or run_id <= 0:
                        raise ValueError('invalid run identity')
                    result.update(status='accepted', runId=run_id, lastAcceptedAt=result['attemptAt'])
                else:
                    result.update(status='unknown', reason='acceptance_unconfirmed')
        except HTTPError as error:
            # Only an explicit rate-limit rejection is retried, at most 3 POSTs.
            # Server errors can have an unknown outcome, just like a timeout.
            result.update(status='unknown' if error.code >= 500 else 'failed',
                          reason='http_error', httpStatus=error.code)
            if error.code == 429 or (error.code == 403 and error.headers.get('X-RateLimit-Remaining') == '0'):
                result['reason'] = 'rate_limit'
                retry_at = epoch + (60 if result['attempts'] == 1 else 300)
                for header, relative in (('Retry-After', True), ('X-RateLimit-Reset', False)):
                    value = error.headers.get(header, '')
                    if value.isdigit():
                        retry_at = max(retry_at, int(value) + (epoch if relative else 0))
                result['retryAfter'] = retry_at
            if error.fp is not None:
                error.close()
        except (URLError, OSError, TimeoutError, ValueError, KeyError, TypeError):
            result.update(status='unknown', reason='acceptance_unconfirmed')
        save(path, result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--region', choices=('global', 'jp'), required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--scheduled', action='store_true', help='Check the latest fixed/activity slot; omit for a manual probe')
    args = parser.parse_args()
    try:
        result = dispatch(args.repository, args.region, args.token_file, args.state_dir, scheduled=args.scheduled)
    except CalendarUnavailable:
        result = {'status': 'failed', 'region': args.region, 'reason': 'calendar_unavailable'}
    except (OSError, ValueError, KeyError, TypeError):
        result = {'status': 'failed', 'region': args.region, 'reason': 'local_configuration'}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] in ('accepted', 'skipped') else 2


if __name__ == '__main__':
    raise SystemExit(main())
