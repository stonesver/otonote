"""Demand-driven public rank windows; credentials belong to the capture process."""
from __future__ import annotations
import base64
import hashlib
import json
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from backend.arena_rankings import scope, number, validate_observation, RankingCursorChanged, absolute

WINDOW = 100

class LiveQueryError(ValueError):
    def __init__(self, code, status=503, retry_after=60):
        super().__init__(code); self.status=status; self.retry_after=retry_after

class ArenaLiveQueries:
    """One upstream read per window/5min, one fresh read per minute globally.

    Concurrent requests for the same window share one result. No autonomous
    polling, credential storage, or public-request override of freshness limits.
    """
    def __init__(self, reader, *, clock=time.time, ttl=300, cooldown=60, capacity=32):
        self.reader,self.clock,self.ttl,self.cooldown,self.capacity=reader,clock,ttl,cooldown,capacity
        self.lock=threading.Condition();self.cache=OrderedDict();self.pending=None;self.next_read=0
        self.errors={}

    def query(self, *, server,season,band,rank=1,end=None,limit=10,cursor=None):
        scope(server,season,band);number(rank,1,2147483647);number(limit,1,100)
        start=(rank-1)//WINDOW*WINDOW+1 if end is None else rank
        end=min(start+WINDOW-1,2147483647) if end is None else end
        number(end,start,min(start+99,2147483647));key=(server,season,band,start,end)
        with self.lock:
            # Waiting consumers share the producer and do not start another login.
            if self.pending==key:self.lock.wait_for(lambda:self.pending!=key,timeout=35)
            stamp=self.clock();cached=self.cache.get(key)
            if cursor and (not cached or cached['until']<=stamp):raise RankingCursorChanged('arena_live_window_changed')
            if not cached or cached['until']<=stamp:
                if self.pending is not None:raise LiveQueryError('arena_live_busy',429,30)
                if stamp<self.next_read:raise LiveQueryError('arena_live_rate_limited',429,max(1,int(self.next_read-stamp)+1))
                self.pending=key;self.next_read=stamp+self.cooldown
            else:
                self.cache.move_to_end(key)
                return self._page(cached,key,rank,limit,cursor)
        try:
            data=validate_observation(self.reader(server,season,band,start,end),server,season,band)
            if data['coverage']!={'startRank':start,'endRank':end}:raise ValueError('arena_live_range_mismatch')
            expires=absolute(data['expiresAt']).timestamp()
            if expires<=self.clock() or absolute(data['observedAt']).timestamp()>self.clock()+60:raise ValueError('arena_live_invalid_time')
            raw=json.dumps(data,sort_keys=True,separators=(',',':')).encode()
            cached=dict(data=data,digest=hashlib.sha256(raw).hexdigest(),until=min(expires,self.clock()+self.ttl))
            with self.lock:
                self.cache[key]=cached;self.cache.move_to_end(key)
                while len(self.cache)>self.capacity:self.cache.popitem(last=False)
        except LiveQueryError:raise
        except Exception:raise LiveQueryError('arena_live_unavailable') from None
        finally:
            with self.lock:self.pending=None;self.lock.notify_all()
        return self._page(cached,key,rank,limit,cursor)

    def _page(self,cached,key,rank,limit,cursor):
        data=cached['data'];rows=[r for r in data['entries'] if r['rank']>=rank];offset=0
        identity=[*key,rank,cached['digest']]
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>1024:raise ValueError()
                payload=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
                offset=payload['offset']
                if payload['identity']!=identity or type(offset) is not int or not 0<offset<len(rows):raise ValueError()
            except Exception:raise RankingCursorChanged('arena_live_window_changed') from None
        next_cursor=None
        if offset+limit<len(rows):
            next_cursor=base64.urlsafe_b64encode(json.dumps(dict(identity=identity,offset=offset+limit)).encode()).decode().rstrip('=')
        return dict(schemaVersion=1,serverId=key[0],seasonId=key[1],bandId=key[2],mode='dynamic',
            status='available' if rows else 'empty',observedAt=data['observedAt'],expiresAt=data['expiresAt'],
            snapshotId=cached['digest'],sourceReleaseId=data['source']['contentReleaseId'],coverage=data['coverage'],
            maxRank=data['maxRank'],totalEntries=len(rows),entries=rows[offset:offset+limit],nextCursor=next_cursor,
            nextRank=None,refreshSeconds=self.ttl)
