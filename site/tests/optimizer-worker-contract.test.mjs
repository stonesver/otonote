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
async function runWorker(t,payload,requestId=17) {
  // Adapt browser messaging to an actual isolated worker, retaining structured clone.
  const moduleUrl=new URL('../src/lib/production-optimizer-worker.ts',import.meta.url).href;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
    import {parentPort} from 'node:worker_threads';
    globalThis.self={postMessage:data=>parentPort.postMessage(data),addEventListener:(type,handler)=>parentPort.on(type,data=>handler({data}))};
    await import(${JSON.stringify(moduleUrl)});
    parentPort.postMessage({type:'ready'});
  `)));
  t.after(()=>worker.terminate());
  const messages=[];
  return new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='ready'){worker.postMessage({type:'optimize',requestId,payload});return;}
      messages.push(message);
      if(message.type==='result'||message.type==='error')resolve({message,messages});
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
