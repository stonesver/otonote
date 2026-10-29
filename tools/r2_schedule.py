"""Shared content schedule for both editions; workflow/timer parity is tested."""

UTC_HOURS = (6, 11, 19)  # Beijing 14:00, 19:00, next-day 03:00.
GRACE_SECONDS = 3600  # Allow Actions scheduling delay before raising an alert.


def last_due_slot(now):
    """Latest daily slot whose scheduling grace has elapsed, as a Unix timestamp."""
    cutoff = now - GRACE_SECONDS
    day = cutoff - cutoff % 86400
    slots = [day + hour * 3600 for hour in UTC_HOURS]
    return max([slot for slot in slots if slot <= cutoff] or [slots[-1] - 86400])
