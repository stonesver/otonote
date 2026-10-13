"""Summarize bounded public fields even when a failed step left empty JSON."""
import argparse
import json
import math
from pathlib import Path


FILES = (
    ('light-prepare.json', 'Light preparation'),
    ('light-probe.json', 'Light source probe'),
    ('light-check.json', 'Light unchanged gate'),
    ('gate-probe.json', 'Full source probe'),
    ('gate-check.json', 'Verified unchanged gate'),
    ('state-restore.json', 'Private state restore'),
    ('state-after.json', 'Private state checkpoint'),
    ('promotion.json', 'Public promotion'),
    ('jp-retention.json', 'JP working set'),
)
STATUSES = {'ready', 'needs_full', 'needs_production', 'probed', 'blocked', 'unchanged', 'checkpointed', 'promoted', 'published', 'pruned',
            'failed', 'skipped', 'uploaded', 'verified', 'complete', 'restored'}
# Never copy arbitrary upstream reason strings into a public Actions summary.
REASONS = frozenset({
    'private_state_missing', 'private_pointer_changed', 'producer_state_not_seeded',
    'receipt_missing_or_legacy', 'image_changed', 'private_inputs_changed',
    'source_changed', 'configuration_changed', 'package_identity_unavailable',
    'verified_client_inventory_missing', 'client_version_unknown',
    'trusted_jp_paths_changed', 'jp_state_unmatched', 'publication_unmatched',
    'client_update_required', 'package_changed', 'resource_version_changed',
    'public_pointer_unmatched', 'pointer_changed', 'state_missing', 'state_unknown',
    'receipt_missing_or_changed', 'input_changed', 'plan_unverified',
    'state_unfinished', 'publication_changed', 'public_pointer_changed',
    'probe_failed', 'gate_failed',
})


METRIC_FIELDS = {
    'state-restore.json': ('restoreMetrics',
        ('workers', 'downloadedObjects', 'downloadedBytes', 'logicalBytes', 'hardlinkedFiles', 'copiedFiles', 'peakResidentBytes'),
        ('prepareSeconds', 'stageSeconds', 'downloadVerifySeconds', 'materializeSeconds', 'publishProofSeconds', 'totalSeconds')),
    'state-after.json': ('checkpointMetrics',
        ('workers', 'uniqueObjects', 'uniqueBytes', 'logicalBytes', 'verifiedReuseObjects',
         'objectVerifyCalls', 'objectPutCalls', 'uploadedBytes', 'peakResidentBytes',
         'inventoryHashCalls', 'inventoryHashBytes', 'sourceVerifyHashCalls', 'sourceVerifyHashBytes'),
        ('prepareSeconds', 'inventorySeconds', 'reuseLookupSeconds', 'transferVerifySeconds',
         'sourceVerifySeconds', 'commitSeconds', 'totalSeconds')),
}

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
        reason = value.get('reason')
        if isinstance(reason, str) and reason in REASONS:
            lines.append(f'Reason: `{reason}`.')
        for key in ('verifiedReuse', 'uploaded', 'manifestBytes', 'manifestLimitBytes', 'excludedGlobalRuns', 'removedRuns'):
            if type(value.get(key)) is int and value[key] >= 0:
                lines.append(f'{key}: `{value[key]}`.')
        if value.get('manifestBudgetWarning') is True:
            lines.append('Warning: private state manifest has reached 80% of its budget.')
        metric_name, count_keys, time_keys = METRIC_FIELDS.get(name, ('', (), ()))
        metrics = value.get(metric_name)
        if isinstance(metrics, dict):
            for key in count_keys:
                number = metrics.get(key)
                if type(number) is int and 0 <= number <= 2**63 - 1:
                    lines.append(f'{key}: `{number}`.')
            for key in time_keys:
                number = metrics.get(key)
                if type(number) in (int, float) and 0 <= number <= 604800 and math.isfinite(number):
                    lines.append(f'{key}: `{number:.3f}`.')
    return '\n\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--job-status', required=True)
    args = parser.parse_args()
    print(summarize(args.directory, args.job_status), end='')


if __name__ == '__main__':
    main()
