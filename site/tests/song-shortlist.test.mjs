import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {fixture} from './fixtures/gekisou-skill-fixture.mjs';
import {screenTeamSongs,selectSongShortlist} from '../src/lib/song-shortlist.mjs';
import {runPlaylistTeamBatch} from '../src/lib/playlist-team-batch.ts';

function inputs(){
  const {rules,chart,draft}=fixture({missions:[1,2,3]});
  draft.modifiers.growth=Object.fromEntries(draft.slots.flatMap(s=>[
    [s.memberCardId,{level:1,rank:1,awake:1,skillLevel:1,gekisouSkillLevel:1}],[s.supportCardId,{level:1,rank:1}]]));
  const charts=rules.tables.LiveMusic.slice(0,8).map(m=>({...chart,id:`music-chart-${m._id}03`,trackId:`music-${m._id}`}));
  const candidates=charts.map(c=>({id:c.id,trackId:c.trackId,difficulty:c.difficulty,title:c.trackId,
    analysisDataUrl:'data:application/json,'+encodeURIComponent(JSON.stringify(c))}));
  return {candidates,payload:{rules,draft,planningScenario:{scope:'selected'},mode:'gekisou',objective:'expected_song_score',
    performanceScenario:{profile:'steady',samples:2,seed:42},gekisouScenario:{ranks:[1,1,1],batches:1},
    constraints:{leaderId:draft.slots[2].memberCardId,lockedPairs:draft.slots}},
    loadChart:async c=>charts.find(chart=>chart.id===c.id),yieldControl:async()=>{}};
}

test('shortlist retains leaders from both samples, deduplicates and respects the limit',()=>{
  const rows=Array.from({length:12},(_,index)=>({index,value:12-index,verifiedValue:index}));
  const selected=selectSongShortlist(rows);
  assert.deepEqual(selected.map(r=>r.index),[0,1,2,9,10,11]);
  const ties=rows.map(r=>({...r,verifiedValue:r.value}));
  assert.deepEqual(selectSongShortlist(ties).map(r=>r.index),[0,1,2,3,4,5]);
  assert.equal(selectSongShortlist(rows.slice(0,2)).length,2);
});

test('real skill-aware screening retains the fully scored winner across mixed mission charts',async()=>{
  const context=inputs(),before=structuredClone(context.payload);
  const screened=await screenTeamSongs(context);
  const full=await runPlaylistTeamBatch(context);
  assert.equal(screened.done,8);assert.equal(screened.selected.length,6);
  assert.equal(screened.coverageComplete,true);assert.equal(screened.globalBestGuaranteed,false);
  assert.ok(screened.rows.every(r=>r.verifiedValue>0));
  const best=[...full.rows].sort((a,b)=>Math.max(...b.result.results.map(r=>r.value))-Math.max(...a.result.results.map(r=>r.value)))[0];
  assert.ok(screened.selected.some(c=>c.id===best.candidate.id));
  assert.deepEqual(context.payload,before);
});

test('screen cancellation does not hand a partial shortlist to full optimization',async()=>{
  const context=inputs(),controller=new AbortController();let loaded=0;
  const result=await screenTeamSongs({...context,signal:controller.signal,
    loadChart:async c=>{loaded++;return context.loadChart(c);},onProgress:p=>{if(p.phase==='song-screen'&&p.chartDone===1)controller.abort();}});
  assert.equal(result.status,'cancelled');assert.equal(result.coverageComplete,false);assert.deepEqual(result.selected,[]);
  assert.equal(result.done,1);assert.equal(loaded,1);
});

test('missing charts remain explicit failures and cultivation is not silently screened as current growth',async()=>{
  const context=inputs();
  const result=await screenTeamSongs({...context,loadChart:async c=>{if(c.id===context.candidates[0].id)throw Error('missing chart');return context.loadChart(c);}});
  assert.equal(result.done,8);assert.equal(result.failures.length,1);assert.equal(result.coverageComplete,false);
  assert.equal(result.failures[0].candidate.id,context.candidates[0].id);
  await assert.rejects(screenTeamSongs({...context,payload:{...context.payload,planningScenario:{scope:'selected',plan:{enabled:true,mode:'current-cap',maxTrainedCards:1}}}}),/关闭培养计划/);
});

test('production worker screens before full search and reports selected versus original coverage',async()=>{
  const context=inputs();
  for(const count of [8,6]){
  const candidates=context.candidates.slice(0,count);
  const worker=new Worker(new URL('./helpers/browser-worker-host.mjs',import.meta.url),{workerData:{entry:new URL('../src/lib/production-optimizer-worker.ts',import.meta.url).href}});
  try{
    const result=await new Promise((resolve,reject)=>{
      worker.on('error',reject);worker.on('message',data=>{if(data.type==='error')reject(Error(data.error));if(data.type==='result')resolve(data.result);});
      worker.postMessage({type:'optimize',requestId:1,payload:{...context.payload,playlistCandidates:candidates,songShortlist:true,concurrency:1}});
    });
    assert.equal(result.kind,'playlist-team-batch');assert.equal(result.status,'completed');assert.equal(result.total,6);
    if(count===8){
      assert.equal(result.screening.total,8);assert.equal(result.screening.done,8);
      assert.equal(result.selectedCoverageComplete,true);assert.equal(result.coverageComplete,false);
      assert.deepEqual(result.rows.map(r=>r.candidate.id).sort(),result.screening.selected.map(c=>c.id).sort());
    }else{assert.equal(result.screening,undefined);assert.equal(result.coverageComplete,true);}
    const scores=result.rows.map(r=>Math.max(...r.result.results.map(t=>t.value)));
    assert.deepEqual(scores,[...scores].sort((a,b)=>b-a));
  }finally{await worker.terminate();}
  }
});

test('cancelling during chart loading does not count the aborted chart as screened',async()=>{
  const context=inputs(),controller=new AbortController();
  const result=await screenTeamSongs({...context,signal:controller.signal,
    loadChart:async()=>{controller.abort();throw Error('aborted fetch');}});
  assert.equal(result.status,'cancelled');assert.equal(result.done,0);
  assert.deepEqual(result.failures,[]);assert.deepEqual(result.selected,[]);
});
