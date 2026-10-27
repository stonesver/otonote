import test from 'node:test';
import assert from 'node:assert/strict';
import {runPlaylistTeamBatch} from '../src/lib/playlist-team-batch.mjs';
const candidates=[1,2,3].map(i=>({id:`c${i}`,trackId:`music-${i}`,title:`song ${i}`,difficulty:'expert',analysisDataUrl:`/${i}`}));
const payload={draft:{slots:[],modifiers:{}},rules:{sourceReleaseId:'test'},objective:'expected_song_score',calculationScope:{title:'test'}};
test('each chart receives independent draft and only requested charts load',async()=>{
 const loads=[],drafts=[],partials=[];const r=await runPlaylistTeamBatch({candidates:candidates.slice(0,2),payload,loadChart:async c=>{loads.push(c.id);return {};},optimize:async o=>{drafts.push(o.draft);return {status:'completed',results:[{draft:o.draft}]};},onPartial:r=>partials.push(r)});
 assert.deepEqual(loads,['c1','c2']);assert.deepEqual(drafts.map(d=>d.selectedSongId),['music-1','music-2']);assert.notEqual(drafts[0],drafts[1]);assert.equal(payload.draft.selectedSongId,undefined);assert.equal(r.coverageComplete,true);assert.equal(r.optimality,'per_chart_results_only');assert.deepEqual(partials.map(p=>p.done),[1,2]);
});
test('failed chart stays visible and is never substituted with a different chart',async()=>{
 const r=await runPlaylistTeamBatch({candidates,payload,loadChart:async c=>{if(c.id==='c2')throw Error('network');return {};},optimize:async()=>({status:'completed',results:[]})});assert.equal(r.rows.length,2);assert.equal(r.failures[0].id,'c2');assert.equal(r.coverageComplete,false);
});
test('cancel during load prevents optimize and all later loads; completed charts survive',async()=>{
 const controller=new AbortController(),loaded=[];const r=await runPlaylistTeamBatch({candidates,payload,signal:controller.signal,loadChart:async c=>{loaded.push(c.id);if(c.id==='c2')controller.abort();return {};},optimize:async()=>({status:'completed',results:[]})});assert.deepEqual(loaded,['c1','c2']);assert.equal(r.rows.length,1);assert.equal(r.status,'cancelled');assert.equal(r.coverageComplete,false);
});
test('empty and duplicate domains fail before expensive work',async()=>{
 await assert.rejects(runPlaylistTeamBatch({candidates:[],payload}),/范围为空/);await assert.rejects(runPlaylistTeamBatch({candidates:[candidates[0],candidates[0]],payload}),/重复/);
});
