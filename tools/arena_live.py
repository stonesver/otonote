"""Loopback-only, rate-limited public Arena range reads using capture mounts."""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
import threading
from dataclasses import replace
from datetime import datetime,timedelta,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from backend.arena_live import ArenaLiveQueries,LiveQueryError
from backend.arena_rankings import RPC,RankingCursorChanged
from tools.collect_arena_rankings import read_public_projection,read_plan,ArenaRankingClient,decode_response
from tools.collect_player_rankings import pause_required
from tools.growth_login import Profile,SdkClient,LoginError,integer
from tools.global_game_config import GLOBAL_SERVERS

class CaptureRange:
    def __init__(self,*,projection=None,digest=None,content_base=None,sdk_resources,state_dir,lock_dir,credentials,
                 game_factory=ArenaRankingClient,sdk_factory=SdkClient):
        self.projection,self.digest,self.content_base=projection,digest,content_base
        self.profile=Profile.from_resources(sdk_resources)
        self.state_dir,self.lock_dir,self.credentials=Path(state_dir),Path(lock_dir),Path(credentials)
        self.game_factory,self.sdk_factory=game_factory,sdk_factory
        self.state_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.status=self.state_dir/'arena-live-status.json'

    def __call__(self,server,season,band,start,end):
        if server not in GLOBAL_SERVERS:raise ValueError('invalid_arena_live_server')
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= 2147483647 or end-start >= 100:
            raise ValueError('invalid_arena_live_range')
        self.lock_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
        with (self.lock_dir/'capture.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise LiveQueryError('arena_live_busy',429,30) from None
            # Existing EN/KR event jobs keep their pause state in server subdirectories.
            # The legacy root also holds the shared live gateway's account pause.
            states=[self.state_dir]
            if server!='global-hmt':states.append(self.state_dir/server)
            for directory in states:
                for name in ('status.json','finalize-status.json','arena-'+server+'-status.json',
                             'arena-trends-'+server+'-status.json','arena-live-status.json'):
                    p=directory/name
                    if p.exists() and json.loads(p.read_text()).get('paused'):raise LiveQueryError('arena_live_paused')
            if self.projection:
                raw=Path(self.projection).read_bytes();digest=hashlib.sha256(raw).hexdigest()
                if digest!=self.digest:raise ValueError('arena_projection_hash_mismatch')
                verified=json.loads(raw),digest
            else:verified=read_public_projection(self.content_base)
            plan=read_plan(*verified,server,season,[band],100) if verified else None
            if plan is None:raise LiveQueryError('arena_live_scope_unverified',404)
            # No SDK credentials are read until exact publication scope is verified.
            game=self.game_factory(plan);host=game.discover();auth=[];account=password='';identity=None
            try:
                account=(self.credentials/'account').read_text().strip();password=(self.credentials/'password').read_text().rstrip('\r\n')
                if not account or not password:raise LoginError('ranking_credentials_required')
                sdk=self.sdk_factory(replace(self.profile,version=game.client_version,language=game.server['language']))
                identity=sdk.login(account,password);auth=game.authenticate(identity,sdk.device_id,host)
                payload=b''.join(integer(n,v) for n,v in enumerate([int(season),int(band),start,end],1))
                result=decode_response(game.rpc(host,RPC,payload,auth),dict(plan,rangeStart=start,rangeEnd=end),band)
                now=datetime.now(timezone.utc)
                return dict(schemaVersion=1,serverId=server,seasonId=season,bandId=band,entries=result['entries'],maxRank=result['maxRank'],
                    coverage=result['coverage'],observedAt=now.isoformat(),expiresAt=(now+timedelta(seconds=300)).isoformat(),
                    source=dict(method=RPC,clientVersion=game.client_version,contentReleaseId=plan['contentReleaseId'],projectionSha256=plan['projectionSha256']))
            except LoginError as exc:
                if pause_required(str(exc)) or str(exc)=='ranking_credentials_required':
                    temp=self.status.with_suffix('.tmp');temp.write_text(json.dumps(dict(paused=True,error=str(exc))));os.chmod(temp,0o600);temp.replace(self.status)
                raise LiveQueryError('arena_live_unavailable') from None
            finally:auth.clear();account=password='';identity=None

class Gateway(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,*args,**kwargs):
        self.connections=threading.BoundedSemaphore(16)
        super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.connections.acquire(blocking=False):self.close_request(request);return
        try:super().process_request(request,address)
        except BaseException:self.connections.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.connections.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,status,value,retry=None):
        raw=json.dumps(value,ensure_ascii=False).encode();self.send_response(status)
        for k,v in [('Content-Type','application/json; charset=utf-8'),('Cache-Control','no-store'),('X-Content-Type-Options','nosniff'),('Content-Length',str(len(raw)))]:self.send_header(k,v)
        if retry:self.send_header('Retry-After',str(retry))
        self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        parsed=urlsplit(self.path)
        if parsed.path=='/healthz':return self.reply(200,dict(status='ok'))
        if parsed.path!='/api/v1/arena-rankings-live':return self.reply(404,dict(error='not_found'))
        try:
            q=parse_qs(parsed.query,keep_blank_values=True)
            if len(self.path)>2048 or set(q)-{'server','season','band','rank','end','limit','cursor'} or any(len(v)!=1 for v in q.values()):raise ValueError()
            args={k:q[k][0] for k in ('server','season','band')}
            args.update(rank=int(q.get('rank',['1'])[0]),end=int(q['end'][0]) if 'end' in q else None,limit=int(q.get('limit',['10'])[0]),cursor=q.get('cursor',[None])[0])
            value=self.server.queries.query(**args)
        except LiveQueryError as exc:return self.reply(exc.status,dict(error=str(exc),retryAfter=exc.retry_after),exc.retry_after)
        except RankingCursorChanged:return self.reply(409,dict(error='arena_live_window_changed'))
        except (ValueError,KeyError,TypeError):return self.reply(400,dict(error='invalid_arena_live_query'))
        except Exception:return self.reply(503,dict(error='arena_live_unavailable'))
        return self.reply(200,value)

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--port',type=int,default=18766)
    p.add_argument('--projection',type=Path);p.add_argument('--projection-sha256');p.add_argument('--content-base',default='https://ournotes.stonebg.cn')
    p.add_argument('--sdk-resources',type=Path,required=True);p.add_argument('--state-dir',type=Path,required=True);p.add_argument('--lock-dir',type=Path,required=True)
    p.add_argument('--credentials',type=Path,default=Path('/run/ranking-credentials'))
    args=p.parse_args(argv)
    if bool(args.projection)!=bool(args.projection_sha256):p.error('Local projection requires its SHA-256')
    reader=CaptureRange(projection=args.projection,digest=args.projection_sha256,content_base=args.content_base,sdk_resources=args.sdk_resources,state_dir=args.state_dir,lock_dir=args.lock_dir,credentials=args.credentials)
    server=Gateway(('127.0.0.1',args.port),Handler);server.queries=ArenaLiveQueries(reader)
    server.serve_forever()

if __name__=='__main__':main()
