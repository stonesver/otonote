import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
import {optimizeTeamPlanning} from '../src/lib/team-planning-optimizer.ts';
import {optimizePractical} from '../src/lib/practical-optimizer.mjs';
import {runPlaylistTeamBatch} from '../src/lib/playlist-team-batch.ts';

function fixture(mode='ordinary') {
  const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url)));
  rules.tables.MemberCard=rules.tables.MemberCard.filter(r=>r._id>=1&&r._id<=5);
  rules.tables.SupportCard=rules.tables.SupportCard.filter(r=>r._id>=1&&r._id<=5);
  const draft=createTeamDraft({selectedSongId:'music-100001',selectedDifficulty:'expert',
    slots:[1,2,3,4,5].map(id=>({memberCardId:`member-card-${id}`,supportCardId:`support-card-${id}`}))});
  const chart={id:'music-chart-10000103',trackId:draft.selectedSongId,sourceReleaseId:rules.sourceReleaseId,difficulty:'expert',
    bpmEvents:[{tick:0,bpm:125}],skillTimings:[1,2,3,4,5],feverRanges:[{start:1,end:2},{start:3,end:4},{start:5,end:7}],
    notes:[100,200,1100,2100,3100,4100,5100,6100,7100].map((tick,i)=>({id:`tap-${i}`,type:'tap',tick,position:0,size:1}))};
  return {rules,draft,chart,mode,objective:'expected_song_score',planningScenario:{scope:'reference'},
    performanceScenario:{profile:'steady',seed:42,samples:3},gekisouScenario:{seed:42,batches:2,ranks:[1,1,1]},
    constraints:{leaderId:'member-card-1',lockedPairs:draft.slots}};
}
async function runWorker(t,payload,requestId=17,control={}) {
  // Adapt browser messaging to an actual isolated worker, retaining structured clone.
  const moduleUrl=new URL('../src/lib/production-optimizer-worker.ts',import.meta.url).href;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';
    const control=${JSON.stringify(control)};let receive,cancelled=false,requestPayload;
    // Deliver cancellation at a precise boundary without racing the CPU clock.
    globalThis.self={postMessage:data=>{
      parentPort.postMessage(data);
      if(!cancelled&&data.type==='progress'&&data.progress.phase===control.cancelAtPhase){cancelled=true;receive({data:{type:'cancel'}});}
      if(!cancelled&&data.type==='progress'&&data.progress.phase===control.replaceAtPhase){
        cancelled=true;
        receive({data:{type:'optimize',requestId:data.requestId+1,payload:requestPayload}})
          .then(()=>parentPort.postMessage({type:'settled',requestId:data.requestId+1}));
      }
    },addEventListener:(type,handler)=>{receive=handler;parentPort.on(type,async data=>{
      if(data.type==='optimize')requestPayload=data.payload;
      const pending=handler({data});
      if(data.type==='optimize'&&control.cancelBeforeSearch)handler({data:{type:'cancel'}});
      await pending;
      if(data.type==='optimize')parentPort.postMessage({type:'settled',requestId:data.requestId});
    });}};
    await import(${JSON.stringify(moduleUrl)});
    parentPort.postMessage({type:'ready'});
  `)));
  t.after(()=>worker.terminate());
  const messages=[];
  return new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='ready'){worker.postMessage({type:'optimize',requestId,payload});return;}
      if(message.type==='settled'){if(message.requestId===requestId+(control.replaceAtPhase?1:0))resolve({message:messages.find(m=>m.type==='result'||m.type==='error'),messages});return;}
      messages.push(message);
    });
  });
}
for(const mode of ['ordinary','gekisou'])test(`typed worker preserves every ${mode} planning score, growth comparison and hash`,{timeout:30000},async t=>{
  const payload=fixture(mode),before=structuredClone(payload);
  const expected=await optimizeTeamPlanning({...payload,yieldControl:async()=>{}});
  const {message,messages}=await runWorker(t,payload);
  assert.equal(message.type,'result');assert.deepEqual(message.result,expected);
  assert.deepEqual(payload,before);assert.ok(messages.every(m=>m.requestId===17));
  const candidate=messages.find(m=>m.progress?.phase==='planning-result');
  assert.ok(candidate);assert.equal(candidate.progress.bestCandidate.planning.plannedTeamCurrentValue,null);
});
test('typed worker preserves practical and playlist result envelopes',{timeout:30000},async t=>{
  const payload=fixture();delete payload.planningScenario;delete payload.performanceScenario;
  Object.assign(payload,{scope:'theoretical',objective:'formation_power',searchMethod:'practical'});
  assert.deepEqual((await runWorker(t,payload)).message.result,await optimizePractical({...payload,yieldControl:async()=>{}}));
  payload.playlistCandidates=[{id:'one',trackId:'music-100001',difficulty:'expert',title:'Fixture',analysisDataUrl:'/unused'}];
  assert.deepEqual((await runWorker(t,payload)).message.result,await runPlaylistTeamBatch({candidates:payload.playlistCandidates,payload}));
});
test('typed worker keeps errors associated with their request',async t=>{
  const payload=fixture();payload.variantLimit=0;
  const {message}=await runWorker(t,payload,29);
  assert.equal(message.type,'error');assert.equal(message.requestId,29);assert.match(message.error,/1–1000/);
});

for(const mode of ['ordinary','gekisou'])for(const control of [{cancelBeforeSearch:true},{cancelAtPhase:'planning'},{cancelAtPhase:'planning-result'}]) {
  test(`planning cancellation settles with full ${mode} candidates only: ${JSON.stringify(control)}`,{timeout:10000},async t=>{
    const payload=fixture(mode);
    const {message,messages}=await runWorker(t,payload,41,control);
    assert.ok(message,'a cancelled worker must send a terminal response so the UI leaves stopping');
    assert.equal(message.type,'result');assert.equal(message.requestId,41);
    assert.equal(message.result.status,'cancelled');assert.equal(message.result.optimality,'incomplete');
    assert.equal(messages.filter(m=>m.type==='result').length,1);
    if(control.cancelAtPhase==='planning-result'){
      const scored=messages.find(m=>m.progress?.phase==='planning-result').progress.bestCandidate;
      assert.ok(message.result.results.length);
      const kept=message.result.results.find(row=>row.id===scored.id);
      assert.ok(kept,'keep the candidate whose full calculation already finished');
      for(const field of ['value','power','expectedScore','minimumScore','maximumScore','scorePrecision','orderCount','performanceScenario'])assert.deepEqual(kept[field],scored[field],field);
      assert.equal(kept.scorePrecision,'full');
    }else assert.deepEqual(message.result.results,[]);
  });
}

test('restarting a planning worker suppresses the cancelled predecessor and returns the unchanged full result',{timeout:10000},async t=>{
  const payload=fixture(),expected=await optimizeTeamPlanning({...payload,yieldControl:async()=>{}});
  const {message,messages}=await runWorker(t,payload,51,{replaceAtPhase:'planning-result'});
  assert.equal(message.type,'result');assert.equal(message.requestId,52);
  assert.deepEqual(message.result,expected);
  assert.equal(messages.filter(m=>m.type==='result'||m.type==='error').length,1);
});
