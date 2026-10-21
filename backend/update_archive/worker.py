"""One admitted archive run; no scheduling or producer mutation."""
from __future__ import annotations
from pathlib import Path
import tempfile
import time
import uuid

from .diff import compare, inventory
from .models import ArchiveError, Conflict, WINDOW, file_record, identity, region
from .policy import TRANSFER_LIMIT, decisions
from .store import file_digest


def observe(repo, snapshot, *, now, mode):
    selected = region(snapshot['region'])
    rows = [file_record(r) for r in snapshot['files']]
    inventory(rows)
    sources = snapshot.get('sources', sorted({r['source'] for r in rows}))
    if not sources or not set(sources) <= {'remote_asset', 'master', 'client_entry'}:
        raise ArchiveError('invalid_source_inventory')
    observation = snapshot.get('observation', {})
    safe_observation = {k: observation[k] for k in ('clientVersion', 'resourceVersion', 'masterVersion',
                        'catalogHash', 'catalogSha256', 'masterManifestSha256', 'clientNotice', 'cdnRoot') if k in observation}
    def commit(s):
        made = []
        for source in sources:
            current = sorted((r for r in rows if r['source'] == source), key=lambda r: r['key'])
            baseline_key = selected + ':' + source
            old = s['baselines'].get(baseline_key)
            source_id = identity({'region': selected, 'source': source, 'files': current,
                                  'observation': safe_observation})
            if old and old['id'] == source_id:
                continue
            s['baselines'][baseline_key] = {'id': source_id, 'files': current,
                                          'observation': safe_observation, 'observedAt': now}
            if old is None:
                continue  # Bootstrap is a baseline, never an unsolicited full download.
            changes = compare(current, old['files'])
            if not changes:
                continue
            batch_id = identity([selected, source, old['id'], source_id])
            if batch_id in s['batches']:
                continue
            states = decisions(changes, mode=mode,
                old_client=old['observation'].get('clientVersion'),
                new_client=safe_observation.get('clientVersion'),
                hard_limit=snapshot.get('fileLimit', 256 * 1024 ** 2))
            ids = []
            for row in changes:
                eid = identity([batch_id, row['source'], row['key']])
                s['entries'].setdefault(eid, {'id': eid, 'region': selected, 'batch': batch_id,
                    'source': source, 'key': row['key'], 'file': row, 'change': row['change'],
                    'size': row['size'], 'observedAt': now, 'expiresAt': now + WINDOW,
                    'status': states[(source, row['key'])], 'objects': [], 'attempts': 0})
                ids.append(eid)
            group = next((g['id'] for g in s['groups'].values() if g['region'] == selected and g.get('active')), None)
            s['batches'][batch_id] = {'id': batch_id, 'region': selected, 'source': source,
                'sourceId': source_id, 'previousSourceId': old['id'], 'observedAt': now,
                'observation': safe_observation, 'entries': ids, 'group': group}
            made.append(batch_id)
        return made
    return repo.mutate(commit)


def run_once(repo, source, *, clock=time.time, max_bytes=TRANSFER_LIMIT, max_seconds=1200,
             previewer=None, mode=None, previews_only=False):
    selected, started, owner = region(source.region), clock(), uuid.uuid4().hex
    if not 0 < max_bytes <= TRANSFER_LIMIT or not 0 < max_seconds <= 1200:
        raise ArchiveError('invalid_run_budget')
    result = {'region': selected, 'status': 'unchanged', 'saved': 0, 'downloadedBytes': 0,
              'startedAt': started, 'failed': 0, 'batches': [], 'budgetBytes': 0}
    def claim(s):
        runs = s.setdefault('runs', {})
        old = runs.get(selected)
        if old and old['until'] > started:
            raise Conflict('archive_region_busy')
        runs[selected] = {'owner': owner, 'until': started + max_seconds}
    repo.mutate(claim)
    try:
        from .requests import process_cleanups, approved_entries, finish_requests, charge_request
        if previews_only:
            source.prepare()
            state, _ = repo.state()
            selected_mode = mode or state['modes'].get(selected, 'auto')
            result['kind'] = 'previews'
        else:
            maintenance_deadline = time.monotonic() + 30
            for maintain in (process_cleanups, repo.expire, repo.recover):
                try:
                    if maintain is process_cleanups:
                        maintain(repo, now=clock(), deadline=maintenance_deadline)
                    else:
                        maintain(now=clock(), deadline=maintenance_deadline)
                except (ArchiveError, OSError):
                    result.setdefault('maintenanceErrors', []).append('cleanup_pending')
            state, _ = repo.state()
            selected_mode = mode or state['modes'].get(selected, 'auto')
            snapshot = source.snapshot(previous={k: v for k, v in state['baselines'].items()
                                                 if k.startswith(selected + ':')})
            if snapshot['region'] != selected:
                raise ArchiveError('snapshot_region_mismatch')
            result['batches'] = observe(repo, snapshot, now=clock(), mode=selected_mode)
        result['downloadedBytes'] = getattr(source, 'received_bytes', 0)
        result['budgetBytes'] = result['downloadedBytes'] + getattr(source, 'control_allowance', 0)
        if selected_mode != 'record':
            if not previews_only:
                approvals = approved_entries(repo, selected, now=clock())
                entries = repo.entries(selected, now=clock())
                new_batch_ids = set(result['batches'])
                fresh = [e for e in entries if e.get('batch') in new_batch_ids]
                older = [e for e in entries if e.get('batch') not in new_batch_ids]
                # Fresh content has first access, history has a separate bounded turn.
                groups = (fresh, sorted(older, key=lambda e: (e['observedAt'], e['id'])))
                for group_index, candidates in enumerate(groups):
                    group_start, group_bytes = clock(), 0
                    allowance = max_bytes if not groups[1 - group_index] else max_bytes // 2
                    for e in candidates:
                        now = clock()
                        current_state, _ = repo.state()
                        current_mode = mode or current_state['modes'].get(selected, 'auto')
                        if current_mode == 'record':
                            break
                        approvals = approved_entries(repo, selected, now=now)
                        approved = e['id'] in approvals
                        if (e['expiresAt'] <= now or e['status'] in ('saved', 'removed', 'metadata_only', 'expired')
                                or e['status'] in ('evicted_fifo', 'cleaned_manual') and not approved):
                            continue
                        if not approved and (current_mode != 'auto' or e['status'] == 'waiting_manual'
                                             or e.get('attempts', 0) >= 3):
                            continue
                        row = e.get('file')
                        if not row:
                            continue
                        estimate = row['size'] * 2
                        if (result['budgetBytes'] + estimate > max_bytes
                                or group_bytes + estimate > allowance
                                or now - started >= max_seconds - 180
                                or now - group_start >= min(420, max_seconds / 2)):
                            continue
                        try:
                            # Recheck a cancelled request/cleanup at each file boundary.
                            current = repo.entry(e['id'], now=now)
                            if current['status'] in ('evicted_fifo', 'cleaned_manual') and not approved:
                                continue
                            if approved:
                                charge_request(repo, approvals[e['id']], estimate)
                            result['budgetBytes'] += estimate
                            group_bytes += estimate
                            with tempfile.TemporaryDirectory(prefix='otonote-archive-') as temp:
                                target = Path(temp) / 'raw'
                                for attempt in range(2):
                                    try:
                                        receipt = source.fetch(row, target)
                                        break
                                    except (OSError, RuntimeError) as transient:
                                        # Protocol/auth refusals are ValueError and never retried here.
                                        if (attempt or type(transient).__name__ not in ('TransportError', 'OSError', 'TimeoutError', 'ConnectionError')
                                                or result['budgetBytes'] + estimate > max_bytes
                                                or group_bytes + estimate > allowance
                                                or clock() - started >= max_seconds - 180):
                                            raise
                                        if approved:
                                            charge_request(repo, approvals[e['id']], estimate)
                                        result['budgetBytes'] += estimate; group_bytes += estimate
                                        target.unlink(missing_ok=True)
                                        target.with_name('raw.receipt.json').unlink(missing_ok=True)
                                if isinstance(receipt, dict) and receipt.get('etag'):
                                    repo.mutate(lambda s: s['entries'][e['id']].update(upstreamEtag=receipt['etag']))
                                actual = target.stat().st_size
                                result['downloadedBytes'] += actual
                                if actual != row['size']:
                                    raise ArchiveError('source_size_mismatch')
                                if row.get('sha256') and file_digest(target) != row['sha256']:
                                    raise ArchiveError('source_digest_mismatch')
                                repo.save(e['id'], target, now=clock(), restore=approved)
                                result['downloadedBytes'] += actual  # upload readback
                                result['saved'] += 1
                        except (ValueError, OSError, RuntimeError) as error:
                            code = str(error) if isinstance(error, ArchiveError) else 'source_or_archive_io_failed'
                            def failed(s):
                                entry = s['entries'][e['id']]
                                if entry['status'] not in ('evicted_fifo', 'cleaned_manual', 'expired'):
                                    entry.update(status='deferred_auto' if any(word in code for word in ('capacity', 'busy', 'budget', 'cancelled', 'entry_changed')) else 'failed',
                                                 error=code)
                                    if entry['status'] == 'failed':
                                        entry['attempts'] += 1
                            repo.mutate(failed)
                            result['failed'] += 1
                finish_requests(repo, selected, now=clock())
            if previewer:
                preview_started = clock()
                preview_bytes = 0
                for e in repo.entries(selected, now=clock()):
                    if clock() - started >= max_seconds - 95 or clock() - preview_started >= min(360, max_seconds / 2) or preview_bytes >= 64 * 1024 ** 2:
                        break
                    if e['status'] == 'saved' and (e.get('previewStatus') in (None, 'deferred') or e.get('previewVersion', 0) < 2):
                        allowance = min(16 * 1024 ** 2, 64 * 1024 ** 2 - preview_bytes)
                        # Original read + output verification + bounded decoder context readback.
                        context = getattr(source, 'context', {})
                        preview_state, _ = repo.state()
                        material = context.get('metadata')
                        context_cost = 64 * 1024 ** 2 if e.get('decoderContext') else 0
                        if material and Path(material).is_file():
                            sha = file_digest(Path(material))
                            version = preview_state['batches'].get(e.get('batch'), {}).get('observation', {}).get('clientVersion')
                            if version == context.get('clientVersion'):
                                known = any(o['sha256'] == sha and o['status'] == 'live' for o in preview_state['objects'].values())
                                context_cost = 0 if known else 2 * Path(material).stat().st_size
                        control_cost = max(16 * 1024 ** 2, 6 * getattr(repo, 'control_bytes', 0))
                        cost = e['size'] + 2 * allowance + context_cost + control_cost
                        if result['budgetBytes'] + cost > max_bytes:
                            continue
                        result['budgetBytes'] += cost
                        previewer(repo, e, clock=clock, max_output_bytes=allowance)
                        current = repo.entry(e['id'], now=clock())
                        if current.get('previewStatus') == 'ready':
                            result['previewed'] = result.get('previewed', 0) + 1
                        preview_bytes += sum(p['size'] for k,p in current.get('previews', {}).items() if k.startswith('preview_'))
        result['status'] = 'partial' if result['failed'] or result.get('maintenanceErrors') else 'archived' if result['saved'] else (
            'recorded' if result['batches'] else 'previews_updated' if result.get('previewed') else 'unchanged')
    except (ValueError, OSError, KeyError, RuntimeError) as error:
        client_required = type(error).__name__ in ('ClientUpdateRequired', 'JpClientUpdateRequired')
        result.update(status='waiting_client' if client_required else 'failed',
                      error='verified_client_material_required' if client_required else 'archive_run_failed')
    finally:
        result['finishedAt'] = clock()
        def release(s):
            if s.get('runs', {}).get(selected, {}).get('owner') == owner:
                s['runs'].pop(selected, None)
            s['checks'].append(result)
            s['checks'] = s['checks'][-180:]
        repo.mutate(release)
        repo.compact(now=clock())
    return result
