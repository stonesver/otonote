import copy
import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from tools.arena_population import probe_population,population_plan,publish_populations,ArenaPopulationClient,decode_population_response
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
  def read(start,end):
   calls.append((start,end));return dict(maxRank=len(points),entries=[dict(rank=r,point=points[r-1]) for r in range(start,min(end,len(points))+1)])
  result=probe_population(read,THRESHOLDS,clock=lambda:0,sleep=waits.append)
  self.assertEqual([r['count'] for r in result['tiers']],[33000,500,300,180,20]);self.assertEqual(result['totalEstimate'],34000)
  self.assertLessEqual(len(calls),24);self.assertTrue(all(1<=end-start+1<=100 for start,end in calls));self.assertLess(len(calls),len(points)//100)
  self.assertTrue(all(v==1 for v in waits));self.assertEqual(result['sampleReads'],len(calls))
  self.assertNotIn('entries',result)

 def test_empty_and_missing_tiers_are_real_zero_only_after_successful_probe(self):
  def read(start,end):return dict(maxRank=0,entries=[])
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertEqual(result['totalEstimate'],0);self.assertTrue(all(r['count']==0 for r in result['tiers']))
  result=probe_population(lambda start,end:dict(maxRank=5,entries=[dict(rank=r,point=4) for r in range(start,min(end,5)+1)]),THRESHOLDS,spacing=0)
  self.assertEqual([r['count'] for r in result['tiers']],[5,0,0,0,0])

 def test_changing_maximum_non_positional_rank_non_monotone_and_budget_fail_closed(self):
  points=[1000,900,800,700,600,500,400,300,200,100]
  def read(start,end):return dict(maxRank=10,entries=[dict(rank=r,point=points[r-1]) for r in range(start,min(end,10)+1)])
  with self.assertRaisesRegex(ValueError,'budget'):probe_population(read,THRESHOLDS,max_reads=1,spacing=0)
  calls=[0]
  def changing(start,end):
   calls[0]+=1;total=10 if calls[0]==1 else 11
   return dict(maxRank=total,entries=[dict(rank=r,point=100) for r in range(start,min(end,total)+1)])
  result=probe_population(changing,THRESHOLDS,spacing=0)
  self.assertEqual((result['totalLower'],result['totalEstimate'],result['totalUpper']),(10,11,11))
  self.assertEqual(sum(r['count'] for r in result['tiers']),11)
  with self.assertRaisesRegex(ValueError,'non_positional'):probe_population(lambda start,end:dict(maxRank=10,entries=[dict(rank=1,point=1)]),THRESHOLDS,spacing=0)
  with self.assertRaisesRegex(ValueError,'non_monotone'):probe_population(lambda start,end:dict(maxRank=10,entries=[dict(rank=r,point=r) for r in range(start,min(end,10)+1)]),THRESHOLDS,spacing=0)

 def test_boundary_recheck_records_small_movement_even_when_maximum_is_unchanged(self):
  seen={}
  def read(start,end):
   entries=[]
   for rank in range(start,min(end,10)+1):
    seen[rank]=seen.get(rank,0)+1
    point=5000 if rank<=5 else 4
    if rank==5 and seen[rank]>1:point=4
    entries.append(dict(rank=rank,point=point))
   return dict(maxRank=10,entries=entries)
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertEqual(result['tiers'][-1]['count'],4)
  self.assertLessEqual(result['tiers'][-1]['lower'],4)
  self.assertGreaterEqual(result['tiers'][-1]['upper'],5)

 def test_plan_requires_complete_published_thresholds_current_season_and_master_binding(self):
  data=dict(sourceMasterVersion='a'*32,serverScopes=['global-hmt'],completeRankBands=['1'],capabilities=dict(ranks=True),
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

 def test_reader_uses_at_most_100_positions_and_discards_profiles_and_clears_auth(self):
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
    if not 1<=last-first+1<=100:raise AssertionError('unbounded window')
    raw=b''.join(message(1,integer(3,r)+integer(4,4)+message(1,'not-decoded')) for r in range(first,min(last,10)+1))
    return raw+integer(2,10)
  with patch('tools.arena_population.time.sleep'),patch('tools.arena_population.probe_population',side_effect=lambda reader,thresholds:probe_population(reader,thresholds,spacing=0)):
   result=Client(plan).export(None,None,'synthetic-host')
  self.assertTrue(all(c in (RPC,'app.masterdata.MasterdataService/Version') for c in calls));self.assertNotIn('not-decoded',json.dumps(result));self.assertEqual(auth,[])
  with tempfile.TemporaryDirectory() as root:publish_populations(result,root,'global-hmt')
  class Failed(Client):
   def rpc(self,*args):raise LoginError('game_rpc_unavailable')
  auth.append(('credential','synthetic-token'))
  with self.assertRaises(LoginError):Failed(plan).export(None,None,'synthetic-host')
  self.assertEqual(auth,[])

 def test_one_moving_band_does_not_discard_other_verified_bands_or_trigger_retries(self):
  from tools.growth_login import message,integer,single
  auth=[('credential','synthetic-token')];calls=[]
  plan=dict(serverId='global-hmt',seasonId='1',bandIds=['1','2','3'],limit=1000,contentReleaseId='test',masterVersion='a'*32,populationThresholds={str(b):THRESHOLDS for b in (1,2,3)})
  class Client(ArenaPopulationClient):
   population_master='a'*32
   def authenticate(self,*args):return auth
   def rpc(self,host,method,payload,credential):
    if method=='app.masterdata.MasterdataService/Version':return message(1,'a'*32)
    band=single(payload,2,wire=0);start=single(payload,3,wire=0);end=single(payload,4,wire=0);calls.append(band)
    total=100 if band==2 and calls.count(2)>1 else 10
    raw=b''.join(message(1,integer(3,r)+integer(4,4)) for r in range(start,min(end,total)+1))
    return raw+integer(2,total)
  from contextlib import redirect_stdout
  import io
  with patch('tools.arena_population.time.sleep'),patch('tools.arena_population.probe_population',side_effect=lambda reader,thresholds:probe_population(reader,thresholds,spacing=0)),redirect_stdout(io.StringIO()):
   result=Client(plan).export(None,None,'synthetic-host')
  self.assertEqual([r['bandId'] for r in result],['1','3']);self.assertEqual(calls.count(2),2);self.assertEqual(auth,[])
  with tempfile.TemporaryDirectory() as root:
   old=observation();old['bandId']='2';publish_populations([old],root,'global-hmt')
   before=population_path(root,'global-hmt','1','2').read_bytes()
   publish_populations(result,root,'global-hmt')
   self.assertEqual(population_path(root,'global-hmt','1','2').read_bytes(),before)

 def test_plateaus_window_edges_and_extreme_distributions_match_full_local_counts(self):
  import random
  randomizer=random.Random(7)
  distributions=[[0]*5,[1,99,100,101,1000],[100,0,100,0,100],[0,0,0,0,1]]
  distributions += [[randomizer.randrange(800) for _ in THRESHOLDS] for _ in range(40)]
  for counts in distributions:
   points=sorted((threshold['threshold'] for count,threshold in zip(counts,THRESHOLDS) for _ in range(count)),reverse=True)
   calls=[]
   def read(start,end):
    calls.append((start,end))
    return dict(maxRank=len(points),entries=[dict(rank=r,point=points[r-1]) for r in range(start,min(end,len(points))+1)])
   result=probe_population(read,THRESHOLDS,spacing=0)
   self.assertEqual([r['count'] for r in result['tiers']],counts)
   self.assertLessEqual(len(calls),48)
   self.assertTrue(all(1<=end-start+1<=100 for start,end in calls))

 def test_large_board_uses_bounded_windows_without_allocating_or_walking_full_board(self):
  total=10_000_000;calls=[]
  def point(rank):return 5000 if rank<=123 else 1900 if rank<=5000 else 745 if rank<=20000 else 190 if rank<=100000 else 4
  def read(start,end):
   calls.append((start,end));return dict(maxRank=total,entries=[dict(rank=r,point=point(r)) for r in range(start,min(end,total)+1)])
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertEqual([r['count'] for r in result['tiers']],[9_900_000,80_000,15_000,4877,123])
  self.assertLessEqual(len(calls),48)

 def test_missing_middle_position_and_duplicate_ranks_never_become_zero_counts(self):
  for entries in [[dict(rank=1,point=1000),dict(rank=3,point=0)],
                  [dict(rank=1,point=1000),dict(rank=1,point=1000),dict(rank=3,point=0)]]:
   with self.assertRaisesRegex(ValueError,'non_positional'):
    probe_population(lambda start,end:dict(maxRank=3,entries=entries),THRESHOLDS,spacing=0)

 def test_deadline_includes_spacing_and_stops_before_next_request(self):
  clock=[0];calls=[]
  def sleep(seconds):clock[0]+=seconds
  def reader(start,end):
   calls.append((start,end));return dict(maxRank=1,entries=[dict(rank=1,point=0)])
  with self.assertRaisesRegex(ValueError,'budget'):
   probe_population(reader,THRESHOLDS,spacing=1,deadline=.5,clock=lambda:clock[0],sleep=sleep)
  self.assertEqual(len(calls),1)

 def test_run_budget_spans_bands_preserves_completed_result_and_never_retries(self):
  from tools.growth_login import message,integer,single
  from contextlib import redirect_stdout
  import io
  calls=[];auth=[('credential','synthetic')]
  plan=dict(serverId='global-hmt',seasonId='1',bandIds=['1','2','3'],contentReleaseId='test',masterVersion='a'*32,populationThresholds={str(b):THRESHOLDS for b in (1,2,3)})
  class Client(ArenaPopulationClient):
   population_master='a'*32
   def authenticate(self,*args):return auth
   def rpc(self,host,method,payload,credential):
    if method=='app.masterdata.MasterdataService/Version':return message(1,'a'*32)
    calls.append(single(payload,2,wire=0));return integer(2,0)
  with patch('tools.arena_population.MAX_RUN_READS',3),patch('tools.arena_population.time.sleep'),redirect_stdout(io.StringIO()):
   result=Client(plan).export(None,None,'synthetic-host')
  self.assertEqual(calls,[1,1,2]);self.assertEqual([row['bandId'] for row in result],['1']);self.assertEqual(auth,[])

 def test_aggregate_decoder_ignores_profiles_and_rejects_oversized_windows(self):
  from tools.growth_login import message,integer
  row=integer(3,1)+integer(4,190)+message(1,b'ignored-profile')+message(2,b'ignored-deck')
  decoded=decode_population_response(message(1,row)+integer(2,1))
  self.assertEqual(decoded,dict(maxRank=1,entries=[dict(rank=1,point=190)]))
  with self.assertRaisesRegex(LoginError,'invalid_arena_population_response'):
   decode_population_response(message(1,row)*101+integer(2,101))

 def test_sustained_growth_and_score_movement_publish_ranges_with_bounded_reads(self):
  calls=[];histories=[]
  def read(start,end):
   step=len(calls);total=34000+step
   cuts=[1000+step,500+step,200+step,20+step]
   def point(rank):return 5000 if rank<=cuts[3] else 1900 if rank<=cuts[2] else 745 if rank<=cuts[1] else 190 if rank<=cuts[0] else 4
   calls.append((start,end));histories.append([total-cuts[0],cuts[0]-cuts[1],cuts[1]-cuts[2],cuts[2]-cuts[3],cuts[3]])
   return dict(maxRank=total,entries=[dict(rank=r,point=point(r)) for r in range(start,min(end,total)+1)])
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertLessEqual(len(calls),48);self.assertTrue(all(b-a<100 for a,b in calls))
  self.assertEqual(sum(r['count'] for r in result['tiers']),result['totalEstimate'])
  for i,row in enumerate(result['tiers']):
   self.assertLessEqual(row['lower'],min(h[i] for h in histories))
   self.assertGreaterEqual(row['upper'],max(h[i] for h in histories))
  self.assertGreater(result['totalUpper'],result['totalLower'])

 def test_adjacent_window_repairs_shift_and_excessive_drift_is_still_rejected(self):
  calls=[];moved=[False]
  def reader(start,end):
   if (start,end)==(438,537):moved[0]=True
   calls.append((start,end));boundary=560 if moved[0] else 500
   return dict(maxRank=1000,entries=[dict(rank=r,point=5000 if r<=boundary else 4) for r in range(start,min(end,1000)+1)])
  result=probe_population(reader,THRESHOLDS,spacing=0)
  self.assertEqual(result['tiers'][-1]['count'],560)
  self.assertTrue(moved[0]);self.assertIn((538,637),calls)
  self.assertLessEqual(result['tiers'][-1]['lower'],500)
  self.assertGreaterEqual(result['tiers'][-1]['upper'],560)
  count=[0]
  def volatile(start,end):
   count[0]+=1;total=1000+count[0]*100
   return dict(maxRank=total,entries=[dict(rank=r,point=4) for r in range(start,min(end,total)+1)])
  with self.assertRaisesRegex(ValueError,'changed'):probe_population(volatile,THRESHOLDS,spacing=0)
  self.assertEqual(count[0],2)

 def test_v2_ranges_are_validated_and_preserved_through_http(self):
  from backend.arena_population import validate_population
  row=observation();row.update(schemaVersion=2,totalLower=9,totalUpper=11,rangeMethod='observed_window_envelope')
  for tier in row['tiers']:tier.update(lower=1,upper=3)
  clean=validate_population(row,'global-hmt','1','1')
  self.assertEqual(clean['totalLower'],9);self.assertEqual(clean['tiers'][0]['upper'],3)
  for mutate in (lambda r:r.update(totalLower=11),lambda r:r.update(totalUpper=9),lambda r:r.update(rangeMethod='95_percent'),lambda r:r['tiers'][0].update(upper=1),lambda r:r['tiers'][0].update(lower=3),lambda r:r.update(sampleReads=49)):
   bad=copy.deepcopy(row);mutate(bad)
   with self.assertRaises(ValueError):validate_population(bad,'global-hmt','1','1')
  with tempfile.TemporaryDirectory() as root:
   publish_populations([row],root,'global-hmt')
   self.assertEqual(query_population(root,server='global-hmt',season='1',band='1')['observation'],clean)

 def test_small_shrink_and_empty_board_remain_nonnegative(self):
  calls=[0]
  def read(start,end):
   calls[0]+=1;total=10 if calls[0]==1 else 8
   return dict(maxRank=total,entries=[dict(rank=r,point=5000 if r<=3 else 4) for r in range(start,min(end,total)+1)])
  result=probe_population(read,THRESHOLDS,spacing=0)
  self.assertEqual(result['totalEstimate'],8);self.assertEqual(result['totalUpper'],10)
  self.assertEqual(sum(r['count'] for r in result['tiers']),8)
  self.assertTrue(all(0<=r['lower']<=r['count']<=r['upper'] for r in result['tiers']))
