"""Read-only, aggregate-only Arena population estimates. Never starts a game read."""
from __future__ import annotations
import json
import re
from pathlib import Path
from datetime import datetime, timezone
from backend.arena_rankings import scope, number, absolute


def population_path(root,server,season,band):
    scope(server,season,band)
    return Path(root)/server/'arena'/('season-'+season)/('population-band-'+band+'.json')


def validate_population(value,server,season,band):
    scope(server,season,band)
    if (not isinstance(value,dict) or type(value.get('schemaVersion')) is not int or value.get('schemaVersion') not in (1,2)
            or any(value.get(k)!=v for k,v in [('serverId',server),('seasonId',season),('bandId',band)])
            or value.get('method')!='rank_boundary_probe' or value.get('accuracy')!='estimate'):
        raise ValueError('invalid_arena_population_identity')
    start,end,expiry=[absolute(value.get(k)) for k in ('startedAt','observedAt','expiresAt')]
    if not 0 <= (end-start).total_seconds() <= 210 or not 0 < (expiry-end).total_seconds() <= 21600:
        raise ValueError('invalid_arena_population_time')
    if (not isinstance(value.get('sourceReleaseId'),str) or not value['sourceReleaseId']
            or not re.fullmatch(r'[a-f0-9]{32}',str(value.get('masterVersion','')))):
        raise ValueError('invalid_arena_population_source')
    total=number(value.get('totalEstimate'));reads=number(value.get('sampleReads'),1,96)
    rows=value.get('tiers')
    if not isinstance(rows,list) or not 1 <= len(rows) <= 7:
        raise ValueError('invalid_arena_population_tiers')
    version=value['schemaVersion'];extra={}
    if version==2:
        low=number(value.get('totalLower'));high=number(value.get('totalUpper'))
        if value.get('rangeMethod')!='observed_window_envelope' or not low<=total<=high or reads>48:
            raise ValueError('invalid_arena_population_range')
        extra=dict(totalLower=low,totalUpper=high,rangeMethod=value['rangeMethod'])
    checked=[];seen=set();previous=-1
    for row in rows:
        if not isinstance(row,dict):raise ValueError('invalid_arena_population_tiers')
        tier=number(row.get('tier'),1,7);threshold=number(row.get('threshold'));count=number(row.get('count'))
        if tier in seen or threshold<=previous:raise ValueError('invalid_arena_population_order')
        item=dict(tier=tier,threshold=threshold,count=count)
        if version==2:
            lower=number(row.get('lower'));upper=number(row.get('upper'))
            if not lower<=count<=upper<=high:raise ValueError('invalid_arena_population_range')
            item.update(lower=lower,upper=upper)
        seen.add(tier);previous=threshold;checked.append(item)
    if checked[0]['threshold']!=0 or sum(r['count'] for r in checked)!=total:
        raise ValueError('invalid_arena_population_counts')
    return dict(schemaVersion=version,serverId=server,seasonId=season,bandId=band,
                method='rank_boundary_probe',accuracy='estimate',sourceReleaseId=value['sourceReleaseId'],
                masterVersion=value['masterVersion'],startedAt=value['startedAt'],observedAt=value['observedAt'],
                expiresAt=value['expiresAt'],totalEstimate=total,sampleReads=reads,tiers=checked,**extra)


def query_population(root,*,server,season,band,now=None):
    target=population_path(root,server,season,band)
    if not target.exists():return dict(schemaVersion=1,serverId=server,seasonId=season,bandId=band,status='unavailable',observation=None)
    if target.stat().st_size>16384:raise ValueError('arena_population_too_large')
    value=validate_population(json.loads(target.read_text()),server,season,band)
    now=now or datetime.now(timezone.utc)
    return dict(schemaVersion=1,serverId=server,seasonId=season,bandId=band,
                status='stale' if absolute(value['expiresAt'])<=now else 'available',observation=value)
