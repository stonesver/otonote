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
    """Estimate moving score boundaries with bounded, fresh window corrections.

    Old samples only guide the search. Fresh windows locate each final boundary;
    their movement and search resolution form an empirical envelope, NOT a
    statistical confidence interval or a bound on unobserved/future movement.
    """
    import math
    if not thresholds or thresholds[0]['threshold']!=0 or len(thresholds)>7:
        raise ValueError('arena_population_thresholds_unverified')
    if len({r['tier'] for r in thresholds})!=len(thresholds) or any(thresholds[i]['threshold']>=thresholds[i+1]['threshold'] for i in range(len(thresholds)-1)):
        raise ValueError('arena_population_thresholds_unverified')
    samples={};totals=[];reads=0;began=clock();last=None;last_window=None
    def read(start,end):
        nonlocal reads,last,last_window
        if reads>=max_reads or clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        if last is not None and spacing:sleep(max(0,spacing-(clock()-last)))
        if clock()-began>deadline:raise ValueError('arena_population_budget_exceeded')
        result=reader(start,end);reads+=1;last=clock();maximum=number(result['maxRank'])
        if maximum>=2147483647:raise ValueError('arena_population_rank_limit')
        totals.append(maximum);last_window=(start,end)
        # A small board gets an absolute allowance; large boards use 0.5%.
        if max(totals)-min(totals)>max(20,math.ceil(totals[0]*.005)):
            raise ValueError('arena_population_changed')
        entries=result['entries']
        if [entry['rank'] for entry in entries]!=list(range(start,min(end,maximum)+1)):
            raise ValueError('arena_population_non_positional_ranks')
        fresh={entry['rank']:number(entry['point']) for entry in entries}
        ordered=list(fresh)
        # Only values from ONE response must be monotone. Earlier windows may
        # legitimately disagree with a newer snapshot of a moving leaderboard.
        if any(fresh[a]<fresh[b] for a,b in zip(ordered,ordered[1:])):
            raise ValueError('arena_population_non_monotone')
        for rank in list(samples):
            if rank>maximum:del samples[rank]
        samples.update(fresh)
        return fresh,maximum
    read(1,WINDOW_SIZE)
    brackets={}
    def bounds(threshold):
        maximum=totals[-1]
        lo=max((r for r,p in samples.items() if p>=threshold and r<=maximum),default=0)
        hi=min((r-1 for r,p in samples.items() if p<threshold and r<=maximum),default=maximum)
        # Contradictory cross-time hints are discarded, never treated as corrupt
        # official data. The request/deadline budgets still bound the new search.
        return (lo,hi) if lo<=hi else (0,maximum)
    def solve(first,last_index):
        if first>last_index:return
        index=(first+last_index)//2;threshold=thresholds[index]['threshold']
        lo,hi=bounds(threshold)
        while hi-lo>=WINDOW_SIZE:
            mid=(lo+hi)//2;start=max(1,mid-WINDOW_SIZE//2+1)
            fresh,maximum=read(start,start+WINDOW_SIZE-1)
            above=[r for r,p in fresh.items() if p>=threshold]
            below=[r-1 for r,p in fresh.items() if p<threshold]
            new_lo=max(above,default=lo);new_hi=min(below,default=min(hi,maximum))
            if new_lo>new_hi:
                # A moving boundary crossed an old search bound. Trust this
                # window and discard the stale side of the bracket.
                new_lo=max(above,default=0);new_hi=min(below,default=maximum)
            lo,hi=new_lo,new_hi
        brackets[index]=(lo,hi)
        solve(first,index-1);solve(index+1,last_index)
    solve(1,len(thresholds)-1)
    located={}
    for index,row in enumerate(thresholds[1:],1):
        if index in located:continue
        lo,hi=brackets[index];center=(lo+hi)//2
        # The first window covers the whole search bracket. Up to two adjacent
        # corrections tolerate drift without restarting a search or a login.
        start=max(1,center-WINDOW_SIZE//2+1)
        for correction in range(3):
            fresh,maximum=read(start,start+WINDOW_SIZE-1)
            for candidate,threshold in enumerate(thresholds[1:],1):
                if candidate in located:continue
                above=[r for r,p in fresh.items() if p>=threshold['threshold']]
                below=[r for r,p in fresh.items() if p<threshold['threshold']]
                lower=max(above,default=0 if start==1 or maximum==0 else None)
                upper=min(below)-1 if below else maximum if start+WINDOW_SIZE-1>=maximum else None
                if lower is not None and lower==upper:located[candidate]=lower
            if index in located:break
            # All below (or beyond the shrunken tail) => move toward the head.
            toward_head=not fresh or any(p<row['threshold'] for p in fresh.values())
            start=max(1,start-WINDOW_SIZE) if toward_head else start+WINDOW_SIZE
        else:raise ValueError('arena_population_changed')
    # Latest official total, including the empty-board case. This also validates
    # a tail window, but a changing maxRank no longer invalidates prior windows.
    total=totals[-1]
    if not (last_window[0]<=max(1,total) and last_window[1]>total):
        read(max(1,total-WINDOW_SIZE+2),max(1,total+1))
    total=totals[-1];lower_total=min(totals);upper_total=max(totals);drift=upper_total-lower_total
    boundaries=[total];envelopes=[(lower_total,upper_total)]
    for index in range(1,len(thresholds)):
        lo,hi=brackets[index];observed=located[index]
        # Project asynchronous cumulative counts onto a non-increasing sequence.
        # Any correction remains visible inside the resulting interval.
        estimate=min(boundaries[-1],observed)
        boundaries.append(estimate)
        envelopes.append((max(0,min(lo,observed,estimate)-drift),min(upper_total,max(hi,observed,estimate)+drift)))
    boundaries.append(0);envelopes.append((0,0))
    tiers=[]
    for i,row in enumerate(thresholds):
        count=boundaries[i]-boundaries[i+1]
        lower=max(0,envelopes[i][0]-envelopes[i+1][1])
        upper=min(upper_total,max(0,envelopes[i][1]-envelopes[i+1][0]))
        if not lower<=count<=upper or upper-lower>max(200,math.ceil(upper_total*.03)):
            raise ValueError('arena_population_changed')
        tiers.append(dict(row,count=count,lower=lower,upper=upper))
    return dict(totalEstimate=total,totalLower=lower_total,totalUpper=upper_total,
                rangeMethod='observed_window_envelope',sampleReads=reads,tiers=tiers)


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
                observations.append(dict(schemaVersion=2,serverId=self.server_id,seasonId=self.plan['seasonId'],bandId=band,
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
