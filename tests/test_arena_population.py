import copy
import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from tools.arena_population import probe_population,population_plan,publish_populations,ArenaPopulationClient
from backend.arena_population import validate_population,query_population,population_path
from tools.collect_arena_rankings import ArenaRankingClient
from tools.growth_login import LoginError

THRESHOLDS=[dict(tier=i+1,threshold=t) for i,t in enumerate([0,190,745,1855,4155])]
NOW=datetime(2026,10,29,6,tzinfo=timezone.utc)

def observation():
 return dict(schemaVersion=1,serverId='global-hmt',seasonId='1',bandId='1',method='rank_boundary_probe',accuracy='estimate',sourceReleaseId='test',masterVersion='a'*32,
  startedAt=NOW.isoformat(),observedAt=(NOW+timedelta(seconds=60)).isoformat(),expiresAt=(NOW+timedelta(hours=6)).isoformat(),totalEstimate=10,sampleReads=20,
  tiers=[dict(r,count=2) for r in THRESHOLDS])

class PopulationTests(unittest.TestCase):
 def test_binary_probes_match_major_counts_without_enumeration_and_obey_spacing(self):
  points=[5000]*17+[4155]*3+[1900]*180+[745]*300+[190]*500+[4]*33000
  calls=[];waits=[]
  def read(rank):
   calls.append(rank);return dict(maxRank=len(points),entries=[dict(rank=rank,point=points[rank-1])] if rank<=len(points) else [])
  result=probe_population(read,THRESHOLDS,clock=lambda:0,sleep=waits.append)
  self.assertEqual([r['count'] for r in result['tiers']],[33000,500,300,180,20]);self.assertEqual(result['totalEstimate'],34000)
  self.assertLessEqual(len(calls),96);self.assertLess(len(calls),len(points)//100)
  self.assertTrue(all(v==1 for v in waits));self.assertEqual(result['sampleReads'],len(calls))
  self.assertNotIn('entries',result)

 def test_empty_and_missing_tiers_are_real_zero_only_after_successful_probe(self):
  def read(rank):return dict(maxRank=0,entries=[])
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertEqual(result['totalEstimate'],0);self.assertTrue(all(r['count']==0 for r in result['tiers']))
  result=probe_population(lambda rank:dict(maxRank=5,entries=[dict(rank=rank,point=4)] if rank<=5 else []),THRESHOLDS,spacing=0)
  self.assertEqual([r['count'] for r in result['tiers']],[5,0,0,0,0])

 def test_changing_maximum_non_positional_rank_non_monotone_and_budget_fail_closed(self):
  points=[1000,900,800,700,600,500,400,300,200,100]
  def read(rank):return dict(maxRank=10,entries=[dict(rank=rank,point=points[rank-1])] if rank<=10 else [])
  with self.assertRaisesRegex(ValueError,'budget'):probe_population(read,THRESHOLDS,max_reads=2,spacing=0)
  calls=[0]
  def changing(rank):
   calls[0]+=1;return dict(maxRank=10 if calls[0]==1 else 11,entries=[dict(rank=rank,point=100)])
  with self.assertRaisesRegex(ValueError,'changed'):probe_population(changing,THRESHOLDS,spacing=0)
  with self.assertRaisesRegex(ValueError,'non_positional'):probe_population(lambda rank:dict(maxRank=10,entries=[dict(rank=1,point=1)]),THRESHOLDS,spacing=0)
  with self.assertRaisesRegex(ValueError,'non_monotone'):probe_population(lambda rank:dict(maxRank=10,entries=[dict(rank=rank,point=rank)]),THRESHOLDS,spacing=0)

 def test_boundary_recheck_detects_movement_even_when_maximum_is_unchanged(self):
  seen={}
  def read(rank):
   seen[rank]=seen.get(rank,0)+1
   point=5000 if rank<=5 else 4
   if rank==5 and seen[rank]>1:point=4
   return dict(maxRank=10,entries=[dict(rank=rank,point=point)] if rank<=10 else [])
  with self.assertRaises(ValueError):probe_population(read,THRESHOLDS,spacing=0)

 def test_plan_requires_complete_published_thresholds_current_season_and_master_binding(self):
  data=dict(sourceMasterVersion='a'*32,completeRankBands=['1'],capabilities=dict(ranks=True),
   seasons=[dict(id='1',validFrom=(NOW-timedelta(days=1)).isoformat(),validUntil=(NOW+timedelta(days=1)).isoformat())],
   ranks=[dict(r,bandId='1',division=1,openingSourceText='') for r in THRESHOLDS])
  plan=dict(serverId='global-hmt',seasonId='1',bandIds=['1'])
  self.assertEqual(population_plan(data,plan,NOW)['populationThresholds']['1'],THRESHOLDS)
  for key,value in [('sourceMasterVersion',None),('completeRankBands',[]),('ranks',[])]:
   bad={**data,key:value}
   with self.assertRaises(ValueError):population_plan(bad,plan,NOW)
  with self.assertRaises(ValueError):population_plan(data,plan,NOW+timedelta(days=2))
  game=ArenaPopulationClient(dict(plan,masterVersion='a'*32));game.population_master='b'*32
  with patch.object(ArenaRankingClient,'discover',return_value='synthetic-host'):
   with self.assertRaisesRegex(LoginError,'master_mismatch'):game.discover()

 def test_publication_whitelists_aggregates_isolates_scopes_and_keeps_old_on_error(self):
  with tempfile.TemporaryDirectory() as root:
   row=observation();row['rawProfile']='private-test-data'
   publish_populations([row],root,'global-hmt');path=population_path(root,'global-hmt','1','1')
   self.assertNotIn('rawProfile',path.read_text());before=path.read_bytes()
   value=query_population(root,server='global-hmt',season='1',band='1',now=NOW+timedelta(minutes=5))
   self.assertEqual(value['status'],'available');self.assertEqual(value['observation']['totalEstimate'],10)
   self.assertEqual(query_population(root,server='global-en',season='1',band='1')['status'],'unavailable')
   self.assertEqual(query_population(root,server='global-hmt',season='1',band='1',now=NOW+timedelta(hours=7))['status'],'stale')
   bad=copy.deepcopy(row);bad['tiers'][0]['count']=999
   with self.assertRaises(ValueError):publish_populations([bad],root,'global-hmt')
   self.assertEqual(path.read_bytes(),before)

 def test_http_is_read_only_aggregate_no_store_and_never_starts_a_probe(self):
  from fastapi.testclient import TestClient
  from tests.test_query_http import _make_config,_build_app
  with tempfile.TemporaryDirectory() as root:
   config=_make_config(Path(root));publish_populations([observation()],config.data_root/'observations','global-hmt')
   with patch('tools.arena_population.probe_population') as probe,TestClient(_build_app(config)) as client:
    url='/api/v1/arena-population?server=global-hmt&season=1&band=1'
    result=client.get(url);self.assertEqual(result.status_code,200);self.assertEqual(result.headers['cache-control'],'no-store')
    self.assertEqual(result.json()['observation']['totalEstimate'],10)
    self.assertEqual(client.get(url.replace('band=1','band=2')).json()['status'],'unavailable')
    self.assertEqual(client.get(url.replace('season=1','season=../')).status_code,400)
    self.assertEqual(client.post(url).status_code,405);probe.assert_not_called()

 def test_cooldown_is_checked_before_credentials_and_cannot_be_bypassed_by_resume(self):
  from tools.collect_arena_rankings import main
  from contextlib import redirect_stdout,redirect_stderr
  import io
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);state=root/'state';state.mkdir()
   (state/'arena-population-global-hmt-attempt.json').write_text(json.dumps(dict(attemptedAt=datetime.now(timezone.utc).isoformat())))
   args=['--population','--root',str(root/'observations'),'--state-dir',str(state),'--lock-dir',str(root/'lock'),'--sdk-resources',str(root/'unused')]
   with patch('tools.collect_arena_rankings.run_capture') as capture,patch('tools.collect_arena_rankings.Profile.from_resources') as profile,redirect_stdout(io.StringIO()):
    self.assertEqual(main(args),0);capture.assert_not_called();profile.assert_not_called()
   with redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):main(args+['--resume'])

 def test_reader_uses_only_one_position_per_call_and_clears_auth_even_on_failure(self):
  from tools.growth_login import message,integer,single
  from backend.arena_rankings import RPC
  auth=[('credential','synthetic-token')];calls=[]
  plan=dict(serverId='global-hmt',seasonId='1',bandIds=['1'],limit=1000,contentReleaseId='test',masterVersion='a'*32,populationThresholds={'1':THRESHOLDS})
  class Client(ArenaPopulationClient):
   population_master='a'*32
   def authenticate(self,*args):return auth
   def rpc(self,host,method,payload,credential):
    calls.append(method)
    if method=='app.masterdata.MasterdataService/Version':return message(1,'a'*32)
    first,last=single(payload,3,wire=0),single(payload,4,wire=0)
    if first!=last:raise AssertionError('not a point probe')
    raw=message(1,message(1,message(1,'not-published')+message(2,'not-published'))+integer(3,first)+integer(4,4)) if first<=10 else b''
    return raw+integer(2,10)
  with patch('tools.arena_population.probe_population',side_effect=lambda reader,thresholds:probe_population(reader,thresholds,spacing=0)):
   result=Client(plan).export(None,None,'synthetic-host')
  self.assertTrue(all(c in (RPC,'app.masterdata.MasterdataService/Version') for c in calls));self.assertNotIn('not-published',json.dumps(result));self.assertEqual(auth,[])
  with tempfile.TemporaryDirectory() as root:publish_populations(result,root,'global-hmt')
  class Failed(Client):
   def rpc(self,*args):raise LoginError('game_rpc_unavailable')
  auth.append(('credential','synthetic-token'))
  with self.assertRaises(LoginError):Failed(plan).export(None,None,'synthetic-host')
  self.assertEqual(auth,[])
