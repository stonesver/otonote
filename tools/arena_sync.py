"""Compile reviewed activity dates into native Actions cron; select only due editions.

Normal runs read a small checked-in calendar without network access or polling.
Calendar preparation may read hash-verified public Arena projections; it never
updates remote workflow files, publishes content, or writes private state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
from datetime import datetime, timezone

from tools.r2_schedule import UTC_HOURS

FIXED_CRON = '0 ' + ','.join(map(str, UTC_HOURS)) + ' * * *'
MAX_BYTES = 16 * 1024 * 1024
MAX_ACTIVITY_CRONS = 16
MAX_START_DELAY = 6 * 3600
ROOT = Path(__file__).resolve().parents[1]
CALENDAR = ROOT / 'config/arena-sync-schedule.json'
WORKFLOW = ROOT / '.github/workflows/content-r2.yml'
BEGIN = '    # arena-activity-schedule:start'
END = '    # arena-activity-schedule:end'


def timestamp(value):
    if not isinstance(value, str) or not re.search(r'(?:Z|[+-]\d{2}:\d{2})$', value):
        raise ValueError('absolute activity time required')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def at_minute(point):
    # Cron has minute precision: never run before the source boundary.
    return math.ceil(point / 60) * 60


def activity_cron(point):
    value = datetime.fromtimestamp(point, timezone.utc)
    return f'{value.minute} {value.hour} {value.day} {value.month} *'


def fixed_slot(point):
    value = datetime.fromtimestamp(point, timezone.utc)
    return value.minute == 0 and value.hour in UTC_HOURS


def activity_boundaries(arena):
    if not arena or not arena.get('capabilities', {}).get('conditions'):
        return set()
    result = set()
    for row in arena.get('activityPeriods', []):
        start, end = timestamp(row['validFrom']), timestamp(row['validUntil'])
        if start >= end:
            raise ValueError('invalid activity interval')
        result.update((at_minute(start), at_minute(end)))
    return result


def checked_object(bucket, name, sha=None):
    value = bucket.get(name)
    if value is None or len(value[0]) > MAX_BYTES:
        raise ValueError('sync input missing or oversized')
    if sha is not None and hashlib.sha256(value[0]).hexdigest() != sha:
        raise ValueError('sync input digest mismatch')
    return json.loads(value[0])


def published_arena(bucket, region):
    from tools.r2_content import pointer_key
    from tools.arena_content import validate_arena_publication
    pointer = checked_object(bucket, pointer_key(region))
    path = pointer.get('manifest', '')
    if (pointer.get('schemaVersion') != 1 or not re.fullmatch(r'/content/releases/[a-f0-9]{24}/manifest.json', path)
            or not re.fullmatch(r'[a-f0-9]{64}', pointer.get('sha256', ''))):
        raise ValueError('invalid sync pointer')
    manifest = checked_object(bucket, path.lstrip('/'), pointer['sha256'])
    root = path.removesuffix('manifest.json')
    if (manifest.get('region') != region or manifest.get('channel') != 'production'
            or manifest.get('root') != root or manifest.get('schemaVersion') != 1):
        raise ValueError('sync edition mismatch')
    files = manifest['locales']['zh-CN']['files']
    entry = files.get('projection/arena.json')
    if entry is None:
        return None
    relative = entry.get('path', '')
    if (not re.fullmatch(r'zh-CN/[A-Za-z0-9_./-]+', relative) or '..' in relative.split('/')
            or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))):
        raise ValueError('invalid sync artifact')
    arena = checked_object(bucket, (root + relative).lstrip('/'), entry['sha256'])
    validate_arena_publication(arena, manifest['contentReleaseId'], region)
    return arena


def validate_calendar(calendar):
    if not isinstance(calendar, dict) or set(calendar) != {'schemaVersion', 'activityChecks'} or calendar['schemaVersion'] != 1:
        raise ValueError('invalid activity calendar')
    rows = calendar['activityChecks']
    if not isinstance(rows, list):
        raise ValueError('invalid activity checks')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'at', 'regions'}:
            raise ValueError('invalid activity check')
        point = timestamp(row['at'])
        regions = row['regions']
        if (point % 60 or point in seen or fixed_slot(point) or not isinstance(regions, list) or not regions
                or any(r not in ('global', 'jp') for r in regions) or len(set(regions)) != len(regions)):
            raise ValueError('invalid or duplicate activity check')
        seen.add(point)
    if len({activity_cron(p) for p in seen}) > MAX_ACTIVITY_CRONS:
        raise ValueError('too many activity dates; shorten the explicit calendar horizon')
    return calendar


def compile_calendar(projections, after, until):
    after, until = timestamp(after), timestamp(until)
    if not after < until:
        raise ValueError('invalid activity calendar horizon')
    points = {}
    for region, arena in projections.items():
        if region not in ('global', 'jp') or not arena or arena.get('region') != region or not arena.get('capabilities', {}).get('conditions'):
            raise ValueError('activity calendar edition mismatch')
        for point in activity_boundaries(arena):
            if after <= point < until and not fixed_slot(point):
                points.setdefault(point, set()).add(region)
    return validate_calendar({'schemaVersion': 1, 'activityChecks': [
        {'at': datetime.fromtimestamp(p, timezone.utc).isoformat().replace('+00:00','Z'), 'regions': sorted(points[p])}
        for p in sorted(points)]})


def scheduled_crons(calendar):
    validate_calendar(calendar)
    return sorted({activity_cron(timestamp(row['at'])) for row in calendar['activityChecks']})


def render_workflow(source, calendar):
    if source.count(BEGIN) != 1 or source.count(END) != 1:
        raise ValueError('activity schedule markers missing or duplicated')
    before, rest = source.split(BEGIN)
    _, after = rest.split(END)
    lines = [f"    - cron: '{cron}'" for cron in scheduled_crons(calendar)]
    if not lines:
        lines = ['    # No verified activity dates are currently registered.']
    return before + BEGIN + '\n' + '\n'.join(lines) + '\n' + END + after


def select_regions(regions, *, event, cron='', requested=None, calendar=None, now=None):
    if any(r not in ('global', 'jp') for r in regions):
        raise ValueError('invalid sync edition')
    if event == 'workflow_dispatch':
        return [requested] if requested in regions else []
    if event != 'schedule':
        raise ValueError('invalid sync event')
    if cron == FIXED_CRON:
        return list(regions)
    if calendar is None or cron not in scheduled_crons(calendar):
        raise ValueError('unregistered activity schedule')
    now = time.time() if now is None else now
    selected = set()
    for row in calendar['activityChecks']:
        point = timestamp(row['at'])
        # POSIX cron has no year. Match the absolute date and allow bounded
        # Actions queue delay; an obsolete calendar must never replay next year.
        if activity_cron(point) == cron and 0 <= now - point <= MAX_START_DELAY:
            selected.update(row['regions'])
    return [r for r in regions if r in selected]


class LocalStore:
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)

    def get(self, name):
        target = (self.root / name.removeprefix('content/')).resolve()
        if self.root not in target.parents or not target.is_file():
            raise ValueError('activity source missing or unsafe')
        return target.read_bytes(), None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('select', 'calendar', 'check'), default='select')
    parser.add_argument('--store', type=Path, help='Verified local public content store; calendar preparation only')
    parser.add_argument('--region', action='append', choices=('global','jp'))
    parser.add_argument('--after', help='Absolute beginning of the reviewed calendar horizon')
    parser.add_argument('--until', help='Absolute exclusive end of the reviewed calendar horizon')
    parser.add_argument('--apply', action='store_true', help='Update local calendar and workflow for normal review; never push')
    args = parser.parse_args(argv)
    try:
        if args.action == 'calendar':
            if not args.after or not args.until:
                raise ValueError('explicit activity calendar horizon required')
            if args.store:
                bucket = LocalStore(args.store)
            else:
                from tools.r2_content import S3Bucket
                bucket = S3Bucket.from_environment()
            projections = {r: published_arena(bucket, r) for r in args.region or ('global','jp')}
            calendar = compile_calendar(projections, args.after, args.until)
            workflow = render_workflow(WORKFLOW.read_text(), calendar)
            if args.apply:
                CALENDAR.write_text(json.dumps(calendar, ensure_ascii=False, indent=2) + '\n')
                WORKFLOW.write_text(workflow)
            print(json.dumps(calendar, ensure_ascii=False))
            return
        calendar = validate_calendar(json.loads(CALENDAR.read_text()))
        if args.action == 'check':
            if render_workflow(WORKFLOW.read_text(), calendar) != WORKFLOW.read_text():
                raise ValueError('activity calendar and workflow differ')
            print('Validated native activity schedules')
            return
        regions = [r for r in ('global', 'jp') if os.environ.get('CONTENT_R2_ENABLED_' + r.upper()) == 'true']
        result = select_regions(regions, event=os.environ['GITHUB_EVENT_NAME'], cron=os.environ.get('SCHEDULE', ''),
                                requested=os.environ.get('INPUT_REGION'), calendar=calendar)
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('regions=' + json.dumps(result or ['global']) + '\n')
            output.write('run=' + str(bool(result)).lower() + '\n')
        print(json.dumps({'selectedEditions': result, 'status': 'selected' if result else 'not_due'}))
    except Exception as error:
        raise SystemExit('Arena sync selection failed: ' + type(error).__name__)


if __name__ == '__main__':
    main()
