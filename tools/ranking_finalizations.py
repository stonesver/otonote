"""Remember verified public plans so event turnover cannot lose a final read."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from tools.global_game_config import GLOBAL_SERVERS
from tools.import_player_rankings import ensure_final_archive_metadata

PLAN_KEYS = ('eventId', 'eventName', 'eventStartAt', 'eventEndAt', 'boards', 'ttl',
             'contentReleaseId', 'eventProjectionSha256', 'contentMasterVersion',
             'uncollectedBoards', 'masterHashes')


def checked_plan(plan, server):
    if (not isinstance(plan, dict) or server not in GLOBAL_SERVERS
            or plan.get('serverId', server) != server
            or not isinstance(plan.get('eventId'), str)
            or not re.fullmatch('[1-9][0-9]{0,9}', plan['eventId'])
            or not isinstance(plan.get('eventName'), str) or not 1 <= len(plan['eventName']) <= 500
            or type(plan.get('ttl')) is not int or not 60 <= plan['ttl'] <= 3600):
        raise ValueError('invalid_remembered_ranking_plan')
    for field in ('eventStartAt', 'eventEndAt'):
        if not isinstance(plan.get(field), str) or len(plan[field]) > 64:
            raise ValueError('invalid_remembered_ranking_plan')
        stamp = datetime.fromisoformat(plan[field].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('invalid_remembered_ranking_plan')
    if datetime.fromisoformat(plan['eventEndAt']) < datetime.fromisoformat(plan['eventStartAt']):
        raise ValueError('invalid_remembered_ranking_plan')
    boards = plan.get('boards')
    if not isinstance(boards, list) or not 1 <= len(boards) <= 20:
        raise ValueError('invalid_remembered_ranking_plan')
    for board in boards:
        if not isinstance(board, dict) or board.get('type') not in ('music', 'event-points', 'total-music') or 'entries' in board:
            raise ValueError('invalid_remembered_ranking_plan')
        if board['type'] == 'music' and (type(board.get('challengeMusicId')) is not int
                or not 1 <= board['challengeMusicId'] <= (1 << 31) - 1
                or not isinstance(board.get('musicId'), str) or not re.fullmatch('[0-9]+', board['musicId'])):
            raise ValueError('invalid_remembered_ranking_plan')
    value = {key: plan[key] for key in PLAN_KEYS if key in plan} | {'serverId': server}
    value['boards'] = [{key: board[key] for key in ('type', 'musicId', 'musicName', 'challengeMusicId')
                        if key in board} for board in boards]
    return value


def remember_plan(state, plan, server):
    if not plan or not plan.get('eventEndAt'):
        return
    value = checked_plan(plan, server)
    Path(state).mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = Path(state) / 'event-plans'
    folder.mkdir(mode=0o700, exist_ok=True)
    target = folder / ('event-' + value['eventId'] + '.json')
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if target.exists() and target.read_text() == raw:
        return
    temporary = target.with_suffix('.tmp')
    with temporary.open('w') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(raw); output.flush(); os.fsync(output.fileno())
    temporary.replace(target)


def pending_plan(state, root, server, *, now=None):
    current = now or datetime.now(timezone.utc)
    folder = Path(state) / 'event-plans'
    paths = sorted(folder.glob('event-*.json'))
    if len(paths) > 1000:
        raise ValueError('too_many_remembered_ranking_plans')
    candidates = []
    for path in paths:
        if path.is_symlink() or path.stat().st_size > 65536:
            raise ValueError('invalid_remembered_ranking_plan')
        plan = checked_plan(json.loads(path.read_text()), server)
        end = datetime.fromisoformat(plan['eventEndAt'])
        if end < current and not ensure_final_archive_metadata(Path(root), server, plan['eventId']):
            candidates.append((end, plan))
    return min(candidates, key=lambda item: item[0])[1] if candidates else None
