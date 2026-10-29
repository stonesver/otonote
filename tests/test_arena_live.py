import copy
import json
import tempfile
import threading
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from backend.arena_live import ArenaLiveQueries,LiveQueryError
from backend.arena_rankings import RankingCursorChanged
from tests.test_arena_rankings import observation

class ArenaLiveTests(unittest.TestCase):
 def test_any_verified_window_is_cached_and_cursor_cannot_cross_range_or_time(self):
  now=[datetime(2026,10,29,6,tzinfo=timezone.utc).timestamp()];calls=[]
  def reader(server,season,band,start,end):
   calls.append((start,end));v=observation(server,season,band);v.update(observedAt=datetime.fromtimestamp(now[0],timezone.utc).isoformat(),expiresAt=datetime.fromtimestamp(now[0]+300,timezone.utc).isoformat(),maxRank=31279,coverage=dict(startRank=start,endRank=end),entries=[dict(playerId='p'+str(i),name='Name',rank=i,point=0) for i in range(start,min(end,31279)+1)]);return v
  live=ArenaLiveQueries(reader,clock=lambda:now[0]);args=dict(server='global-hmt',season='1',band='1',rank=10001,limit=10)
  first=live.query(**args);second=live.query(**args,cursor=first['nextCursor'])
  self.assertEqual((first['entries'][0]['rank'],second['entries'][0]['rank']), (10001,10011));self.assertEqual(calls,[(10001,10100)])
  with self.assertRaises(RankingCursorChanged):live.query(**{**args,'rank':10002},cursor=first['nextCursor'])
  with self.assertRaises(LiveQueryError) as exc:live.query(**{**args,'band':'2'})
  self.assertEqual(exc.exception.status,429)
  now[0]+=301
  with self.assertRaises(RankingCursorChanged):live.query(**args,cursor=first['nextCursor'])
  live.query(**args);self.assertEqual(len(calls),2)
  now[0]+=61;empty=live.query(**{**args,'rank':32000});self.assertEqual(empty['status'],'empty');self.assertEqual(empty['maxRank'],31279)

 def test_explicit_100_range_is_bounded_cached_and_never_auto_chains(self):
  calls=[];now=datetime(2026,10,29,1,5,tzinfo=timezone.utc).timestamp()
  def reader(server,season,band,start,end):
   calls.append((start,end));return dict(observation(),coverage=dict(startRank=start,endRank=end),maxRank=40000,
     entries=[dict(playerId='p'+str(i),name='Name',rank=i,point=0) for i in range(start,end+1)])
  live=ArenaLiveQueries(reader,clock=lambda:now);args=dict(server='global-hmt',season='1',band='1',rank=10001,end=10100)
  page=live.query(**args,limit=100);self.assertEqual(page['totalEntries'],100);self.assertIsNone(page['nextRank'])
  ranks=[r['rank'] for r in page['entries']]
  while page['nextCursor']:
   page=live.query(**args,limit=100,cursor=page['nextCursor']);ranks.extend(r['rank'] for r in page['entries'])
  self.assertEqual(ranks,list(range(10001,10101)));self.assertEqual(calls,[(10001,10100)])
  for end in (10101,10000,True):
   with self.assertRaises(ValueError):live.query(**dict(args,end=end))
  self.assertEqual(len(calls),1)

 def test_concurrent_identical_queries_share_one_upstream_read(self):
  now=datetime(2026,10,29,1,5,tzinfo=timezone.utc).timestamp();started=threading.Event();release=threading.Event();calls=[];results=[]
  def reader(*args):calls.append(1);started.set();release.wait(2);return observation()
  live=ArenaLiveQueries(reader,clock=lambda:now)
  def read():results.append(live.query(server='global-hmt',season='1',band='1'))
  a=threading.Thread(target=read);a.start();self.assertTrue(started.wait(2));b=threading.Thread(target=read);b.start();release.set();a.join();b.join()
  self.assertEqual(len(calls),1);self.assertEqual(len(results),2);self.assertEqual(results[0]['snapshotId'],results[1]['snapshotId'])

 def test_invalid_response_does_not_refresh_cache_or_trigger_unbounded_retry(self):
  calls=[];now=[datetime(2026,10,29,1,5,tzinfo=timezone.utc).timestamp()]
  def reader(*args):calls.append(1);return dict(observation(),serverId='global-en')
  live=ArenaLiveQueries(reader,clock=lambda:now[0]);args=dict(server='global-hmt',season='1',band='1')
  with self.assertRaises(LiveQueryError):live.query(**args)
  with self.assertRaises(LiveQueryError):live.query(**args)
  self.assertEqual(len(calls),1)

 def test_capture_verifies_scope_and_existing_pause_before_sdk_and_clears_auth(self):
  from unittest.mock import patch
  from tools.arena_live import CaptureRange
  from tools.growth_login import Profile,integer,message
  from tests.test_arena_rankings import projection,NOW
  import hashlib
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);raw=json.dumps(projection()).encode();p=root/'arena.json';p.write_bytes(raw)
   (root/'account').write_text('synthetic-account');(root/'password').write_text('synthetic-password');auth=[('token','synthetic-private')];calls=[]
   class Game:
    client_version='1.1.0';server={'language':'zh-TW'}
    def __init__(self,plan):self.plan=plan
    def discover(self):return 'synthetic-host'
    def authenticate(self,*args):return auth
    def rpc(self,host,method,payload,credential):
     calls.append(method);return message(1,message(1,message(1,'public')+message(2,'Name'))+integer(3,10001))+integer(2,31279)
   class SDK:
    device_id='synthetic-device'
    def __init__(self,*args):pass
    def login(self,*args):calls.append('login');return object()
   with patch('tools.arena_live.Profile.from_resources',return_value=Profile('FAKE')),patch('tools.arena_live.read_plan',return_value=dict(seasonId='1',contentReleaseId='test-release',projectionSha256='a'*64,limit=100)):
    reader=CaptureRange(projection=p,digest=hashlib.sha256(raw).hexdigest(),sdk_resources=root/'unused',state_dir=root/'state',lock_dir=root/'lock',credentials=root,game_factory=Game,sdk_factory=SDK)
    (root/'state/status.json').write_text(json.dumps(dict(paused=True)))
    with self.assertRaises(LiveQueryError):reader('global-hmt','1','1',10001,10100)
    self.assertEqual(calls,[]);(root/'state/status.json').write_text(json.dumps(dict(paused=False)))
    data=reader('global-hmt','1','1',10001,10100);self.assertEqual(data['entries'][0]['rank'],10001);self.assertEqual(auth,[]);self.assertEqual(calls[0],'login')
    with self.assertRaises(ValueError):reader('global-hmt','1','1',10001,10101)
    from tools.growth_login import LoginError
    class FailedGame(Game):
     def rpc(self,*args):raise LoginError('game_authentication_failed')
    failed=CaptureRange(projection=p,digest=hashlib.sha256(raw).hexdigest(),sdk_resources=root/'unused',state_dir=root/'state',lock_dir=root/'lock',credentials=root,game_factory=FailedGame,sdk_factory=SDK)
    auth.append(('token','synthetic-private'))
    with self.assertRaises(LiveQueryError):failed('global-hmt','1','1',10001,10100)
    self.assertEqual(auth,[]);self.assertTrue(json.loads((root/'state/arena-live-status.json').read_text())['paused'])
    previous=len(calls)
    with self.assertRaises(LiveQueryError):failed('global-hmt','1','1',10001,10100)
    self.assertEqual(len(calls),previous)


 def test_http_input_is_bounded_and_busy_has_retry_information(self):
  from types import SimpleNamespace
  from tools.arena_live import Handler
  class Queries:
   calls=0
   def query(self,**kwargs):self.calls+=1;raise LiveQueryError('arena_live_busy',429,30)
  queries=Queries();handler=object.__new__(Handler);handler.server=SimpleNamespace(queries=queries);responses=[];handler.reply=lambda *args:responses.append(args)
  for path in ('/api/v1/arena-rankings-live?server=a&server=b','/api/v1/arena-rankings-live?unknown=x','/api/v1/arena-rankings-live?server=a&season=1&band=1&rank=no'):
   handler.path=path;handler.do_GET();self.assertEqual(responses[-1][0],400)
  self.assertEqual(queries.calls,0)
  handler.path='/api/v1/arena-rankings-live?server=global-hmt&season=1&band=1';handler.do_GET();self.assertEqual(responses[-1],(429,dict(error='arena_live_busy',retryAfter=30),30))
