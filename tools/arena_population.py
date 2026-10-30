"""Bounded major-tier estimates from rank boundaries, without enumerating players."""
from __future__ import annotations
import json
import os
import re
import tempfile
import time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from backend.arena_rankings import RPC,number,absolute
from backend.arena_population import validate_population,population_path
from tools.collect_arena_rankings import ArenaRankingClient
from tools.growth_login import LoginError,integer,string,single
from tools.growth_export import fields
from tools.arena_content import arena_master_version


def population_plan(data,plan,now=None):
    now=now or datetime.now(timezone.utc)
    master=arena_master_version(data,plan['serverId'])
    if (not isinstance(master,str) or not re.fullmatch(r'[a-f0-9]{32}',master) or not data.get('capabilities',{}).get('ranks')):
        raise ValueError('arena_population_master_unverified')
    season=next(s for s in data['seasons'] if s['id']==plan['seasonId'])
    if not absolute(season['validFrom'])<=now<absolute(season['validUntil']):
        raise ValueError('arena_population_requires_current_season')
    groups={}
    for band in plan['bandIds']:
        if band not in data.get('completeRankBands',[]):raise ValueError('arena_population_thresholds_incomplete')
        rows=[r for r in data['ranks'] if r['bandId']==band]
        if not rows or any((not r.get('opensAt') and r.get('openingSourceText')!='') for r in rows):
            raise ValueError('arena_population_thresholds_unverified')
        rows=[r for r in rows if not r.get('opensAt') or absolute(r['opensAt'])<=now]
        thresholds={}
        for r in rows:
            tier=number(r['tier'],1,7);threshold=number(r['threshold'])
            thresholds[tier]=min(threshold,thresholds.get(tier,threshold))
        if any(sum(r['tier']==tier and r['division']==1 for r in rows)!=1 for tier in thresholds):
            raise ValueError('arena_population_thresholds_unverified')
        values=[dict(tier=k,threshold=v) for k,v in sorted(thresholds.items(),key=lambda r:r[1])]
        if not values or values[0]['threshold']!=0 or len({r['threshold'] for r in values})!=len(values):
            raise ValueError('arena_population_thresholds_unverified')
        groups[band]=values
    return dict(plan,populationThresholds=groups,masterVersion=master,populationValidUntil=season['validUntil'])


WINDOW_SIZE = 100
MAX_BAND_READS = 48
MAX_RUN_READS = 160


def decode_population_response(raw):
    """Discard player profiles/decks; only positions and scores enter the probe."""
    entries=[]
    for field,wire,value in fields(raw):
        if field!=1:continue
        if wire!=2 or len(entries)>=WINDOW_SIZE:
            raise LoginError('invalid_arena_population_response')
        entries.append(dict(rank=single(value,3,wire=0),point=single(value,4,wire=0,required=False) or 0))
    return dict(maxRank=single(raw,2,wire=0,required=False) or 0,entries=entries)


def probe_population(reader,thresholds,*,max_reads=MAX_BAND_READS,spacing=1,deadline=180,clock=time.monotonic,sleep=time.sleep):
    """Search shared rank windows, then freshly verify boundary sides.

    reader(start, end) returns at most 100 positions. Samples live only within
    this band/run; an old snapshot cannot stand in for a current observation.
    Every response must agree on maxRank. Counts remain multi-request estimates.
    """
    if not thresholds or thresholds[0]['threshold']!=0 or len(thresholds)>7:
        raise ValueError('arena_population_thresholds_unverified')
    if len({r['tier'] for r in thresholds})!=len(thresholds) or any(thresholds[i]['threshold']>=thresholds[i+1]['threshold'] for i in range(len(thresholds)-1)):
        raise ValueError('arena_population_thresholds_unverified')
    samples={};total=None;reads=0;began=clock();last=None
    def read(start,end):
        nonlocal total,reads,last
        if reads>=max_reads or clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        if last is not None and spacing:sleep(max(0,spacing-(clock()-last)))
        if clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        result=reader(start,end);reads+=1;last=clock();maximum=number(result['maxRank'])
        if maximum>=2147483647:raise ValueError('arena_population_rank_limit')
        if total is None:total=maximum
        if maximum!=total:raise ValueError('arena_population_changed')
        entries=result['entries']
        expected=list(range(start,min(end,total)+1))
        if [entry['rank'] for entry in entries]!=expected:
            raise ValueError('arena_population_non_positional_ranks')
        fresh={entry['rank']:number(entry['point']) for entry in entries}
        combined=samples|fresh
        ordered=sorted(combined)
        if any(combined[left]<combined[right] for left,right in zip(ordered,ordered[1:])):
            raise ValueError('arena_population_non_monotone')
        samples.update(fresh)
        return fresh
    read(1,WINDOW_SIZE)
    if total:read(total,total+1)
    at_least=[total]+[None]*(len(thresholds)-1)
    def solve(first,last_index):
        if first>last_index:return
        index=(first+last_index)//2;threshold=thresholds[index]['threshold']
        while True:
            lo=max((rank for rank,point in samples.items() if point>=threshold),default=0)
            hi=min((rank for rank,point in samples.items() if point<threshold),default=total+1)
            if lo+1==hi:break
            mid=(lo+hi)//2
            start=(mid-1)//WINDOW_SIZE*WINDOW_SIZE+1
            read(start,min(start+WINDOW_SIZE-1,total))
        at_least[index]=lo
        # The middle threshold's samples also bound both neighbouring searches.
        solve(first,index-1);solve(index+1,last_index)
    solve(1,len(thresholds)-1)
    # Group nearby verification points into one fresh request, including boundaries
    # that straddle a search window. Empty and one-player boards are also rechecked.
    checks={1,total+1}
    if total:checks.add(total)
    for boundary in at_least[1:]:
        if boundary:checks.add(boundary)
        if boundary<total:checks.add(boundary+1)
    checkpoints=sorted(checks);verified={};index=0
    while index<len(checkpoints):
        start=end=checkpoints[index];index+=1
        while index<len(checkpoints) and checkpoints[index]-start<WINDOW_SIZE:
            end=checkpoints[index];index+=1
        verified.update(read(start,end))
    for index,row in enumerate(thresholds[1:],1):
        boundary=at_least[index]
        if boundary and verified[boundary]<row['threshold']:raise ValueError('arena_population_changed')
        if boundary<total and verified[boundary+1]>=row['threshold']:raise ValueError('arena_population_changed')
    return dict(totalEstimate=total,sampleReads=reads,
                tiers=[dict(row,count=at_least[i]-(at_least[i+1] if i+1<len(at_least) else 0)) for i,row in enumerate(thresholds)])


class ArenaPopulationClient(ArenaRankingClient):
    def discover(self):
        host=super().discover()
        if getattr(self,'population_master',None)!=self.plan['masterVersion']:
            raise LoginError('arena_population_master_mismatch')
        return host

    def _public_rpc(self,host,method):
        raw=super()._public_rpc(host,method)
        if method=='app.masterdata.MasterdataService/Version':self.population_master=string(raw,1,optional=True)
        return raw

    def export(self,identity,device_id,host,progress=lambda stage:None):
        if getattr(self,'population_master',None)!=self.plan['masterVersion']:
            raise LoginError('arena_population_master_mismatch')
        auth=self.authenticate(identity,device_id,host,progress)
        observations=[];remaining=MAX_RUN_READS;last_rpc=None
        try:
            for band in self.plan['bandIds']:
                if remaining==0:break
                started=datetime.now(timezone.utc)
                def reader(start,end):
                    nonlocal remaining,last_rpc
                    if remaining==0:raise ValueError('arena_population_budget_exceeded')
                    if last_rpc is not None:time.sleep(max(0,1-(time.monotonic()-last_rpc)))
                    remaining-=1
                    payload=b''.join(integer(n,v) for n,v in enumerate([int(self.plan['seasonId']),int(band),start,end],1))
                    raw=self.rpc(host,RPC,payload,auth);last_rpc=time.monotonic()
                    return decode_population_response(raw)
                try:
                    counts=probe_population(reader,self.plan['populationThresholds'][band])
                except ValueError as exc:
                    if str(exc) not in ('arena_population_changed','arena_population_budget_exceeded'):raise
                    # Preserve independently verified bands. Neither movement nor
                    # exhausted budgets trigger retries or bypass the server cooldown.
                    print(json.dumps(dict(bandId=band,status='skipped',reason=str(exc))),flush=True)
                    continue
                observed=datetime.now(timezone.utc)
                if self.plan.get('populationValidUntil') and observed>=absolute(self.plan['populationValidUntil']):raise LoginError('arena_population_season_ended')
                observations.append(dict(schemaVersion=1,serverId=self.server_id,seasonId=self.plan['seasonId'],bandId=band,
                    method='rank_boundary_probe',accuracy='estimate',sourceReleaseId=self.plan['contentReleaseId'],masterVersion=self.population_master,
                    startedAt=started.isoformat(),observedAt=observed.isoformat(),expiresAt=(observed+timedelta(hours=6)).isoformat(),**counts))
            if string(self.rpc(host,'app.masterdata.MasterdataService/Version',b'',()),1,optional=True)!=self.population_master:
                raise LoginError('arena_population_master_mismatch')
            if not observations:raise LoginError('arena_population_no_consistent_bands')
        finally:auth.clear()
        return observations


def publish_populations(observations,root,server):
    checked=[];seen=set()
    if not isinstance(observations,list) or not 1<=len(observations)<=10:raise ValueError('invalid_arena_populations')
    for row in observations:
        value=validate_population(row,server,row['seasonId'],row['bandId'])
        target=population_path(root,server,row['seasonId'],row['bandId'])
        if target in seen:raise ValueError('duplicate_arena_population')
        seen.add(target);checked.append((target,value))
    for target,value in checked:
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
        for directory in (target.parent,target.parent.parent,target.parent.parent.parent):os.chmod(directory,0o755)
        fd,temp=tempfile.mkstemp(prefix='.arena-population-',dir=target.parent)
        try:
            with os.fdopen(fd,'w') as stream:
                os.fchmod(stream.fileno(),0o644);json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
            os.replace(temp,target)
        finally:Path(temp).unlink(missing_ok=True)
    return [target for target,_ in checked]
