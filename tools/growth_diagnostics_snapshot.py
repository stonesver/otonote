"""Export bounded, credential-free growth diagnostics for the private dashboard."""
import argparse
import json
import os
import re
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

REQUEST_ID = re.compile(r'[a-f0-9]{32}\Z')
SERVICE_ERROR = re.compile(r'(?:sdk_service_-?[0-9]{1,10}|sdk_http_[0-9]{3})\Z')
GRPC_CODES = frozenset({'cancelled', 'unknown', 'invalid_argument', 'deadline_exceeded',
                        'not_found', 'already_exists', 'permission_denied',
                        'resource_exhausted', 'failed_precondition', 'aborted',
                        'out_of_range', 'unimplemented', 'internal', 'unavailable',
                        'data_loss', 'unauthenticated'})
ERROR_CODES = frozenset({
    'origin_refused', 'not_found', 'invalid_request', 'request_too_large',
    'busy', 'rate_limited', 'upstream_unavailable', 'invalid_sdk_profile',
    'unsupported_sdk_profile', 'invalid_auth_response',
    'sdk_parameter_override_refused', 'sdk_operation_refused',
    'sdk_response_too_large', 'sdk_network_or_tls_error',
    'invalid_sdk_response', 'invalid_account_input', 'invalid_password_input',
    'invalid_rsa_key', 'sdk_rsa_encryption_failed', 'invalid_game_text',
    'game_target_refused', 'game_authentication_failed',
    'unexpected_game_server', 'tw_server_not_unique',
    'no_existing_role_in_selected_server', 'unexpected_new_role_response',
    'response_too_large', 'truncated_varint', 'varint_overflow',
    'too_many_fields', 'invalid_field_number', 'truncated_field',
    'unsupported_wire_type', 'ambiguous_or_invalid_growth_field',
    'growth_integer_out_of_range', 'missing_public_master_id',
    'expected_one_uncompressed_grpc_frame', 'invalid_player_data',
    'expected_exactly_one_player_data', 'invalid_growth_message',
    'too_many_growth_records', 'duplicate_tgw_message',
    'duplicate_public_master_id', 'invalid_history_field',
    'missing_history_prize_id', 'invalid_history_collection',
    'too_many_history_records', 'unsupported_history_response',
    'missing_history_pool_id', 'invalid_history_prize', 'empty_history_batch',
    'invalid_game_response_field', 'other',
})
TIMESTAMP = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)\Z')
STAGES = frozenset({'request', 'discovering', 'sdk_login', 'checking_existing_account',
                    'game_login', 'reading_growth', 'reading_gacha_history', 'other'})
REASONS = frozenset({'credentials_rejected', 'account_not_found',
                     'verification_required', 'rate_limited', 'unclassified'})
ROUTES = frozenset({'growth', 'gacha_history'})


def parse_time(value):
    if not isinstance(value, str) or not TIMESTAMP.fullmatch(value):
        return None
    try:
        naive = datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')
        if value.endswith('Z'):
            offset = timedelta()
        else:
            match = re.search(r'([+-])(\d\d):?(\d\d)\Z', value)
            minutes = int(match.group(2)) * 60 + int(match.group(3))
            if minutes >= 24 * 60:
                return None
            offset = timedelta(minutes=minutes * (1 if match.group(1) == '+' else -1))
        return (naive - offset).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def bounded_json_lines(text, start, end):
    for line in text.splitlines():
        if len(line) > 2048:
            continue
        try:
            row = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(row, dict):
            timestamp = parse_time(row.get('time'))
            if timestamp and start <= timestamp <= end:
                yield row, timestamp


def build_snapshot(access_text, gateway_text, *, now=None):
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(hours=24)
    gateway = {}
    for row, _ in bounded_json_lines(gateway_text, start, now):
        request_id = row.get('requestId')
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            continue
        if row.get('event') != 'finish':
            continue
        stage = row.get('stage')
        error = row.get('error')
        reason = row.get('reason')
        route = row.get('route')
        gateway[request_id] = {
            'route': route if isinstance(route, str) and route in ROUTES else 'unknown',
            'stage': stage if isinstance(stage, str) and stage in STAGES else 'other',
            'error': (error if isinstance(error, str) and
                      (error in ERROR_CODES or SERVICE_ERROR.fullmatch(error) or
                       (error.startswith('game_rpc_') and error[9:] in GRPC_CODES)) else None),
            'reason': reason if isinstance(reason, str) and reason in REASONS else None,
        }
    counts = Counter()
    errors = Counter()
    recent = []
    first = None
    last = None
    for row, timestamp in bounded_json_lines(access_text, start, now):
        if row.get('method') != 'POST' or row.get('route') != 'growth_export':
            continue
        request_id = row.get('requestId')
        status = row.get('status')
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id) or type(status) is not int or not 100 <= status <= 599:
            continue
        first = min(first, timestamp) if first else timestamp
        last = max(last, timestamp) if last else timestamp
        counts[str(status)] += 1
        if status < 400:
            continue
        detail = gateway.get(request_id, {})
        error = detail.get('error')
        if error:
            errors[error] += 1
        recent.append({'time': timestamp.isoformat(timespec='seconds'), 'requestId': request_id,
                       'status': status, 'route': detail.get('route', 'unknown'),
                       'stage': detail.get('stage', 'no_gateway_finish'),
                       'error': error, 'reason': detail.get('reason')})
    recent.sort(key=lambda row: row['time'], reverse=True)
    return {'schemaVersion': 1, 'generatedAt': now.isoformat(timespec='seconds'),
            'windowStart': start.isoformat(timespec='seconds'),
            'firstRequest': first.isoformat(timespec='seconds') if first else None,
            'lastRequest': last.isoformat(timespec='seconds') if last else None,
            'requests': sum(counts.values()), 'statusCounts': dict(counts),
            'errorCounts': dict(errors.most_common(12)), 'recentFailures': recent[:50]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-log', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--container', default='ournotes-growth')
    args = parser.parse_args()
    access_parts = []
    for path in (Path(args.access_log + '.1'), Path(args.access_log)):
        if path.exists():
            with path.open('rb') as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell() - 8 * 1024 * 1024))
                access_parts.append(stream.read().decode('utf-8', errors='replace'))
    access = '\n'.join(access_parts)
    result = subprocess.run(['docker', 'logs', '--since', '24h', args.container],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=20, check=True)
    gateway = result.stdout[-4 * 1024 * 1024:].decode('utf-8', errors='replace')
    snapshot = build_snapshot(access, gateway)
    destination = Path(args.output)
    fd, temporary = tempfile.mkstemp(prefix='.growth-', dir=str(destination.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(snapshot, stream, ensure_ascii=False, separators=(',', ':'))
            stream.write('\n')
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    main()
