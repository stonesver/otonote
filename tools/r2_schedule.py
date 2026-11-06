"""Shared schedule for Actions and the lightweight Python 3.6+ trigger."""
import calendar as calendar_module
import datetime
import re

UTC_HOURS = (6, 11, 19)  # Beijing 14:00, 19:00, next-day 03:00.
GRACE_SECONDS = 3600  # Allow Actions scheduling delay before raising an alert.
EXTERNAL_GRACE_SECONDS = 600


def slot_time(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_slot(value):
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00)(Z|[+-]\d{2}:\d{2})', value)
    if match is None:
        raise ValueError('absolute minute required')
    point = calendar_module.timegm(datetime.datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%S').timetuple())
    zone = match[2]
    if zone != 'Z':
        hours, minutes = int(zone[1:3]), int(zone[4:6])
        if hours > 23 or minutes > 59:
            raise ValueError('invalid timezone')
        point -= (1 if zone[0] == '+' else -1) * (hours * 3600 + minutes * 60)
    return point


def activity_slots(calendar, region):
    if (not isinstance(calendar, dict) or calendar.get('schemaVersion') != 1
            or not isinstance(calendar.get('activityChecks'), list)):
        raise ValueError('invalid activity calendar')
    slots = []
    for row in calendar['activityChecks']:
        regions = row['regions']
        if not isinstance(regions, list) or not regions or any(r not in ('global', 'jp') for r in regions):
            raise ValueError('invalid activity edition')
        point = parse_slot(row['at'])
        if region in regions:
            slots.append(point)
    return slots


def due_slot(now, region, calendar=None):
    """Only the latest due check is dispatched, including after a restart."""
    day = now - now % 86400
    slots = [day + hour * 3600 for hour in UTC_HOURS] + [day - 86400 + UTC_HOURS[-1] * 3600]
    if calendar:
        slots.extend(activity_slots(calendar, region))
    return int(max(slot for slot in slots if slot <= now))


def last_due_slot(now, grace=GRACE_SECONDS, region='global', calendar=None):
    """Latest daily slot whose scheduling grace has elapsed, as a Unix timestamp."""
    return due_slot(now - grace, region, calendar)
