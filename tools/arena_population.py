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
from tools.collect_arena_rankings import ArenaRankingClient,decode_response
from tools.growth_login import LoginError,integer,string


def population_plan(data,plan,now=None):
    now=now or datetime.now(timezone.utc)
    master=data.get('sourceMasterVersion')
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


def probe_population(reader,thresholds,*,max_reads=96,spacing=1,deadline=180,clock=time.monotonic,sleep=time.sleep):
    """reader(rank) returns one official position. Publish estimates, never a census.

    Every sampled maxRank must match; endpoints and each threshold boundary are
    checked again. Remaining movement between probes is why counts are estimates.
    """
    if not thresholds or thresholds[0]['threshold']!=0 or len(thresholds)>7:
        raise ValueError('arena_population_thresholds_unverified')
    if len({r['tier'] for r in thresholds})!=len(thresholds) or any(thresholds[i]['threshold']>=thresholds[i+1]['threshold'] for i in range(len(thresholds)-1)):
        raise ValueError('arena_population_thresholds_unverified')
    samples={};total=None;reads=0;began=clock();last=None
    def read(rank,force=False):
        nonlocal total,reads,last
        if rank in samples and not force:return samples[rank]
        if reads>=max_reads or clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        if last is not None and spacing:sleep(max(0,spacing-(clock()-last)))
        if clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        result=reader(rank);reads+=1;last=clock();maximum=number(result['maxRank'])
        if maximum>=2147483647:raise ValueError('arena_population_rank_limit')
        if total is None:total=maximum
        if maximum!=total:raise ValueError('arena_population_changed')
        entries=result['entries']
        if rank>total:
            if entries:raise ValueError('arena_population_inconsistent_tail')
            value=None
        else:
            if len(entries)!=1 or entries[0]['rank']!=rank:
                raise ValueError('arena_population_non_positional_ranks')
            value=number(entries[0]['point'])
        for position,point in samples.items():
            if position==rank or point is None or value is None:continue
            if (position<rank and point<value) or (position>rank and point>value):
                raise ValueError('arena_population_non_monotone')
        samples[rank]=value;return value
    read(1)
    if total:
        read(total);read(total+1)
    at_least=[total];previous=total
    for row in thresholds[1:]:
        threshold=row['threshold'];lo=0;hi=previous+1
        while lo+1<hi:
            mid=(lo+hi)//2
            if read(mid)>=threshold:lo=mid
            else:hi=mid
        at_least.append(lo);previous=lo
    # Verify the side of every inferred boundary, not just the head and tail.
    for i,row in enumerate(thresholds[1:],1):
        boundary=at_least[i]
        if boundary and read(boundary,True)<row['threshold']:raise ValueError('arena_population_changed')
        if boundary<total and read(boundary+1,True)>=row['threshold']:raise ValueError('arena_population_changed')
    read(1,True)
    if total:read(total,True);read(total+1,True)
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
        observations=[]
        try:
            for band in self.plan['bandIds']:
                started=datetime.now(timezone.utc)
                def reader(rank):
                    payload=b''.join(integer(n,v) for n,v in enumerate([int(self.plan['seasonId']),int(band),rank,rank],1))
                    return decode_response(self.rpc(host,RPC,payload,auth),dict(self.plan,rangeStart=rank,rangeEnd=rank),band)
                counts=probe_population(reader,self.plan['populationThresholds'][band])
                observed=datetime.now(timezone.utc)
                if self.plan.get('populationValidUntil') and observed>=absolute(self.plan['populationValidUntil']):raise LoginError('arena_population_season_ended')
                observations.append(dict(schemaVersion=1,serverId=self.server_id,seasonId=self.plan['seasonId'],bandId=band,
                    method='rank_boundary_probe',accuracy='estimate',sourceReleaseId=self.plan['contentReleaseId'],masterVersion=self.population_master,
                    startedAt=started.isoformat(),observedAt=observed.isoformat(),expiresAt=(observed+timedelta(hours=6)).isoformat(),**counts))
            if string(self.rpc(host,'app.masterdata.MasterdataService/Version',b'',()),1,optional=True)!=self.population_master:
                raise LoginError('arena_population_master_mismatch')
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
