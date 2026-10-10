"""Summarize bounded public fields even when a failed step left empty JSON."""
import argparse
import json
from pathlib import Path


FILES = (
    ('light-check.json', 'Light unchanged gate'),
    ('light-prepare.json', 'Light preparation'),
    ('gate-check.json', 'Verified unchanged gate'),
    ('state-after.json', 'Private state checkpoint'),
    ('promotion.json', 'Public promotion'),
    ('jp-retention.json', 'JP working set'),
)
STATUSES = {'ready', 'needs_full', 'unchanged', 'checkpointed', 'promoted', 'pruned',
            'failed', 'skipped', 'uploaded', 'verified', 'complete'}


def summarize(directory: Path, job_status: str) -> str:
    status = job_status if job_status in {'success', 'failure', 'cancelled', 'skipped'} else 'unknown'
    lines = [f'Workflow result: `{status}`. The Actions run is the last-attempt record.']
    for name, label in FILES:
        path = directory/name
        if not path.exists():
            continue
        try:
            if path.stat().st_size > 1024 * 1024:
                raise ValueError('oversized result')
            value = json.loads(path.read_bytes())
            if not isinstance(value, dict):
                raise ValueError('invalid result')
        except (OSError, ValueError):
            lines.append(f'{label}: `result unavailable`; consult the failing step log.')
            continue
        stage_status = value.get('status')
        lines.append(f'{label}: `{stage_status if isinstance(stage_status, str) and stage_status in STATUSES else "unknown"}`.')
        for key in ('verifiedReuse', 'uploaded', 'manifestBytes', 'manifestLimitBytes', 'excludedGlobalRuns', 'removedRuns'):
            if type(value.get(key)) is int and value[key] >= 0:
                lines.append(f'{key}: `{value[key]}`.')
        if value.get('manifestBudgetWarning') is True:
            lines.append('Warning: private state manifest has reached 80% of its budget.')
    return '\n\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--job-status', required=True)
    args = parser.parse_args()
    print(summarize(args.directory, args.job_status), end='')


if __name__ == '__main__':
    main()
